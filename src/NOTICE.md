# Bulkhead TZ — attribution notices

This extension is a modified version of **Bulkhead** and is distributed under
the same license, GPL-3.0-only (see `LICENSE`). GPL-3.0 §5 requires modified
files to carry prominent notices; this file is the index, and each modified
file says so at the point of change.

## Upstream: Bulkhead

- Copyright © S4N-T0S
- <https://github.com/S4N-T0S/Bulkhead>, version 1.0.5 (commit ab26291)
- License: GPL-3.0-only

Unmodified from upstream: `decide.js` (the killswitch decision core),
`blocked/` (the blocked page), `ui/base.css`, `ui/picker.js`, `flags/`,
`icons/`, the relay-list and probe logic in `background.js` and `relays.js`,
and the test suites for all of the above.

Modified for Bulkhead TZ (every change marked `[bhtz]` in-file):

- `manifest.json` — name, id, version, description; three new background
  scripts. Permissions are unchanged from upstream.
- `background.js` — probe geography capture (`setGeo`), `tzlib.sync` on
  health transitions, timezone rehydration in `hydrate()`, storage-change
  handling for the timezone settings, badge title, `getState()` snapshot,
  four RPC commands (`tzOverride`, `tzReloadTabs`, `tzVerify`,
  `tzSetEnabled`, `tzSetReload`). The gate, router and probe verdicts are
  untouched.
- `relays.js` — `mergeAssignments()` additionally preserves the in-memory
  `lastGeo` field where the proxy config is unchanged.
- `ui/fmt.js` — added `tzSourceText()`.
- `popup/`, `options/` — added the timezone card, pin picker, verify view
  and the settings card; existing views unchanged.
- `types/globals.d.ts`, `package.json`, `eslint.config.mjs`,
  `tsconfig.json`, `test/unit/relays.test.js` (one added test).

## Timezone realm engine and geo tables

- `tz-realm.js` is adapted from the **Timezone Lock** userscript v3.3.4
  (MIT license), whose realm engine was verified in the field against
  CreepJS's timezone derivations. Changes from the upstream script:
  function renamed (`installTZRealm`), log/marker branding, and removal of
  the userscript-only delivery machinery (the extension delivers via
  MAIN-world content-script registration instead). MIT terms: the copyright
  notice and permission notice are preserved in spirit by this attribution;
  the combined work is distributed under GPL-3.0-only, which the MIT license
  permits (MIT is GPL-compatible, one-way).
- `zones.js` adapts the same script's embedded tzdb tables: `zone.tab`
  country→zone membership (public domain, from tzdb), umpirsky country-list
  name→ISO mappings (MIT), and the city→zone table (audited 2026-10 against
  Mullvad's live relay list; six cities added). The IATA/colo table the
  userscript carried for Cloudflare-trace derivation is not used here and
  was dropped.

## Third parties

- Not affiliated with Mullvad AB. `am.i.mullvad.net` and Mullvad's relay
  lists are used exactly as upstream Bulkhead uses them.
- Flag SVGs: upstream Bulkhead's `src/flags/`.
