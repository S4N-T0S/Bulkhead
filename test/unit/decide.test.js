'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { decide, isProbeUrl, isLoopbackUrl, neverProxied, probeTraversed, routedThrough, usableProxy, R, PROBE_URL } = require('../../src/decide.js')

const TOKEN = 'c0ffee00c0ffee00c0ffee00c0ffee00'
const PROBE = `${PROBE_URL}?bkh_probe=${TOKEN}`

const UP = { ip: '10.124.0.20', port: 1080, host: 'se-got-wg-001', socksHost: 'se-got-wg-socks5-001', health: 'up' }
const DOWN = { ...UP, health: 'down' }
const UNKNOWN = { ...UP, health: 'unknown' }
const MISROUTED = { ...UP, health: 'misrouted' }
const TAKEN = { ...UP, health: 'taken' }
const CUSTOM_UP = { ip: '127.0.0.1', port: 1080, host: 'custom:ab12cd34ef56', socksHost: '', custom: true, label: 'ssh box', health: 'up' }
const CUSTOM_DOWN = { ...CUSTOM_UP, health: 'down' }
// what Firefox reports for a request on UP's exit as the router built it,
// and on someone else's
/** @param {{ ip: string, port: number }} c @param {string} [id] */
const routeOf = (c, id = 'firefox-container-1') => ({ type: 'socks', host: c.ip, port: c.port, proxyDNS: true, connectionIsolationKey: id })
const ROUTE = routeOf(UP)
const FOREIGN = { type: 'socks', host: '127.0.0.1', port: 9050, proxyDNS: true }

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
    proxyInfo: ROUTE,
    ...over
  }
}

const verdict = (s, r) => decide(s, r).verdict
const reason = (s, r) => decide(s, r).reason

// a live probe for container 1, on that container's own route
const probeReq = (over = {}) => rq({ url: PROBE, cookieStoreId: 'firefox-default', probeFor: 'firefox-container-1', ...over })

test('the probe passes even when the container is down', () => {
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  assert.equal(verdict(s, probeReq()), 'allow')
  assert.equal(reason(s, probeReq()), R.PROBE)
})

test('the probe passes before hydration', () => {
  const s = st({ ready: false })
  assert.equal(verdict(s, probeReq()), 'allow')
})

test('a probe off its own route is stopped, not let through', () => {
  // routed by token rather than by container, so another proxy that grabs
  // tab-less requests would otherwise carry, or strip, the check itself
  const s = st({ containers: { 'firefox-container-1': DOWN } })
  for (const proxyInfo of [FOREIGN, null, { ...ROUTE, connectionIsolationKey: 'firefox-default' }, { ...ROUTE, proxyDNS: false }]) {
    assert.equal(reason(s, probeReq({ proxyInfo })), R.REROUTED, JSON.stringify(proxyInfo))
  }
  // a probe whose target is gone, or never named, checks nothing
  assert.equal(verdict(s, probeReq({ probeFor: 'firefox-container-9' })), 'block')
  assert.equal(verdict(s, probeReq({ probeFor: undefined })), 'block')
  assert.equal(verdict(s, probeReq({ probeFor: '__proto__' })), 'block')
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
    const r = rq({ cookieStoreId: id, proxyInfo: routeOf(UP, id) })
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
  // and its own list of what Firefox sends with no proxy at all
  const UNPROXIED_URLS = new Set(['http://127.0.0.1:8080/callback', 'http://evil.com.localhost/'])
  for (const ready of [true, false]) {
    for (const strict of [true, false]) {
      for (const allowLocal of [true, false]) {
        for (const c of [UP, DOWN, UNKNOWN, MISROUTED, TAKEN, CUSTOM_UP, CUSTOM_DOWN, undefined]) {
          for (const id of ['firefox-container-1', 'firefox-default', undefined]) {
            for (const type of ['main_frame', 'speculative', 'script']) {
              for (const url of [
                'https://example.com/',
                PROBE,
                `${PROBE_URL}?bkh_probe=${'d'.repeat(32)}`,
                'http://127.0.0.1:8080/callback',
                'http://evil.com.localhost/'
              ]) {
                for (const route of ['own', 'foreign', 'none', 'stripped', 'otherType', 'otherHost', 'otherPort', 'noKey', 'localDns']) {
                  // when Firefox stamped the request, against the router's call
                  for (const [timeStamp, routedAt] of [[undefined, undefined], [999, 1000], [1000, 1000], [1001, 1000], [1001, Infinity]]) {
                    const s = {
                      ready,
                      strict,
                      allowLocal,
                      containers: c ? { 'firefox-container-1': c } : {},
                      probeTokens: new Set([TOKEN])
                    }
                    const own = c ? routeOf(c) : ROUTE
                    const proxyInfo = {
                      own,
                      foreign: FOREIGN,
                      none: null,
                      stripped: null,
                      otherType: { ...own, type: 'http' },
                      otherHost: { ...own, host: '10.9.9.9' },
                      otherPort: { ...own, port: own.port + 1 },
                      noKey: { ...own, connectionIsolationKey: undefined },
                      localDns: { ...own, proxyDNS: false }
                    }[route]
                    const routed = route !== 'none'
                    const out = decide(s, {
                      url, cookieStoreId: id, type, proxyInfo, routed, timeStamp, routedAt: routed ? routedAt : undefined, probeFor: 'firefox-container-1'
                    })
                    // only ever a block, on a bare, routed subresource stamped
                    // no later than its route
                    if (out.reason === R.PRE_ROUTE) {
                      assert.equal(out.verdict, 'block', 'pre-route allowed')
                      assert.ok(routed && proxyInfo === null && type !== 'main_frame', `pre-route on ${type} via ${route}`)
                      assert.ok(timeStamp !== undefined && routedAt !== undefined && timeStamp <= routedAt, `pre-route at ${timeStamp}/${routedAt}`)
                    }
                    // a page taken off its route raises the alarm, whenever it was stamped
                    if (id === 'firefox-container-1' && c && c.health === 'up' && ready && type === 'main_frame' && route !== 'own' && route !== 'none'
                      && !(route === 'stripped' && UNPROXIED_URLS.has(url))) {
                      assert.equal(out.reason, R.REROUTED, `page on route ${route} to ${url} at ${timeStamp}`)
                    }
                    if (out.verdict === 'allow') {
                      assert.ok(allowed.has(out.reason), `allow via unexpected reason ${out.reason}`)
                      if (out.reason === R.PROBE) {
                        assert.equal(url, PROBE, 'probe reason on a non-probe url')
                        assert.ok(c && route === 'own', `probe allowed on route ${route}`)
                      }
                      if (out.reason === R.LOOPBACK) {
                        assert.ok(allowLocal === true, 'loopback allowed without the opt-in')
                        assert.ok(LOOPBACK_URLS.has(url), `loopback reason on ${url}`)
                        assert.ok(ready, 'loopback allowed before hydration')
                        if (id === 'firefox-container-1' && c) assert.equal(proxyInfo, null, 'managed loopback allowed with a proxy on it')
                      }
                      // A managed container that is not up may be allowed only
                      // by one of the two rules that outrank its health, and
                      // only for the URL that rule is about.
                      if (id === 'firefox-container-1' && c && c.health !== 'up' && ready) {
                        const excused = (out.reason === R.PROBE && url === PROBE)
                          || (out.reason === R.LOOPBACK && LOOPBACK_URLS.has(url))
                        assert.ok(excused, `allowed a non-up container via ${out.reason} on ${url}`)
                      }
                      // A managed container, once hydrated, lets a request through
                      // on exactly three grounds: the live probe, opted-in
                      // loopback with no proxy, or its own route -- which a
                      // bare request only matches when the router never routed
                      // it, or when it is bound for a name Firefox never
                      // proxies.
                      if (id === 'firefox-container-1' && c && ready) {
                        const onRoute = route === 'own' || route === 'none' || (route === 'stripped' && UNPROXIED_URLS.has(url))
                        const fine = (out.reason === R.PROBE && url === PROBE)
                          || (out.reason === R.LOOPBACK && LOOPBACK_URLS.has(url) && proxyInfo === null)
                          || (out.reason === R.OK && onRoute)
                        assert.ok(fine, `managed request allowed via ${out.reason} on route ${route} to ${url}`)
                      }
                    }
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
  // the router strips any proxy from opted-in loopback, so it arrives bare
  const lo = { proxyInfo: null }
  for (const c of [DOWN, UNKNOWN, MISROUTED, { ...UP, ip: '' }]) {
    const s = st({ allowLocal: true, containers: { 'firefox-container-1': c } })
    assert.equal(verdict(s, rq({ ...lo, url: 'http://127.0.0.1:8888/x' })), 'allow')
    assert.equal(reason(s, rq({ ...lo, url: 'http://localhost/x' })), R.LOOPBACK)
    // the hole is loopback-shaped; the same container stays shut otherwise
    assert.equal(verdict(s, rq()), 'block')
    // and a proxy someone else put back on a sign-in callback is no hole
    assert.equal(verdict(s, rq({ url: 'http://127.0.0.1:8888/x', proxyInfo: FOREIGN })), 'block')
  }
  // strict-mode refusals open for loopback too -- wherever the request came
  // from, its destination is this machine
  const s = st({ allowLocal: true })
  assert.equal(verdict(s, rq({ ...lo, url: 'http://[::1]:9000/', cookieStoreId: '' })), 'allow')
  assert.equal(verdict(s, rq({ ...lo, url: 'http://127.0.0.1/', type: 'speculative' })), 'allow')
})

test('outside a managed container, a proxy on opted-in loopback is not Bulkhead\'s call', () => {
  // the router leaves it alone there, so a mitmproxy on localhost keeps working
  const s = st({ allowLocal: true })
  for (const cookieStoreId of ['firefox-container-2', 'firefox-default', '']) {
    assert.equal(reason(s, rq({ url: 'http://127.0.0.1:8080/', cookieStoreId, proxyInfo: FOREIGN })), R.LOOPBACK, cookieStoreId)
    assert.equal(reason(s, rq({ url: 'http://localhost/', cookieStoreId, proxyInfo: FOREIGN, type: 'speculative' })), R.LOOPBACK, cookieStoreId)
  }
  assert.equal(reason(s, rq({ url: 'http://127.0.0.1:8080/', proxyInfo: FOREIGN })), R.REROUTED)
})

test('a check another proxy took blocks the container under its own reason', () => {
  const s = st({ containers: { 'firefox-container-1': TAKEN } })
  for (const route of [ROUTE, FOREIGN, null]) {
    assert.equal(reason(s, rq({ proxyInfo: route, routed: true })), R.CHECK_TAKEN)
  }
  // and the next check still gets through on its own route, so it can clear
  assert.equal(reason(s, probeReq()), R.PROBE)
  assert.equal(reason(s, probeReq({ proxyInfo: FOREIGN })), R.REROUTED)
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
  const r = rq({ proxyInfo: routeOf(CUSTOM_UP) })
  assert.equal(verdict(s, r), 'allow')
  for (const health of ['down', 'unknown', 'misrouted']) {
    const blocked = st({ containers: { 'firefox-container-1': { ...CUSTOM_UP, health } } })
    assert.equal(verdict(blocked, r), 'block', health)
  }
})

test('a verified exit does not pass a request another proxy took over', () => {
  // a later listener's own proxy
  for (const proxyInfo of [
    FOREIGN,
    { type: 'direct' },
    { ...ROUTE, port: 1081 },
    { ...ROUTE, host: '10.124.0.21' },
    { ...ROUTE, type: 'http' },
    { host: UP.ip, port: UP.port },
    // the right server, answered by someone else: names would resolve
    // locally, or the connection would not be the container's own
    { ...ROUTE, proxyDNS: false },
    { ...ROUTE, proxyDNS: undefined },
    { ...ROUTE, connectionIsolationKey: 'firefox-container-2' },
    { ...ROUTE, connectionIsolationKey: undefined }
  ]) {
    const out = decide(st(), rq({ proxyInfo }))
    assert.equal(out.verdict, 'block', JSON.stringify(proxyInfo))
    assert.equal(out.reason, R.REROUTED, JSON.stringify(proxyInfo))
  }
  // the router gave it an exit and something took the proxy away: direct
  for (const proxyInfo of [null, undefined]) {
    assert.equal(reason(st(), rq({ proxyInfo, routed: true })), R.REROUTED, String(proxyInfo))
  }
  assert.equal(reason(st(), rq()), R.OK)
})

test('no route on a request the router never routed is not a strip', () => {
  // cache-only loads never get a route, so a bare one is not a strip
  for (const routed of [false, undefined]) {
    assert.equal(reason(st(), rq({ proxyInfo: null, routed })), R.OK, String(routed))
  }
  // which says nothing for a route someone else put there
  assert.equal(reason(st(), rq({ proxyInfo: FOREIGN, routed: false })), R.REROUTED)
})

test('a tracker Firefox cancelled before routing it is blocked without the alarm', () => {
  // tracking protection reports its cancels before proxy resolution, then the
  // router runs anyway
  const bare = { proxyInfo: null, routed: true, routedAt: 1000 }
  for (const type of ['xmlhttprequest', 'script', 'image', 'sub_frame', 'beacon', 'ping', 'websocket']) {
    for (const timeStamp of [990, 999, 1000]) {
      assert.deepEqual(decide(st(), rq({ ...bare, type, timeStamp })), { verdict: 'block', reason: R.PRE_ROUTE }, `${type} at ${timeStamp}`)
    }
    // a strip comes after the router
    assert.deepEqual(decide(st(), rq({ ...bare, type, timeStamp: 1001 })), { verdict: 'block', reason: R.REROUTED }, type)
    // a hop whose route is used up, or a websocket not routed for its channel yet
    assert.deepEqual(decide(st(), rq({ ...bare, type, routedAt: Infinity, timeStamp: 5000 })), { verdict: 'block', reason: R.PRE_ROUTE }, type)
    // Firefox may leave proxyInfo out rather than null it
    assert.equal(reason(st(), rq({ ...bare, type, proxyInfo: undefined, timeStamp: 999 })), R.PRE_ROUTE, type)
  }
  // tracking protection never blocks the page itself
  for (const timeStamp of [999, 1000, 1001]) {
    assert.equal(reason(st(), rq({ ...bare, timeStamp })), R.REROUTED, String(timeStamp))
  }
  assert.equal(reason(st(), rq({ ...bare, routedAt: Infinity, timeStamp: 999 })), R.REROUTED)
  // without both times there is nothing to tell it from a strip
  for (const times of [
    { timeStamp: 999, routedAt: undefined }, { timeStamp: undefined }, { timeStamp: NaN }, { routedAt: NaN, timeStamp: 999 },
    { timeStamp: null }, { timeStamp: '999' }, { routedAt: null, timeStamp: -1 }, { routedAt: '1000', timeStamp: 999 }
  ]) {
    assert.equal(reason(st(), rq({ ...bare, type: 'script', ...times })), R.REROUTED, JSON.stringify(times))
  }
  // a proxy someone else put there is a takeover whenever it was stamped
  for (const proxyInfo of [FOREIGN, { type: 'direct' }, { ...ROUTE, proxyDNS: false }]) {
    assert.equal(reason(st(), rq({ ...bare, proxyInfo, type: 'script', timeStamp: 999 })), R.REROUTED, JSON.stringify(proxyInfo))
  }
  // and the rules above the route check still come first
  assert.equal(reason(st({ containers: { 'firefox-container-1': DOWN } }), rq({ ...bare, type: 'script', timeStamp: 999 })), R.PROXY_DOWN)
  assert.equal(reason(st(), rq({ ...bare, url: 'http://app.localhost/', type: 'script', timeStamp: 999 })), R.OK)
  assert.equal(reason(st(), rq({ proxyInfo: null, routed: false, type: 'script', timeStamp: 999 })), R.OK)
})

test('a failed exit is reported as failed, whatever the route', () => {
  for (const [c, why] of [[DOWN, R.PROXY_DOWN], [UNKNOWN, R.NOT_VERIFIED], [MISROUTED, R.MISROUTED]]) {
    const s = st({ containers: { 'firefox-container-1': c } })
    for (const proxyInfo of [ROUTE, FOREIGN, null]) {
      assert.equal(reason(s, rq({ proxyInfo })), why, `${c.health} ${JSON.stringify(proxyInfo)}`)
    }
  }
})

test('the route check is about managed containers only', () => {
  // someone else's proxy in a container Bulkhead does not manage is that
  // extension's business, and a probe is routed by token, not by container
  assert.equal(reason(st(), rq({ cookieStoreId: 'firefox-container-2', proxyInfo: FOREIGN })), R.UNMANAGED)
  assert.equal(reason(st(), probeReq()), R.PROBE)
})

test('names Firefox never proxies are not mistaken for a takeover', () => {
  // these arrive with no proxy under default prefs; blocking them breaks
  // local dev servers and sign-in callbacks
  for (const url of [
    'http://127.0.0.1:8080/', 'http://localhost:3000/', 'http://[::1]/',
    'http://app.localhost/', 'http://a.b.localhost:8443/x', 'http://app.localhost./'
  ]) {
    assert.equal(reason(st(), rq({ url, proxyInfo: null, routed: true })), R.OK, url)
    // the exemption covers a missing route, never someone else's
    assert.equal(reason(st(), rq({ url, proxyInfo: FOREIGN })), R.REROUTED, url)
  }
  for (const url of ['http://localhost.evil.com/', 'http://127.0.0.1.evil.com/', 'http://example.com/']) {
    assert.equal(reason(st(), rq({ url, proxyInfo: null, routed: true })), R.REROUTED, url)
  }
})

test('neverProxied stops at the names Firefox itself keeps local', () => {
  for (const url of ['http://localhost/', 'http://127.4.5.6/', 'http://[::1]:80/', 'http://x.localhost/', 'http://X.LOCALHOST/', 'http://x.localhost./']) {
    assert.equal(neverProxied(url), true, url)
  }
  for (const url of ['http://localhost.example/', 'http://xlocalhost/', 'http://10.0.0.1/', 'http://[::2]/', 'not a url', '']) {
    assert.equal(neverProxied(url), false, url)
  }
})

test('routedThrough wants the exit itself, as the router built it', () => {
  assert.equal(routedThrough(ROUTE, UP, 'firefox-container-1'), true)
  const named = { ...CUSTOM_UP, ip: 'Proxy.Example' }
  assert.equal(routedThrough({ ...routeOf(named), host: 'proxy.example' }, named, 'firefox-container-1'), true)
  for (const via of [
    null, undefined, {}, FOREIGN,
    { ...ROUTE, type: 'socks4' }, { ...ROUTE, type: 'direct' },
    { ...ROUTE, proxyDNS: false }, { ...ROUTE, connectionIsolationKey: '' }
  ]) {
    assert.equal(routedThrough(via, UP, 'firefox-container-1'), false, JSON.stringify(via))
  }
  // the key is per container: one container's route is not another's
  assert.equal(routedThrough(ROUTE, UP, 'firefox-container-2'), false)
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
