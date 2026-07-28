'use strict'
// Runtime wiring. decide() owns every allow/block rule and nothing here may
// re-implement one; this file's job is state, I/O, health and what the user
// sees. relays.js owns the relay-list logic.

/* global decide, probeToken, isProbeUrl, usableProxy, R, PROBE_MARKER, PROBE_URL, relaylib, fmt */

// How long Firefox ignores this proxy after it fails -- a blacklist
// duration, not a grace period (nsIProtocolProxyService: "the length of time
// (in seconds) to ignore this proxy if this proxy fails"; MDN describes it
// wrongly). Every second here is a second of skipping SOCKS and taking the
// failover path, which ends at DIRECT while network.proxy.failover_direct is
// true. Keep it at the floor so the proxy is reconsidered immediately and
// the gate, not the blacklist, decides what happens.
const FAILOVER_SECONDS = 1

const PROBE_TIMEOUT_MS = 10000
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

// Read synchronously on every request, so it lives in memory. Never a
// storage round-trip inside a listener: each async gap is a race.
/** @type {KillswitchState} */
const state = {
  ready: false,
  hydrateError: '',
  dohActive: false,
  strict: true,
  containers: Object.create(null),
  probeTokens: new Set()
}

/** @type {Map<string, string>} */
const probeTargets = new Map()
// cookieStoreId -> the config fingerprint being probed, so a result that
// lands after the assignment changed can be recognised and discarded
/** @type {Map<string, string>} */
const probesInFlight = new Map()
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
    const s = await browser.storage.local.get(['containers', 'strict'])
    state.strict = s.strict !== false
    // Health survives for containers whose proxy config did not change;
    // everything else starts at 'unknown', which blocks until proven up.
    // Health is never persisted: a restarted browser trusts nothing.
    const { containers, stale } = relaylib.mergeAssignments(state.containers, s.containers || {})
    state.containers = containers
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
  if (changes.containers || changes.strict) hydrateWithRetry()
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

/** @param {ContainerConfig} c @param {string} cookieStoreId */
function socksInfo (c, cookieStoreId) {
  return {
    type: 'socks', // SOCKS5 in ProxyInfo vocabulary
    host: c.ip, // the 10.124.x.x literal; the hostname would leak per-request DNS
    port: c.port || 1080,
    proxyDNS: true,
    failoverTimeout: FAILOVER_SECONDS,
    // A connection opened for one container must never be reused by another.
    connectionIsolationKey: cookieStoreId
  }
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
    // Burn the probe token on use. proxy.onRequest has already run and taken
    // its copy from probeTargets, so the round trip is unaffected; what this
    // closes is replay of an observed token by anything else.
    if (out.reason === R.PROBE) {
      const token = probeToken(d.url)
      if (token) state.probeTokens.delete(token)
    }
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
  const c = d.cookieStoreId ? state.containers[d.cookieStoreId] : undefined
  if (!c || !d.cookieStoreId) return

  if (HARD_PROXY_ERRORS.has(d.error)) {
    markHealth(d.cookieStoreId, 'down', d.error)
  } else if (d.error === 'NS_ERROR_NET_TIMEOUT') {
    // Ambiguous: a slow site is indistinguishable from a dead proxy. Probe
    // instead of tripping, or one sluggish server takes a container offline.
    probe(d.cookieStoreId)
  }
}, { urls: ['<all_urls>'] })

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

  try {
    const res = await fetch(`${PROBE_URL}?${PROBE_MARKER}=${token}`, {
      cache: 'no-store',
      credentials: 'omit',
      referrer: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    // A rate limit or an error page is not evidence about the proxy.
    if (!res.ok) throw new Error(`probe endpoint returned HTTP ${res.status}`)
    const j = await res.json()

    // The assignment may have been replaced during the round trip. A verdict
    // computed against the old config says nothing about the new one.
    if (relaylib.configKey(state.containers[id]) !== key) return

    if (!j.mullvad_exit_ip) {
      markHealth(id, 'down', 'exit is not a Mullvad server')
    } else if (c.socksHost && j.mullvad_exit_ip_hostname !== c.socksHost) {
      // Answered, but from the wrong exit -- a failure either way. A rename
      // is worth reporting differently from traffic going astray.
      const became = relaylib.renamedTo(c, j.mullvad_exit_ip_hostname, relayMemo.relays)
      renamed[id] = became ? became.host : ''
      markHealth(id, 'misrouted', `expected ${c.socksHost}, got ${j.mullvad_exit_ip_hostname}`)
    } else {
      delete renamed[id]
      markHealth(id, 'up', j.mullvad_exit_ip_hostname, typeof j.ip === 'string' ? j.ip : '')
    }
  } catch (e) {
    if (relaylib.configKey(state.containers[id]) !== key) return
    markHealth(id, 'down', e instanceof Error ? e.message : String(e))
  } finally {
    probeTargets.delete(token)
    state.probeTokens.delete(token)
    if (probesInFlight.get(id) === key) probesInFlight.delete(id)
    const now = state.containers[id]
    if (now) scheduleProbe(id, now.health)
    else nextProbeAt.delete(id)
  }
}

// No API reads network.trr.mode, but dns.resolve reports whether the answer
// came from a trusted recursive resolver. On 154: mode 5 gives isTRR false,
// modes 2 and 3 true.
//
// Only ever a warning. true proves DoH is on; false proves nothing, since a
// mode 2 lookup that falls back to the native resolver also reads false.
//
// Resolves the probe endpoint, which this already contacts anyway, so the
// lookup tells a resolver nothing new.
async function checkDoh () {
  try {
    const rec = await browser.dns.resolve(new URL(PROBE_URL).hostname, ['bypass_cache'])
    // the dns schema declares isTRR a string while the runtime returns a
    // boolean; accept both, so a correction either way does not quietly
    // turn this check off
    const trr = /** @type {unknown} */ (rec.isTRR)
    if (trr !== true && trr !== 'true') return
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
      // Allow the next failure to notify again.
      delete lastNotified[id]
    } else {
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
    const where = c.host === MULLVAD_DIRECT.host ? 'Mullvad tunnel exit' : `${c.host}, ${c.city}`
    const ago = fmt.timeAgo(c.healthAt, Date.now())
    title = `Protected — ${where}${ago ? ` · checked ${ago}` : ''}`
  } else if (c && c.health === 'unknown') {
    text = '?'
    color = '#8f6400'
    title = 'Blocked — verifying this exit. Nothing is being sent direct.'
  } else if (c) {
    text = '!'
    color = '#c50042'
    const why = fmt.explainDetail(c.healthDetail)
    title = `Blocked — ${c.health === 'misrouted' ? 'wrong exit' : 'proxy down'}. ${why}`.trim()
  } else if (managing) {
    // managed elsewhere, but not here -- say so rather than look identical
    // to a verified tab
    text = '·'
    title = 'Not protected — this context has no exit assigned'
  }

  browser.browserAction.setBadgeText({ text, tabId: tab.id })
  browser.browserAction.setBadgeBackgroundColor({ color, tabId: tab.id })
  browser.browserAction.setTitle({ title, tabId: tab.id })
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
  browser.notifications.create(`bulkhead-${id}`, {
    type: 'basic',
    title: `${name}: blocked`,
    message: `${fmt.explainDetail(detail)}\nNew requests are blocked, not sent direct. Pages already open stay put — reload one for details.`.trim()
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
    return c ? c.host : id
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
  await browser.storage.local.set({ relayCache: { ts: relayMemo.ts, source, relays } })
  log(`[bulkhead] relay list: ${relays.length} servers via ${source}`)
  checkAssignedOffline()
  return relayMemo
}

async function loadRelayCache () {
  const { relayCache } = await browser.storage.local.get('relayCache')
  if (relayCache && Array.isArray(relayCache.relays) && relayCache.relays.length) {
    relayMemo = { ts: relayCache.ts || 0, source: relayCache.source || '', relays: relayCache.relays, offline: [] }
    checkAssignedOffline()
  }
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
  } else {
    let memo
    try {
      memo = await refreshRelays(false)
    } catch (e) {
      return { ok: false, error: `could not load the server list: ${e instanceof Error ? e.message : String(e)}` }
    }
    const relay = relaylib.findRelay(memo.relays, host)
    if (!relay) return { ok: false, error: `unknown server ${host}` }

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
          ? `Could not look up ${relay.socksName}. DNS-over-HTTPS is switched on, and at its strictest setting Firefox will not ask Mullvad's resolver — so this name cannot be found. Set network.trr.mode to 5 (see the setup card above), then try again.`
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
          ? `${relay.socksName} was answered from outside the tunnel, so it was refused. DNS-over-HTTPS is switched on — set network.trr.mode to 5 (see the setup card above), then try again.`
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

  if (!usableProxy(config)) return { ok: false, error: 'refusing an unroutable proxy configuration' }

  return serialize(async () => {
    const s = await browser.storage.local.get(['containers', 'recents'])
    const containers = s.containers || {}
    containers[cookieStoreId] = config
    /** @type {string[]} */
    const recents = s.recents || []
    await browser.storage.local.set({
      containers,
      recents: [config.host, ...recents.filter(h => h !== config.host)].slice(0, 6)
    })
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

async function getState () {
  const s = await browser.storage.local.get(['prefsAck', 'recents', 'favorites'])
  // Private windows are only reachable if the user ticked "Run in Private
  // Windows"; without it the listeners never fire there at all, so an
  // assignment would be a promise the extension cannot keep.
  const privateAllowed = await browser.extension.isAllowedIncognitoAccess()
  return {
    ready: state.ready,
    hydrateError: state.hydrateError || '',
    dohActive: state.dohActive === true,
    strict: state.strict,
    containers: { ...state.containers },
    blockLog: blockLog.slice(0, 50),
    relays: {
      ts: relayMemo.ts,
      source: relayMemo.source,
      count: relayMemo.relays.filter(r => r.active).length,
      offline: relayMemo.offline
    },
    privateAllowed,
    renamed: { ...renamed },
    prefsAck: s.prefsAck === true,
    recents: Array.isArray(s.recents) ? s.recents : [],
    favorites: Array.isArray(s.favorites) ? s.favorites : [],
    version: browser.runtime.getManifest().version
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

hydrateWithRetry()
loadRelayCache().catch(e => log('[bulkhead] relay cache load failed:', String(e)))
