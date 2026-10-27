'use strict'
const { test } = require('node:test')
const assert = require('node:assert')

const { zoneFromLocation, canonicalZone, usableZone, derive, normStr } = require('../../src/zones.js')

test('single-zone countries resolve on the country alone', () => {
  for (const [cc, zone] of [['NO', 'Europe/Oslo'], ['SE', 'Europe/Stockholm'], ['GR', 'Europe/Athens'], ['IS', 'Atlantic/Reykjavik'], ['JP', 'Asia/Tokyo']]) {
    const d = zoneFromLocation({ cc })
    assert.equal(d.zone, zone, cc)
    assert.equal(d.approx, false)
  }
  // a mis-geolocated city cannot move a single-zone country
  const d = zoneFromLocation({ country: 'Norway', city: 'Stockholm' })
  assert.equal(d.zone, 'Europe/Oslo')
})

test('country NAMES map through the name table', () => {
  assert.equal(zoneFromLocation({ country: 'Sweden' }).zone, 'Europe/Stockholm')
  assert.equal(zoneFromLocation({ country: 'United States', city: 'Seattle' }).zone, 'America/Los_Angeles')
  assert.equal(zoneFromLocation({ country: 'Türkiye' }).zone, 'Europe/Istanbul')
  assert.equal(zoneFromLocation({ country: 'Côte d’Ivoire' }).zone, 'Africa/Abidjan')
})

test('cc beats country name', () => {
  // a name the table has never seen, but the code is right there
  assert.equal(zoneFromLocation({ country: 'Kingdom of Norway', cc: 'no' }).zone, 'Europe/Oslo')
})

test('multi-zone countries resolve by city', () => {
  assert.equal(zoneFromLocation({ country: 'United States', city: 'New York' }).zone, 'America/New_York')
  assert.equal(zoneFromLocation({ country: 'United States', city: 'Chicago' }).zone, 'America/Chicago')
  assert.equal(zoneFromLocation({ country: 'United States', city: 'Phoenix' }).zone, 'America/Phoenix')
  assert.equal(zoneFromLocation({ country: 'Australia', city: 'Perth' }).zone, 'Australia/Perth')
  assert.equal(zoneFromLocation({ country: 'Brazil', city: 'Manaus' }).zone, 'America/Manaus')
  assert.equal(zoneFromLocation({ country: 'Canada', city: 'Toronto' }).zone, 'America/Toronto')
})

test('the 2026-10 Mullvad audit gaps stay fixed', () => {
  // McAllen TX is US Central; the country primary (New York) would be wrong
  assert.equal(zoneFromLocation({ country: 'United States', city: 'McAllen, TX' }).zone, 'America/Chicago')
  assert.equal(zoneFromLocation({ country: 'United States', city: 'Raleigh, NC' }).zone, 'America/New_York')
  assert.equal(zoneFromLocation({ country: 'Germany', city: 'Düsseldorf' }).zone, 'Europe/Berlin')
  assert.equal(zoneFromLocation({ country: 'Germany', city: 'Frankfurt' }).zone, 'Europe/Berlin')
  assert.equal(zoneFromLocation({ country: 'Cyprus', city: 'Nicosia' }).zone, 'Asia/Nicosia')
})

test('state suffixes and accents fold away', () => {
  assert.equal(zoneFromLocation({ country: 'United States', city: 'Ashburn, VA' }).zone, 'America/New_York')
  assert.equal(zoneFromLocation({ country: 'Brazil', city: 'São Paulo' }).zone, 'America/Sao_Paulo')
  assert.equal(normStr('  Düsseldorf, DE  '), 'dusseldorf de')
})

test('a city outside the country falls back to the country primary, flagged', () => {
  // a Toronto geolocation for a US exit says nothing about the exit
  const d = zoneFromLocation({ country: 'United States', city: 'Toronto' })
  assert.equal(d.zone, 'America/New_York')
  assert.equal(d.approx, true)
  assert.match(d.rule, /outside US/)
})

test('an unmapped city in a multi-zone country degrades to primary, flagged', () => {
  const d = zoneFromLocation({ country: 'United States', city: 'Nowhereville' })
  assert.equal(d.zone, 'America/New_York')
  assert.equal(d.approx, true)
})

test('null city in a multi-zone country still answers with the primary', () => {
  // am.i.mullvad.net answers city:null for plenty of non-Mullvad ranges
  const d = zoneFromLocation({ country: 'United States', city: null })
  assert.equal(d.zone, 'America/New_York')
  assert.equal(d.approx, true)
})

test('unmappable locations answer null rather than guess', () => {
  assert.equal(zoneFromLocation({}).zone, null)
  assert.equal(zoneFromLocation({ country: 'Atlantis', city: 'Poseidon' }).zone, null)
  assert.equal(zoneFromLocation({ cc: 'ZZ' }).zone, null)
})

test('canonicalZone and usableZone defer to the engine ICU', () => {
  assert.equal(canonicalZone('utc', Intl), 'UTC')
  assert.equal(canonicalZone('  europe/oslo ', Intl), 'Europe/Oslo')
  assert.equal(canonicalZone('Mars/Olympus', Intl), null)
  assert.equal(canonicalZone('', Intl), null)
  assert.equal(canonicalZone(42, Intl), null)
  assert.equal(usableZone('Asia/Kolkata', Intl), true)
  assert.equal(usableZone('Not/AZone', Intl), false)
  assert.equal(usableZone(null, Intl), false)
})

// -- derive(): precedence ---------------------------------------------------

const CFG_SE = { city: 'Gothenburg', country: 'Sweden', cc: 'se' }
const GEO_US = { country: 'United States', city: 'Ashburn, VA' }

test('derive: a pin outranks everything, even no config at all', () => {
  const d = derive({ enabled: true, override: 'Asia/Tokyo', config: null, intl: Intl })
  assert.equal(d.zone, 'Asia/Tokyo')
  assert.equal(d.source, 'pin')
  // pins canonicalise, so storage can drift without breaking injection
  assert.equal(derive({ enabled: true, override: 'utc', config: null, intl: Intl }).zone, 'UTC')
  // an unusable pin is treated as absent, never injected raw
  const bad = derive({ enabled: true, override: 'Mars/Olympus', config: CFG_SE, intl: Intl })
  assert.equal(bad.zone, 'Europe/Stockholm')
  assert.equal(bad.source, 'relay')
})

test('derive: off means off, even with an exit assigned', () => {
  const d = derive({ enabled: true, override: 'off', config: CFG_SE, intl: Intl })
  assert.equal(d.zone, null)
  assert.equal(d.source, 'off')
})

test('derive: globally disabled beats probe geography', () => {
  const d = derive({ enabled: false, geo: GEO_US, geoTrusted: true, config: CFG_SE, intl: Intl })
  assert.equal(d.zone, null)
  assert.equal(d.source, 'disabled')
})

test('derive: unmanaged contexts are never spoofed', () => {
  const d = derive({ enabled: true, config: null, intl: Intl })
  assert.equal(d.zone, null)
  assert.equal(d.source, 'unmanaged')
})

test('derive: trusted probe geography wins over the relay listing', () => {
  // assigned to Sweden, but the verified exit answered from the US:
  // the observed exit is what sites see, so it is what pages present
  const d = derive({ enabled: true, geo: GEO_US, geoTrusted: true, config: CFG_SE, intl: Intl })
  assert.equal(d.zone, 'America/New_York')
  assert.equal(d.source, 'probe')
})

test('derive: untrusted probe geography is ignored', () => {
  const d = derive({ enabled: true, geo: GEO_US, geoTrusted: false, config: CFG_SE, intl: Intl })
  assert.equal(d.zone, 'Europe/Stockholm')
  assert.equal(d.source, 'relay')
})

test('derive: relay listing carries a fresh assignment before its first probe', () => {
  const d = derive({ enabled: true, geo: null, config: { city: 'Gothenburg', country: 'Sweden', cc: 'se' }, intl: Intl })
  assert.equal(d.zone, 'Europe/Stockholm')
  assert.equal(d.source, 'relay')
})

test('derive: nothing to work with says unknown, not UTC', () => {
  // a custom exit with no listed geography and no probe answer yet
  const d = derive({ enabled: true, config: { city: '', country: '', cc: '' }, intl: Intl })
  assert.equal(d.zone, null)
  assert.equal(d.source, 'unknown')
})
