// Audits the offline city table (src/zones.js) against Mullvad's live relay
// list, so a new server city degrades visibly (country-level approx) instead
// of silently. Run: node tools/audit-cities.mjs  — exits non-zero when a
// relay city in a multi-zone country has no exact mapping, which is the
// signal to add it to CITY_BLOB.
//
// Single-zone countries cannot have gaps by construction: the country alone
// decides, and the audit says so rather than pretending to check cities.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { zoneFromLocation } = require('../src/zones.js')

const RELAYS_URL = 'https://api.mullvad.net/www/relays/all/'

const res = await fetch(RELAYS_URL, { signal: AbortSignal.timeout(20000) })
if (!res.ok) {
  console.error(`relay list: HTTP ${res.status}`)
  process.exit(2)
}
const json = await res.json()
const relays = json.filter(r => r && r.type === 'wireguard')
console.log(`relays: ${relays.length} wireguard of ${json.length}`)

/** @type {Map<string, { cc: string, country: string, city: string, zone: string | null, approx: boolean, rule: string }>} */
const gaps = new Map()
let exact = 0
let single = 0

for (const r of relays) {
  const loc = { country: r.country_name, city: r.city_name, cc: r.country_code }
  const d = zoneFromLocation(loc)
  if (!d.zone) {
    gaps.set(`${r.country_code}|${r.city_name}`, { cc: r.country_code, country: r.country_name, city: r.city_name, zone: null, approx: false, rule: d.rule })
    continue
  }
  if (!d.approx) {
    // exact either way; distinguish single-zone countries (city ignored by
    // design) from multi-zone ones resolved by the city table
    if (/single-zone/.test(d.rule)) single++
    else exact++
    continue
  }
  gaps.set(`${r.country_code}|${r.city_name}`, { cc: r.country_code, country: r.country_name, city: r.city_name, zone: d.zone, approx: true, rule: d.rule })
}

console.log(`exact by single-zone country: ${single}`)
console.log(`exact by city table:          ${exact}`)
console.log(`approx / unmapped:            ${gaps.size}`)
for (const g of gaps.values()) {
  console.log(`  ${g.cc} | ${JSON.stringify(g.city)} | -> ${g.zone || 'NULL'} | ${g.rule}`)
}

if (gaps.size) {
  console.error('\nCity table has gaps against the live list. Add the cities above to CITY_BLOB in src/zones.js (normStr-folded keys), then re-run.')
  process.exit(1)
}
console.log('\nCity table fully covers the live relay list.')
