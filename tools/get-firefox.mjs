// Fetches a project-local Firefox Developer Edition into .cache/firefox/ so
// `npm start` and the e2e runner drive a known browser instead of whatever
// happens to be installed. Re-running is cheap: completed downloads are kept
// and keyed by version.

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

const versions = await getJson('https://product-details.mozilla.org/1.0/firefox_versions.json')
const version = process.env.FIREFOX_VERSION || versions.FIREFOX_DEVEDITION
const dir = join(cacheDir, `${version}-${platform}`)
const binary = platform === 'win64' ? join(dir, 'core', 'firefox.exe') : join(dir, 'firefox', 'firefox')
const marker = join(dir, '.complete')

if (await exists(marker)) {
  await writeCurrent()
  console.log(`firefox devedition ${version} already present: ${binary}`)
  process.exit(0)
}

const base = `https://archive.mozilla.org/pub/devedition/releases/${version}`
const artifact = platform === 'win64'
  ? `win64/en-US/Firefox Setup ${version}.exe`
  : `linux-x86_64/en-US/firefox-${version}.tar.xz`
const url = `${base}/${artifact.split('/').map(encodeURIComponent).join('/')}`

await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })
const tmp = join(cacheDir, `download-${version}.tmp`)

const expected = await expectedDigest(artifact)
console.log(`downloading firefox devedition ${version} (${platform})`)
const actual = await download(url, tmp)
if (actual !== expected) {
  await rm(tmp, { force: true })
  console.error(`get-firefox: checksum mismatch for ${artifact}\n  expected ${expected}\n  got      ${actual}`)
  process.exit(1)
}
console.log(`  sha256 ok (${actual.slice(0, 16)}…)`)
extract(tmp, dir)

if (!await exists(binary)) {
  console.error(`get-firefox: extraction finished but ${binary} is missing`)
  process.exit(1)
}

await rm(tmp, { force: true })
await writeFile(marker, '')
await writeCurrent()
console.log(`ready: ${binary}`)

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
  await writeFile(join(cacheDir, 'current.json'), JSON.stringify({ version, platform, binary }, null, 2) + '\n')
}

async function exists (p) {
  return stat(p).then(() => true, () => false)
}
