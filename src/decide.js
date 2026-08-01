'use strict'
// The killswitch decision function. Pure: state in, verdict out. No browser
// APIs, no storage, no network, no clock. Everything security-critical lives
// here so it can be tested exhaustively without a browser, and nothing
// outside this file may re-implement an allow/block rule.
//
// Loaded both as an MV2 background script (attaches to globalThis) and by
// node --test (module.exports).
;(function (root) {
  const ALLOW = 'allow'
  const BLOCK = 'block'

  // Reasons are surfaced on the blocked page and in the log, so the user can
  // always tell why something was stopped.
  const R = {
    PROBE: 'probe',
    NOT_READY: 'not-ready',
    LOOPBACK: 'loopback',
    SPECULATIVE: 'speculative',
    UNATTRIBUTED: 'unattributed',
    UNMANAGED: 'unmanaged',
    NO_PROXY: 'no-proxy',
    PROXY_DOWN: 'proxy-down',
    // Distinct from proxy-down on purpose. Health is never persisted, so
    // every browser start begins here; telling those users their proxy
    // failed would be false, and it is the most-seen state in daily use.
    NOT_VERIFIED: 'proxy-unverified',
    MISROUTED: 'misrouted',
    ERROR: 'error',
    OK: 'ok'
  }

  const PROBE_MARKER = 'bkh_probe'
  const PROBE_URL = 'https://am.i.mullvad.net/json'

  /** @param {string} url @returns {string | null} */
  function probeToken (url) {
    if (typeof url !== 'string') return null
    const m = url.match(/[?&]bkh_probe=([0-9a-f]{16,64})(?:&|$)/)
    return m ? m[1] : null
  }

  // Identity check, not a prefix match: a prefix admits /jsonextra and
  // /json/.. , and this is the comparison that decides whether a request may
  // skip the gate.
  /** @param {string} url @returns {boolean} */
  function isProbeUrl (url) {
    if (typeof url !== 'string') return false
    try {
      const u = new URL(url)
      return u.origin + u.pathname === PROBE_URL
    } catch {
      return false
    }
  }

  // Addresses that cannot leave this machine and cannot be redirected
  // anywhere by anyone: the literal loopback range, plus the one name for it
  // Firefox resolves internally. Deliberately narrower than "private
  // address" -- 192.168/16 and friends are real networks with real leak
  // potential -- and narrower than RFC 6761, which would also admit
  // *.localhost: those names only stay on-machine while
  // network.dns.offline-localhost holds its default, and a pref this cannot
  // read is not something to hang an exemption on. The URL parser has
  // already normalised IPv4 spellings (127.1, octal) and IPv6 forms by the
  // time hostname is read.
  /** @param {string} url @returns {boolean} */
  function isLoopbackUrl (url) {
    if (typeof url !== 'string') return false
    let host
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    if (host.endsWith('.')) host = host.slice(0, -1)
    if (host === 'localhost') return true
    if (host === '[::1]') return true
    const m = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    return !!m && m.slice(1).every(n => Number(n) <= 255)
  }

  // Whether the proxy Firefox reports having carried a request is the one
  // the assignment asks for. A refused SOCKS connection is failed over, and
  // that failover ends at a direct connection while
  // network.proxy.failover_direct is true -- which answers with a perfectly
  // good 200 from the user's own address. Reachability alone therefore
  // proves nothing about the proxy; this is what proves it. Firefox echoes
  // back the ProxyInfo it was given, so compare hostnames the way hostnames
  // compare.
  /**
   * @param {{ host?: string, port?: number } | null | undefined} via
   * @param {ContainerConfig | undefined} c
   * @returns {boolean}
   */
  function probeTraversed (via, c) {
    if (!via || !c || typeof via.host !== 'string') return false
    return via.host.toLowerCase() === String(c.ip).toLowerCase() && via.port === (c.port || 1080)
  }

  // Whether a stored assignment can actually be routed. Both listeners must
  // agree on this: a config the gate accepts but proxy.onRequest cannot turn
  // into a valid ProxyInfo takes Firefox's invalid-proxy path, which is a
  // direct connection.
  /** @param {ContainerConfig | undefined} c @returns {boolean} */
  function usableProxy (c) {
    if (!c) return false
    return typeof c.ip === 'string'
      && c.ip !== ''
      && Number.isInteger(c.port)
      && c.port >= 1
      && c.port <= 65535
  }

  /**
   * @param {KillswitchState} state
   * @param {GateRequest} req
   * @returns {Verdict}
   */
  function decide (state, req) {
    // 0. The health probe must never be blocked; if it were, a container
    //    marked down could never be observed recovering and the killswitch
    //    would latch shut for good. Only a token this session issued and
    //    still holds counts, and only towards the probe endpoint -- the bare
    //    marker is forgeable by any web page, and a request carrying an
    //    unrecognised token gets no special treatment anywhere, so forging
    //    one cannot open the gate or dodge the proxy.
    const token = probeToken(req.url)
    if (token && state.probeTokens.has(token) && isProbeUrl(req.url)) {
      return v(ALLOW, R.PROBE)
    }

    // 1. Until storage is hydrated every container would read as unmanaged
    //    and go direct -- a window that lands exactly on session restore,
    //    when a pile of tabs reloads at once. Fail closed through it.
    if (!state.ready) return v(BLOCK, R.NOT_READY)

    // 2. Loopback, once the user has opted in. Sits above the speculative
    //    and unattributed rules on purpose: whoever issued this request, its
    //    destination is this machine, and blocking it breaks every sign-in
    //    flow that hands a token to an app listening on a local port. After
    //    the ready check, so the toggle is only honoured once it has
    //    actually been read.
    if (state.allowLocal === true && isLoopbackUrl(req.url)) return v(ALLOW, R.LOOPBACK)

    // 3. Speculative connections carry unreliable tab information, so their
    //    cookieStoreId cannot be trusted. Strict mode refuses to route them
    //    on a guess.
    if (req.type === 'speculative' && state.strict) return v(BLOCK, R.SPECULATIVE)

    const id = req.cookieStoreId
    const known = typeof id === 'string' && id !== ''
    const c = known ? state.containers[id] : undefined

    // 4. A container we manage. Deliberately checked before the strict-mode
    //    branches, so relaxing strict can never re-open a container whose
    //    proxy is down; strict governs only the unattributable cases below.
    if (c) {
      // Managed but misconfigured -- never fall through to direct.
      if (!usableProxy(c)) return v(BLOCK, R.NO_PROXY)

      // Anything other than a confirmed-up proxy blocks, including
      // 'unknown': a freshly started browser must not pass traffic over an
      // unverified proxy.
      if (c.health !== 'up') {
        if (c.health === 'misrouted') return v(BLOCK, R.MISROUTED)
        if (c.health === 'unknown') return v(BLOCK, R.NOT_VERIFIED)
        return v(BLOCK, R.PROXY_DOWN)
      }
      return v(ALLOW, R.OK)
    }

    // 5. No container identity at all. It cannot be proven that this did not
    //    originate in a managed container, so strict mode refuses it rather
    //    than let it take the default route.
    if (!known) return state.strict ? v(BLOCK, R.UNATTRIBUTED) : v(ALLOW, R.UNATTRIBUTED)

    // 6. A container we do not manage. Not our business -- this is what
    //    keeps the extension inert for ordinary browsing.
    return v(ALLOW, R.UNMANAGED)
  }

  /** @param {'allow' | 'block'} verdict @param {string} reason @returns {Verdict} */
  function v (verdict, reason) {
    return { verdict, reason }
  }

  const api = { decide, probeToken, isProbeUrl, isLoopbackUrl, probeTraversed, usableProxy, R, PROBE_MARKER, PROBE_URL, ALLOW, BLOCK }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    Object.assign(root, api)
  }
})(globalThis)
