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
  const HEALTH_LABEL = {
    up: 'Protected',
    down: 'Blocked — proxy down',
    misrouted: 'Blocked — wrong exit',
    unknown: 'Blocked — checking'
  }

  /** @param {string | undefined} health @returns {string} */
  function healthLabel (health) {
    if (!health) return 'Not protected'
    // An unrecognised state must not render as the most reassuring label in
    // the set; fail loud instead.
    return HEALTH_LABEL[health] || 'Blocked — Bulkhead is unsure'
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
  /** @type {Record<string, string>} */
  const ERROR_TEXT = {
    NS_ERROR_PROXY_CONNECTION_REFUSED: 'Nothing answered at this server. Usually that means the Mullvad app is not connected.',
    NS_ERROR_UNKNOWN_PROXY_HOST: 'Could not find this server\'s address. Usually that means the Mullvad app is not connected.',
    NS_ERROR_PROXY_BAD_GATEWAY: 'This server answered with an error.',
    NS_ERROR_PROXY_GATEWAY_TIMEOUT: 'This server did not answer in time.',
    NS_ERROR_NET_TIMEOUT: 'This server did not answer in time.',
    NS_ERROR_PROXY_AUTHENTICATION_FAILED: 'This server refused the connection. Usually that means Firefox reached it from outside the Mullvad tunnel.',
    NS_ERROR_SOCKS5_BAD_CONNECT: 'This server rejected the connection.'
  }

  /**
   * Plain-language half of a health detail, or '' when there is nothing
   * worth saying beyond the raw value.
   * @param {string | undefined} detail
   * @returns {string}
   */
  function explainDetail (detail) {
    if (!detail) return ''
    if (ERROR_TEXT[detail]) return ERROR_TEXT[detail]
    if (detail.startsWith('expected ')) return 'Your traffic came out at a different server than this container is set to use, so it was blocked.'
    if (/timed out|timeout/i.test(detail)) return 'This server did not answer in time.'
    if (/NetworkError|Failed to fetch/i.test(detail)) return 'This server could not be reached.'
    if (detail.startsWith('NS_ERROR')) return 'The connection to this server failed.'
    return detail
  }

  /** @param {string | undefined} detail @returns {string} */
  function rawDetail (detail) {
    return detail && explainDetail(detail) !== detail ? detail : ''
  }

  /** @type {Record<string, string>} */
  const REASON_LABEL = {
    'proxy-down': 'Server not answering',
    'proxy-unverified': 'Server not checked yet',
    'misrouted': 'Came out at the wrong server',
    'not-ready': 'Firefox was still starting',
    'unattributed': 'No container given',
    'speculative': 'Early connection',
    'no-proxy': 'No server set',
    'error': 'Bulkhead error — blocked to be safe'
  }

  /** @param {string} reason @returns {string} */
  function reasonLabel (reason) {
    return REASON_LABEL[reason] || reason
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

  const api = { timeAgo, healthLabel, healthClass, explainDetail, rawDetail, reasonLabel, flagSrc, relayTags }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.fmt = api
  }
})(globalThis)
