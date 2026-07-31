'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { decide, isProbeUrl, usableProxy, R, PROBE_URL } = require('../../src/decide.js')

const TOKEN = 'c0ffee00c0ffee00c0ffee00c0ffee00'
const PROBE = `${PROBE_URL}?bkh_probe=${TOKEN}`

const UP = { ip: '10.124.0.20', port: 1080, host: 'se-got-wg-001', socksHost: 'se-got-wg-socks5-001', health: 'up' }
const DOWN = { ...UP, health: 'down' }
const UNKNOWN = { ...UP, health: 'unknown' }
const MISROUTED = { ...UP, health: 'misrouted' }

function st (over = {}) {
  return {
    ready: true,
    strict: true,
    containers: { 'firefox-container-1': UP },
    probeTokens: new Set([TOKEN]),
    ...over
  }
}

function rq (over = {}) {
  return {
    url: 'https://example.com/',
    cookieStoreId: 'firefox-container-1',
    type: 'main_frame',
    ...over
  }
}

const verdict = (s, r) => decide(s, r).verdict
const reason = (s, r) => decide(s, r).reason

test('the probe passes even when the container is down', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  const r = rq({ url: PROBE })
  assert.equal(verdict(s, r), 'allow')
  assert.equal(reason(s, r), R.PROBE)
})

test('the probe passes before hydration', () => {
  const s = st({ ready: false })
  assert.equal(verdict(s, rq({ url: PROBE })), 'allow')
})

test('a forged token is not a probe', () => {
  // Any web page can paste the marker into a URL. Only a token this session
  // issued and still holds may open the gate.
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  const forged = `${PROBE_URL}?bkh_probe=${'d'.repeat(32)}`
  assert.equal(verdict(s, rq({ url: forged })), 'block')
  assert.equal(reason(s, rq({ url: forged })), R.PROXY_DOWN)
})

test('a live token aimed anywhere but the probe endpoint is not a probe', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  const r = rq({ url: `https://evil.test/json?bkh_probe=${TOKEN}` })
  assert.equal(verdict(s, r), 'block')
})

test('a forged token gives no shortcut in relaxed mode either', () => {
  const s = st({ strict: false, containers: {} })
  const r = rq({ url: `https://example.com/?bkh_probe=${'d'.repeat(32)}`, cookieStoreId: 'firefox-default' })
  assert.equal(verdict(s, r), 'allow')
  assert.equal(reason(s, r), R.UNMANAGED)
})

test('probe lookalikes in a path or fragment do not parse as tokens', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  for (const url of [
    `https://evil.test/bkh_probe=${TOKEN}`,
    `https://evil.test/#bkh_probe=${TOKEN}`,
    `https://evil.test/?x=bkh_probe=${TOKEN}y`,
    'https://evil.test/?bkh_probe=short'
  ]) {
    assert.equal(verdict(s, rq({ url })), 'block', url)
  }
})

test('blocks everything before storage is hydrated', () => {
  const s = st({ ready: false })
  assert.equal(verdict(s, rq()), 'block')
  assert.equal(reason(s, rq()), R.NOT_READY)
})

test('blocks unmanaged containers too before hydration', () => {
  // Pre-hydration nothing is known about which containers are managed, so
  // the unmanaged-allow shortcut must not apply yet.
  const s = st({ ready: false, containers: {} })
  assert.equal(verdict(s, rq({ cookieStoreId: 'firefox-default' })), 'block')
})

test('blocks speculative requests in strict mode', () => {
  assert.equal(verdict(st(), rq({ type: 'speculative' })), 'block')
  assert.equal(reason(st(), rq({ type: 'speculative' })), R.SPECULATIVE)
})

test('allows speculative requests when strict is off', () => {
  assert.equal(verdict(st({ strict: false }), rq({ type: 'speculative' })), 'allow')
})

test('blocks unattributable requests in strict mode', () => {
  for (const id of [undefined, null, '']) {
    assert.equal(verdict(st(), rq({ cookieStoreId: id })), 'block', String(id))
    assert.equal(reason(st(), rq({ cookieStoreId: id })), R.UNATTRIBUTED)
  }
})

test('allows unattributable requests when strict is off', () => {
  assert.equal(verdict(st({ strict: false }), rq({ cookieStoreId: undefined })), 'allow')
})

test('allows unmanaged containers', () => {
  const r = rq({ cookieStoreId: 'firefox-default' })
  assert.equal(verdict(st(), r), 'allow')
  assert.equal(reason(st(), r), R.UNMANAGED)
})

test('the default and private contexts are gated like any container', () => {
  // both can be pointed at a proxy; firefox-default also covers the
  // extension's own requests, and firefox-private is the one context that
  // would otherwise always go direct
  for (const id of ['firefox-default', 'firefox-private']) {
    const r = rq({ cookieStoreId: id })
    const down = st({ containers: { [id]: DOWN } })
    assert.equal(verdict(down, r), 'block', id)
    assert.equal(reason(down, r), R.PROXY_DOWN, id)
    assert.equal(reason(st({ containers: { [id]: UNKNOWN } }), r), R.NOT_VERIFIED, id)
    assert.equal(verdict(st({ containers: { [id]: UP } }), r), 'allow', id)
    // unmanaged, it browses normally, exactly like any other container
    assert.equal(reason(st({ containers: {} }), r), R.UNMANAGED, id)
  }
})

test('a container id that is a prototype key cannot reach a config', () => {
  const s = st({ containers: Object.assign(Object.create(null), { 'firefox-container-1': UP }) })
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const out = decide(s, rq({ cookieStoreId: id }))
    assert.equal(out.verdict, 'allow', id)
    assert.equal(out.reason, R.UNMANAGED, id)
  }
})

test('allows everything when no container is managed', () => {
  assert.equal(verdict(st({ containers: {} }), rq()), 'allow')
})

test('allows a managed container whose proxy is up', () => {
  assert.equal(verdict(st(), rq()), 'allow')
  assert.equal(reason(st(), rq()), R.OK)
})

test('blocks when the proxy is down', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  assert.equal(verdict(s, rq()), 'block')
  assert.equal(reason(s, rq()), R.PROXY_DOWN)
})

test('blocks while health is still unknown, under its own reason', () => {
  // A freshly started browser must not pass traffic over an unverified
  // proxy -- but it has not failed either, and saying so would be a lie
  // told on every restart.
  const s = st({ containers: { 'firefox-container-1': UNKNOWN } })
  assert.equal(verdict(s, rq()), 'block')
  assert.equal(reason(s, rq()), R.NOT_VERIFIED)
  assert.notEqual(reason(s, rq()), R.PROXY_DOWN)
})

test('blocks when the proxy answers from the wrong exit', () => {
  const s = st({ containers: { 'firefox-container-1': MISROUTED } })
  assert.equal(verdict(s, rq()), 'block')
  assert.equal(reason(s, rq()), R.MISROUTED)
})

test('blocks a managed container with no usable proxy config', () => {
  const bad = [
    { health: 'up' },
    { ip: '10.124.0.20', health: 'up' },
    { port: 1080, health: 'up' },
    // a port Firefox cannot turn into a ProxyInfo: the router would throw
    // and Firefox answers an invalid ProxyInfo with a direct connection, so
    // the gate has to reject exactly what the router rejects
    { ip: '10.124.0.20', port: 70000, health: 'up' },
    { ip: '10.124.0.20', port: 0, health: 'up' },
    { ip: '10.124.0.20', port: '1080', health: 'up' },
    { ip: '10.124.0.20', port: 1080.5, health: 'up' }
  ]
  for (const c of bad) {
    const s = st({ containers: { 'firefox-container-1': c } })
    assert.equal(verdict(s, rq()), 'block', JSON.stringify(c))
    assert.equal(reason(s, rq()), R.NO_PROXY, JSON.stringify(c))
    assert.equal(usableProxy(c), false, JSON.stringify(c))
  }
  assert.equal(usableProxy({ ip: '10.124.0.20', port: 1080 }), true)
})

test('isProbeUrl matches the endpoint exactly, not by prefix', () => {
  assert.equal(isProbeUrl(PROBE_URL), true)
  assert.equal(isProbeUrl(`${PROBE_URL}?x=1`), true)
  for (const url of [
    'https://am.i.mullvad.net/jsonextra',
    'https://am.i.mullvad.net/json/../secret',
    'https://am.i.mullvad.net.evil.test/json',
    'https://evil.test@am.i.mullvad.net.evil.test/json',
    'http://am.i.mullvad.net/json',
    'https://am.i.mullvad.net:8443/json',
    'not a url',
    ''
  ]) {
    assert.equal(isProbeUrl(url), false, url)
  }
})

test('a probe token on a lookalike endpoint does not open the gate', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  for (const url of [
    `https://am.i.mullvad.net/jsonextra?bkh_probe=${TOKEN}`,
    `https://am.i.mullvad.net.evil.test/json?bkh_probe=${TOKEN}`
  ]) {
    assert.equal(verdict(s, rq({ url })), 'block', url)
  }
})

test('relaxing strict mode cannot re-open a container whose proxy is down', () => {
  // strict governs only the unattributable cases; the killswitch applies
  // regardless, or a convenience setting silently becomes a leak.
  const s = st({ strict: false, containers: { 'firefox-container-1': DOWN } })
  for (const type of ['main_frame', 'speculative', 'script', 'xmlhttprequest']) {
    assert.equal(verdict(s, rq({ type })), 'block', type)
  }
})

test('an unrecognised health value blocks rather than allows', () => {
  // Guards a future health state against defaulting open.
  const s = st({ containers: { 'firefox-container-1': { ...UP, health: 'weird' } } })
  assert.equal(verdict(s, rq()), 'block')
})

test('no request type slips through on a down proxy', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  const types = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
    'beacon', 'speculative', 'other'
  ]
  for (const type of types) {
    assert.equal(verdict(s, rq({ type })), 'block', type)
  }
})

test('the only allow paths are probe, unmanaged, confirmed-up and relaxed-mode passthroughs', () => {
  // Exhaustive sweep: anything that returns allow must carry an expected
  // reason, and a managed container that is not up must never be allowed.
  // Catches a new branch accidentally defaulting open.
  const allowed = new Set([R.PROBE, R.UNMANAGED, R.OK, R.SPECULATIVE, R.UNATTRIBUTED])
  for (const ready of [true, false]) {
    for (const strict of [true, false]) {
      for (const c of [UP, DOWN, UNKNOWN, MISROUTED, undefined]) {
        for (const id of ['firefox-container-1', 'firefox-default', undefined]) {
          for (const type of ['main_frame', 'speculative', 'script']) {
            for (const url of ['https://example.com/', PROBE, `${PROBE_URL}?bkh_probe=${'d'.repeat(32)}`]) {
              const s = {
                ready,
                strict,
                containers: c ? { 'firefox-container-1': c } : {},
                probeTokens: new Set([TOKEN])
              }
              const out = decide(s, { url, cookieStoreId: id, type })
              if (out.verdict === 'allow') {
                assert.ok(allowed.has(out.reason), `allow via unexpected reason ${out.reason}`)
                if (out.reason === R.PROBE) {
                  assert.equal(url, PROBE, 'probe reason on a non-probe url')
                }
                if (id === 'firefox-container-1' && c && c.health !== 'up' && ready && url !== PROBE) {
                  assert.notEqual(out.reason, R.OK)
                }
              }
            }
          }
        }
      }
    }
  }
})
