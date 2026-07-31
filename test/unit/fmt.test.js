'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  timeAgo, healthLabel, healthClass, explainDetail, rawDetail, flagSrc, relayTags
} = require('../../src/ui/fmt.js')

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
  assert.match(healthLabel('weird'), /^Blocked/)
  assert.match(healthLabel('weird'), /unsure/)
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
  assert.equal(explainDetail('exit is not a Mullvad server'), 'exit is not a Mullvad server')
})

test('rawDetail keeps the code only when it was replaced', () => {
  assert.equal(rawDetail('NS_ERROR_PROXY_CONNECTION_REFUSED'), 'NS_ERROR_PROXY_CONNECTION_REFUSED')
  assert.equal(rawDetail('exit is not a Mullvad server'), '')
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
