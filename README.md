# Bulkhead TZ

Fail-closed SOCKS5 proxies for Firefox containers — **plus per-container
timezone matching**. Every container gets its own Mullvad exit, traffic is
blocked whenever that exit is not confirmed working, *and* the pages inside
each container present the IANA timezone of the exit they are proven to use —
consistently enough to defeat derived-timezone fingerprinting
([CreepJS's timezone test](https://abrahamjuliot.github.io/creepjs/tests/timezone.html)
included).

This is a fork of [**Bulkhead**](https://github.com/S4N-T0S/Bulkhead) 1.0.5
by S4N-T0S (GPL-3.0). The killswitch, the probe, the gate, the relay logic,
the blocked page and the picker are upstream code, unmodified; every
addition is marked `[bhtz]` in the source and confined to three new modules
plus narrow hooks. See [Attribution](#attribution-and-license).

Works with Mullvad's SOCKS5 relays. Requires your own Mullvad account and an
active tunnel. Unofficial; not affiliated with Mullvad AB.

Target: **Firefox 142+ (developed against Nightly 160, macOS)**, Manifest V2.

---

## Why an extension beats a userscript here

The timezone half of this project started life as a userscript
(`Timezone Lock` v3.3.4, MIT). Its changelog is a catalogue of things a
userscript cannot control, every one of which disappears inside Bulkhead:

| Userscript problem | Bulkhead TZ answer |
| --- | --- |
| **Late injection.** The manager delivered the script after page scripts ran; the page captured un-patched `Date` and rendered the real zone even though the realm later measured clean. Cost: corrective reloads, inject-mode tuning. | The background page registers the script with `browser.contentScripts.register({ runAt: 'document_start', world: 'MAIN' })`. The platform injects it before the document parses. There is no manager pipeline left to lose a race with. |
| **Cold start.** No synchronous way to learn the exit zone: veil the page, sprint a Cloudflare-trace ladder, reload once. | The killswitch already blocks every request until a probe through the container's own relay verifies the exit. That probe's answer (`am.i.mullvad.net/json`) names the exit's country and city. The zone is known, verified and registered **before the first page load is allowed** — no veil, no reload, no extra request. |
| **Wrong-container lookups.** `GM_xmlhttpRequest` leaves from the manager's context, so under per-container proxies it measures the *default* tunnel (the v2.0.0 Norway-from-Greece bug). | There is no lookup. The probe rides the container's SOCKS relay by token routing and is only believed after the exit hostname checks out — the same evidence the killswitch stakes its verdicts on. |
| **Page CSP blocks inline injection.** | MAIN-world content scripts are exempt from page CSP and iframe sandbox (Firefox 128+). |
| **Geo-IP providers, blocklists, firewalls.** An entire ladder of endpoints audited against EasyPrivacy/Disconnect/1Host. | Zero page-side requests. The geography is mapped offline from tzdb's own tables. |
| **Per-container cache in `localStorage`, wiped by "clear cookies".** | Zone state lives in the background page's memory, rebuilt from assignments and probes on every start. Nothing for a site or a cleanup to corrupt. |

## What timezone matching does

For every context (container, default, private) that has an exit assigned:

1. **Derive.** The verified probe's country/city → IANA zone, offline
   (`src/zones.js`): single-zone countries resolve on the country alone;
   multi-zone countries on the city, accepted only if tzdb lists that zone
   inside that country; otherwise the country's primary zone, flagged
   *country-level* in the UI. A user **pin** outranks everything; **off**
   never spoofs; unassigned contexts are **never spoofed** — a zone your
   real IP contradicts is a louder signal than an honest one.
2. **Deliver.** One MAIN-world `document_start` registration per context
   (`cookieStoreId`-filtered), the zone baked into the registered code
   (`src/tz.js`).
3. **Patch.** The realm engine (`src/tz-realm.js`, ported from Timezone
   Lock) rebuilds `Date`, `Intl.DateTimeFormat` defaults and `Temporal.Now`
   around the target zone in the page realm — and keeps every observable
   mutually consistent:
   - non-ISO string parsing (`new Date('7/1/1113')`, `'M/D/YYYY'`) is
     re-interpreted in the target zone — this is what CreepJS's
     `offsetComputed` and year-1113 "computed location" actually measure;
   - local getters/setters, `toString/toDateString/toTimeString` (incl. the
     CLDR zone name and truncated GMT label), `toLocaleString*` (delegated
     to the natives with the zone injected, because SpiderMonkey resolves
     the `%Intl%` intrinsic directly), Annex B `getYear/setYear`;
   - explicit `timeZone` options are still honoured — the
     `Intl.DateTimeFormat` constructor only supplies a *default*, so nothing
     is a blanket lie;
   - about:blank/srcdoc probe realms (captured at DOM-insertion time, since
     indexed `WindowProxy` access is not a hookable getter — this is the
     realm CreepJS inspects patched prototypes *from*),
     `window.open` targets, workers (constructors shimmed onto blob payloads
     that re-run the same engine);
   - `Function.prototype.toString` vouches narrowly — only for functions the
     engine created — and patched members satisfy CreepJS's `searchLies`
     invariants exactly (own props `['length','name']`, no own `prototype`,
     strict-mode `TypeError` on `.caller`/`.arguments`).

### Why the CreepJS timezone panel comes out consistent

CreepJS derives, rather than reads, and compares derivations:

- `offset` vs `offsetComputed` — a local-string parse against
  `getTimezoneOffset()`. Both come from the patched engine: equal.
- `location` vs `locationMeasured` — `resolvedOptions().timeZone` against a
  **year-1113 LMT** probe (`+new Date('7/1/1113')` vs Intl-formatted
  round-trip, binary-searched over ~500 cities when they disagree). Because
  the local parse *and* the Intl default are the same target zone, system and
  resolved sides are equal, the search short-circuits to the reported zone,
  and the LMT offsets come from ICU's own historical data — no LMT table is
  baked in, so it cannot drift from the engine it is compared against.
- `zone` — the parenthesised name in `Date#toString`, rendered from CLDR for
  the target zone at the correct instant (DST-aware).
- `lied` — `lieProps` from a hidden probe iframe's `Function.prototype.toString`.
  The deep-stealth disguise covers the probe realm (see above).

The popup's **Verify** button replays exactly these derivations against the
live page (through the Xray view of the page realm) and reports each one.

## Install (Firefox Nightly, macOS)

Unsigned forks load as temporary add-ons — fine for a personal build, gone
after browser restart, re-added in two clicks:

1. Build: `npm ci && npm run build` → `dist/bulkhead-tz-1.1.0.zip`, or use
   the provided `bulkhead-tz.xpi` (it is the same zip of `src/`).
2. Nightly → `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** → pick the `.xpi`/`.zip` (or `src/manifest.json`).
3. Set the two `about:config` prefs the setup card asks for
   (`network.proxy.failover_direct = false`, `network.trr.mode = 5`) — the
   killswitch's own requirements, unchanged.
4. Assign servers to your containers as in Bulkhead. Timezone matching is on
   by default and needs no configuration: the first verified probe fixes each
   container's zone.

For a permanent install, either set `xpinstall.signatures.required = false`
in Nightly and install the xpi, or run `web-ext run` from the repo
(`npm start`).

> If you also run the original Bulkhead, disable it while this fork is
> installed — two extensions must not both own `proxy.onRequest`. The fork
> uses its own extension id, so profiles/settings do not mix.

## Using it

- **Popup** (managed context): the timezone card shows the presented zone
  and its provenance (*matched to the verified exit*, *from the assigned
  server*, *pinned by you*, *country-level* …). **Pin zone…** opens a
  searchable zone list (Auto / Off / any ICU zone); after a pin change the
  popup offers to reload the context's open tabs, since a registration only
  reaches new documents. **Verify** reads the live page realm and replays
  the CreepJS derivations, line by line, with ✓/✗ per invariant.
- **Settings page → Timezone matching**: the global switch, the
  reload-on-change switch, a per-context table (presented zone, provenance,
  override), and an honest list of what the feature cannot do.
- **Badge tooltip**: `Protected — se-got-wg-001, Gothenburg · Europe/Stockholm · checked 2m ago`.

## Limitations — read before trusting this

Everything in upstream Bulkhead's
[*What it does not protect against*](https://github.com/S4N-T0S/Bulkhead#what-it-does-not-protect-against)
still applies to the networking half. For the timezone half:

- **Service workers cannot be patched.** No platform API exposes a service
  worker's realm to page JS, and `register()` rejects blob:/data: script
  URLs. A site fingerprinting from a SW still sees the system zone. The
  engine logs a warning when a page registers one
  (`serviceWorkerMode: 'warn'`). The only complete fixes live below JS:
  `privacy.resistFingerprinting = true` (forces UTC engine-wide — your
  matched zone would then have to be UTC) or overriding the OS timezone at
  launch.
- **Zone↔IP matching is necessary, not sufficient.** `navigator.language`,
  Accept-Language, WebRTC, and the rest of the fingerprint are out of scope.
  A Swedish zone with `en-IR` language headers is its own signal.
- **Country-level precision.** When the exit's city is missing or unmapped
  (Mullvad's geo answers `city: null` for some ranges, and the offline table
  is frozen at build time), the country's primary zone is used and the UI
  says *country-level*. In the US/CA/BR/RU/AU class that can be the wrong
  coast; a pin is the exact fix. The city table was audited against
  Mullvad's full live relay list (2026-10): every relay city in a multi-zone
  country maps to a member of that country's zone set.
- **Cross-origin *module* workers** are passed through unpatched (dynamic
  `import()` there requires CORS the target may not grant); classic workers
  and same-origin modules are shimmed.
- **`world: 'MAIN'` is the only delivery mode.** If a future Firefox removes
  it, this feature reports itself unavailable (popup/settings banner) rather
  than degrading to an isolated-world half-patch that would fail lie
  detection while looking installed. The killswitch is unaffected either way.
- **Existing documents keep their zone.** A registration reaches new
  documents; after a server switch or a pin change, open tabs run the old
  zone until reloaded (offered in the popup; automatable via the
  reload-on-change setting).
- **No JS patch is undetectable in principle.** This makes the values
  correct and mutually consistent — which is what actually identifies you —
  and keeps the lie surface narrow. It does not eliminate it.

## Development

```
npm ci
npm test          # 100 unit tests: decide, relays, fmt, zones, and the
                  # realm engine run end-to-end in node:vm with CreepJS's
                  # own derivations as the assertions
npm run lint      # eslint, upstream config (tz-realm.js exempt as vendored)
npm run typecheck # tsc --strict over src + types (same exemption)
npm run lint:amo  # addons-linter at upstream's 0/0/0 bar
npm run build     # web-ext build → dist/
npm run audit:cities   # re-audit the offline city table against Mullvad's
                  # LIVE relay list; exits non-zero when a new server city
                  # needs a CITY_BLOB entry (currently: 553/553 exact)
```

`test/unit/tz-realm.test.js` is the port's safety net: it builds the exact
registered payload, runs it in a fresh `node:vm` context per zone
(including DST, half-hour, 45-minute and LMT-second zones), and asserts the
CreepJS derivations, the ICU ground truth for winter/summer offsets, and
every `searchLies` invariant. Caveat stated honestly: node:vm is V8 and
production is SpiderMonkey — the engine itself was field-verified against
Gecko upstream; the suite proves the *port* is faithful.

### Layout of the additions

```
src/zones.js      pure geography: country/city → IANA zone + derive() precedence
src/tz-realm.js   the page-realm engine (ported verbatim; lint/tsc-exempt)
src/tz.js         delivery: contentScripts registration lifecycle, payload,
                  overrides, verify source
src/background.js [bhtz] hooks only: probe geo capture, markHealth sync,
                  hydrate rehydrate, storage events, badge title, getState,
                  4 RPC commands — decide()/gate/router untouched
src/popup/*       timezone card, pin picker, verify view
src/options/*     Timezone matching card
test/unit/zones.test.js, test/unit/tz-realm.test.js
```

## Attribution and license

GPL-3.0-only, like its upstream.

- **Bulkhead** © S4N-T0S — <https://github.com/S4N-T0S/Bulkhead> (GPL-3.0).
  This fork modifies `background.js`, `relays.js`, `manifest.json`,
  `ui/fmt.js`, the popup, the options page and `types/globals.d.ts`; each
  modification is marked `[bhtz]`. Modified files carry prominent notices,
  per GPL-3.0 §5.
- **Timezone Lock** userscript v3.3.4 (MIT) — `src/tz-realm.js` is its realm
  engine, and `src/zones.js` adapts its tzdb/country/city tables; both files
  say so in their headers.
- Timezone data: tzdb `zone.tab` (public domain); country names: umpirsky
  country-list (MIT).

See `src/NOTICE.md`.
