'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  timeAgo, healthLabel, healthClass, explainDetail, rawDetail, flagSrc, relayTags, tunnelSuspect, tunnelHint, blockedNext, nameList, usedBy
} = require('../../src/ui/fmt.js')
const { decide } = require('../../src/decide.js')

test('timeAgo covers every bucket and its boundaries', () => {
  const now = 1_000_000_000_000
  assert.equal(timeAgo(undefined, now), '')
  assert.equal(timeAgo(0, now), '')
  assert.equal(timeAgo(now, now), 'just now')
  assert.equal(timeAgo(now - 4_999, now), 'just now')
  assert.equal(timeAgo(now - 5_000, now), '5s ago')
  assert.equal(timeAgo(now - 59_000, now), '59s ago')
  assert.equal(timeAgo(now - 60_000, now), '1m ago')
  assert.equal(timeAgo(now - 59 * 60_000, now), '59m ago')
  assert.equal(timeAgo(now - 60 * 60_000, now), '1h ago')
  assert.equal(timeAgo(now - 23 * 3_600_000, now), '23h ago')
  assert.equal(timeAgo(now - 24 * 3_600_000, now), '1d ago')
  assert.equal(timeAgo(now + 60_000, now), 'just now', 'clock skew must not go negative')
})

test('every blocking state says so in words, not just in colour', () => {
  assert.equal(healthLabel('up'), 'Protected')
  for (const h of ['down', 'misrouted', 'unknown']) {
    assert.match(healthLabel(h), /^Blocked/, h)
  }
  assert.equal(healthLabel(undefined), 'Not protected')
})

test('an unrecognised health value fails loud rather than reassuring', () => {
  // the dangerous regression is a future state rendering as "Not protected"
  // (grey, sounds inert) or worse as "Protected"
  const fallback = healthLabel('weird')
  assert.match(fallback, /^Blocked/)
  for (const h of ['up', 'down', 'misrouted', 'unknown']) {
    assert.notEqual(fallback, healthLabel(h), 'must not borrow a known label')
  }
  assert.equal(healthClass('weird'), 'down')
  assert.equal(healthClass('misrouted'), 'misrouted')
  assert.equal(healthClass(undefined), 'off')
})

test('explainDetail turns Gecko constants into something a person can act on', () => {
  assert.match(explainDetail('NS_ERROR_PROXY_CONNECTION_REFUSED'), /Mullvad app is not connected/)
  assert.match(explainDetail('NS_ERROR_NET_TIMEOUT'), /did not answer in time/)
  assert.match(explainDetail('expected se-got-wg-socks5-001, got de-fra-wg-socks5-002'), /different server/)
  assert.match(explainDetail('NS_ERROR_SOMETHING_NEW'), /connection to this server failed/)
  assert.match(explainDetail('The operation timed out.'), /did not answer in time/)
  assert.equal(explainDetail(''), '')
  assert.equal(explainDetail(undefined), '')
  // already-plain text passes through untouched
  assert.equal(explainDetail('Traffic came out somewhere else.'), 'Traffic came out somewhere else.')
})

test('no Gecko constant reaches the user as itself', () => {
  // The passthrough at the end of explainDetail means anything unrecognised
  // is shown verbatim, and rawDetail then suppresses the code line as a
  // duplicate -- so a constant that slips the net is all the user gets.
  for (const code of [
    'NS_ERROR_PROXY_CONNECTION_REFUSED', 'NS_ERROR_NET_RESET',
    'NS_ERROR_CONNECTION_REFUSED', 'NS_ERROR_ABORT', 'NS_BINDING_ABORTED',
    'NS_ERROR_UNKNOWN_HOST', 'NS_SOMETHING_UNSEEN'
  ]) {
    for (const custom of [false, true]) {
      const out = explainDetail(code, custom)
      assert.notEqual(out, code, `${code} (custom=${custom}) reached the user raw`)
      assert.match(out, /^[A-Z]/, code)
    }
  }
})

test('a custom exit is never told to check the Mullvad app', () => {
  // every relay-table entry that names Mullvad needs a custom-table twin
  for (const code of [
    'NS_ERROR_PROXY_CONNECTION_REFUSED',
    'NS_ERROR_UNKNOWN_PROXY_HOST',
    'NS_ERROR_PROXY_AUTHENTICATION_FAILED'
  ]) {
    assert.doesNotMatch(explainDetail(code, true), /Mullvad/, code)
  }
  assert.match(explainDetail('NS_ERROR_PROXY_CONNECTION_REFUSED', true), /Check it is running/)
  assert.match(explainDetail('NS_ERROR_PROXY_AUTHENTICATION_FAILED', true), /username and password/)
  // the relay wording is untouched for relays
  assert.match(explainDetail('NS_ERROR_PROXY_CONNECTION_REFUSED', false), /Mullvad app is not connected/)
})

test('rawDetail keeps the code only when it was replaced', () => {
  assert.equal(rawDetail('NS_ERROR_PROXY_CONNECTION_REFUSED'), 'NS_ERROR_PROXY_CONNECTION_REFUSED')
  assert.equal(rawDetail('Traffic came out somewhere else.'), '')
  assert.equal(rawDetail(undefined), '')
})

test('flagSrc only builds paths for sane codes', () => {
  assert.equal(flagSrc('se'), '/flags/se.svg')
  assert.equal(flagSrc('SE'), '')
  assert.equal(flagSrc('../x'), '')
  assert.equal(flagSrc(''), '')
})

test('relayTags marks ownership and only out-of-the-ordinary speed', () => {
  // 10G is the fleet minimum, so it earns no tag
  const base = { owned: false, speed: 10 }
  assert.deepEqual(relayTags(base), [])
  assert.deepEqual(relayTags({ ...base, owned: true }), ['owned'])
  assert.deepEqual(relayTags({ ...base, speed: 40 }), [])
  assert.deepEqual(relayTags({ owned: true, speed: 100 }), ['owned', '100G'])
})

test('tunnelSuspect needs every Mullvad exit down, and a Mullvad exit to ask about', () => {
  const down = { health: 'down' }
  assert.equal(tunnelSuspect({ a: down }, 'a'), true)
  assert.equal(tunnelSuspect({ a: down, b: down }, 'a'), true)
  // one exit answering proves Firefox is inside the tunnel; unknown and
  // misrouted prove nothing either way
  assert.equal(tunnelSuspect({ a: down, b: { health: 'up' } }, 'a'), false)
  assert.equal(tunnelSuspect({ a: down, b: { health: 'unknown' } }, 'a'), false)
  assert.equal(tunnelSuspect({ a: down, b: { health: 'misrouted' } }, 'a'), false)
  assert.equal(tunnelSuspect({ a: { health: 'unknown' } }, 'a'), false)
  // custom exits are not in the tunnel and say nothing about it
  assert.equal(tunnelSuspect({ a: down, b: { custom: true, health: 'up' } }, 'a'), true)
  assert.equal(tunnelSuspect({ a: { custom: true, health: 'down' }, b: down }, 'a'), false)
  assert.equal(tunnelSuspect({ a: down }, 'gone'), false)
  assert.equal(tunnelSuspect({}, ''), false)
  // inherited keys are not assignments, and a null entry is not a config
  assert.equal(tunnelSuspect({}, '__proto__'), false)
  assert.equal(tunnelSuspect({}, 'constructor'), false)
  assert.equal(tunnelSuspect(/** @type {any} */ ({ a: down, b: null }), 'a'), true)
})

test('tunnelHint waits for the exit to fail again before blaming the tunnel', () => {
  const at = 1_000_000
  /** @param {number} healthAt @param {Record<string, object>} [others] @param {string[]} [offline] */
  const st = (healthAt, others = {}, offline = []) => ({
    containers: { a: { health: 'down', healthAt }, ...others },
    relays: { offline: offline.map(cookieStoreId => ({ cookieStoreId })) }
  })

  assert.equal(tunnelHint(st(at), 'a', at, false), false)
  // a verdict restamped seconds later by a request already in flight is the
  // same outage, not a second check; a Re-check by the page counts at once
  assert.equal(tunnelHint(st(at + 5_000), 'a', at, false), false)
  assert.equal(tunnelHint(st(at + 19_999), 'a', at, false), false)
  assert.equal(tunnelHint(st(at + 20_000), 'a', at, false), true)
  assert.equal(tunnelHint(st(at), 'a', at, true), true)
  // an older snapshot arriving late
  assert.equal(tunnelHint(st(at - 60_000), 'a', at, false), false)
  assert.equal(tunnelHint(st(at + 60_000), 'a', undefined, true), false)

  // anything that already explains the failure
  assert.equal(tunnelHint(st(at, { b: { health: 'up' } }), 'a', at, true), false)
  assert.equal(tunnelHint(st(at, {}, ['a']), 'a', at, true), false)
  assert.equal(tunnelHint(st(at, {}, ['b']), 'a', at, true), true)
  assert.equal(tunnelHint({ containers: { a: { health: 'misrouted', healthAt: at } }, relays: { offline: [] } }, 'a', at, true), false)
  assert.equal(tunnelHint({ containers: { a: { custom: true, health: 'down', healthAt: at } }, relays: { offline: [] } }, 'a', at, true), false)
  assert.equal(tunnelHint(st(at), '__proto__', at, true), false)
})

const REASONS = ['not-ready', 'proxy-unverified', 'proxy-down', 'misrouted', 'no-proxy', 'error', 'unattributed', 'speculative', 'unknown', '']
const WAITING = ['not-ready', 'proxy-unverified']

test('blockedNext continues a page that was only waiting, and nothing else', () => {
  /** @param {string} [health] @param {boolean} [ready] */
  const st = (health, ready = true) => ({ ready, containers: health ? { a: { health } } : {} })
  /** @param {string} reason @param {ReturnType<typeof st>} s @param {boolean} [managed] */
  const next = (reason, s, managed = false) => blockedNext(reason, s, 'a', managed)

  // before the settings are read a list means nothing, whatever it holds
  for (const reason of REASONS) {
    for (const health of [undefined, 'up', 'down']) {
      assert.deepEqual(next(reason, st(health, false)), { next: 'wait', show: '' }, `${reason}/${health}`)
    }
  }

  // stopped at startup with no server set: nothing left to wait for
  assert.deepEqual(next('not-ready', st()), { next: 'go', show: '' })
  // unassigned while the page sat open is not the same thing, and the page
  // must not be put back to a promise to load
  assert.deepEqual(next('not-ready', st(), true), { next: 'stop', show: '' })
  for (const reason of REASONS.filter(r => r !== 'not-ready')) {
    for (const managed of [true, false]) {
      assert.deepEqual(next(reason, st(), managed), { next: 'stop', show: '' }, `${reason}/${managed}`)
    }
  }

  for (const waiting of WAITING) {
    assert.deepEqual(next(waiting, st('up')), { next: 'go', show: '' }, waiting)
    assert.deepEqual(next(waiting, st('unknown')), { next: 'wait', show: 'proxy-unverified' }, waiting)
    // a failed check is shown for what it is, and the page keeps waiting
    assert.deepEqual(next(waiting, st('down')), { next: 'wait', show: 'proxy-down' }, waiting)
    assert.deepEqual(next(waiting, st('misrouted')), { next: 'wait', show: 'misrouted' }, waiting)
  }

  // opened on a failure: report the recovery, leave the loading to a click
  for (const failed of REASONS.filter(r => !WAITING.includes(r))) {
    assert.deepEqual(next(failed, st('up')), { next: 'back', show: '' }, failed)
    for (const h of ['down', 'misrouted', 'unknown']) {
      assert.deepEqual(next(failed, st(h)), { next: 'wait', show: '' }, `${failed}/${h}`)
    }
  }

  // inherited keys are not containers
  assert.equal(blockedNext('proxy-down', st('up'), '__proto__', false).next, 'stop')
  assert.equal(blockedNext('proxy-unverified', st('up'), 'constructor', false).next, 'stop')
})

test('blockedNext never continues while a managed exit is not up', () => {
  for (const reason of REASONS) {
    for (const health of ['down', 'misrouted', 'unknown', undefined, 'nonsense']) {
      for (const ready of [true, false]) {
        for (const managed of [true, false]) {
          const out = blockedNext(reason, { ready, containers: { a: { health } } }, 'a', managed)
          assert.equal(out.next, 'wait', `${reason}/${health}/${ready}/${managed}`)
        }
      }
    }
  }
})

test('blockedNext shows a waiting page the reason the gate would give', () => {
  for (const health of ['down', 'misrouted', 'unknown', 'nonsense', undefined]) {
    const containers = { a: { ip: '10.124.0.1', port: 1080, health } }
    const gate = decide(
      /** @type {any} */ ({ ready: true, strict: true, containers, probeTokens: new Set() }),
      { url: 'https://example.com/', cookieStoreId: 'a', type: 'main_frame' }
    )
    assert.equal(gate.verdict, 'block', String(health))
    for (const waiting of WAITING) {
      assert.equal(blockedNext(waiting, { ready: true, containers }, 'a', false).show, gate.reason, `${waiting}/${health}`)
    }
  }
})

test('nameList reads as English for one, two and more names', () => {
  assert.equal(nameList([]), '')
  assert.equal(nameList(['Work']), 'Work')
  assert.equal(nameList(['Work', 'Banking']), 'Work and Banking')
  assert.equal(nameList(['Work', 'Banking', 'Shopping']), 'Work, Banking and Shopping')
})

test('usedBy names the contexts on each host and never shows a raw id', () => {
  const assigned = new Map([['se-got-wg-001', ['firefox-container-1', 'firefox-container-9']], ['custom:abc', ['firefox-default']]])
  const names = { 'firefox-container-1': 'Work', 'firefox-default': 'No container' }
  assert.deepEqual(usedBy(assigned, names), {
    'se-got-wg-001': ['Work', 'another container'],
    'custom:abc': ['No container']
  })
  assert.deepEqual(usedBy(new Map(), names), {})
})
