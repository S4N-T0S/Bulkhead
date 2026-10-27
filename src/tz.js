'use strict'
// Bulkhead TZ — timezone matching wiring.zonelib (zones.js) owns every
// derivation rule and installTZRealm (tz-realm.js) owns the page-realm
// patch; this file's job is delivery: work out which zone each context
// should present, and get the engine into that context's pages before any
// page script runs.
//
// THE DELIVERY MECHANISM, and why it is not a userscript's:
// browser.contentScripts.register() with world:'MAIN', runAt:'document_start'
// and a cookieStoreId filter — one registration per managed context, the zone
// baked into the registered code. Consequences, each of which was a failure
// mode of the userscript this replaces:
//
//   - MAIN world: the engine runs in the page's own realm. No Xray wrappers,
//     no exportFunction seams, no unsafeWindow — patched functions ARE page
//     functions, which is what the toString disguise and CreepJS's lie
//     checks require. (Firefox 128+; BCD: contentScripts.register.world=128,
//     .cookieStoreId=97, .matchOriginAsFallback=128.)
//   - document_start by the platform: injection happens before the document
//     parses, guaranteed. The userscript's late-injection failure (page
//     captured Date before the patch existed, rendering the real zone even
//     though the realm later measured clean) cannot occur here — there is no
//     manager delivery pipeline to lose a race with.
//   - Exempt from page CSP and iframe sandbox (Firefox 128 release notes):
//     strict-CSP sites are patched exactly like any other.
//   - The zone arrives synchronously, resolved: it is a string literal in
//     the registered code. No veil, no cold-start sprint, no corrective
//     reload, no geo-IP request from the page — none of the userscript's
//     resolution machinery is needed, because the extension already knows
//     the answer from a better source (below).
//
// WHERE THE ZONE COMES FROM — and why it is stronger than any page-side
// lookup: the killswitch's own health probe fetches am.i.mullvad.net/json
// THROUGH the container's SOCKS relay, token-routed, and verifies the exit
// hostname before believing a word of it. That answer names the country and
// city of the very IP the container's pages use. zonelib maps it to an IANA
// zone offline, from tzdb's own tables. And because the gate blocks every
// request until a probe succeeds, no page in a managed container can load
// before that answer exists — the fail-closed killswitch turns out to be a
// fail-accurate timezone oracle: the zone is known, verified and registered
// before the first document is allowed to start.
//
// Unmanaged contexts are NEVER spoofed (zonelib.derive: 'unmanaged'). A zone
// your real IP contradicts is a louder signal than an honest one; matching
// only where the exit is controlled is the whole point. A user pin overrides
// everything, including for unassigned contexts — with the UI saying plainly
// that a pin without an exit is a claim the network will not back up.

/* global zonelib, installTZRealm, log */

;(function (root) {
  /** @type {Map<string, { zone: string, handle: { unregister(): Promise<void> } }>} */
  const registered = new Map()
  /** Per-context serialisation: sync() can be called from probe bursts and
   *  storage events at once; registration order per context must not interleave. */
  /** @type {Map<string, Promise<unknown>>} */
  const chains = new Map()
  /** @type {Map<string, TzDerivation>} */
  const derived = new Map()

  let enabled = true
  let reloadOnChange = false
  /** @type {Record<string, string>} zone string, or 'off' */
  let overrides = Object.create(null)
  /** @type {boolean | null} null = untested, true/false = world:'MAIN' registration capability */
  let mainWorldOk = null
  let lastError = ''

  /* ---------------------------------------------------------------- storage */

  // The first probe can fire (and markHealth -> sync with it) before the
  // startup settings read completes. Rather than let that race install a
  // zone under default settings — wrong whenever the user switched matching
  // off or pinned something — every sync waits on the same one-shot read.
  /** @type {Promise<void> | null} */
  let settingsReady = null

  async function loadSettings () {
    const s = await browser.storage.local.get(['tzEnabled', 'tzOverrides', 'tzReload'])
    enabled = s.tzEnabled !== false
    reloadOnChange = s.tzReload === true
    const ov = s.tzOverrides
    overrides = ov && typeof ov === 'object' ? ov : Object.create(null)
  }

  /** @returns {Promise<void>} */
  function ensureSettings () {
    if (!settingsReady) {
      settingsReady = loadSettings().catch((e) => {
        settingsReady = null // a failed read must be retryable, not latched
        throw e
      })
    }
    return settingsReady
  }

  /* ---------------------------------------------------------------- payload */

  /**
   * The registered code: the realm engine, serialised, with the zone baked
   * in. installTZRealm receives a reference to itself so its worker shims can
   * regenerate the same payload inside worker realms.
   * @param {string} zone
   * @returns {string}
   */
  function payload (zone) {
    const cfg = {
      timeZone: zone,
      // deep: capture about:blank/srcdoc probe realms at insertion time and
      // disguise this engine's own functions to Function.prototype.toString
      // in every realm reached — this is what clears CreepJS's lie marks,
      // since it inspects patched prototypes with a probe iframe's toString.
      stealth: 'deep',
      // all: shim http(s) workers too (blob/data inline workers always).
      workerMode: 'all',
      serviceWorkerMode: 'warn',
      debug: false
    }
    // The late-arrival stamp cannot happen with platform document_start
    // injection, but the engine's own contract says never trust install() —
    // so the check stays, cheap and honest, and verify surfaces it.
    return '(function () {\n'
      + '"use strict";\n'
      + 'var LATE = (function () { try { if (document.readyState && document.readyState !== "loading") return true; '
      + 'return !!(document.scripts && document.scripts.length) } catch (e) { return false } })();\n'
      + 'if (LATE && window === window.top) console.warn("[bulkhead-tz] injected after page scripts ran; reload for a clean install");\n'
      + '(function (__tzl, __cfg) { __tzl(__cfg, __tzl); })(' + installTZRealm.toString() + ', ' + JSON.stringify(cfg) + ');\n'
      + 'try { Object.defineProperty(window, "__bhtz", { configurable: true, value: { zone: ' + JSON.stringify(zone)
      + ', late: LATE, at: Date.now() } }) } catch (e) {}\n'
      + '})();'
  }

  /* ----------------------------------------------------------- registration */

  /**
   * One registration, with defensive option laddering: matchOriginAsFallback
   * (128+, covers about:blank/srcdoc/blob frames by inherited origin) first,
   * matchAboutBlank (52+) if the engine rejects the modern key, and the bare
   * minimum last. world:'MAIN' is NOT laddered away: an isolated-world
   * fallback would deliver Xray-wrapped half-measures that fail lie
   * detection — worse than not patching, because it looks patched. If MAIN
   * is unavailable the feature reports itself unavailable instead.
   * @param {string} id cookieStoreId
   * @param {string} zone
   */
  async function registerZone (id, zone) {
    /** @type {browser.contentScripts.RegisteredContentScriptOptions} */
    const base = {
      matches: ['*://*/*'],
      js: [{ code: payload(zone) }],
      runAt: 'document_start',
      allFrames: true,
      cookieStoreId: [id],
      world: 'MAIN'
    }
    const attempts = [
      { ...base, matchOriginAsFallback: true },
      { ...base, matchAboutBlank: true },
      base
    ]
    let err
    for (const opts of attempts) {
      try {
        const handle = await browser.contentScripts.register(opts)
        mainWorldOk = true
        return handle
      } catch (e) {
        err = e
        // A rejection that names the world option means MAIN is unavailable
        // on this engine; nothing below can fix that, and the ladder must
        // not silently degrade to a detectable half-patch.
        if (/world/i.test(String(e && e instanceof Error ? e.message : e))) break
      }
    }
    mainWorldOk = mainWorldOk === true ? true : false
    throw err instanceof Error ? err : new Error(String(err))
  }

  /** @param {string} id */
  async function unregisterZone (id) {
    const cur = registered.get(id)
    if (!cur) return
    registered.delete(id)
    try {
      await cur.handle.unregister()
    } catch (e) {
      log('[bulkhead-tz] unregister failed for', id, String(e))
    }
  }

  /**
   * Bring one context's registration in line with what it should present.
   * Idempotent: re-syncing an unchanged zone touches nothing.
   * @param {string} id cookieStoreId
   * @param {ContainerConfig | undefined} config live assignment, if any
   * @returns {Promise<{ zone: string | null, source: string, changed: boolean }>}
   */
  async function sync (id, config) {
    const prev = chains.get(id) || Promise.resolve()
    const next = prev.then(async () => {
      await ensureSettings()
      const want = zonelib.derive({
        enabled,
        override: Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null,
        geo: config ? config.lastGeo || null : null,
        // Probe geography is only trustworthy while the probe verdict stands:
        // it described the exit that was verified 'up'.
        geoTrusted: Boolean(config && config.health === 'up' && config.lastGeo),
        config: config || null,
        intl: Intl
      })

      if (want.zone) {
        derived.set(id, { zone: want.zone, source: want.source, approx: want.approx, rule: want.rule, at: Date.now() })
      } else {
        derived.delete(id)
      }

      const cur = registered.get(id)
      if (!want.zone) {
        const changed = Boolean(cur)
        await unregisterZone(id)
        if (changed) log(`[bulkhead-tz] ${id}: unregistered (${want.source})`)
        return { zone: null, source: want.source, changed }
      }
      if (cur && cur.zone === want.zone) {
        return { zone: want.zone, source: want.source, changed: false }
      }

      const changedZone = cur ? cur.zone : null
      try {
        await unregisterZone(id)
        const handle = await registerZone(id, want.zone)
        registered.set(id, { zone: want.zone, handle })
        lastError = ''
        log(`[bulkhead-tz] ${id}: ${want.zone} via ${want.source}${want.approx ? ' (approx)' : ''} — ${want.rule}`)
        if (changedZone && changedZone !== want.zone && reloadOnChange) {
          reloadContextTabs(id)
        }
        return { zone: want.zone, source: want.source, changed: true }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        // Fail loud, fail visible: pages in this context now run with the
        // machine's real zone while the container's exit says otherwise —
        // exactly the inconsistency this feature exists to remove. The
        // popup and options page surface tz.error rather than pretend.
        log('[bulkhead-tz] registration FAILED for', id, lastError)
        return { zone: null, source: want.source, changed: false }
      }
    }, () => undefined)
    chains.set(id, next)
    // The chain must stay alive for later syncs even if this one rejected.
    next.catch(() => {})
    return next.then(
      r => r || { zone: null, source: 'unknown', changed: false },
      () => ({ zone: null, source: 'unknown', changed: false })
    )
  }

  /** @param {string} id */
  async function drop (id) {
    derived.delete(id)
    await unregisterZone(id)
  }

  /**
   * Called after hydrate(): prune registrations for contexts that are gone,
   * sync the rest. Registrations do not survive a browser restart (they live
   * as long as the page that registered them — the persistent background),
   * so on startup this rebuilds the whole set from assignments + overrides.
   * @param {Record<string, ContainerConfig>} containers
   */
  async function rehydrate (containers) {
    for (const id of [...registered.keys()]) {
      if (!(id in containers) && !Object.prototype.hasOwnProperty.call(overrides, id)) await drop(id)
    }
    for (const id of Object.keys(overrides)) {
      if (!(id in containers)) await sync(id, undefined).catch(() => {})
    }
    await Promise.all(Object.entries(containers).map(([id, c]) => sync(id, c).catch(() => {})))
  }

  /** Called when the feature is switched off globally: pull every script. */
  async function unregisterAll () {
    await Promise.all([...registered.keys()].map(id => unregisterZone(id)))
    derived.clear()
  }

  /* -------------------------------------------------------------- overrides */

  /**
   * Store a pin ('Europe/Oslo'), 'off', or null/'auto' to clear. Validated
   * here rather than trusting the UI: a bad string must never reach storage.
   * @param {string} id
   * @param {string | null} value
   * @returns {Promise<{ ok: boolean, error?: string, zone?: string | null }>}
   */
  async function setOverride (id, value) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'bad context' }
    let store = null
    if (value === 'off') {
      store = 'off'
    } else if (typeof value === 'string' && value && value !== 'auto') {
      const z = zonelib.canonicalZone(value, Intl)
      if (!z) return { ok: false, error: `Not a timezone this engine knows: ${value}` }
      store = z
    }
    const next = { ...overrides }
    if (store === null) delete next[id]
    else next[id] = store
    await browser.storage.local.set({ tzOverrides: next })
    // loadSettings runs on the storage.onChanged echo; do it here too so the
    // sync below cannot race the event and read the previous value.
    await loadSettings()
    return { ok: true, zone: store === 'off' ? null : store }
  }

  /* ----------------------------------------------------------------- reload */

  /**
   * Reload the context's http(s) tabs so already-open documents pick up a
   * changed zone. Only ever called from an explicit user action (popup) or
   * when reloadOnChange is on; a zone changing mid-session otherwise waits
   * for the next navigation, which is how every other page state works.
   * @param {string} id
   * @returns {Promise<number>} tabs reloaded
   */
  async function reloadContextTabs (id) {
    try {
      const tabs = await browser.tabs.query({ cookieStoreId: id })
      let n = 0
      for (const t of tabs) {
        if (t.id === undefined) continue
        if (!/^https?:/i.test(t.url || '')) continue
        browser.tabs.reload(t.id).catch(() => null)
        n++
      }
      if (n) log(`[bulkhead-tz] reloaded ${n} tab(s) in ${id} for a zone change`)
      return n
    } catch {
      return 0
    }
  }

  /* -------------------------------------------------------------- introspect */

  /** Synchronous read for the badge title. @param {string} id @returns {string} */
  function zoneOf (id) {
    const d = derived.get(id)
    return d && d.zone ? d.zone : ''
  }

  function snapshot () {
    return {
      enabled,
      reloadOnChange,
      /** false means world:'MAIN' registration was refused by this engine */
      supported: mainWorldOk,
      error: lastError,
      overrides: { ...overrides },
      zones: Object.fromEntries([...derived].map(([id, d]) => [id, { ...d }]))
    }
  }

  /* ----------------------------------------------------------------- verify */

  /**
   * Source for browser.tabs.executeScript (ISOLATED world) behind the popup's
   * Verify button. Reads the page realm through wrappedJSObject — the Xray
   * view of exactly the objects the page itself sees — and reproduces
   * CreepJS's own derivations, so the verdict is about what a fingerprinter
   * measures, not about what we intended to install.
   * @returns {string}
   */
  function verifySource () {
    return `(function () {
  'use strict';
  var out = { ok: false };
  try {
    var w = window.wrappedJSObject;
    if (!w) { out.error = 'no page realm from here'; return out; }
    var D = w.Date;
    var now = new D();
    out.ok = true;
    out.url = location.href;
    out.tz = new w.Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.dateToString = String(now);
    out.offset = now.getTimezoneOffset();
    // CreepJS getTimezoneOffset(): local-string parse minus UTC parse.
    try {
      var p = JSON.stringify(now).slice(1, 11).split('-');
      var y = p[0], m = p[1], d = p[2];
      out.offsetComputed = ~~((+new D(m + '/' + d + '/' + y) - +new D(y + '-' + m + '-' + d)) / 60000);
    } catch (e) { out.offsetComputed = null; }
    // CreepJS decryptLocation(): year-1113 LMT, system vs resolvedOptions.
    try {
      var tzName = out.tz;
      var f = new w.Intl.DateTimeFormat('en', {
        timeZone: tzName, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric'
      });
      var utcAnchor = +new D('1113-07-01');
      var system = (+new D('7/1/1113') - utcAnchor) / 60000;
      var resolved = (+new D(f.format(new D('7/1/1113'))) - utcAnchor) / 60000;
      out.lmtSystem = system;
      out.lmtResolved = resolved;
      out.lmtMatch = system === resolved;
    } catch (e) { out.lmtMatch = null; }
    // Internal consistency: local getters must agree with Intl for one instant.
    try {
      out.gettersAgree = now.getHours() ===
        +new w.Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23' }).format(now);
    } catch (e) { out.gettersAgree = null; }
    // Probe realm: a fresh about:blank iframe, the way CreepJS inspects lies.
    try {
      var fr = document.createElement('iframe');
      fr.style.display = 'none';
      (document.body || document.documentElement).appendChild(fr);
      out.iframeTz = new fr.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone;
      out.iframeOffset = new fr.contentWindow.Date().getTimezoneOffset();
      fr.remove();
    } catch (e) { out.iframeTz = null; }
    // The engine's own stamp.
    try {
      var st = w.__bhtz;
      out.stamp = st ? { zone: st.zone, late: st.late } : null;
    } catch (e) { out.stamp = null; }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
})();`
  }

  /* ------------------------------------------------------------------- boot */

  const api = {
    loadSettings,
    sync,
    drop,
    rehydrate,
    unregisterAll,
    setOverride,
    reloadContextTabs,
    zoneOf,
    snapshot,
    verifySource,
    payload
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.tzlib = api
  }
})(globalThis)
