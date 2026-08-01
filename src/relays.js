'use strict'
// Relay-list handling, kept pure so it can be tested without a browser:
// adapters from the two Mullvad endpoints to one canonical shape, plus the
// selection and bookkeeping helpers built on it. All fetching happens in
// background.js.
//
// Canonical relay: { host, socksName, socksHost, socksPort, cc, country,
// city, active, owned, speed, messages }. socksHost is the first label of
// socks_name -- it is what am.i.mullvad.net reports as the exit hostname,
// and the only safe value to compare probes against. Comparing against
// `hostname` flags every container as misrouted.
//
// The relay list's daita flag is deliberately not carried over: DAITA is a
// property of the WireGuard entry link the Mullvad app negotiates, not of a
// SOCKS exit hop inside the tunnel, so surfacing it here would only suggest
// a protection this extension cannot influence.
;(function (root) {
  /** @param {unknown} x @returns {string} */
  const str = x => typeof x === 'string' ? x : ''
  /** @param {unknown} x @param {number} d @returns {number} */
  const num = (x, d) => typeof x === 'number' && Number.isFinite(x) ? x : d
  // A port outside this range cannot become a valid ProxyInfo, and Firefox
  // answers an invalid ProxyInfo with a direct connection.
  /** @param {unknown} x @returns {number} */
  const port = x => Number.isInteger(x) && Number(x) >= 1 && Number(x) <= 65535 ? Number(x) : 1080

  const HOST_RE = /^[a-z]{2}-[a-z0-9]+-wg-\d+$/
  const SOCKS_RE = /^[a-z]{2}-[a-z0-9]+-wg-socks5-\d+$/

  /** @param {unknown} m @returns {string} */
  function message (m) {
    if (typeof m === 'string') return m
    if (m && typeof m === 'object' && 'message' in m) return str(m.message)
    return ''
  }

  /**
   * The public relay list, https://api.mullvad.net/www/relays/all/.
   * @param {unknown} json
   * @returns {Relay[]}
   */
  function adaptPublic (json) {
    if (!Array.isArray(json)) throw new Error('relay list: expected an array')
    /** @type {Relay[]} */
    const out = []
    for (const r of json) {
      if (!r || typeof r !== 'object') continue
      const e = /** @type {Record<string, unknown>} */ (r)
      if (e.type !== 'wireguard') continue
      const socksName = str(e.socks_name)
      const host = str(e.hostname)
      const socksHost = socksName.split('.')[0]
      if (!HOST_RE.test(host) || !SOCKS_RE.test(socksHost)) continue
      out.push({
        host,
        socksName,
        socksHost,
        socksPort: port(e.socks_port),
        cc: str(e.country_code).toLowerCase(),
        country: str(e.country_name),
        city: str(e.city_name),
        active: e.active === true,
        owned: e.owned === true,
        speed: num(e.network_port_speed, 0),
        messages: Array.isArray(e.status_messages) ? e.status_messages.map(message).filter(Boolean) : []
      })
    }
    if (!out.length) throw new Error('relay list: no usable relays')
    return sortRelays(out)
  }

  /**
   * The in-tunnel endpoint Mullvad's own extension uses,
   * https://n/network/v1-beta1/socks-proxies. Unofficial and undocumented,
   * so this maps what it can and throws when the shape doesn't hold --
   * background.js falls back to the public list on any failure.
   * @param {unknown} json
   * @returns {Relay[]}
   */
  function adaptTunnel (json) {
    if (!Array.isArray(json)) throw new Error('socks-proxies: expected an array')
    /** @type {Relay[]} */
    const out = []
    for (const r of json) {
      if (!r || typeof r !== 'object') continue
      const e = /** @type {Record<string, unknown>} */ (r)
      const socksName = str(e.name) || str(e.socks_name) || str(e.hostname)
      const socksHost = socksName.split('.')[0]
      if (!SOCKS_RE.test(socksHost)) continue
      out.push({
        host: socksHost.replace('-socks5', ''),
        socksName,
        socksHost,
        socksPort: port(e.port ?? e.socks_port),
        // the validated name pattern starts with the ISO code; the payload's
        // own location fields are less trustworthy than that
        cc: socksHost.slice(0, 2),
        country: str(e.country_name ?? e.country),
        city: str(e.city_name ?? e.city),
        active: e.online !== false && e.active !== false,
        owned: e.owned === true || e.ownership === 'owned',
        speed: num(e.network_port_speed ?? e.speed, 0),
        messages: []
      })
    }
    // A half-empty mapping means the schema drifted; better to use the
    // public list than to show a truncated world.
    if (out.length < json.length / 2 || !out.length) throw new Error('socks-proxies: unrecognised shape')
    return sortRelays(out)
  }

  /** @param {Relay[]} relays @returns {Relay[]} */
  function sortRelays (relays) {
    return relays.slice().sort((a, b) =>
      a.country.localeCompare(b.country) || a.city.localeCompare(b.city) || a.host.localeCompare(b.host))
  }

  /**
   * Active relays matching a text query and the picker filters.
   * @param {Relay[]} relays
   * @param {string} q
   * @param {{ ownedOnly?: boolean }} [f]
   * @returns {Relay[]}
   */
  function searchRelays (relays, q, f = {}) {
    const needle = q.trim().toLowerCase()
    return relays.filter(r => r.active
      && (!f.ownedOnly || r.owned)
      && (!needle
        || r.host.includes(needle)
        || r.cc === needle
        || r.city.toLowerCase().includes(needle)
        || r.country.toLowerCase().includes(needle)))
  }

  /**
   * Country -> city grouping that preserves sortRelays order.
   * @param {Relay[]} relays
   * @returns {{ cc: string, country: string, cities: { city: string, relays: Relay[] }[] }[]}
   */
  function groupByLocation (relays) {
    /** @type {{ cc: string, country: string, cities: { city: string, relays: Relay[] }[] }[]} */
    const groups = []
    for (const r of relays) {
      let g = groups[groups.length - 1]
      if (!g || g.cc !== r.cc) {
        g = { cc: r.cc, country: r.country, cities: [] }
        groups.push(g)
      }
      let c = g.cities[g.cities.length - 1]
      if (!c || c.city !== r.city) {
        c = { city: r.city, relays: [] }
        g.cities.push(c)
      }
      c.relays.push(r)
    }
    return groups
  }

  /** @param {Relay[]} relays @param {string} host @returns {Relay | undefined} */
  function findRelay (relays, host) {
    return relays.find(r => r.host === host)
  }

  /**
   * Replacement suggestion when a relay goes offline: same city first, then
   * same country.
   * @param {Relay[]} relays
   * @param {{ host: string, city: string, cc: string }} gone
   * @returns {Relay | undefined}
   */
  function alternativeFor (relays, gone) {
    const usable = relays.filter(r => r.active && r.host !== gone.host)
    return usable.find(r => r.cc === gone.cc && r.city === gone.city)
      || usable.find(r => r.cc === gone.cc)
  }

  /**
   * Managed containers whose assigned relay has vanished from the list or
   * gone inactive -- the case that actually bites. Assignments that do not
   * point at a listed relay (an empty socksHost means "any Mullvad exit",
   * i.e. the tunnel's own 10.64.0.1 endpoint) have no offline state here.
   * @param {Record<string, ContainerConfig>} containers
   * @param {Relay[]} relays
   * @returns {{ cookieStoreId: string, host: string, alternative: Relay | undefined }[]}
   */
  function offlineAssigned (containers, relays) {
    const out = []
    for (const [cookieStoreId, c] of Object.entries(containers)) {
      if (!c.socksHost) continue
      const r = findRelay(relays, c.host)
      if (r && r.active) continue
      out.push({
        cookieStoreId,
        host: c.host,
        alternative: alternativeFor(relays, r || { host: c.host, city: c.city, cc: c.cc })
      })
    }
    return out
  }

  /**
   * Rebuild the in-memory assignment map from storage while keeping the
   * probed health of containers whose proxy config did not change.
   * Re-hydrating must not knock a healthy container back to 'unknown' (which
   * blocks) just because an unrelated one was edited.
   * @param {Record<string, ContainerConfig>} prev
   * @param {Record<string, ContainerConfig>} next
   * @returns {{ containers: Record<string, ContainerConfig>, stale: string[] }}
   */
  function mergeAssignments (prev, next) {
    /** @type {Record<string, ContainerConfig>} */
    const containers = Object.create(null)
    /** @type {string[]} */
    const stale = []
    for (const [id, n] of Object.entries(next)) {
      if (!n || typeof n !== 'object') continue
      const p = prev[id]
      // Credentials count as config: a custom exit whose password changed
      // must be re-proven, not trusted on the old verdict. So does the host
      // -- a custom exit at 10.64.0.1:1080 and the Mullvad tunnel endpoint
      // are the same address under different rules, and the reachability
      // verdict one earns does not answer the question the other is asked.
      if (p && p.ip === n.ip && p.port === n.port && p.socksHost === n.socksHost
        && p.host === n.host && p.custom === n.custom
        && p.username === n.username && p.password === n.password) {
        containers[id] = {
          ...n,
          health: p.health,
          healthDetail: p.healthDetail,
          healthAt: p.healthAt,
          exitIp: p.exitIp
        }
      } else {
        containers[id] = { ...n, health: 'unknown' }
        stale.push(id)
      }
    }
    return { containers, stale }
  }

  /**
   * Mullvad's SOCKS relays live in 10.124.x.x and the tunnel's own endpoint
   * is 10.64.0.1, so a legitimate answer is always inside 10.64.0.0/10. An
   * answer outside it means the query was answered from outside the tunnel,
   * and routing traffic there would be exactly the leak this extension
   * exists to stop. The wider RFC 1918 ranges are deliberately rejected:
   * 192.168/16 and 172.16/12 are what a hostile or captive LAN hands back,
   * never what Mullvad answers.
   * @param {string} ip
   * @returns {boolean}
   */
  function isTunnelAddress (ip) {
    const m = typeof ip === 'string' && ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (!m) return false
    const [a, b, c, d] = m.slice(1).map(Number)
    if ([a, b, c, d].some(n => n > 255)) return false
    return a === 10 && b >= 64 && b <= 127
  }

  /**
   * Identity of the proxy an assignment points at. A probe result is only
   * meaningful for the config that was in place when it was issued.
   * @param {ContainerConfig | undefined} c
   * @returns {string}
   */
  function configKey (c) {
    // Never logged or persisted -- lives in in-memory maps only, so the
    // credentials can safely be part of the identity.
    return c ? `${c.ip}:${c.port}:${c.socksHost}:${c.username || ''}:${c.password || ''}` : ''
  }

  /**
   * Whether an unexpected exit looks like a rename rather than a misroute:
   * the configured host has gone from the list, and the host that answered
   * is listed, active and in the same city. Only ever a hint for the user --
   * accepting a different exit automatically is what the misroute check
   * exists to prevent.
   * @param {ContainerConfig} c
   * @param {string} observedSocksHost
   * @param {Relay[]} relays
   * @returns {Relay | undefined} the relay it appears to have become
   */
  function renamedTo (c, observedSocksHost, relays) {
    if (!observedSocksHost || !relays.length) return undefined
    // Still listed under the configured name: a real misroute, not a rename.
    if (relays.some(r => r.socksHost === c.socksHost)) return undefined
    const seen = relays.find(r => r.socksHost === observedSocksHost)
    if (!seen || !seen.active) return undefined
    return seen.cc === c.cc && seen.city === c.city ? seen : undefined
  }

  const api = {
    adaptPublic,
    adaptTunnel,
    searchRelays,
    groupByLocation,
    findRelay,
    alternativeFor,
    offlineAssigned,
    mergeAssignments,
    isTunnelAddress,
    configKey,
    renamedTo
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.relaylib = api
  }
})(globalThis)
