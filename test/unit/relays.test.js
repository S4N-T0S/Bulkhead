'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  adaptPublic, adaptTunnel, searchRelays, groupByLocation, findRelay,
  alternativeFor, offlineAssigned, mergeAssignments, isTunnelAddress, configKey, renamedTo
} = require('../../src/relays.js')

function publicEntry (over = {}) {
  return {
    hostname: 'se-got-wg-001',
    country_code: 'SE',
    country_name: 'Sweden',
    city_code: 'got',
    city_name: 'Gothenburg',
    fqdn: 'se-got-wg-001.relays.mullvad.net',
    active: true,
    owned: true,
    provider: '31173',
    network_port_speed: 10,
    type: 'wireguard',
    status_messages: [],
    socks_name: 'se-got-wg-socks5-001.relays.mullvad.net',
    socks_port: 1080,
    daita: true,
    ...over
  }
}

test('adaptPublic maps the fields that matter', () => {
  const [r] = adaptPublic([publicEntry()])
  assert.deepEqual(r, {
    host: 'se-got-wg-001',
    socksName: 'se-got-wg-socks5-001.relays.mullvad.net',
    socksHost: 'se-got-wg-socks5-001',
    socksPort: 1080,
    cc: 'se',
    country: 'Sweden',
    city: 'Gothenburg',
    active: true,
    owned: true,
    speed: 10,
    messages: []
  })
})

test('adaptPublic keeps inactive relays but skips the unusable', () => {
  const out = adaptPublic([
    publicEntry(),
    publicEntry({ hostname: 'se-got-wg-002', socks_name: 'se-got-wg-socks5-002.relays.mullvad.net', active: false }),
    publicEntry({ hostname: 'se-got-ovpn-001', type: 'openvpn' }),
    publicEntry({ hostname: 'se-got-wg-003', socks_name: undefined }),
    publicEntry({ hostname: 'net<script>', socks_name: 'x.y' }),
    { unrelated: true }
  ])
  assert.deepEqual(out.map(r => [r.host, r.active]), [['se-got-wg-001', true], ['se-got-wg-002', false]])
})

test('adaptPublic normalises status messages in both observed shapes', () => {
  const [r] = adaptPublic([publicEntry({
    status_messages: ['maintenance tonight', { message: 'packet loss reported' }, { other: 'x' }]
  })])
  assert.deepEqual(r.messages, ['maintenance tonight', 'packet loss reported'])
})

test('adaptPublic rejects payloads that are not a usable list', () => {
  assert.throws(() => adaptPublic({ not: 'an array' }))
  assert.throws(() => adaptPublic([]))
  assert.throws(() => adaptPublic([publicEntry({ type: 'openvpn' })]))
})

test('adaptTunnel maps a plausible socks-proxies shape', () => {
  const out = adaptTunnel([
    { name: 'se-got-wg-socks5-001.relays.mullvad.net', port: 1080, country: 'Sweden', city: 'Gothenburg' },
    { name: 'de-fra-wg-socks5-002.relays.mullvad.net', port: 1080, country: 'Germany', city: 'Frankfurt' }
  ])
  assert.equal(out.length, 2)
  assert.equal(out[1].host, 'se-got-wg-001')
  assert.equal(out[1].socksHost, 'se-got-wg-socks5-001')
  assert.equal(out[0].cc, 'de')
  assert.equal(out[1].cc, 'se')
})

test('adaptTunnel throws when the shape drifts', () => {
  assert.throws(() => adaptTunnel('nope'))
  assert.throws(() => adaptTunnel([{ foo: 1 }, { bar: 2 }]))
  // half the entries unusable -> refuse the truncated world
  assert.throws(() => adaptTunnel([
    { name: 'se-got-wg-socks5-001.relays.mullvad.net' },
    { name: 'garbage' },
    { name: 'more-garbage' }
  ]))
})

const LIST = adaptPublic([
  publicEntry(),
  publicEntry({ hostname: 'se-got-wg-002', socks_name: 'se-got-wg-socks5-002.relays.mullvad.net', owned: false, daita: false, network_port_speed: 1 }),
  publicEntry({ hostname: 'se-sto-wg-001', socks_name: 'se-sto-wg-socks5-001.relays.mullvad.net', city_code: 'sto', city_name: 'Stockholm' }),
  publicEntry({ hostname: 'de-fra-wg-001', socks_name: 'de-fra-wg-socks5-001.relays.mullvad.net', country_code: 'DE', country_name: 'Germany', city_code: 'fra', city_name: 'Frankfurt', owned: false }),
  publicEntry({ hostname: 'de-fra-wg-002', socks_name: 'de-fra-wg-socks5-002.relays.mullvad.net', country_code: 'DE', country_name: 'Germany', city_code: 'fra', city_name: 'Frankfurt', active: false })
])

test('searchRelays matches country, city and hostname, active only', () => {
  assert.deepEqual(searchRelays(LIST, 'gothen').map(r => r.host), ['se-got-wg-001', 'se-got-wg-002'])
  assert.deepEqual(searchRelays(LIST, 'Germany').map(r => r.host), ['de-fra-wg-001'])
  assert.deepEqual(searchRelays(LIST, 'sto-wg').map(r => r.host), ['se-sto-wg-001'])
  assert.equal(searchRelays(LIST, '').length, 4)
  // de-fra-wg-002 matches but is inactive
  assert.deepEqual(searchRelays(LIST, 'frankfurt').map(r => r.host), ['de-fra-wg-001'])
})

test('searchRelays applies the owned filter', () => {
  assert.deepEqual(searchRelays(LIST, '', { ownedOnly: true }).map(r => r.host), ['se-got-wg-001', 'se-sto-wg-001'])
})

test('groupByLocation groups sorted relays by country then city', () => {
  const groups = groupByLocation(LIST)
  assert.deepEqual(groups.map(g => g.country), ['Germany', 'Sweden'])
  assert.deepEqual(groups[1].cities.map(c => c.city), ['Gothenburg', 'Stockholm'])
  assert.deepEqual(groups[1].cities[0].relays.map(r => r.host), ['se-got-wg-001', 'se-got-wg-002'])
})

test('alternativeFor prefers the same city, then the same country', () => {
  const gone = findRelay(LIST, 'se-got-wg-002')
  assert.equal(alternativeFor(LIST, gone).host, 'se-got-wg-001')
  const stockholm = findRelay(LIST, 'se-sto-wg-001')
  assert.equal(alternativeFor(LIST, stockholm).host, 'se-got-wg-001')
  const onlyDe = LIST.filter(r => r.cc === 'de')
  assert.equal(alternativeFor(onlyDe, findRelay(LIST, 'se-got-wg-001')), undefined)
})

test('offlineAssigned flags inactive and vanished assignments with a replacement', () => {
  const containers = {
    'firefox-container-1': { ip: '10.124.0.1', port: 1080, host: 'de-fra-wg-002', socksHost: 'de-fra-wg-socks5-002', city: 'Frankfurt', country: 'Germany', cc: 'de' },
    'firefox-container-2': { ip: '10.124.0.2', port: 1080, host: 'se-got-wg-001', socksHost: 'se-got-wg-socks5-001', city: 'Gothenburg', country: 'Sweden', cc: 'se' },
    'firefox-container-3': { ip: '10.124.0.3', port: 1080, host: 'us-nyc-wg-999', socksHost: 'us-nyc-wg-socks5-999', city: 'New York', country: 'USA', cc: 'us' },
    // the tunnel's own endpoint has no relay-list identity and no offline
    // state; it must never be flagged
    'firefox-default': { ip: '10.64.0.1', port: 1080, host: 'mullvad-direct', socksHost: '', city: '', country: '', cc: '' }
  }
  const out = offlineAssigned(containers, LIST)
  assert.deepEqual(out.map(o => o.host), ['de-fra-wg-002', 'us-nyc-wg-999'])
  assert.equal(out[0].alternative.host, 'de-fra-wg-001')
  assert.equal(out[1].alternative, undefined)
})

test('mergeAssignments keeps health only where the proxy config is unchanged', () => {
  const prev = {
    a: { ip: '10.124.0.1', port: 1080, socksHost: 's-1', host: 'h-1', city: '', country: '', cc: '', health: 'up', healthAt: 5, exitIp: '1.2.3.4' },
    b: { ip: '10.124.0.2', port: 1080, socksHost: 's-2', host: 'h-2', city: '', country: '', cc: '', health: 'up' },
    gone: { ip: '10.124.0.9', port: 1080, socksHost: 's-9', host: 'h-9', city: '', country: '', cc: '', health: 'down' }
  }
  const next = {
    a: { ip: '10.124.0.1', port: 1080, socksHost: 's-1', host: 'h-1', city: '', country: '', cc: '' },
    b: { ip: '10.124.0.3', port: 1080, socksHost: 's-3', host: 'h-3', city: '', country: '', cc: '' },
    c: { ip: '10.124.0.4', port: 1080, socksHost: 's-4', host: 'h-4', city: '', country: '', cc: '' }
  }
  const { containers, stale } = mergeAssignments(prev, next)
  assert.equal(containers.a.health, 'up')
  assert.equal(containers.a.exitIp, '1.2.3.4')
  assert.equal(containers.b.health, 'unknown')
  assert.equal(containers.c.health, 'unknown')
  assert.ok(!('gone' in containers))
  assert.deepEqual(stale.sort(), ['b', 'c'])
})

test('isTunnelAddress accepts only Mullvad tunnel space', () => {
  // relays live in 10.124.x.x, the tunnel endpoint is 10.64.0.1
  for (const ip of ['10.124.0.1', '10.64.0.1', '10.64.0.0', '10.127.255.255']) {
    assert.equal(isTunnelAddress(ip), true, ip)
  }
  // the wider RFC 1918 ranges are what a hostile or captive LAN answers with
  for (const ip of ['192.168.1.1', '172.16.0.1', '172.31.255.255', '10.0.0.1', '10.63.255.255', '10.128.0.0']) {
    assert.equal(isTunnelAddress(ip), false, ip)
  }
  for (const ip of ['8.8.8.8', '10.0.0.256', 'fd00::1', '10.1.2', 'localhost', '']) {
    assert.equal(isTunnelAddress(ip), false, ip)
  }
})

test('renamedTo separates a renamed server from a real misroute', () => {
  const conf = {
    ip: '10.124.0.1',
    port: 1080,
    host: 'se-got-wg-009',
    socksHost: 'se-got-wg-socks5-009',
    city: 'Gothenburg',
    country: 'Sweden',
    cc: 'se'
  }
  // configured name gone, observed name present in the same city -> rename
  assert.equal(renamedTo(conf, 'se-got-wg-socks5-001', LIST).host, 'se-got-wg-001')

  // configured name still listed: traffic really did come out elsewhere
  const stillListed = { ...conf, host: 'se-got-wg-002', socksHost: 'se-got-wg-socks5-002' }
  assert.equal(renamedTo(stillListed, 'se-got-wg-socks5-001', LIST), undefined)

  // observed exit is in a different country -- never call that a rename
  assert.equal(renamedTo(conf, 'de-fra-wg-socks5-001', LIST), undefined)

  // observed exit is not in the list at all
  assert.equal(renamedTo(conf, 'xx-nowhere-wg-socks5-001', LIST), undefined)

  // an inactive replacement is not somewhere to send traffic
  const frankfurt = { ...conf, city: 'Frankfurt', cc: 'de', socksHost: 'de-fra-wg-socks5-009', host: 'de-fra-wg-009' }
  assert.equal(renamedTo(frankfurt, 'de-fra-wg-socks5-002', LIST), undefined)

  assert.equal(renamedTo(conf, '', LIST), undefined)
  assert.equal(renamedTo(conf, 'se-got-wg-socks5-001', []), undefined)
})

test('configKey distinguishes the things a probe verdict depends on', () => {
  const base = { ip: '10.124.0.1', port: 1080, socksHost: 'se-got-wg-socks5-001' }
  assert.equal(configKey(base), configKey({ ...base, city: 'elsewhere' }))
  assert.notEqual(configKey(base), configKey({ ...base, ip: '10.124.0.2' }))
  assert.notEqual(configKey(base), configKey({ ...base, port: 1081 }))
  assert.notEqual(configKey(base), configKey({ ...base, socksHost: 'de-fra-wg-socks5-001' }))
  assert.equal(configKey(undefined), '')
})

test('adaptPublic refuses ports that cannot become a valid ProxyInfo', () => {
  // an out-of-range port makes proxy.onRequest throw inside Firefox, and
  // Firefox answers an invalid ProxyInfo with a direct connection
  for (const bad of [0, -1, 70000, 1.5, '1080', null]) {
    const [r] = adaptPublic([publicEntry({ socks_port: bad })])
    assert.equal(r.socksPort, 1080, String(bad))
  }
  const [ok] = adaptPublic([publicEntry({ socks_port: 1081 })])
  assert.equal(ok.socksPort, 1081)
})

test('mergeAssignments treats credentials as config', () => {
  const a = { ip: '127.0.0.1', port: 1080, socksHost: '', host: 'custom:x', city: '', country: '', cc: '', username: 'u', password: 'p', health: 'up' }
  const same = mergeAssignments({ c1: a }, { c1: { ...a } })
  assert.equal(same.containers.c1.health, 'up')
  const { containers, stale } = mergeAssignments({ c1: a }, { c1: { ...a, password: 'q' } })
  assert.equal(containers.c1.health, 'unknown')
  assert.deepEqual(stale, ['c1'])
})
