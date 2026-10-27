'use strict'
// Runs the ACTUAL registered payload — the same string tz.js hands to
// browser.contentScripts.register — inside a fresh node:vm context, then
// replays CreepJS's own derivations against the patched realm and checks
// every value a fingerprinter can reach.
//
// Caveat, stated honestly: node:vm is V8 and production is SpiderMonkey. The
// engine was field-verified against Gecko by the upstream userscript; what
// this suite proves is that the PORT is faithful — payload construction,
// config plumbing, and every observable the patch claims to own.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const realmSrc = fs.readFileSync(path.join(__dirname, '../../src/tz-realm.js'), 'utf8')

// ICU ground truth from THIS realm, which is never patched.
function icuOffsetMinutes (zone, ts) {
  // formatToParts drops milliseconds; truncate the instant too, exactly like
  // the engine's own offsetMsAt does, or the division below leaks sub-minute
  // remainder into the comparison.
  ts = ts - (ts % 1000)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
  const p = {}
  for (const x of dtf.formatToParts(new Date(ts))) p[x.type] = x.value
  let hour = parseInt(p.hour, 10)
  if (hour === 24) hour = 0
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second)
  // ts - asUTC: negative for zones east of UTC — i.e. exactly the sign
  // getTimezoneOffset() uses (minutes WEST). Whole-minute for every modern
  // offset, so truncation only matters for the LMT probes.
  return (ts - asUTC) / 60000
}

// The probe, run inside the patched context. Everything CreepJS's timezone
// module measures, plus the lie-detection invariants its searchLies() applies
// to every patched prototype member.
const PROBE = `(function () {
  'use strict';
  var R = {};
  var now = new Date();
  R.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  R.offset = now.getTimezoneOffset();
  R.toString = String(now);
  R.offsetComputed = (function () {
    var p = JSON.stringify(now).slice(1, 11).split('-');
    var y = p[0], m = p[1], d = p[2];
    return ~~((+new Date(m + '/' + d + '/' + y) - +new Date(y + '-' + m + '-' + d)) / 60000);
  })();
  // CreepJS decryptLocation, year 1113 — the LMT-era "computed location"
  var anchor = +new Date('1113-07-01');
  var system = (+new Date('7/1/1113') - anchor) / 60000;
  var f = new Intl.DateTimeFormat('en', {
    timeZone: R.tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  });
  var resolved = (+new Date(f.format(new Date('7/1/1113'))) - anchor) / 60000;
  R.lmtSystem = system;
  R.lmtResolved = resolved;
  R.lmtMatch = system === resolved;
  R.locationEpoch = +new Date(new Date('7/1/1113'));
  // explicit zones must still be honoured — a blanket override is a lie
  R.explicitHonoured = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo' }).resolvedOptions().timeZone === 'Asia/Tokyo';
  R.localeTokyoHour = new Date('2026-01-15T12:00:00Z').toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' });
  // internal consistency: local getters vs Intl for one instant
  R.gettersAgree = now.getHours() === +new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23' }).format(now);
  // setters round-trip
  var s = new Date(now.getTime());
  s.setHours(5, 43, 21, 123);
  R.setterRoundTrip = s.getHours() === 5 && s.getMinutes() === 43 && s.getSeconds() === 21 && s.getMilliseconds() === 123;
  // invalid input stays invalid
  R.invalid = String(new Date('not a date at all')) === 'Invalid Date';
  // Date() as a function returns a string, per spec
  R.dateCallType = typeof Date();
  // ISO absolute forms pass through untouched
  R.isoRoundTrip = JSON.stringify(new Date('2026-07-01T00:00:00.000Z')) === '"2026-07-01T00:00:00.000Z"';
  R.isoValueOf = +new Date('2026-07-01T00:00:00Z');
  // toString round-trip: an absolute string (zone designator) reparses to the
  // same SECOND — toString drops milliseconds by spec, so that is the exact
  // fidelity a round-trip can have
  R.toStringRoundTrip = +new Date(String(now)) === (+now - (+now % 1000));
  // winter and summer offsets against nothing — the harness compares to ICU
  R.winterOffset = new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset();
  R.summerOffset = new Date(Date.UTC(2026, 6, 15, 12)).getTimezoneOffset();
  // the wall clock a local parse lands on, for harness comparison
  R.localNoon = +new Date('2026/07/01 12:00:00');
  // ---- lie-detection invariants (CreepJS searchLies) ----
  var fn = Date.prototype.getHours;
  R.ownProps = JSON.stringify(Object.getOwnPropertyNames(fn));
  R.noPrototype = !Object.prototype.hasOwnProperty.call(fn, 'prototype');
  R.callerThrows = (function () { try { return String(fn.caller), false } catch (e) { return e instanceof TypeError && /strict mode/.test(e.message) } })();
  R.argumentsThrows = (function () { try { return String(fn.arguments), false } catch (e) { return e instanceof TypeError && /strict mode/.test(e.message) } })();
  R.toStringDisguise = fn.toString() === 'function getHours() { [native code] }';
  R.ctorToStringDisguise = Date.toString() === 'function Date() { [native code] }';
  R.dtfToStringDisguise = Intl.DateTimeFormat.toString() === 'function DateTimeFormat() { [native code] }';
  // prototype identity must survive: instanceof and getPrototypeOf
  R.instanceOf = now instanceof Date;
  R.protoIdentity = Object.getPrototypeOf(new Intl.DateTimeFormat()) === Intl.DateTimeFormat.prototype;
  return JSON.stringify(R);
})()`

function buildContext (zone) {
  const ctx = vm.createContext({ console: { log () {}, warn () {}, error () {}, debug () {} } })
  // Load the engine exactly as the manifest does, then build the registered
  // payload exactly as tz.js does: serialise the function, inline it, pass a
  // reference to itself for the worker shims.
  vm.runInContext(realmSrc, ctx)
  const fn = vm.runInContext('installTZRealm.toString()', ctx)
  const cfg = { timeZone: zone, stealth: 'deep', workerMode: 'all', serviceWorkerMode: 'warn', debug: false }
  const code
    = '(function () {\n"use strict";\n'
      + 'var LATE = (function () { try { if (document.readyState && document.readyState !== "loading") return true; '
      + 'return !!(document.scripts && document.scripts.length) } catch (e) { return false } })();\n'
      + 'if (LATE && window === window.top) console.warn("[bulkhead-tz] late");\n'
      + '(function (__tzl, __cfg) { __tzl(__cfg, __tzl); })(' + fn + ', ' + JSON.stringify(cfg) + ');\n'
      + '})();'
  vm.runInContext(code, ctx)
  return ctx
}

const ZONES = ['Europe/Oslo', 'Asia/Kolkata', 'Pacific/Chatham', 'America/New_York', 'UTC']

for (const zone of ZONES) {
  test(`realm patch presents ${zone} consistently everywhere CreepJS looks`, () => {
    const ctx = buildContext(zone)
    const R = JSON.parse(vm.runInContext(PROBE, ctx))

    // 1. the reported zone IS the installed zone — as this engine's ICU
    //    canonicalises it (older ICU answers Asia/Calcutta for Asia/Kolkata;
    //    the engine faithfully reports whatever the realm's ICU says, which
    //    is the whole point of delegating canonicalisation to it)
    const canon = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    assert.equal(R.tz, canon)

    // 2. getTimezoneOffset agrees with ICU, winter AND summer
    const WINTER = Date.UTC(2026, 0, 15, 12)
    const SUMMER = Date.UTC(2026, 6, 15, 12)
    assert.equal(R.winterOffset, Math.trunc(icuOffsetMinutes(zone, WINTER)), 'winter offset')
    assert.equal(R.summerOffset, Math.trunc(icuOffsetMinutes(zone, SUMMER)), 'summer offset')

    // 3. CreepJS offsetComputed === offset (its first consistency check)
    assert.equal(R.offsetComputed, R.offset, 'offsetComputed')
    assert.equal(R.offset, Math.trunc(icuOffsetMinutes(zone, Date.now())), 'current offset')

    // 4. CreepJS year-1113 LMT: system === resolvedOptions, so its binary
    //    search short-circuits to the reported zone ("computed location"
    //    matches "location" — the check that beat every offset-only spoof)
    assert.equal(R.lmtMatch, true, 'year-1113 LMT match')
    // and the LMT offset it derived is genuinely the zone's, per ICU
    const lmtIcu = (() => {
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
      // format the instant the patched realm parsed '7/1/1113' to, from ICU
      const instant = vm.runInContext('+new Date("7/1/1113")', ctx)
      const p = {}
      for (const x of f.formatToParts(new Date(instant))) p[x.type] = x.value
      let hour = parseInt(p.hour, 10)
      if (hour === 24) hour = 0
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second)
      return (instant - asUTC) / 60000
    })()
    assert.equal(R.lmtSystem, lmtIcu, 'LMT offset matches ICU for the zone')

    // 5. a local wall-clock parse lands exactly where ICU says that wall
    //    clock exists in the zone (this is the mechanism behind 3 and 4)
    const expectedNoon = Date.UTC(2026, 6, 1, 12) + icuOffsetMinutes(zone, Date.UTC(2026, 6, 1, 12)) * 60000
    assert.equal(R.localNoon, expectedNoon, 'local string parse re-homed')

    // 6. explicit timezones are honoured — no blanket lie
    assert.equal(R.explicitHonoured, true)
    assert.equal(R.localeTokyoHour, '21', 'Tokyo hour from UTC noon in January')

    // 7. internal consistency and spec corners
    assert.equal(R.gettersAgree, true)
    assert.equal(R.setterRoundTrip, true)
    assert.equal(R.invalid, true)
    assert.equal(R.dateCallType, 'string')
    assert.equal(R.isoRoundTrip, true)
    assert.equal(R.isoValueOf, Date.UTC(2026, 6, 1))
    assert.equal(R.toStringRoundTrip, true)

    // 8. lie-detection invariants (CreepJS searchLies, point by point)
    assert.equal(R.ownProps, '["length","name"]')
    assert.equal(R.noPrototype, true)
    assert.equal(R.callerThrows, true)
    assert.equal(R.argumentsThrows, true)
    assert.equal(R.toStringDisguise, true)
    assert.equal(R.ctorToStringDisguise, true)
    assert.equal(R.dtfToStringDisguise, true)
    assert.equal(R.instanceOf, true)
    assert.equal(R.protoIdentity, true)

    // 9. toString carries the zone's GMT label and CLDR name
    assert.match(R.toString, /GMT[+-]\d{4}|\bUTC\b|GMT$/)
  })
}

test('zone validation: a rejected zone leaves the realm untouched', () => {
  // build() validates the zone against the realm's ICU before touching
  // anything; a bad zone must produce NO patch rather than a half patch.
  const ctx = vm.createContext({ console: { log () {}, warn () {}, error () {}, debug () {} } })
  vm.runInContext(realmSrc, ctx)
  const cfg = { timeZone: 'Mars/Olympus_Mons', stealth: 'deep', workerMode: 'off', serviceWorkerMode: 'warn', debug: false }
  vm.runInContext(
    '(function (__tzl, __cfg) { __tzl(__cfg, __tzl); })(installTZRealm, ' + JSON.stringify(cfg) + ');',
    ctx
  )
  const unpatched = vm.runInContext('Date.prototype.getHours.toString().indexOf("[native code]") !== -1 && Intl.DateTimeFormat.name === "DateTimeFormat"', ctx)
  assert.equal(unpatched, true)
})

test('payload is self-contained: no free identifiers beyond its own wrapper', () => {
  // The registered code must not reference anything from background scope —
  // a stray identifier would be a ReferenceError in the page realm.
  const ctx = vm.createContext({ console: { log () {}, warn () {}, error () {}, debug () {} } })
  vm.runInContext(realmSrc, ctx)
  const fn = vm.runInContext('installTZRealm.toString()', ctx)
  for (const banned of ['zonelib', 'tzlib', 'relaylib', 'browser.', 'state.', 'SYSTEM_ZONE', 'installRealm']) {
    assert.equal(fn.includes(banned), false, `engine source must not reference ${banned}`)
  }
})
