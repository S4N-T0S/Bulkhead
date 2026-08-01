'use strict'
// Small presentation helpers shared by the pages. Pure, so the time logic
// stays testable; callers pass the clock in.
;(function (root) {
  /** @param {number | undefined} ts @param {number} now @returns {string} */
  function timeAgo (ts, now) {
    if (!ts) return ''
    const s = Math.max(0, Math.floor((now - ts) / 1000))
    if (s < 5) return 'just now'
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  // Consequence first, cause second. "up" and "misrouted" describe the
  // proxy; the user is asking whether their traffic is moving. The word
  // "Blocked" appears in every state where it is not, so the meaning
  // survives colour blindness, forced-colors and a screen reader.
  /** @type {Record<string, string>} */
  const HEALTH_LABEL = Object.assign(Object.create(null), {
    up: 'Protected',
    down: 'Blocked — server down',
    misrouted: 'Blocked — wrong exit',
    unknown: 'Blocked — checking'
  })

  /** @param {string | undefined} health @returns {string} */
  function healthLabel (health) {
    if (!health) return 'Not protected'
    // An unrecognised state must not render as the most reassuring label in
    // the set; fail loud instead.
    return HEALTH_LABEL[health] || 'Blocked — unknown state'
  }

  /** @param {string | undefined} health @returns {string} */
  function healthClass (health) {
    if (!health) return 'off'
    return HEALTH_LABEL[health] ? health : 'down'
  }

  // Gecko error constants are for the issue tracker, not for someone whose
  // browsing just stopped. The code is kept, but demoted. Hedged, too: a
  // refused connection also covers a drained server or a closed port, and
  // Mullvad's SOCKS relays do not authenticate.
  //
  // Anything added here that mentions Mullvad needs its own entry in the
  // custom table below, which falls through to this one.
  /** @type {Record<string, string>} */
  const ERROR_TEXT = Object.assign(Object.create(null), {
    NS_ERROR_PROXY_CONNECTION_REFUSED: 'Nothing answered at this server. Usually that means the Mullvad app is not connected.',
    NS_ERROR_UNKNOWN_PROXY_HOST: 'Could not find this server\'s address. Usually that means the Mullvad app is not connected.',
    NS_ERROR_PROXY_BAD_GATEWAY: 'This server answered with an error.',
    NS_ERROR_PROXY_GATEWAY_TIMEOUT: 'This server did not answer in time.',
    NS_ERROR_NET_TIMEOUT: 'This server did not answer in time.',
    NS_ERROR_PROXY_AUTHENTICATION_FAILED: 'This server refused the connection. Usually that means Firefox reached it from outside the Mullvad tunnel.',
    NS_ERROR_SOCKS5_BAD_CONNECT: 'This server rejected the connection.',
    NS_ERROR_NET_RESET: 'The connection to this server was dropped part way through.',
    NS_ERROR_CONNECTION_REFUSED: 'This server refused to open the connection.',
    NS_ERROR_ABORT: 'The connection to this server ended before it finished.',
    NS_BINDING_ABORTED: 'The connection to this server ended before it finished.'
  })

  // The same Gecko constants, read against a server the user runs. There is
  // no Mullvad app to blame, and a wrong password is a failure mode relays
  // cannot have -- Mullvad's SOCKS relays do not authenticate at all.
  /** @type {Record<string, string>} */
  const CUSTOM_ERROR_TEXT = Object.assign(Object.create(null), {
    NS_ERROR_PROXY_CONNECTION_REFUSED: 'Nothing answered at this server. Check it is running, on that port.',
    NS_ERROR_UNKNOWN_PROXY_HOST: 'Could not find this server\'s address. Check the hostname, or use an IP address.',
    NS_ERROR_PROXY_AUTHENTICATION_FAILED: 'This server refused the username and password saved for it.',
    NS_ERROR_SOCKS5_BAD_CONNECT: 'This server rejected the connection. If it needs a username and password, check them.',
    NS_ERROR_NET_RESET: 'The connection to this server was dropped part way through. Check it is still running.',
    NS_ERROR_CONNECTION_REFUSED: 'This server refused to open the connection. Check it is running, on that port.'
  })

  /**
   * Plain-language half of a health detail, or '' when there is nothing
   * worth saying beyond the raw value.
   * @param {string | undefined} detail
   * @param {boolean} [custom] the exit is the user's own, not a relay
   * @returns {string}
   */
  function explainDetail (detail, custom) {
    if (!detail) return ''
    if (custom && CUSTOM_ERROR_TEXT[detail]) return CUSTOM_ERROR_TEXT[detail]
    if (ERROR_TEXT[detail]) return ERROR_TEXT[detail]
    // no ", so it was blocked" here: this renders under a pill or heading
    // that already says Blocked, and saying it twice reads as a stutter
    if (detail.startsWith('expected ')) return 'Traffic came out at a different server than the one set for this container.'
    if (/timed out|timeout/i.test(detail)) return 'This server did not answer in time.'
    if (/NetworkError|Failed to fetch/i.test(detail)) return 'This server could not be reached.'
    // Every Gecko constant, not just the NS_ERROR ones: NS_BINDING_ABORTED
    // and its neighbours would otherwise be handed to the user as-is, and
    // rawDetail would then suppress the very line that explains them.
    if (/^NS_/.test(detail)) return 'The connection to this server failed.'
    return detail
  }

  /** @param {string | undefined} detail @param {boolean} [custom] @returns {string} */
  function rawDetail (detail, custom) {
    return detail && explainDetail(detail, custom) !== detail ? detail : ''
  }

  /** @type {Record<string, string>} */
  const REASON_LABEL = Object.assign(Object.create(null), {
    'proxy-down': 'Server not answering',
    'proxy-unverified': 'Server not checked yet',
    'misrouted': 'Came out at the wrong server',
    // Bulkhead's own startup, not the browser's: the same state shows up on
    // a plain extension reload, when Firefox never restarted.
    'not-ready': 'Bulkhead was still starting',
    'unattributed': 'No container given',
    'speculative': 'Speculative connection',
    'no-proxy': 'No server set',
    'error': 'Bulkhead error — blocked to be safe'
  })

  /** @param {string} reason @returns {string} */
  function reasonLabel (reason) {
    return REASON_LABEL[reason] || reason
  }

  // What to call an exit in prose: relays by hostname, the tunnel endpoint
  // by its role, custom exits by whatever the user named them.
  /** @param {ContainerConfig} c @returns {string} */
  function exitName (c) {
    if (c.custom) return c.label || 'custom exit'
    if (c.host === 'mullvad-direct') return 'Mullvad tunnel exit'
    return c.host
  }

  /** @param {string} cc @returns {string} */
  function flagSrc (cc) {
    return /^[a-z]{2}$/.test(cc) ? `/flags/${cc}.svg` : ''
  }

  // Every relay in the fleet runs at 10 Gbps or better, so speed is only
  // worth a tag when it is out of the ordinary.
  /** @param {Relay} r @returns {string[]} */
  function relayTags (r) {
    const tags = []
    if (r.owned) tags.push('owned')
    if (r.speed >= 100) tags.push(`${r.speed}G`)
    return tags
  }

  const api = { timeAgo, healthLabel, healthClass, explainDetail, rawDetail, reasonLabel, flagSrc, relayTags, exitName }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.fmt = api
  }
})(globalThis)
