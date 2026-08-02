// Fetches a project-local Firefox into .cache/firefox/ so `npm start` and the
// e2e runner drive a known browser instead of whatever happens to be
// installed. Re-running is cheap: completed downloads are kept and keyed by
// version.
//
// Developer Edition by default, since that is what development tracks.
// FIREFOX_CHANNEL=release|esr picks a shipping build instead, and
// FIREFOX_VERSION pins an exact one -- which is how the extension gets tested
// against the floor it claims in strict_min_version rather than only against
// whatever is newest:
//
//   FIREFOX_CHANNEL=release FIREFOX_VERSION=142.0 node tools/get-firefox.mjs
//   FIREFOX_CHANNEL=esr node tools/get-firefox.mjs

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(root, '.cache', 'firefox')

const platform = process.platform === 'win32' ? 'win64' : process.platform === 'linux' ? 'linux64' : null
if (!platform) {
  console.error(`get-firefox: unsupported platform ${process.platform}`)
  process.exit(1)
}

const channel = process.env.FIREFOX_CHANNEL || 'devedition'
if (!['devedition', 'release', 'esr'].includes(channel)) {
  console.error(`get-firefox: unknown channel ${channel}`)
  process.exit(1)
}

// The version lands in a path that gets rm -rf'd and in the URL the checksums
// are fetched from, and in CI it arrives from an HTTP response rather than
// from a person. Anything that is not a version number stops here -- a pinned
// one before the network is touched at all.
const VERSION_RE = /^\d+(\.\d+){0,2}([ab]\d+)?(esr)?$/
let version = process.env.FIREFOX_VERSION
if (version && !VERSION_RE.test(version)) {
  throw new Error(`get-firefox: refusing FIREFOX_VERSION ${JSON.stringify(version)}`)
}
if (!version) {
  const versions = await getJson('https://product-details.mozilla.org/1.0/firefox_versions.json')
  version = {
    devedition: versions.FIREFOX_DEVEDITION,
    release: versions.LATEST_FIREFOX_VERSION,
    esr: versions.FIREFOX_ESR
  }[channel]
  if (!VERSION_RE.test(String(version))) {
    throw new Error(`get-firefox: product-details gave an unusable ${channel} version ${JSON.stringify(version)}`)
  }
}
// Release and ESR share one archive tree; only Developer Edition has its own.
const product = channel === 'devedition' ? 'devedition' : 'firefox'
const dir = join(cacheDir, `${version}-${platform}`)
const binary = platform === 'win64' ? join(dir, 'core', 'firefox.exe') : join(dir, 'firefox', 'firefox')
const marker = join(dir, '.complete')

const base = `https://archive.mozilla.org/pub/${product}/releases/${version}`
const artifact = platform === 'win64'
  ? `win64/en-US/Firefox Setup ${version}.exe`
  : `linux-x86_64/en-US/firefox-${version}.tar.xz`
const url = `${base}/${artifact.split('/').map(encodeURIComponent).join('/')}`

// Ending by falling off the bottom rather than calling process.exit: the
// version lookup above leaves a keep-alive socket open, and exiting out from
// under it aborts the process on Windows -- which turned a successful setup
// into a failed one.
if (await exists(marker)) {
  await writeCurrent()
  console.log(`firefox ${channel} ${version} already present: ${binary}`)
} else {
  await install()
}

async function install () {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const tmp = join(cacheDir, `download-${version}.tmp`)

  const expected = await expectedDigest(artifact)
  console.log(`downloading firefox ${channel} ${version} (${platform})`)
  const actual = await download(url, tmp)
  if (actual !== expected) {
    await rm(tmp, { force: true })
    throw new Error(`checksum mismatch for ${artifact}\n  expected ${expected}\n  got      ${actual}`)
  }
  console.log(`  sha256 ok (${actual.slice(0, 16)}…)`)
  extract(tmp, dir)

  if (!await exists(binary)) {
    throw new Error(`extraction finished but ${binary} is missing`)
  }

  await rm(tmp, { force: true })
  await writeFile(marker, '')
  await writeCurrent()
  console.log(`ready: ${binary}`)
}

async function getJson (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

// Mozilla publishes a SHA256SUMS beside every release. Verifying against it
// adds no new trust root -- it is the same TLS channel -- but it turns "the
// bytes we happened to receive" into "the bytes Mozilla published", which
// covers truncation, a corrupted mirror, and tampering with a single object.
/** @param {string} artifact @returns {Promise<string>} */
async function expectedDigest (artifact) {
  const res = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`SHA256SUMS: HTTP ${res.status}`)
  for (const line of (await res.text()).split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+?)\s*$/)
    if (m && m[2] === artifact) return m[1]
  }
  throw new Error(`SHA256SUMS has no entry for ${artifact}`)
}

/** @returns {Promise<string>} the sha256 of what was written */
async function download (url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  // Redirects are followed by fetch; make sure we did not end up somewhere
  // other than Mozilla's own CDN before writing the bytes to disk.
  const host = new URL(res.url).host
  if (!/(^|\.)mozilla\.(org|net)$/.test(host)) throw new Error(`refusing download from ${host}`)

  const total = Number(res.headers.get('content-length')) || 0
  let done = 0
  let lastMark = 0
  const hash = createHash('sha256')
  const progress = new TransformStream({
    transform (chunk, controller) {
      hash.update(chunk)
      done += chunk.byteLength
      if (total && done - lastMark > total / 4) {
        lastMark = done
        console.log(`  ${Math.round(done / total * 100)}% of ${Math.round(total / 1e6)} MB`)
      }
      controller.enqueue(chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body.pipeThrough(progress)), createWriteStream(dest))
  return hash.digest('hex')
}

function extract (archive, dest) {
  if (platform === 'win64') {
    // The full installer is a 7-Zip SFX, so it can be unpacked without being
    // run. Deliberately no fallback to executing it: a project about failing
    // closed should not execute a binary it just pulled off the network,
    // signature or not.
    const sevenZip = spawnSync('7z', ['x', archive, `-o${dest}`, '-y'], { stdio: 'ignore' })
    if (sevenZip.status !== 0) {
      throw new Error('7-Zip is required to unpack the Windows build. Install it (scoop install 7zip, or choco install 7zip) and re-run.')
    }
  } else {
    const tar = spawnSync('tar', ['-xJf', archive, '-C', dest], { stdio: 'inherit' })
    if (tar.status !== 0) throw new Error('tar extraction failed')
  }
}

async function writeCurrent () {
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, 'current.json'), JSON.stringify({ version, channel, platform, binary }, null, 2) + '\n')
}

async function exists (p) {
  return stat(p).then(() => true, () => false)
}
