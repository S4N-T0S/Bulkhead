'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { decide, isProbeUrl, isLoopbackUrl, probeTraversed, usableProxy, R, PROBE_URL } = require('../../src/decide.js')

const TOKEN = 'c0ffee00c0ffee00c0ffee00c0ffee00'
const PROBE = `${PROBE_URL}?bkh_probe=${TOKEN}`

const UP = { ip: '10.124.0.20', port: 1080, host: 'se-got-wg-001', socksHost: 'se-got-wg-socks5-001', health: 'up' }
const DOWN = { ...UP, health: 'down' }
const UNKNOWN = { ...UP, health: 'unknown' }
const MISROUTED = { ...UP, health: 'misrouted' }
const CUSTOM_UP = { ip: '127.0.0.1', port: 1080, host: 'custom:ab12cd34ef56', socksHost: '', custom: true, label: 'ssh box', health: 'up' }
const CUSTOM_DOWN = { ...CUSTOM_UP, health: 'down' }

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
  // R.SPECULATIVE is deliberately absent: it is only ever a block reason,
  // and listing it here would let a speculative allow through unnoticed.
  const allowed = new Set([R.PROBE, R.UNMANAGED, R.OK, R.UNATTRIBUTED, R.LOOPBACK])
  // Asserting isLoopbackUrl(url) would only ask the mutated function the
  // question it just answered; the sweep has to hold its own list.
  const LOOPBACK_URLS = new Set(['http://127.0.0.1:8080/callback'])
  for (const ready of [true, false]) {
    for (const strict of [true, false]) {
      for (const allowLocal of [true, false]) {
        for (const c of [UP, DOWN, UNKNOWN, MISROUTED, CUSTOM_UP, CUSTOM_DOWN, undefined]) {
          for (const id of ['firefox-container-1', 'firefox-default', undefined]) {
            for (const type of ['main_frame', 'speculative', 'script']) {
              for (const url of [
                'https://example.com/',
                PROBE,
                `${PROBE_URL}?bkh_probe=${'d'.repeat(32)}`,
                'http://127.0.0.1:8080/callback',
                'http://evil.com.localhost/'
              ]) {
                const s = {
                  ready,
                  strict,
                  allowLocal,
                  containers: c ? { 'firefox-container-1': c } : {},
                  probeTokens: new Set([TOKEN])
                }
                const out = decide(s, { url, cookieStoreId: id, type })
                if (out.verdict === 'allow') {
                  assert.ok(allowed.has(out.reason), `allow via unexpected reason ${out.reason}`)
                  if (out.reason === R.PROBE) {
                    assert.equal(url, PROBE, 'probe reason on a non-probe url')
                  }
                  if (out.reason === R.LOOPBACK) {
                    assert.ok(allowLocal === true, 'loopback allowed without the opt-in')
                    assert.ok(LOOPBACK_URLS.has(url), `loopback reason on ${url}`)
                    assert.ok(ready, 'loopback allowed before hydration')
                  }
                  // A managed container that is not up may be allowed only
                  // by one of the two rules that outrank its health, and
                  // only for the URL that rule is about.
                  if (id === 'firefox-container-1' && c && c.health !== 'up' && ready) {
                    const excused = (out.reason === R.PROBE && url === PROBE)
                      || (out.reason === R.LOOPBACK && LOOPBACK_URLS.has(url))
                    assert.ok(excused, `allowed a non-up container via ${out.reason} on ${url}`)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
})

test('loopback is blocked like anything else until the user opts in', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  const r = rq({ url: 'http://127.0.0.1:8888/callback' })
  assert.equal(verdict(s, r), 'block')
  assert.equal(reason(s, r), R.PROXY_DOWN)
})

test('opted-in loopback passes every blocking state -- and only loopback', () => {
  for (const c of [DOWN, UNKNOWN, MISROUTED, { ...UP, ip: '' }]) {
    const s = st({ allowLocal: true, containers: { 'firefox-container-1': c } })
    assert.equal(verdict(s, rq({ url: 'http://127.0.0.1:8888/x' })), 'allow')
    assert.equal(reason(s, rq({ url: 'http://localhost/x' })), R.LOOPBACK)
    // the hole is loopback-shaped; the same container stays shut otherwise
    assert.equal(verdict(s, rq()), 'block')
  }
  // strict-mode refusals open for loopback too -- wherever the request came
  // from, its destination is this machine
  const s = st({ allowLocal: true })
  assert.equal(verdict(s, rq({ url: 'http://[::1]:9000/', cookieStoreId: '' })), 'allow')
  assert.equal(verdict(s, rq({ url: 'http://127.0.0.1/', type: 'speculative' })), 'allow')
})

test('the loopback toggle is not honoured before hydration', () => {
  const s = st({ ready: false, allowLocal: true })
  assert.equal(verdict(s, rq({ url: 'http://127.0.0.1/' })), 'block')
  assert.equal(reason(s, rq({ url: 'http://127.0.0.1/' })), R.NOT_READY)
})

test('isLoopbackUrl draws the line at real loopback', () => {
  for (const url of [
    'http://localhost/', 'http://localhost:3000/cb',
    'http://localhost./', 'http://127.0.0.1/', 'http://127.1.2.3:9999/',
    'http://127.1/', // the URL parser canonicalises IPv4 shorthand
    'http://0177.0.0.1/', 'http://2130706433/',
    'http://[::1]:8443/', 'http://[0:0:0:0:0:0:0:1]/'
  ]) {
    assert.equal(isLoopbackUrl(url), true, url)
  }
  for (const url of [
    'http://localhost.evil.com/', 'http://mylocalhost/', 'http://evil-localhost/',
    // *.localhost only stays on-machine while network.dns.offline-localhost
    // is at its default, and no API can read that
    'https://app.localhost/x', 'http://evil.com.localhost/',
    // userinfo is not the host, however much it looks like one
    'http://localhost@evil.com/', 'http://127.0.0.1@evil.com/',
    'http://128.0.0.1/', 'http://126.255.255.255/', 'http://10.0.0.1/',
    'http://192.168.1.1/', 'http://[::2]/', 'http://[::ffff:127.0.0.1]/',
    'http://127.0.0.1.evil.com/', 'not a url', ''
  ]) {
    assert.equal(isLoopbackUrl(url), false, url)
  }
})

test('a custom exit rides the same health rules as a relay', () => {
  const s = st({ containers: { 'firefox-container-1': CUSTOM_UP } })
  assert.equal(verdict(s, rq()), 'allow')
  for (const health of ['down', 'unknown', 'misrouted']) {
    const blocked = st({ containers: { 'firefox-container-1': { ...CUSTOM_UP, health } } })
    assert.equal(verdict(blocked, rq()), 'block', health)
  }
})

test('a probe only counts when it travelled through the assigned server', () => {
  // Reachability is not proof: a refused SOCKS connection fails over, and
  // that failover answers 200 from the user's own address.
  const c = { ip: '10.124.0.20', port: 1080, host: 'se-got-wg-001', socksHost: 's', health: 'up' }
  assert.equal(probeTraversed({ host: '10.124.0.20', port: 1080 }, c), true)
  // went direct -- Firefox attaches no proxyInfo at all
  assert.equal(probeTraversed(null, c), false)
  assert.equal(probeTraversed(undefined, c), false)
  assert.equal(probeTraversed({}, c), false)
  // answered, but through something else
  assert.equal(probeTraversed({ host: '10.124.0.99', port: 1080 }, c), false)
  assert.equal(probeTraversed({ host: '10.124.0.20', port: 9050 }, c), false)
  assert.equal(probeTraversed({ host: '10.124.0.20', port: 1080 }, undefined), false)
  // a custom exit may carry a name, and Firefox echoes it back as it likes
  const named = { ip: 'Tunnel.Local', port: 9050, host: 'custom:x', socksHost: '', custom: true }
  assert.equal(probeTraversed({ host: 'tunnel.local', port: 9050 }, named), true)
  // the default port is implied on both sides or neither
  const noPort = { ip: '127.0.0.1', port: 1080, host: 'custom:y', socksHost: '', custom: true }
  assert.equal(probeTraversed({ host: '127.0.0.1', port: 1080 }, noPort), true)
})
