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

    // 2. Speculative connections carry unreliable tab information, so their
    //    cookieStoreId cannot be trusted. Strict mode refuses to route them
    //    on a guess.
    if (req.type === 'speculative' && state.strict) return v(BLOCK, R.SPECULATIVE)

    const id = req.cookieStoreId
    const known = typeof id === 'string' && id !== ''
    const c = known ? state.containers[id] : undefined

    // 3. A container we manage. Deliberately checked before the strict-mode
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

    // 4. No container identity at all. It cannot be proven that this did not
    //    originate in a managed container, so strict mode refuses it rather
    //    than let it take the default route.
    if (!known) return state.strict ? v(BLOCK, R.UNATTRIBUTED) : v(ALLOW, R.UNATTRIBUTED)

    // 5. A container we do not manage. Not our business -- this is what
    //    keeps the extension inert for ordinary browsing.
    return v(ALLOW, R.UNMANAGED)
  }

  /** @param {'allow' | 'block'} verdict @param {string} reason @returns {Verdict} */
  function v (verdict, reason) {
    return { verdict, reason }
  }

  const api = { decide, probeToken, isProbeUrl, usableProxy, R, PROBE_MARKER, PROBE_URL, ALLOW, BLOCK }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    Object.assign(root, api)
  }
})(globalThis)
