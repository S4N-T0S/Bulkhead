// Manual diagnostic, not wired into npm test or CI: measures whether the
// request that discovers a dead proxy can escape to a direct connection.
// Pins the default context to a live relay, streams exit checks, drops the
// Mullvad tunnel mid-stream via the CLI, and counts what happens. Run it
// with the pref in both positions to see what the extension can and cannot
// close on its own:
//
//   node test/e2e/transition.mjs --failover-direct=true
//   node test/e2e/transition.mjs --failover-direct=true --failover-seconds=2 --duration=60000
//   node test/e2e/transition.mjs --failover-direct=false --failover-seconds=2 --duration=60000
//
// Needs the mullvad CLI and a logged-in app. The tunnel is restored to its
// starting state afterwards.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const buildDir = join(root, '.cache', 'transition-src')

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
}))
const failoverDirect = args.get('failover-direct') === 'true'
const failoverSeconds = Number(args.get('failover-seconds')) || 1
const durationMs = Number(args.get('duration')) || 150_000
const dropAfterMs = Number(args.get('drop-after')) || 15_000
const relay = args.get('relay') || 'se-got-wg-001'
// 'drop' pulls the tunnel mid-stream (the proxy black-holes); 'refused'
// points at a closed port so the proxy answers with RST, which is the
// failure mode that can actually reach Firefox's failover list.
const mode = args.get('mode') === 'refused' ? 'refused' : 'drop'

function mullvad (...cmd) {
  const r = spawnSync('mullvad', cmd, { encoding: 'utf8' })
  if (r.error) throw new Error(`mullvad CLI not available: ${r.error.message}`)
  return r.stdout + r.stderr
}

const initiallyConnected = /Connected/.test(mullvad('status'))
console.log(`transition: mode=${mode} failover_direct=${failoverDirect} failoverTimeout=${failoverSeconds}s duration=${durationMs}ms`)
console.log(`transition: tunnel initially ${initiallyConnected ? 'connected' : 'disconnected'}`)

if (!initiallyConnected) mullvad('connect')
await waitTunnel(true)

const firefox = JSON.parse(await readFile(join(root, '.cache', 'firefox', 'current.json'), 'utf8')).binary

await rm(buildDir, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })
await cp(join(root, 'src'), buildDir, { recursive: true })
await cp(join(root, 'test', 'e2e', 'transition-selftest.js'), join(buildDir, 'selftest.js'))
await writeFile(join(buildDir, 'test-config.js'),
  `globalThis.TEST_RELAY = ${JSON.stringify(relay)}\n`
  + `globalThis.TEST_DURATION_MS = ${durationMs}\n`
  + `globalThis.TEST_MODE = ${JSON.stringify(mode)}\n`)

// Overriding the shipped value is the point of the experiment: the two runs
// that matter differ only here.
const bg = join(buildDir, 'background.js')
const bgSrc = await readFile(bg, 'utf8')
const pattern = /const FAILOVER_SECONDS = \d+/
if (!pattern.test(bgSrc)) throw new Error('could not find FAILOVER_SECONDS to patch')
await writeFile(bg, bgSrc.replace(pattern, `const FAILOVER_SECONDS = ${failoverSeconds}`))

const manifestPath = join(buildDir, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.background.scripts = [...manifest.background.scripts, 'test-config.js', 'selftest.js']
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

const child = spawn(process.execPath, [
  join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
  'run',
  '--verbose',
  '--no-config-discovery',
  '--no-input',
  '--no-reload',
  `--source-dir=${buildDir}`,
  `--firefox=${firefox}`,
  '--pref=browser.dom.window.dump.enabled=true',
  '--pref=devtools.console.stdout.chrome=true',
  `--pref=network.proxy.failover_direct=${failoverDirect}`,
  '--pref=network.trr.mode=5'
], {
  cwd: root,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe']
})

/** @type {string[]} */
const lines = []
let finished = false
let dropped = false

function onChunk (chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue
    lines.push(line)
    if (line.includes('[t]') || line.includes('[bulkhead]')) console.log(line)
    if (line.includes('[t] up') && !dropped && mode === 'drop') {
      dropped = true
      setTimeout(() => {
        console.log(`transition: dropping tunnel (${dropAfterMs}ms after healthy stream started)`)
        mullvad('disconnect')
      }, dropAfterMs)
    }
    if (line.includes('[t] done')) finish()
  }
}
child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)

const timer = setTimeout(() => {
  console.error('transition: timed out')
  finish()
}, durationMs + 120_000)

child.on('exit', () => {
  if (!finished) finish()
})

function finish () {
  if (finished) return
  finished = true
  clearTimeout(timer)
  setTimeout(() => {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGINT')
      } catch {}
    }
    setTimeout(evaluate, 1000)
  }, 500)
}

async function evaluate () {
  try {
    if (initiallyConnected) {
      mullvad('connect')
      await waitTunnel(true)
    } else {
      mullvad('disconnect')
    }
    console.log(`transition: tunnel restored to ${initiallyConnected ? 'connected' : 'disconnected'}`)
  } catch (e) {
    console.error(`transition: could not restore tunnel state: ${e instanceof Error ? e.message : e}`)
  }

  const summary = lines.find(l => l.includes('[t] summary'))
  const leaks = lines.filter(l => l.includes('[t] LEAK'))
  console.log('')
  if (!summary) {
    console.error('transition: no summary line — run did not complete')
    process.exit(1)
  }
  if (leaks.length) {
    console.error(`transition: DIRECT FALLBACK OBSERVED (${leaks.length} canaries escaped)`)
    process.exit(1)
  }
  console.log('transition: no direct fallback observed')
  process.exit(0)
}

async function waitTunnel (up) {
  for (let i = 0; i < 60; i++) {
    if (/Connected/.test(mullvad('status')) === up) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`tunnel did not reach ${up ? 'connected' : 'disconnected'} state`)
}
