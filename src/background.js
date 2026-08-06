'use strict'
// Runtime wiring. decide() owns every allow/block rule and nothing here may
// re-implement one; this file's job is state, I/O, health and what the user
// sees. relays.js owns the relay-list logic.

/* global decide, probeToken, isProbeUrl, isLoopbackUrl, probeTraversed, usableProxy, R, PROBE_MARKER, PROBE_URL, relaylib, fmt */

// How long Firefox ignores this proxy after it fails -- a blacklist
// duration, not a grace period (nsIProtocolProxyService: "the length of time
// (in seconds) to ignore this proxy if this proxy fails"; MDN describes it
// wrongly). Every second here is a second of skipping SOCKS and taking the
// failover path, which ends at DIRECT while network.proxy.failover_direct is
// true. Keep it at the floor so the proxy is reconsidered immediately and
// the gate, not the blacklist, decides what happens.
const FAILOVER_SECONDS = 1

const PROBE_TIMEOUT_MS = 10000
// A check that was not carried by its own server is re-run once before any
// verdict, after Firefox's failover blacklist has lapsed. One failed
// connection anywhere -- an ordinary tab request, a neighbouring probe in a
// re-check-all burst -- blacklists that proxy for FAILOVER_SECONDS, and a
// probe resolved inside the window is silently carried elsewhere. That says
// something about the last second, not about the server; only a mis-carry
// that repeats after the window is evidence worth convicting on.
const RECHECK_DELAY_MS = FAILOVER_SECONDS * 1000 + 1000
const RELAY_TTL_MS = 24 * 60 * 60 * 1000
// Mullvad's in-tunnel SOCKS endpoint: exits at whatever server the app is
// connected to, unreachable when the app is off. An assignment to it stores
// an empty socksHost, which the probe reads as "any Mullvad exit is fine".
const MULLVAD_DIRECT = { host: 'mullvad-direct', ip: '10.64.0.1', port: 1080 }
// The in-tunnel endpoint Mullvad's own extension uses. The request never
// leaves the tunnel, and its failure doubles as a tunnel-down hint.
const TUNNEL_RELAYS_URL = 'https://n/network/v1-beta1/socks-proxies'
const PUBLIC_RELAYS_URL = 'https://api.mullvad.net/www/relays/all/'
const BLOCK_LOG_MAX = 200
const BLOCK_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const HARD_PROXY_ERRORS = new Set([
  'NS_ERROR_PROXY_CONNECTION_REFUSED',
  'NS_ERROR_UNKNOWN_PROXY_HOST',
  'NS_ERROR_PROXY_BAD_GATEWAY',
  'NS_ERROR_PROXY_GATEWAY_TIMEOUT',
  'NS_ERROR_PROXY_AUTHENTICATION_FAILED',
  'NS_ERROR_SOCKS5_BAD_CONNECT'
])

// Failures that name no layer. A SOCKS listener that dies mid-connection
// reports NS_ERROR_NET_RESET, and one that answers CONNECT with a refusal
// reports NS_ERROR_CONNECTION_REFUSED -- but so does a website that resets
// or refuses on its own, and tripping the killswitch for one broken site
// would be a false alarm the user cannot argue with. Probe instead: the
// check goes through the same proxy and settles it either way.
//
// Aborts are deliberately absent. The gate's own cancel surfaces as one, so
// probing on it would mean a probe for every blocked request.
const AMBIGUOUS_ERRORS = new Set([
  'NS_ERROR_NET_TIMEOUT',
  'NS_ERROR_NET_RESET',
  'NS_ERROR_CONNECTION_REFUSED'
])
const ERROR_PROBE_COOLDOWN_MS = 15000
/** @type {Map<string, number>} */
const lastErrorProbe = new Map()

// Read synchronously on every request, so it lives in memory. Never a
// storage round-trip inside a listener: each async gap is a race.
/** @type {KillswitchState} */
const state = {
  ready: false,
  hydrateError: '',
  dohActive: false,
  strict: true,
  allowLocal: false,
  containers: Object.create(null),
  probeTokens: new Set()
}

/** @type {Map<string, string>} */
const probeTargets = new Map()
// token -> the proxy the gate saw carrying that probe, or null for a request
// that travelled direct. A probe answers "did this reach the network", and
// only this says "through the server it was supposed to".
/** @type {Map<string, { host: string, port: number } | null>} */
const probeRoute = new Map()
// cookieStoreId -> the config fingerprint being probed, so a result that
// lands after the assignment changed can be recognised and discarded
/** @type {Map<string, string>} */
const probesInFlight = new Map()
// cookieStoreId -> the config fingerprint that got its follow-up check and
// when it was parked, so a mis-carried check gets its second look exactly
// once and a persistent mismatch still convicts without parking again.
// Cleared when the episode ends -- an 'up', or a hard failure -- so the
// next transient, months from now, earns its own retry.
/** @type {Map<string, { key: string, at: number }>} */
const rechecked = new Map()
/** @type {BlockEntry[]} */
const blockLog = []
// Set when blocked.html actually renders; how the e2e run proves the
// redirect survives, not just the cancellation.
/** @type {{ t: number, container: string, reason: string } | null} */
let lastBlockedPage = null
/** @type {Record<string, string>} */
let lastNotified = Object.create(null)
/** @type {Set<string>} */
const offlineNotified = new Set()
// cookieStoreId -> the host the configured server appears to have been
// renamed to, or '' when it looks like a genuine misroute
/** @type {Record<string, string>} */
const renamed = Object.create(null)

/** @type {{ ts: number, source: string, relays: Relay[], offline: OfflineAssignment[] }} */
let relayMemo = { ts: 0, source: '', relays: [], offline: [] }

// Mirrored to stdout when browser.dom.window.dump.enabled is set, so the
// e2e runner can capture decisions without a human at the Browser Console.
/** @param {...unknown} args */
function log (...args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  console.log(line)
  if (typeof dump === 'function') dump(line + '\n')
}

// Every mutation of storage.local runs through here. Without it, two
// read-modify-write cycles that overlap silently lose one of the writes --
// and a lost assignment leaves a container the user was told is proxied
// browsing direct instead.
/** @type {Promise<unknown>} */
let writeQueue = Promise.resolve()
/** @param {() => Promise<any>} fn @returns {Promise<any>} */
function serialize (fn) {
  const next = writeQueue.then(fn, fn)
  writeQueue = next.catch(() => {})
  return next
}

async function hydrate () {
  return serialize(async () => {
    const s = await browser.storage.local.get(['containers', 'strict', 'allowLocal'])
    state.strict = s.strict !== false
    state.allowLocal = s.allowLocal === true
    // Health survives for containers whose proxy config did not change;
    // everything else starts at 'unknown', which blocks until proven up.
    // Health is never persisted: a restarted browser trusts nothing.
    const { containers, stale } = relaylib.mergeAssignments(state.containers, s.containers || {})
    state.containers = containers
    // Notification bookkeeping follows the assignments. A leftover entry is
    // not just dead weight: lastNotified still holding 'down' for an id that
    // was unassigned would swallow the warning the next time that context is
    // assigned and fails.
    for (const id of Object.keys(lastNotified)) {
      if (!(id in containers) || stale.includes(id)) delete lastNotified[id]
    }
    for (const id of Object.keys(renamed)) {
      if (!(id in containers) || stale.includes(id)) delete renamed[id]
    }
    // The recheck marker follows the config it judged. Left behind across a
    // reassignment, it would deny the new config the second look the old
    // one already spent -- a switch away and back would then convict on its
    // first transient, which is the exact false verdict it exists to stop.
    for (const id of rechecked.keys()) {
      if (!(id in containers) || stale.includes(id)) rechecked.delete(id)
    }
    state.ready = true
    state.hydrateError = ''
    log('[bulkhead] ready, managed:', Object.keys(containers))
    for (const id of stale) probe(id)
    updateAllBadges()
    checkAssignedOffline()
    checkDoh()
  })
}

// Failing to read storage leaves the gate blocking everything, which is the
// right direction but a dead end without a retry: nothing would ever clear
// it and the popup would claim to be starting up forever.
async function hydrateWithRetry () {
  for (let attempt = 0; ; attempt++) {
    try {
      await hydrate()
      return
    } catch (e) {
      state.hydrateError = e instanceof Error ? e.message : String(e)
      log('[bulkhead] hydrate failed:', state.hydrateError)
      await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)))
    }
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.containers || changes.strict || changes.allowLocal) hydrateWithRetry()
})

// Router: picks the SOCKS exit for each request. Fires before webRequest,
// and cannot block -- an invalid return here means a direct connection, so
// it only ever assigns.
browser.proxy.onRequest.addListener((d) => {
  const token = probeToken(d.url)
  if (token) {
    const target = probeTargets.get(token)
    if (target !== undefined && isProbeUrl(d.url)) {
      const c = state.containers[target]
      // Probes originate from this background page, not the container, so
      // they are routed here by token to travel the container's own proxy.
      // If the target vanished mid-probe, send the request nowhere rather
      // than direct: a probe that escapes to the real connection is the
      // leak, and an unroutable proxy fails it closed instead.
      return usableProxy(c) ? socksInfo(c, target) : UNROUTABLE
    }
    // Unrecognised token: treat the request like any other. Giving it any
    // shortcut would let a web page opt out of the proxy by pasting the
    // marker into a URL.
  }
  // Mirrors the gate's loopback opt-in. Under default prefs Firefox refuses
  // to proxy loopback anyway (network.proxy.allow_hijacking_localhost), so
  // this mostly states intent -- but on a profile that flipped that pref, a
  // 127.0.0.1 request would otherwise be handed to a SOCKS server and told
  // "connect to yourself". Direct to loopback cannot leave the machine.
  if (state.allowLocal && isLoopbackUrl(d.url)) return { type: 'direct' }
  const id = d.cookieStoreId
  const c = id ? state.containers[id] : undefined
  // Same validity test the gate uses. If these two ever disagree, a config
  // the gate allows can produce an invalid ProxyInfo, and Firefox answers
  // that with a direct connection.
  if (!id || !usableProxy(c)) return { type: 'direct' }
  return socksInfo(/** @type {ContainerConfig} */ (c), id)
}, { urls: ['<all_urls>'] })

// A syntactically valid SOCKS proxy that cannot resolve, so a request routed
// here fails hard instead of falling through. .invalid is reserved by
// RFC 2606 and never resolves.
const UNROUTABLE = { type: 'socks', host: 'bulkhead.invalid', port: 1, proxyDNS: true, failoverTimeout: 1 }

// Deliberately not appended to the ProxyInfo below as a failover tail.
// Measured on 154 with network.proxy.failover_direct=true: a refused SOCKS
// proxy ends the request at NS_ERROR_PROXY_CONNECTION_REFUSED, not at a
// direct connection, so a tail buys nothing there -- and it costs. With one
// appended, the same failure arrives as NS_ERROR_ABORT: the specific error
// is what onErrorOccurred matches to trip health instantly, and what tells
// the user their server refused rather than "something went wrong".

/** @param {ContainerConfig} c @param {string} cookieStoreId */
function socksInfo (c, cookieStoreId) {
  /** @type {Record<string, unknown>} */
  const info = {
    type: 'socks', // SOCKS5 in ProxyInfo vocabulary
    // Mullvad configs store the 10.124.x.x literal -- a name here would
    // leak per-request DNS. A custom exit carries whatever the user typed;
    // the options page tells them what a hostname costs.
    host: c.ip,
    port: c.port || 1080,
    proxyDNS: true,
    failoverTimeout: FAILOVER_SECONDS,
    // A connection opened for one container must never be reused by another.
    connectionIsolationKey: cookieStoreId
  }
  // SOCKS credentials ride in ProxyInfo itself. proxyAuthorizationHeader is
  // for CONNECT proxies only, and its mere presence on a socks entry breaks
  // the request in a way nothing downstream can recover from.
  if (c.username) {
    info.username = c.username
    info.password = c.password || ''
  }
  return info
}

// Gate: the killswitch. Blocking listener, fires after the router, and its
// cancel wins -- this is the sole authority on what passes.
browser.webRequest.onBeforeRequest.addListener((d) => {
  let out
  try {
    out = decide(state, d)
  } catch (e) {
    // A bug in the decision path must fail closed, not open.
    out = { verdict: 'block', reason: R.ERROR }
    log('[bulkhead] decide threw:', String(e))
  }
  if (out.verdict === 'allow') {
    const token = probeToken(d.url)
    // Route bookkeeping runs on every attempt at the probe endpoint, not
    // just the first. A proxy that refuses is retried down Firefox's
    // failover list -- a system proxy, then a direct connection -- and each
    // retry arrives here again, by which time the token below has been
    // burned and this is an ordinary allow. It is the attempt that finally
    // completed whose route the verdict has to be judged against, so the
    // last one seen wins. Firefox attaches proxyInfo only to a request
    // actually being proxied, so its absence means direct. Not in the type
    // definitions; the API is Gecko-only.
    if (token && probeTargets.has(token) && isProbeUrl(d.url)) {
      const via = /** @type {{ proxyInfo?: { type: string, host: string, port: number } }} */ (d).proxyInfo
      probeRoute.set(token, via && via.type !== 'direct' ? { host: via.host, port: via.port } : null)
    }
    // Burn the token on use: proxy.onRequest has already taken its copy from
    // probeTargets, so the round trip is unaffected. What this closes is
    // replay of an observed token by anything else.
    if (out.reason === R.PROBE && token) state.probeTokens.delete(token)
    return {}
  }

  log(`[bulkhead] BLOCKED ${out.reason} ${d.type} ${String(d.url).slice(0, 100)}`)
  recordBlock(d, out.reason)

  // A bare cancel renders a blank network-error page, which teaches people
  // to ignore failures. Drive top-level documents to the explainer page
  // instead -- via tabs.update, because a redirectUrl into a non-web-
  // accessible extension page is silently dropped and the page never shows.
  if (d.type === 'main_frame' && d.tabId >= 0) {
    const q = new URLSearchParams({
      reason: out.reason,
      container: d.cookieStoreId || '',
      url: d.url
    })
    const url = browser.runtime.getURL('blocked/blocked.html') + '?' + q.toString()
    browser.tabs.update(d.tabId, { url }).catch(() => null)
  }
  return { cancel: true }
}, { urls: ['<all_urls>'] }, ['blocking'])

/** @param {{ url: string, type: string, cookieStoreId?: string }} d @param {string} reason */
function recordBlock (d, reason) {
  const now = Date.now()
  blockLog.unshift({ t: now, url: d.url, type: d.type, container: d.cookieStoreId || '', reason })
  if (blockLog.length > BLOCK_LOG_MAX) blockLog.length = BLOCK_LOG_MAX
  // holds URLs, so it is never persisted; age it out too, for the machines
  // that stay awake for weeks
  const cutoff = now - BLOCK_LOG_MAX_AGE_MS
  while (blockLog.length && blockLog[blockLog.length - 1].t < cutoff) blockLog.pop()
}

browser.webRequest.onErrorOccurred.addListener((d) => {
  // A probe travels the proxy of the container it is checking, but it is
  // issued by this page, so it arrives here labelled firefox-default.
  // probe() draws its own conclusion from the failure; charging it here as
  // well would take down whichever exit the default context happens to be
  // using, for a fault that is not its own.
  const token = probeToken(d.url)
  if (token && probeTargets.has(token)) return

  const c = d.cookieStoreId ? state.containers[d.cookieStoreId] : undefined
  if (!c || !d.cookieStoreId) return

  if (HARD_PROXY_ERRORS.has(d.error)) {
    // A hard error names a broken proxy, but not whose. The label on this
    // event is the request's container, and the request may have been
    // carried by a different exit entirely: a probe for another container
    // whose token was already swept up by the time the event landed (the
    // fetch settles first when the race falls that way), or a failover
    // attempt through some other proxy. Blaming this container's exit for
    // one of those took a healthy exit down for a refusal it never issued.
    // proxyInfo names the proxy that actually failed, so the instant
    // verdict is reserved for a failure of this container's own exit;
    // anything else gets the check instead, which rides that exit and
    // settles it either way.
    const via = /** @type {{ proxyInfo?: { type: string, host: string, port: number } }} */ (d).proxyInfo
    if (probeTraversed(via && via.type !== 'direct' ? { host: via.host, port: via.port } : null, c)) {
      markHealth(d.cookieStoreId, 'down', d.error)
    } else {
      errorProbe(d.cookieStoreId)
    }
  } else if (AMBIGUOUS_ERRORS.has(d.error)) {
    errorProbe(d.cookieStoreId)
  }
}, { urls: ['<all_urls>'] })

// A page can produce probe-worthy failures at will -- a subresource aimed at
// a host that resets every connection is enough. Without a floor here it
// could drive one check per failure for as long as its tab is open, which is
// both a request the page gets to time and a way to earn a rate limit from
// the one endpoint this design has to trust.
/** @param {string} id */
function errorProbe (id) {
  const last = lastErrorProbe.get(id) || 0
  if (Date.now() - last < ERROR_PROBE_COOLDOWN_MS) return
  lastErrorProbe.set(id, Date.now())
  probe(id)
}

/** @param {string} id */
async function probe (id) {
  const c = state.containers[id]
  if (!usableProxy(c)) return
  // The fingerprint of what is being probed. Re-probing the same config
  // while one is in flight is pointless; a different config must not be
  // suppressed, because that is how a freshly assigned relay ends up
  // inheriting the previous one's verdict.
  const key = relaylib.configKey(c)
  if (probesInFlight.get(id) === key) return
  probesInFlight.set(id, key)

  const token = randomToken()
  probeTargets.set(token, id)
  state.probeTokens.add(token)
  // When this probe began, which is what recheck() judges a repeat by: the
  // connection is made at the start of the fetch, so only the start says
  // whether it could still have fallen inside the failover blacklist.
  const startedAt = Date.now()

  try {
    const res = await fetch(`${PROBE_URL}?${PROBE_MARKER}=${token}`, {
      cache: 'no-store',
      credentials: 'omit',
      referrer: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    // The assignment may have been replaced during the round trip. A verdict
    // computed against the old config says nothing about the new one.
    if (relaylib.configKey(state.containers[id]) !== key) return

    // Which proxy carried this, before anything is read out of the answer. A
    // refused SOCKS connection is failed over, and while
    // network.proxy.failover_direct is true that failover ends at a direct
    // connection -- which answers, with a 200, from the user's own address.
    // Taking that as proof the server is alive would leave a dead exit
    // certified healthy and every request in the container leaving bare.
    // A Mullvad exit has a second line of defence in the hostname compare
    // below; a custom exit has none, so this check is what stands in for it.
    const via = probeRoute.get(token)
    if (!probeTraversed(via, c)) {
      // Carried by something else entirely -- another proxy in Firefox's
      // failover list, or nothing at all. That is a misroute in the plainest
      // sense, whatever the exit itself is doing, so it gets the state whose
      // label and advice already fit: wrong exit, pick another. First time
      // through it gets the recheck instead: the likeliest cause is the
      // failover blacklist, and 'unknown' blocks while the retry settles it.
      if (recheck(id, key, startedAt, 'The last check did not travel this server. Checking again.')) return
      delete renamed[id]
      markHealth(id, via ? 'misrouted' : 'down', via
        ? 'A different server carried the check, not this one.'
        : 'The check bypassed this server entirely, so it is not carrying traffic.')
      return
    }

    // A rate limit or an error page is not evidence about the proxy -- and
    // the check above has already proved the exit carried the request, so
    // there is no reason to doubt it. Leave the previous verdict and its
    // timestamp alone, so the UI keeps saying how long ago the last real
    // answer was, and let the reschedule try again.
    if (!res.ok) {
      log(`[bulkhead] ${id}: check inconclusive, am.i.mullvad.net answered HTTP ${res.status}`)
      if (c.custom) markHealth(id, 'up', 'reachable', c.exitIp || '')
      return
    }
    const j = await res.json()
    // Reading the body is an async gap like the fetch itself: the same
    // reassignment the guard above catches can also land here.
    if (relaylib.configKey(state.containers[id]) !== key) return

    if (c.custom) {
      // Reachability is all a foreign exit can prove: the round trip went
      // through the proxy, so it is passing traffic. Where that traffic
      // surfaces is whatever the user signed up for -- there is no "right"
      // exit to compare against, so no misroute state from the exit's own
      // answer. The check above still catches a check that took another
      // route entirely.
      delete renamed[id]
      const seen = typeof j.mullvad_exit_ip_hostname === 'string' ? j.mullvad_exit_ip_hostname : ''
      markHealth(id, 'up', seen || 'reachable', typeof j.ip === 'string' ? j.ip : '')
    } else if (!j.mullvad_exit_ip) {
      // Honest evidence -- this probe travelled its own proxy -- so it also
      // ends whatever episode the recheck marker was holding open.
      rechecked.delete(id)
      markHealth(id, 'down', 'Traffic came out somewhere that is not a Mullvad server.')
    } else if (c.socksHost && j.mullvad_exit_ip_hostname !== c.socksHost) {
      // Answered, but from the wrong exit -- a failure either way, once it
      // repeats. A rename is worth reporting differently from traffic going
      // astray.
      if (recheck(id, key, startedAt, 'The last check came out at a different server. Checking again.')) return
      const became = relaylib.renamedTo(c, j.mullvad_exit_ip_hostname, relayMemo.relays)
      renamed[id] = became ? became.host : ''
      markHealth(id, 'misrouted', `expected ${c.socksHost}, got ${j.mullvad_exit_ip_hostname}`)
    } else {
      delete renamed[id]
      markHealth(id, 'up', j.mullvad_exit_ip_hostname, typeof j.ip === 'string' ? j.ip : '')
    }
  } catch (e) {
    if (relaylib.configKey(state.containers[id]) !== key) return
    // The marker means "this mis-carry had its look", and a server that has
    // since failed outright makes the next mis-carry a new event, not a
    // repeat. Left standing through the outage, the marker would convict a
    // transient months after the episode it belongs to.
    rechecked.delete(id)
    markHealth(id, 'down', e instanceof Error ? e.message : String(e))
  } finally {
    probeTargets.delete(token)
    probeRoute.delete(token)
    state.probeTokens.delete(token)
    if (probesInFlight.get(id) === key) probesInFlight.delete(id)
    const now = state.containers[id]
    if (now) scheduleProbe(id, now.health)
    else nextProbeAt.delete(id)
  }
}

// The second look a mis-carried check gets, and the only one. True means
// the caller must return without a verdict: health is parked at 'unknown'
// -- which blocks, so a proxy that really is failing over to direct leaks
// nothing while the answer is pending -- and the same config is probed
// again once the failover blacklist cannot be the explanation any more.
// False means this config already had its look, from a probe that began
// after the window, and whatever the caller saw is real.
//
// Judged on when the probe began, not on the marker alone: the parked
// container can be probed again at any moment -- a popup click, a stale
// timer -- and a probe that began inside the window would otherwise convict
// on the same blacklist event the park was for.
/** @param {string} id @param {string} key @param {number} startedAt @param {string} detail @returns {boolean} */
function recheck (id, key, startedAt, detail) {
  const prev = rechecked.get(id)
  if (prev && prev.key === key && startedAt - prev.at >= RECHECK_DELAY_MS) return false
  if (!prev || prev.key !== key) {
    rechecked.set(id, { key, at: Date.now() })
    setTimeout(() => probe(id), RECHECK_DELAY_MS)
  }
  markHealth(id, 'unknown', detail)
  return true
}

// No API reads network.trr.mode, but dns.resolve reports whether the answer
// came from a trusted recursive resolver. On 154: mode 5 gives isTRR false,
// modes 2 and 3 true.
//
// Only ever a warning. true proves DoH is on; false proves nothing, since a
// mode 2 lookup that falls back to the native resolver also reads false.
//
// The lookup itself does not go through any container's proxy, so unlike the
// probe -- which resolves the same name at the SOCKS server, via proxyDNS --
// it is visible to whoever answers for the ordinary connection. That is the
// cost of the only detection the platform offers, which is why it runs on a
// slow alarm rather than per request.
async function checkDoh () {
  try {
    const rec = await browser.dns.resolve(new URL(PROBE_URL).hostname, ['bypass_cache'])
    // the dns schema declares isTRR a string while the runtime returns a
    // boolean; accept both, so a correction either way does not quietly
    // turn this check off
    const trr = /** @type {unknown} */ (rec.isTRR)
    // A quiet answer is not proof DoH is off, but it is the only evidence
    // there is that the user acted on the warning -- latching this on for the
    // session would leave the setup card and the popup strip nagging about a
    // pref they already changed, which is how a warning gets ignored.
    if (trr !== true && trr !== 'true') {
      state.dohActive = false
      return
    }
  } catch {
    return
  }

  // Revoked on every observation, not just the first: the user may tick the
  // box after DoH was already detected, and an acknowledgement must never
  // outlive the thing it claims.
  const s = await browser.storage.local.get('prefsAck')
  if (s.prefsAck === true) await browser.storage.local.set({ prefsAck: false })

  // Everything below is once per session, so a recurring check does not
  // become a recurring notification.
  if (state.dohActive) return
  state.dohActive = true
  log('[bulkhead] DNS-over-HTTPS is active; network.trr.mode is not 5')
  browser.notifications.create('bulkhead-doh', {
    type: 'basic',
    title: 'DNS-over-HTTPS is switched on',
    message: 'Every container is resolving names through one provider over your main connection, which links them back together. Set network.trr.mode to 5 in about:config.'
  })
}

/** @param {string} id @param {Health} health @param {string} detail @param {string} [exitIp] */
function markHealth (id, health, detail, exitIp) {
  const c = state.containers[id]
  if (!c) return
  const prev = c.health
  c.health = health
  c.healthDetail = detail
  c.healthAt = Date.now()
  c.exitIp = health === 'up' ? (exitIp || '') : ''
  if (prev !== health) {
    log(`[bulkhead] ${id}: ${prev} -> ${health} (${detail})`)
    if (health === 'up') {
      // Allow the next failure to notify again, and the next mis-carried
      // check to earn a fresh retry.
      delete lastNotified[id]
      rechecked.delete(id)
    } else if (health !== 'unknown') {
      // 'unknown' is the recheck parking state, not a verdict; if the retry
      // convicts, the transition out of it notifies then.
      notifyDown(id, health, detail)
    }
  }
  // Outside the transition check: the badge title carries healthDetail, and
  // a container that stays down for a new reason should not keep the old one.
  updateBadgesFor(id)
}

// Confirmed containers are re-checked slowly, to catch an exit that changed
// underneath; unconfirmed ones fast, since they are blocking traffic while
// they wait.
//
// Each keeps its own due time. Probing them on a shared tick would land one
// request per container on the same endpoint in the same millisecond, each
// from a different exit -- which links them by arrival time at the one
// endpoint this design has to trust.
const PROBE_INTERVAL_UP_MS = 10 * 60 * 1000
const PROBE_INTERVAL_DOWN_MS = 30 * 1000

/** @type {Map<string, number>} */
const nextProbeAt = new Map()

/** @param {string} id @param {Health | undefined} health */
function scheduleProbe (id, health) {
  const base = health === 'up' ? PROBE_INTERVAL_UP_MS : PROBE_INTERVAL_DOWN_MS
  nextProbeAt.set(id, Date.now() + Math.round(base * (0.7 + Math.random() * 0.6)))
}

// Everything below the two listeners is optional to the killswitch, and a
// permission this profile has not granted makes one of these throw at load.
// Start hydrating first, so a failure here costs a feature rather than
// leaving state.ready false and every request blocked for the session with
// nothing on screen to explain it.
hydrateWithRetry()
loadRelayCache().catch(e => log('[bulkhead] relay cache load failed:', String(e)))

browser.alarms.create('tick', { periodInMinutes: 0.5 })
browser.alarms.create('slow', { periodInMinutes: 10 })
browser.alarms.create('relays', { periodInMinutes: 60 * 24 })
browser.alarms.onAlarm.addListener((a) => {
  if (!state.ready) return
  if (a.name === 'relays') {
    refreshRelays(true).catch(e => log('[bulkhead] relay refresh failed:', String(e)))
    return
  }
  if (a.name === 'slow') checkDoh()
  if (a.name !== 'tick') return

  const now = Date.now()
  for (const id of Object.keys(state.containers)) {
    const due = nextProbeAt.get(id)
    if (due === undefined) {
      scheduleProbe(id, state.containers[id].health)
      continue
    }
    if (due <= now) probe(id)
  }
  for (const id of nextProbeAt.keys()) {
    if (!(id in state.containers)) nextProbeAt.delete(id)
  }
  for (const id of lastErrorProbe.keys()) {
    if (!(id in state.containers)) lastErrorProbe.delete(id)
  }
  for (const id of rechecked.keys()) {
    if (!(id in state.containers)) rechecked.delete(id)
  }
})

/** @param {string} cookieStoreId */
async function updateBadgesFor (cookieStoreId) {
  const tabs = await browser.tabs.query({ cookieStoreId })
  for (const tab of tabs) badgeTab(tab)
}

async function updateAllBadges () {
  const tabs = await browser.tabs.query({})
  for (const tab of tabs) badgeTab(tab)
}

// The toolbar is the only surface a user sees without asking, so it has to
// distinguish "protected" from "not protected at all" -- an empty badge for
// both would make the good case and the absent case identical.
//
// It stays silent while nothing is managed: an extension that has been given
// no work should not decorate every tab.
/** @param {browser.tabs.Tab} tab */
function badgeTab (tab) {
  if (tab.id === undefined) return
  const c = tab.cookieStoreId ? state.containers[tab.cookieStoreId] : undefined
  const managing = Object.keys(state.containers).length > 0
  let text = ''
  let color = '#5b6674'
  let title = 'Bulkhead'

  if (c && c.health === 'up') {
    // the check can be ten minutes old, so say when it was
    const where = c.custom
      ? fmt.exitName(c)
      : c.host === MULLVAD_DIRECT.host ? 'Mullvad tunnel exit' : `${c.host}, ${c.city}`
    const ago = fmt.timeAgo(c.healthAt, Date.now())
    title = `Protected — ${where}${ago ? ` · checked ${ago}` : ''}`
  } else if (c && c.health === 'unknown') {
    text = '?'
    color = '#8f6400'
    title = 'Blocked — verifying this exit. Nothing is being sent direct.'
  } else if (c) {
    text = '!'
    color = '#c50042'
    const why = fmt.explainDetail(c.healthDetail, c.custom)
    title = `Blocked — ${c.health === 'misrouted' ? 'wrong exit' : 'server down'}. ${why}`.trim()
  } else if (managing) {
    // managed elsewhere, but not here -- say so rather than look identical
    // to a verified tab
    text = '·'
    title = 'Not protected — no exit assigned here'
  }

  // A tab can close between the query that found it and these three calls,
  // and each would reject with "Invalid tab ID" -- noise that would bury a
  // real error in a console this page keeps for weeks.
  const gone = () => null
  browser.browserAction.setBadgeText({ text, tabId: tab.id }).catch(gone)
  browser.browserAction.setBadgeBackgroundColor({ color, tabId: tab.id }).catch(gone)
  browser.browserAction.setTitle({ title, tabId: tab.id }).catch(gone)
}

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.cookieStoreId && state.containers[tab.cookieStoreId]) badgeTab(tab)
})

/** @param {string} id @param {Health} health @param {string} detail */
async function notifyDown (id, health, detail) {
  // One notification per transition, never per blocked request.
  if (lastNotified[id] === health) return
  lastNotified[id] = health
  const name = await containerName(id)
  const c = state.containers[id]
  browser.notifications.create(`bulkhead-${id}`, {
    type: 'basic',
    title: `${name}: blocked`,
    message: `${fmt.explainDetail(detail, c && c.custom)}\nNew requests are blocked, not sent direct. Pages already open stay put — reload one for details.`.trim()
  })
}

/** @param {string} id @returns {Promise<string>} */
async function containerName (id) {
  // neither is a contextual identity, so the lookup below rejects and the
  // fallback would title a notification "se-got-wg-001: blocked"
  if (id === 'firefox-default') return 'No container'
  if (id === 'firefox-private') return 'Private windows'
  try {
    const ident = await browser.contextualIdentities.get(id)
    return ident.name
  } catch {
    const c = state.containers[id]
    return c ? fmt.exitName(c) : id
  }
}

browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
  unassign(contextualIdentity.cookieStoreId).catch(() => null)
})

/** @param {string} url @param {number} timeoutMs @returns {Promise<unknown>} */
async function fetchJson (url, timeoutMs) {
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    referrer: 'no-referrer',
    // same stance as the probe: a redirected list is somebody else's list
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

/** @param {boolean} force @returns {Promise<typeof relayMemo>} */
async function refreshRelays (force) {
  if (!force && relayMemo.relays.length && Date.now() - relayMemo.ts < RELAY_TTL_MS) return relayMemo

  let relays, source
  try {
    try {
      relays = relaylib.adaptTunnel(await fetchJson(TUNNEL_RELAYS_URL, 4000))
      source = 'tunnel'
    } catch {
      relays = relaylib.adaptPublic(await fetchJson(PUBLIC_RELAYS_URL, 20000))
      source = 'public'
    }
  } catch (e) {
    // A cached list is better than no picker. This matters most when the
    // default context is itself proxied and its proxy is down: the fetch is
    // gated by our own killswitch, and without a fallback the user cannot
    // reach the UI that would let them switch to a working server.
    if (relayMemo.relays.length) {
      log('[bulkhead] relay refresh failed, using cached list:', e instanceof Error ? e.message : String(e))
      return relayMemo
    }
    throw e
  }
  relayMemo = { ts: Date.now(), source, relays, offline: [] }
  // The list is already live in memory; failing to cache it is not a failed
  // refresh, and reporting it as one sends the user to check a tunnel that
  // is working.
  try {
    await browser.storage.local.set({ relayCache: { ts: relayMemo.ts, source, relays } })
  } catch (e) {
    log('[bulkhead] could not cache the relay list:', e instanceof Error ? e.message : String(e))
  }
  log(`[bulkhead] relay list: ${relays.length} servers via ${source}`)
  checkAssignedOffline()
  return relayMemo
}

async function loadRelayCache () {
  const { relayCache } = await browser.storage.local.get('relayCache')
  if (!relayCache || !Array.isArray(relayCache.relays)) return
  // A list off the network goes through the adapters, which validate every
  // field; this one comes back from disk and has never been checked since.
  // Put it through the same adapter rather than trusting it -- a truncated
  // or hand-edited entry would otherwise reach the picker and the snapshot
  // every page reads.
  let relays
  try {
    relays = relaylib.adaptPublic(relayCache.relays)
  } catch (e) {
    log('[bulkhead] discarding an unusable relay cache:', e instanceof Error ? e.message : String(e))
    await browser.storage.local.remove('relayCache')
    return
  }
  relayMemo = { ts: relayCache.ts || 0, source: relayCache.source || '', relays, offline: [] }
  checkAssignedOffline()
}

// An assigned exit going offline underneath you is the relay-list case that
// actually bites; say so once, prominently.
async function checkAssignedOffline () {
  if (!state.ready || !relayMemo.relays.length) return
  const offline = relaylib.offlineAssigned(state.containers, relayMemo.relays)
  relayMemo.offline = offline
  const current = new Set(offline.map(o => o.host))
  for (const host of offlineNotified) {
    if (!current.has(host)) offlineNotified.delete(host)
  }
  for (const o of offline) {
    if (offlineNotified.has(o.host)) continue
    offlineNotified.add(o.host)
    const name = await containerName(o.cookieStoreId)
    browser.notifications.create(`bulkhead-offline-${o.host}`, {
      type: 'basic',
      title: `${o.host} is offline`,
      message: `The server assigned to "${name}" is out of service. Pick another in the extension settings.`
    })
  }
}

// Every context that can own cookies is assignable, not just containers.
// firefox-default covers tabs outside any container and the extension's own
// requests, so pointing it at a proxy also stops the relay-list fetches from
// leaving bare; firefox-private covers private windows, which would
// otherwise be the one place traffic goes direct with no gate at all.
/** @param {string} id @returns {boolean} */
function assignable (id) {
  if (typeof id !== 'string') return false
  return id === 'firefox-default'
    || id === 'firefox-private'
    || id.startsWith('firefox-container-')
}

/** @param {string} cookieStoreId @param {string} host @returns {Promise<{ ok: boolean, error?: string }>} */
async function assign (cookieStoreId, host) {
  if (!assignable(cookieStoreId) || typeof host !== 'string') {
    return { ok: false, error: 'bad assignment' }
  }

  /** @type {ContainerConfig} */
  let config
  if (host === MULLVAD_DIRECT.host) {
    config = {
      ip: MULLVAD_DIRECT.ip,
      port: MULLVAD_DIRECT.port,
      host: MULLVAD_DIRECT.host,
      socksHost: '',
      city: '',
      country: '',
      cc: ''
    }
  } else if (host.startsWith('custom:')) {
    const s = await browser.storage.local.get('customExits')
    const exits = Array.isArray(s.customExits) ? s.customExits : []
    const exit = exits.find(e => `custom:${e.id}` === host)
    if (!exit) return { ok: false, error: 'That custom exit no longer exists.' }
    config = customConfig(exit)
  } else {
    let memo
    try {
      memo = await refreshRelays(false)
    } catch (e) {
      return { ok: false, error: `Could not load the server list: ${e instanceof Error ? e.message : String(e)}` }
    }
    const relay = relaylib.findRelay(memo.relays, host)
    if (!relay) return { ok: false, error: `Unknown server ${host}.` }

    // Resolve once here, at assignment time, and store the literal address.
    // Resolving the hostname per request would tell the DNS resolver which
    // exit every container uses -- re-correlating what this separates.
    // disable_trr keeps that one lookup off DoH, which would otherwise send
    // the chosen exit's name to a third-party resolver over the main
    // connection, before any of this extension's checks can run.
    let rec
    try {
      rec = await browser.dns.resolve(relay.socksName, ['disable_trr', 'bypass_cache'])
    } catch {
      // With network.trr.mode at 3 this fails with NS_ERROR_UNKNOWN_HOST
      // whatever flags are passed: strict DoH refuses the native resolver
      // and these names only answer inside the tunnel. Measured on 154.
      // Blaming the tunnel sends people to restart an app already running.
      await checkDoh()
      return {
        ok: false,
        error: state.dohActive
          ? `Could not look up ${relay.socksName}. DNS-over-HTTPS is switched on, and at its strictest setting Firefox will not ask Mullvad's resolver — so this name cannot be found. Set network.trr.mode to 5 (the setup card in Settings walks through it), then try again.`
          : `Could not look up ${relay.socksName}. Check the Mullvad app is connected — these names only exist inside the tunnel.`
      }
    }
    const ip = (rec.addresses || []).find(a => relaylib.isTunnelAddress(a))
    if (!ip) {
      // An answer outside the tunnel's own range means the query escaped it;
      // routing there would be the exact leak this extension exists to stop.
      await checkDoh()
      return {
        ok: false,
        error: state.dohActive
          ? `${relay.socksName} was answered from outside the tunnel, so it was refused. DNS-over-HTTPS is switched on — set network.trr.mode to 5 (the setup card in Settings walks through it), then try again.`
          : `${relay.socksName} was answered from outside the tunnel, so it was refused. Check the Mullvad app is connected.`
      }
    }

    config = {
      ip,
      port: relay.socksPort,
      host: relay.host,
      socksHost: relay.socksHost,
      city: relay.city,
      country: relay.country,
      cc: relay.cc
    }
  }

  if (!usableProxy(config)) return { ok: false, error: 'Refused an unroutable proxy configuration.' }

  return serialize(async () => {
    const s = await browser.storage.local.get(['containers', 'recents'])
    const containers = s.containers || {}
    containers[cookieStoreId] = config
    /** @type {string[]} */
    const recents = s.recents || []
    // Quick picks are drawn from the relay list, so anything that is not a
    // relay would be recorded and then silently dropped at render -- costing
    // a real server its place in a list of six.
    const listed = config.host !== MULLVAD_DIRECT.host && !config.host.startsWith('custom:')
    await browser.storage.local.set({
      containers,
      recents: listed ? [config.host, ...recents.filter(h => h !== config.host)].slice(0, 6) : recents
    })
    return { ok: true }
  })
}

// No tunnel-range gate here on purpose: that rule is a property of Mullvad's
// SOCKS names, which only answer inside the tunnel. A custom exit lives
// wherever the user says it does; the killswitch treats it exactly the same
// afterwards -- unverified until probed, blocked while down.
/** @param {CustomExit} e @returns {ContainerConfig} */
function customConfig (e) {
  /** @type {ContainerConfig} */
  const c = {
    ip: e.host,
    port: e.port,
    host: `custom:${e.id}`,
    socksHost: '',
    city: '',
    country: '',
    cc: '',
    custom: true,
    label: e.label
  }
  if (e.username) {
    c.username = e.username
    c.password = e.password || ''
  }
  return c
}

/** @param {Record<string, unknown>} raw @returns {Promise<{ ok: boolean, error?: string, id?: string }>} */
async function saveCustomExit (raw) {
  // Only this extension's own pages can reach the RPC, so these are a shape
  // guarantee rather than a boundary -- but the label rides every getState
  // response and the badge title, so it does not get to be unbounded.
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 60) : ''
  const host = typeof raw.host === 'string' ? raw.host.trim().slice(0, 255) : ''
  const port = typeof raw.port === 'number' ? raw.port : NaN
  const username = typeof raw.username === 'string' ? raw.username.slice(0, 255) : ''
  const password = typeof raw.password === 'string' ? raw.password.slice(0, 255) : ''
  if (!host || /[\s/]/.test(host)) return { ok: false, error: 'A custom exit needs a host — an IP address or a name, nothing else.' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Port must be a number from 1 to 65535.' }
  // SOCKS5 has no password-only mode, so storing one would be a setting that
  // silently does nothing -- and a server that wanted it would refuse.
  if (password && !username) return { ok: false, error: 'A password needs a username too.' }

  return serialize(async () => {
    const s = await browser.storage.local.get(['customExits', 'containers'])
    const exits = Array.isArray(s.customExits) ? s.customExits : []
    const prev = typeof raw.id === 'string' ? exits.find(e => e.id === raw.id) : undefined
    // Editing something that has since been deleted -- a second options tab,
    // most likely. Saving it as a new entry would look like the edit worked
    // and leave an exit nothing points at.
    if (typeof raw.id === 'string' && raw.id && !prev) {
      return { ok: false, error: 'That exit no longer exists. It may have been deleted in another tab.' }
    }
    const id = prev ? prev.id : randomToken().slice(0, 12)
    // The form never receives the stored password back, so an empty box on
    // an edit means "leave it alone" rather than "clear it". Clearing the
    // username is how credentials are dropped -- but a *changed* username
    // must not silently inherit the old password, which is a login the user
    // never typed and cannot see to correct.
    if (prev && !password && username && username !== prev.username) {
      return { ok: false, error: 'The username changed, so the password has to be entered again.' }
    }
    const kept = prev && !password && username ? prev.password : password
    /** @type {CustomExit} */
    const exit = { id, label: label || `${host}:${port}`, host, port, username, password: username ? kept : '' }
    const next = prev ? exits.map(e => e.id === id ? exit : e) : [...exits, exit]

    // Assignments freeze the exit's address at assign time, the same way
    // relay assignments do -- so an edit has to be pushed into every
    // container pointing at this exit. hydrate() then re-probes the ones
    // whose address or credentials actually changed.
    const containers = s.containers || {}
    for (const cid of Object.keys(containers)) {
      if (containers[cid] && containers[cid].host === `custom:${id}`) containers[cid] = customConfig(exit)
    }
    await browser.storage.local.set({ customExits: next, containers })
    return { ok: true, id }
  })
}

/** @param {string} id @returns {Promise<{ ok: boolean, error?: string }>} */
async function deleteCustomExit (id) {
  return serialize(async () => {
    const s = await browser.storage.local.get(['customExits', 'containers'])
    const exits = Array.isArray(s.customExits) ? s.customExits : []
    const containers = s.containers || {}
    // Deleting an exit that containers still point at would leave them
    // routed to a proxy that no longer exists on any page of the UI.
    // Refusing is less code than orphan-handling and easier to explain.
    if (Object.keys(containers).some(cid => containers[cid] && containers[cid].host === `custom:${id}`)) {
      return { ok: false, error: 'This exit is still assigned. Move those containers to another server first.' }
    }
    await browser.storage.local.set({ customExits: exits.filter(e => e.id !== id) })
    return { ok: true }
  })
}

/** @param {string} cookieStoreId @returns {Promise<{ ok: boolean }>} */
async function unassign (cookieStoreId) {
  return serialize(async () => {
    const s = await browser.storage.local.get('containers')
    const containers = s.containers || {}
    if (cookieStoreId in containers) {
      delete containers[cookieStoreId]
      await browser.storage.local.set({ containers })
    }
    return { ok: true }
  })
}

async function getHardening () {
  const [webrtc, prediction, stored] = await Promise.all([
    browser.privacy.network.webRTCIPHandlingPolicy.get({}),
    browser.privacy.network.networkPredictionEnabled.get({}),
    browser.storage.local.get('hardening')
  ])
  return {
    enabled: stored.hardening === true,
    webRTC: {
      value: webrtc.value,
      ok: webrtc.value === 'proxy_only',
      levelOfControl: webrtc.levelOfControl
    },
    prediction: {
      value: prediction.value,
      ok: prediction.value === false,
      levelOfControl: prediction.levelOfControl
    }
  }
}

// These are global browser settings, not per-container -- which is why the
// toggle is opt-in rather than applied on install, and why clear() restores
// whatever the user had. networkPredictionEnabled covers DNS prefetch,
// prerender and preemptive TCP/TLS in one switch.
/** @param {boolean} on */
async function applyHardening (on) {
  if (on) {
    await browser.privacy.network.webRTCIPHandlingPolicy.set({ value: 'proxy_only' })
    await browser.privacy.network.networkPredictionEnabled.set({ value: false })
  } else {
    await browser.privacy.network.webRTCIPHandlingPolicy.clear({})
    await browser.privacy.network.networkPredictionEnabled.clear({})
  }
  await browser.storage.local.set({ hardening: on })
  log(`[bulkhead] hardening ${on ? 'applied' : 'cleared'}`)
  return getHardening()
}

// getManifest() hands back a fresh deep copy of the whole manifest, and the
// relay count would rebuild a 600-element array -- both on a call the pages
// make every few seconds, one of them per open blocked tab.
const VERSION = browser.runtime.getManifest().version
function activeRelayCount () {
  let n = 0
  for (const r of relayMemo.relays) if (r && r.active) n++
  return n
}

async function getState () {
  const s = await browser.storage.local.get(['prefsAck', 'recents', 'favorites', 'customExits'])
  // Private windows are only reachable if the user ticked "Run in Private
  // Windows"; without it the listeners never fire there at all, so an
  // assignment would be a promise the extension cannot keep.
  const privateAllowed = await browser.extension.isAllowedIncognitoAccess()
  return {
    ready: state.ready,
    hydrateError: state.hydrateError || '',
    dohActive: state.dohActive === true,
    strict: state.strict,
    allowLocal: state.allowLocal === true,
    // A custom exit's config carries its credentials, for ProxyInfo. The
    // pages that render one need a name and an address and nothing else,
    // and blocked.html asks for this snapshot from inside a container.
    containers: Object.fromEntries(Object.entries(state.containers)
      .filter(([, c]) => c && typeof c === 'object')
      .map(([id, c]) => [id, { ...c, password: undefined }])),
    blockLog: blockLog.slice(0, 50),
    relays: {
      ts: relayMemo.ts,
      source: relayMemo.source,
      count: activeRelayCount(),
      offline: relayMemo.offline
    },
    privateAllowed,
    renamed: { ...renamed },
    prefsAck: s.prefsAck === true,
    recents: Array.isArray(s.recents) ? s.recents : [],
    favorites: Array.isArray(s.favorites) ? s.favorites : [],
    // same rule as the containers above: no password leaves this page
    customExits: (Array.isArray(s.customExits) ? s.customExits : [])
      .filter((/** @type {unknown} */ e) => e && typeof e === 'object')
      .map((/** @type {CustomExit} */ e) => ({ id: e.id, label: e.label, host: e.host, port: e.port, username: e.username })),
    version: VERSION
  }
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  // Only this extension's own pages may drive the RPC. There are no content
  // scripts and nothing externally connectable, so this is belt and braces
  // -- but the commands behind it change global browser settings and
  // routing, and blocked.html runs inside a container tab.
  if (sender.id !== browser.runtime.id) return { ok: false, error: 'refused' }
  if (!sender.url || !sender.url.startsWith(browser.runtime.getURL(''))) {
    return { ok: false, error: 'refused' }
  }
  if (!msg || typeof msg.cmd !== 'string') return { ok: false, error: 'bad message' }
  switch (msg.cmd) {
    case 'getState':
      return getState()
    case 'getRelays': {
      const memo = await refreshRelays(msg.force === true)
      return { relays: memo.relays, ts: memo.ts, source: memo.source }
    }
    case 'assign':
      return assign(msg.cookieStoreId, msg.host)
    case 'unassign':
      return unassign(msg.cookieStoreId)
    case 'probe':
      await probe(msg.cookieStoreId)
      return { ok: true }
    case 'probeAll':
      await Promise.all(Object.keys(state.containers).map(probe))
      return { ok: true }
    case 'getHardening':
      return getHardening()
    case 'setHardening':
      return applyHardening(msg.on === true)
    case 'setStrict':
      await browser.storage.local.set({ strict: msg.on === true })
      return { ok: true }
    case 'setAllowLocal':
      await browser.storage.local.set({ allowLocal: msg.on === true })
      return { ok: true }
    case 'customSave':
      return saveCustomExit(msg.exit && typeof msg.exit === 'object' ? msg.exit : {})
    case 'customDelete':
      return deleteCustomExit(String(msg.id || ''))
    case 'ackPrefs':
      await browser.storage.local.set({ prefsAck: msg.on === true })
      return { ok: true }
    case 'favorite':
      return serialize(async () => {
        const s = /** @type {{ favorites?: string[] }} */ (await browser.storage.local.get('favorites'))
        const favorites = s.favorites || []
        const next = msg.on === true
          ? [...new Set([...favorites, String(msg.host)])]
          : favorites.filter(h => h !== msg.host)
        await browser.storage.local.set({ favorites: next })
        return { ok: true }
      })
    case 'blockedShown':
      lastBlockedPage = { t: Date.now(), container: String(msg.container || ''), reason: String(msg.reason || '') }
      log(`[bulkhead] blocked page shown (${lastBlockedPage.reason}) in ${lastBlockedPage.container}`)
      return { ok: true }
    case 'clearBlockLog':
      blockLog.length = 0
      return { ok: true }
    default:
      return { ok: false, error: 'unknown command' }
  }
})

/** @returns {string} */
function randomToken () {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
}

browser.runtime.onInstalled.addListener(({ reason }) => {
  // The two prefs no extension can set are what close the remaining leak;
  // that conversation happens on install, not buried in a README.
  if (reason === 'install') browser.runtime.openOptionsPage()
})
