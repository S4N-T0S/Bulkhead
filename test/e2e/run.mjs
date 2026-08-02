// End-to-end run against a real Firefox: copies src/ into a build dir,
// appends the selftest to the background, launches web-ext on the
// project-local Developer Edition with a fresh temp profile, and asserts on
// the "[test] ..." lines the selftest dumps to stdout.
//
// Cases needing live Mullvad relays run only when a tunnel is detected;
// otherwise they are skipped and reported as such. Usage:
//   node test/e2e/run.mjs        (MOZ_HEADLESS=1 for headless, set on CI)

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const buildDir = join(root, '.cache', 'e2e-src')
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS) || 240_000

const firefox = await firefoxBinary()
const tunnel = await detectTunnel()
console.log(`e2e: firefox=${firefox}`)
console.log(`e2e: mullvad tunnel ${tunnel ? 'detected — full run' : 'not detected — tunnel cases will SKIP'}`)

await rm(buildDir, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })
await cp(join(root, 'src'), buildDir, { recursive: true })
await cp(join(root, 'test', 'e2e', 'selftest.js'), join(buildDir, 'selftest.js'))
// A canary on loopback, so the loopback case can assert a request actually
// arrived rather than merely going unblocked. Bound to 127.0.0.1, so nothing
// is exposed off the machine.
/** @type {string[]} */
const canaryHits = []
const canary = createServer((req, res) => {
  canaryHits.push(String(req.url))
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})
await new Promise(r => canary.listen(0, '127.0.0.1', r))
const canaryPort = /** @type {{ port: number }} */ (canary.address()).port

await writeFile(join(buildDir, 'test-config.js'),
  `globalThis.TEST_TUNNEL = ${tunnel}\nglobalThis.TEST_CANARY_PORT = ${canaryPort}\n`)

const manifestPath = join(buildDir, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.background.scripts = [...manifest.background.scripts, 'test-config.js', 'selftest.js']
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

const args = [
  join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
  'run',
  // verbose is what makes web-ext forward Firefox's stdout, where dump()
  // writes; without it the [test] lines never surface
  '--verbose',
  '--no-config-discovery',
  '--no-input',
  '--no-reload',
  `--source-dir=${buildDir}`,
  `--firefox=${firefox}`,
  '--pref=browser.dom.window.dump.enabled=true',
  '--pref=devtools.console.stdout.chrome=true',
  '--pref=network.proxy.failover_direct=false',
  '--pref=network.trr.mode=5'
]

const child = spawn(process.execPath, args, {
  cwd: root,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe']
})

/** @type {string[]} */
const lines = []
let finished = false

function onChunk (chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue
    lines.push(line)
    if (line.includes('[test]') || line.includes('[bulkhead]')) console.log(line)
    if (line.includes('[test] done')) finish()
  }
}
child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)

const timer = setTimeout(() => {
  console.error(`e2e: timed out after ${timeoutMs}ms`)
  finish()
}, timeoutMs)

child.on('exit', () => {
  if (!finished) finish()
})

function killTree () {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGINT')
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }, 5000).unref()
    } catch {}
  }
}

function finish () {
  if (finished) return
  finished = true
  clearTimeout(timer)
  // give trailing output a moment to flush before the tree goes down
  setTimeout(() => {
    killTree()
    setTimeout(evaluate, 1000)
  }, 500)
}

function evaluate () {
  const expected = [
    '[test] inert ok=true',
    '[test] A blocked=true reason=proxy-down',
    '[test] A cancelled=true',
    '[test] A blockedpage shown=true',
    '[test] harden apply=ok clear=ok',
    '[test] F loopback off blocked=true',
    '[test] F loopback on passed=true',
    '[test] F loopback narrow stillblocked=true',
    '[test] G custom dead health=down blocked=true',
    '[test] E race notup=true'
  ]
  if (tunnel) {
    expected.push(
      '[test] D health=up passed=true',
      '[test] B health=up passed=true',
      '[test] C health=misrouted',
      '[test] H custom live health=up custom=true'
    )
  } else {
    expected.push(
      '[test] D health=down blocked=true reason=proxy-down',
      '[test] D cancelled=true',
      '[test] D blockedpage shown=true',
      '[test] D self-fetch blocked=true',
      '[test] SKIP B (no tunnel)',
      '[test] SKIP C (no tunnel)',
      '[test] SKIP H (no tunnel)'
    )
  }
  canary.close()
  if (!canaryHits.some(u => u.includes('bulkhead-loopon'))) {
    console.error('e2e: the loopback canary was never reached — the opt-in case proved nothing')
    lines.push('[test] FAIL loopback canary never reached')
  }

  const missing = expected.filter(e => !lines.some(l => l.includes(e)))
  const failures = lines.filter(l => l.includes('[test] FAIL'))

  console.log('')
  if (!missing.length && !failures.length) {
    console.log(`e2e: PASS (${expected.length} assertions${tunnel ? '' : ', 2 skipped cases'})`)
    process.exit(0)
  }
  for (const f of failures) console.error(`e2e: ${f}`)
  for (const m of missing) console.error(`e2e: MISSING ${m}`)
  console.error('e2e: FAIL — last 40 lines:')
  for (const l of lines.slice(-40)) console.error(`  ${l}`)
  process.exit(1)
}

async function firefoxBinary () {
  // Point at any build already in .cache/firefox to run the same suite
  // against another version without disturbing the one npm start uses.
  if (process.env.FIREFOX_BINARY) return process.env.FIREFOX_BINARY
  const current = join(root, '.cache', 'firefox', 'current.json')
  try {
    return JSON.parse(await readFile(current, 'utf8')).binary
  } catch {
    console.log('e2e: no local firefox yet, running setup')
    const setup = spawnSync(process.execPath, [join(root, 'tools', 'get-firefox.mjs')], { stdio: 'inherit' })
    if (setup.status !== 0) throw new Error('setup failed')
    return JSON.parse(await readFile(current, 'utf8')).binary
  }
}

// BULKHEAD_E2E_TUNNEL states what the environment is, rather than asking a
// third party. CI sets 0 because a runner has no Mullvad tunnel. Setting it
// wrongly does not weaken the run -- the assertions for the other state
// simply will not hold and the run fails -- so do not set it on a machine
// where the tunnel might be up.
async function detectTunnel () {
  if (process.env.BULKHEAD_E2E_TUNNEL === '0') return false
  if (process.env.BULKHEAD_E2E_TUNNEL === '1') return true
  try {
    const res = await fetch('https://am.i.mullvad.net/json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return false
    const j = await res.json()
    return j.mullvad_exit_ip === true
  } catch {
    return false
  }
}
