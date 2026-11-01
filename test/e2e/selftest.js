'use strict'
// Appended to background.scripts by test/e2e/run.mjs, never shipped. Runs in
// the background context, so it reaches the real state, the real listeners
// and the real probe path. Results go to stdout as "[test] ..." lines via
// the same dump()-backed log the runner captures.
//
// TEST_TUNNEL is set by a generated test-config.js: cases that need live
// Mullvad relays are skipped without a tunnel, everything else runs anywhere.

/* global state, blockLog, lastBlockedPage, rerouted, routedAt, noteRouted, ROUTED_CAP, moveTail, tail, tailMovedAt, tailFrame, tailFrameLoading, tailFrameMoves:writable, TAIL_FRAME_MOVES, TAIL_FRAME_LOAD_MS, TAIL_OVERLAP_MS, TAIL_PERIOD_MS, assign, unassign, probe, probesInFlight, RECHECK_DELAY_MS, refreshRelays, refreshNotices, settingsOpened, noticesAsked:writable, installOpened:writable, fetchJson:writable, NOTICES_URL, PROBE_SPREAD_MS, relayMemo, relayRecheckAt:writable, applyHardening, saveCustomExit, log, TEST_TUNNEL, TEST_CANARY_PORT, TEST_SOCKS_PORT, TEST_FOREIGN_PORT, TEST_EXIT_PORT, TEST_LEAK_PORT, nextProbeAt, PROBE_INTERVAL_DOWN_MS */

;(() => {
  /** @param {string} line */
  const t = line => log(`[test] ${line}`)
  /** @param {number} ms */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  // skip the start-up wait, a fetch from the install tab would show right away
  const realNow = performance.now
  performance.now = () => Infinity

  // The block log is written before the listener returns, so asserting on it
  // proves the decision, not the outcome -- swap the return for {} and it
  // still reads as blocked. These watch what Firefox actually did with the
  // request: a cancelled one aborts and never completes.
  /** @type {Map<string, string>} */
  const outcomes = new Map()
  /** @param {string} marker @returns {string} */
  const outcomeOf = (marker) => {
    for (const [url, o] of outcomes) if (url.includes(marker)) return o
    return 'none'
  }
  browser.webRequest.onCompleted.addListener(
    d => outcomes.set(d.url, 'completed'), { urls: ['<all_urls>'] })
  browser.webRequest.onErrorOccurred.addListener(
    d => outcomes.set(d.url, d.error), { urls: ['<all_urls>'] })

  // Every notification the run creates. getAll() only lists ones still
  // showing, and headless Firefox may never show any.
  /** @type {string[]} */
  const notified = []
  const createNotification = browser.notifications.create
  browser.notifications.create = (id, opts) => {
    notified.push(String(id))
    return createNotification.call(browser.notifications, id, opts)
  }

  /** @param {() => boolean} cond @param {number} ms */
  async function waitFor (cond, ms) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (cond()) return true
      await sleep(250)
    }
    return cond()
  }

  async function run () {
    t('begin')
    await waitFor(() => state.ready, 8000)

    // the install tab reports in but doesn't fetch
    const installTab = () => browser.extension.getViews({ type: 'tab' }).some(v => v.location.pathname.endsWith('/options/options.html') && v.document.readyState === 'complete')
    await waitFor(installTab, 8000)
    await sleep(1000)
    performance.now = realNow
    t(`P install tab=${installTab()} reported=${!installOpened} asked=${noticesAsked}`)

    // No managed containers yet: the extension must be inert for a normal
    // tab. Its request must pass and leave no trace in the block log.
    const inertMoved = tailMovedAt
    const inertTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-inert', active: false })
    await sleep(6000)
    t(`O inert moved=${tailMovedAt !== inertMoved} listening=${Boolean(tail) && tail.api.hasListener(tail.fn)}`)
    const inertHit = blockLog.find(b => b.url.includes('bulkhead-inert'))
    // the positive path: with nothing managed the request must genuinely
    // complete, not merely go unblocked
    t(`inert ok=${!inertHit && outcomeOf('bulkhead-inert') === 'completed'} outcome=${outcomeOf('bulkhead-inert')}`)
    if (inertTab.id !== undefined) await browser.tabs.remove(inertTab.id)

    // Dead proxy: an address inside Mullvad's SOCKS range with no listener.
    // Without a tunnel it is unroutable, with one it refuses -- either way
    // the probe cannot succeed, and the killswitch must cancel a real
    // navigation instead of letting Firefox fall through to direct.
    const dead = await browser.contextualIdentities.create({ name: 'bulkhead-dead', color: 'red', icon: 'circle' })
    const deadId = dead.cookieStoreId
    const stored = { ip: '10.124.255.254', port: 1080, host: 'test-dead', socksHost: 'test-dead-socks5', city: 'Nowhere', country: 'Nowhere', cc: 'xx' }
    // A relay-backed failure fetches the relay list. Without a tunnel that
    // lands over the runner's own connection and seeds the cache case D
    // needs empty, so the trigger is parked here; the tunnel run asserts it.
    if (!TEST_TUNNEL) relayRecheckAt = Date.now()
    const firstMoved = tailMovedAt
    await browser.storage.local.set({ containers: { [deadId]: stored } })
    await waitFor(() => deadId in state.containers, 5000)
    t(`O first moved=${tailMovedAt !== firstMoved}`)
    await waitFor(() => {
      const c = state.containers[deadId]
      return Boolean(c && c.health === 'down')
    }, 15000)
    const deadHealth = state.containers[deadId] && state.containers[deadId].health
    t(`A health=${deadHealth}`)
    if (TEST_TUNNEL) {
      const refreshed = await waitFor(() => relayMemo.relays.length > 0, 30000)
      t(`A relays refreshed=${refreshed} triggered=${relayRecheckAt > 0}`)
    }

    const deadTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-dead', cookieStoreId: deadId, active: false })
    await sleep(5000)
    const deadHit = blockLog.find(b => b.container === deadId && b.url.includes('bulkhead-dead'))
    t(`A blocked=${Boolean(deadHit)} reason=${deadHit ? deadHit.reason : 'NONE-LEAKED'}`)
    // the assertion that actually matters: Firefox aborted it, and it never
    // completed by any route
    const deadOutcome = outcomeOf('bulkhead-dead')
    t(`A cancelled=${deadOutcome !== 'completed' && deadOutcome !== 'none'} outcome=${deadOutcome}`)
    // cancellation alone is not the promise -- the explainer page must have
    // actually rendered in the tab
    await waitFor(() => Boolean(lastBlockedPage && lastBlockedPage.container === deadId), 6000)
    t(`A blockedpage shown=${Boolean(lastBlockedPage && lastBlockedPage.container === deadId)}`)
    if (deadTab.id !== undefined) await browser.tabs.remove(deadTab.id)

    // The badge is per tab, so a blocked container with no tab in front is
    // named in every other tab's title instead.
    const otherTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-hint', active: false })
    let hint = ''
    for (let i = 0; i < 32 && !hint.includes('blocked elsewhere'); i++) {
      await sleep(250)
      if (otherTab.id !== undefined) hint = await browser.browserAction.getTitle({ tabId: otherTab.id })
    }
    t(`A hint elsewhere=${hint.includes('blocked elsewhere: bulkhead-dead')} title=${hint}`)
    if (otherTab.id !== undefined) await browser.tabs.remove(otherTab.id)

    // Hardening: apply must take control of both settings, clear must give
    // them back untouched.
    const applied = await applyHardening(true)
    const applyOk = applied.webRTC.ok && applied.prediction.ok
      && applied.webRTC.levelOfControl === 'controlled_by_this_extension'
    const cleared = await applyHardening(false)
    const clearOk = !cleared.webRTC.ok && !cleared.prediction.ok
      && cleared.webRTC.levelOfControl !== 'controlled_by_this_extension'
    t(`harden apply=${applyOk ? 'ok' : JSON.stringify(applied)} clear=${clearOk ? 'ok' : JSON.stringify(cleared)}`)

    // Loopback, from a container that is blocked. A sign-in flow finishing
    // on 127.0.0.1 has to be reachable once the user opts in, and not one
    // moment before -- the container from case A is still down, so it is
    // exactly the right place to ask. The canary is the runner's own server,
    // so a completed request means the request really arrived.
    const loop = `http://127.0.0.1:${TEST_CANARY_PORT}/`
    const loopOffTab = await browser.tabs.create({ url: `${loop}?bulkhead-loopoff`, cookieStoreId: deadId, active: false })
    await sleep(4000)
    const loopOffHit = blockLog.find(b => b.container === deadId && b.url.includes('bulkhead-loopoff'))
    t(`F loopback off blocked=${Boolean(loopOffHit)} reason=${loopOffHit ? loopOffHit.reason : 'NONE-LEAKED'}`)
    if (loopOffTab.id !== undefined) await browser.tabs.remove(loopOffTab.id)

    await browser.storage.local.set({ allowLocal: true })
    await waitFor(() => state.allowLocal === true, 5000)
    const loopOnTab = await browser.tabs.create({ url: `${loop}?bulkhead-loopon`, cookieStoreId: deadId, active: false })
    await sleep(4000)
    const loopOnHit = blockLog.find(b => b.container === deadId && b.url.includes('bulkhead-loopon'))
    t(`F loopback on passed=${!loopOnHit && outcomeOf('bulkhead-loopon') === 'completed'} outcome=${outcomeOf('bulkhead-loopon')}`)
    // the hole is loopback-shaped: the same container stays shut otherwise
    const stillTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-loopother', cookieStoreId: deadId, active: false })
    await sleep(4000)
    t(`F loopback narrow stillblocked=${Boolean(blockLog.find(b => b.container === deadId && b.url.includes('bulkhead-loopother')))}`)
    for (const tab of [loopOnTab, stillTab]) {
      if (tab.id !== undefined) await browser.tabs.remove(tab.id)
    }
    await browser.storage.local.set({ allowLocal: false })
    await waitFor(() => state.allowLocal === false, 5000)

    // A custom exit is the user's own SOCKS server, with no expected exit
    // name to compare a probe against. It is held to the same rule anyway:
    // unproven blocks.
    const deadCx = await saveCustomExit({ label: 'e2e dead', host: '127.0.0.1', port: 1 })
    const cxIdent = await browser.contextualIdentities.create({ name: 'bulkhead-custom', color: 'purple', icon: 'circle' })
    const cxId = cxIdent.cookieStoreId
    const cxAssign = await assign(cxId, `custom:${deadCx.id}`)
    if (!cxAssign.ok) t(`FAIL custom assign: ${cxAssign.error}`)
    await waitFor(() => {
      const c = state.containers[cxId]
      return Boolean(c && c.health === 'down')
    }, 20000)
    const cxTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-cxdead', cookieStoreId: cxId, active: false })
    await sleep(5000)
    const cxDead = state.containers[cxId]
    const cxHit = blockLog.find(b => b.container === cxId && b.url.includes('bulkhead-cxdead'))
    t(`G custom dead health=${cxDead && cxDead.health} blocked=${Boolean(cxHit)}`)
    if (cxTab.id !== undefined) await browser.tabs.remove(cxTab.id)

    // Re-checking one container's dead exit must never move another
    // container's verdict. The probe is issued by this page, so its failure
    // events arrive labelled with the default context; before the proxyInfo
    // gate in onErrorOccurred, the refusal above landed on whatever exit the
    // default context was using whenever the token sweep won the race --
    // about every other click. The runner's own SOCKS listener stands in as
    // the healthy exit, so this holds with or without a tunnel.
    const localCx = await saveCustomExit({ label: 'e2e local', host: '127.0.0.1', port: TEST_SOCKS_PORT })
    const defLocal = await assign('firefox-default', `custom:${localCx.id}`)
    if (!defLocal.ok) t(`FAIL local assign: ${defLocal.error}`)
    // The first probe can miss its 10s timeout and the retry then waits out
    // the down interval, so the bound covers a full reschedule cycle. A local
    // exit that never verifies is an environment failure -- reported as its
    // own thing, because the loop below would misread it as interference.
    const localUp = await waitFor(() => {
      const c = state.containers['firefox-default']
      return Boolean(c && c.health === 'up')
    }, 60000)
    if (!localUp) {
      const c = state.containers['firefox-default']
      t(`FAIL I local exit never verified: health=${c && c.health} (${c && c.healthDetail})`)
    } else {
      let moved = ''
      for (let i = 0; i < 12 && !moved; i++) {
        await probe(cxId)
        const c = state.containers['firefox-default']
        if (!c || c.health !== 'up') moved = `${c && c.health} after ${i + 1} (${c && c.healthDetail})`
      }
      // stragglers: the event that does the damage can land after the probe
      // that provoked it has already settled
      await sleep(1500)
      const defLate = state.containers['firefox-default']
      if (!moved && defLate && defLate.health !== 'up') moved = `${defLate.health} late (${defLate.healthDetail})`
      t(`I interference clean=${!moved}${moved ? ` got=${moved}` : ''}`)
    }

    // A check carried off its server must park at 'unknown' and re-run, not
    // convict: Firefox blacklists a proxy for a second after any failed
    // connection through it, and a probe resolved inside that window rides
    // the failover path instead. probeTraversed is background.js's view of
    // whether the check travelled its own proxy, read from the global scope
    // at call time, so stubbing it stages the mis-carry against the healthy
    // local exit without needing a real blacklist race.
    if (localUp) {
      const defC = () => state.containers['firefox-default']
      // Straggler probes of the dead containers can hang up to the 10s
      // probe timeout; proceeding under one would let probesInFlight
      // swallow the probe a phase below is asserting on.
      const quiet = async () => {
        if (!await waitFor(() => probesInFlight.size === 0, 12000)) t('FAIL J probes never went quiet')
      }
      const realTraversed = globalThis.probeTraversed
      await quiet()
      globalThis.probeTraversed = () => false
      await probe('firefox-default')
      t(`J recheck parked=${Boolean(defC() && defC().health === 'unknown')} health=${defC() && defC().health}`)
      // an immediate repeat began inside the failover window, so it proves
      // nothing and must keep the container parked, not convict it
      await probe('firefox-default')
      t(`J recheck stillparked=${Boolean(defC() && defC().health === 'unknown')} health=${defC() && defC().health}`)
      // a mis-carry on a probe that began after the window is the real
      // verdict -- either the armed follow-up or the manual probe below
      // lands it, whichever is not thrown away as already in flight
      await quiet()
      await sleep(RECHECK_DELAY_MS + 200)
      await probe('firefox-default')
      const convicted = await waitFor(() => Boolean(defC() && defC().health === 'misrouted'), 15000)
      t(`J recheck convicted=${convicted} health=${defC() && defC().health}`)
      globalThis.probeTraversed = realTraversed
      await quiet()
      await probe('firefox-default')
      const healed = await waitFor(() => Boolean(defC() && defC().health === 'up'), 15000)
      t(`J recheck healed=${healed} health=${defC() && defC().health}`)
      // the 'up' verdict must have re-armed the retry, and the scheduled
      // follow-up probe must heal on its own once the route is honest again
      await quiet()
      globalThis.probeTraversed = () => false
      await probe('firefox-default')
      const rearmed = Boolean(defC() && defC().health === 'unknown')
      globalThis.probeTraversed = realTraversed
      t(`J recheck rearmed=${rearmed} health=${defC() && defC().health}`)
      const autohealed = await waitFor(() => Boolean(defC() && defC().health === 'up'), 15000)
      t(`J recheck autohealed=${autohealed} health=${defC() && defC().health}`)
    }
    await unassign('firefox-default')

    // A listener registered after Bulkhead's (MAC with a proxy on the same
    // container) takes tab traffic while the tab-less probe still passes.
    /** @param {string} [host] @returns {Promise<number>} */
    const carried = async (host = 'example.com') => {
      const hits = await (await fetch(`http://127.0.0.1:${TEST_CANARY_PORT}/foreign-hits`)).json()
      return hits.filter((/** @type {string} */ h) => h === host).length
    }
    const takeIdent = await browser.contextualIdentities.create({ name: 'bulkhead-takeover', color: 'orange', icon: 'circle' })
    const takeId = takeIdent.cookieStoreId
    const takeCx = await saveCustomExit({ label: 'e2e takeover', host: '127.0.0.1', port: TEST_SOCKS_PORT })
    await assign(takeId, `custom:${takeCx.id}`)
    if (!await waitFor(() => Boolean(state.containers[takeId] && state.containers[takeId].health === 'up'), 60000)) {
      t(`FAIL K exit never verified: ${JSON.stringify(state.containers[takeId])}`)
    }
    /** @type {'proxy' | 'null' | ''} */
    let late = 'proxy'
    // the default context's tabs too, for the stack case below; never its
    // tab-less requests, which include this page's own
    let lateDefault = false
    // and, for the probe case, the tab-less check itself
    let lateProbe = false
    /** @param {browser.proxy._OnRequestDetails} d */
    const lateListener = (d) => {
      const mine = d.cookieStoreId === takeId || (lateDefault && d.cookieStoreId === 'firefox-default' && d.tabId >= 0)
        || (lateProbe && d.tabId === -1 && d.url.includes('am.i.mullvad.net'))
      if (!mine || !late) return undefined
      return late === 'null' ? null : { type: 'socks', host: '127.0.0.1', port: TEST_FOREIGN_PORT, proxyDNS: true }
    }
    browser.proxy.onRequest.addListener(lateListener, { urls: ['<all_urls>'] })
    const takeBefore = await carried()
    const takeTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-takeover', cookieStoreId: takeId, active: false })
    await sleep(5000)
    const takeHit = blockLog.find(b => b.container === takeId && b.url.includes('bulkhead-takeover'))
    t(`K takeover blocked=${Boolean(takeHit)} reason=${takeHit ? takeHit.reason : 'NONE-LEAKED'} outcome=${outcomeOf('bulkhead-takeover')}`)
    t(`K takeover carried=${await carried() - takeBefore}`)
    await waitFor(() => Boolean(lastBlockedPage && lastBlockedPage.container === takeId), 6000)
    t(`K takeover blockedpage shown=${Boolean(lastBlockedPage && lastBlockedPage.container === takeId && lastBlockedPage.reason === 'rerouted')}`)
    // the exit itself is fine, and the flag is what tells the popup otherwise
    t(`K takeover health=${state.containers[takeId] && state.containers[takeId].health} flagged=${rerouted.has(Number(takeTab.id))}`)
    // null strips the proxy outright: a direct connection, the worse case
    late = 'null'
    const stripTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-stripped', cookieStoreId: takeId, active: false })
    await sleep(5000)
    const stripHit = blockLog.find(b => b.container === takeId && b.url.includes('bulkhead-stripped'))
    t(`K stripped blocked=${Boolean(stripHit)} reason=${stripHit ? stripHit.reason : 'NONE-LEAKED'} completed=${outcomeOf('bulkhead-stripped') === 'completed'} outcome=${outcomeOf('bulkhead-stripped')}`)
    // the same with only a page's subresources stripped: the page stays on
    // loopback, so a flag can only come from them
    const subTab = await browser.tabs.create({ url: `http://127.0.0.1:${TEST_CANARY_PORT}/strip-page`, cookieStoreId: takeId, active: false })
    await sleep(3000)
    const subHits = blockLog.filter(b => b.url.includes('bulkhead-strip-sub') && b.reason === 'rerouted').length
    const subDone = [...outcomes].filter(([u, o]) => u.includes('bulkhead-strip-sub') && o === 'completed').length
    t(`K stripped sub flagged=${rerouted.has(Number(subTab.id))} completed=${subDone} logged=${subHits}`)
    if (subTab.id !== undefined) await browser.tabs.remove(subTab.id).catch(() => null)
    // The check is routed by token and carries no tab, so a listener that
    // takes every tab-less request takes it too: it must be stopped before
    // it connects, and the container must say why it could not be checked,
    // without a log entry for every check.
    late = 'proxy'
    lateProbe = true
    const probeBefore = await carried('am.i.mullvad.net')
    await probe(takeId)
    const probed = state.containers[takeId]
    t(`K probe taken health=${probed && probed.health} carried=${await carried('am.i.mullvad.net') - probeBefore} logged=${blockLog.some(b => b.url.includes('am.i.mullvad.net'))} said=${Boolean(probed && /took the check/.test(probed.healthDetail || ''))}`)
    lateProbe = false
    await probe(takeId)
    await waitFor(() => Boolean(state.containers[takeId] && state.containers[takeId].health === 'up'), 20000)
    // A blocked page that continues by itself -- here one waiting on a fresh
    // exit's check -- runs straight into the takeover. The second blocked
    // page must replace the first, or Back lands on the one that continues.
    // Run in the default context: getViews cannot see an extension page in
    // a container tab.
    late = 'proxy'
    lateDefault = true
    await assign('firefox-default', `custom:${takeCx.id}`)
    const stackTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-stack', active: false })
    await waitFor(() => blockLog.some(b => b.url.includes('bulkhead-stack') && b.reason === 'rerouted'), 20000)
    await sleep(1500)
    const stackView = browser.extension.getViews({ type: 'tab' })
      .find(w => w.location.pathname.endsWith('/blocked/blocked.html') && w.location.search.includes('bulkhead-stack'))
    const stackReasons = blockLog.filter(b => b.url.includes('bulkhead-stack')).map(b => b.reason).reverse().join(',')
    t(`K stack depth=${stackView ? stackView.history.length : 'no-page'} reasons=${stackReasons}`)
    lateDefault = false
    if (stackTab.id !== undefined) await browser.tabs.remove(stackTab.id).catch(() => null)
    await unassign('firefox-default')
    // and once the other proxy lets go, the tab works again, and loading a
    // page on the right route clears its flag
    late = ''
    if (takeTab.id !== undefined) await browser.tabs.update(takeTab.id, { url: 'https://example.com/?bulkhead-released' })
    await sleep(6000)
    t(`K released passed=${outcomeOf('bulkhead-released') === 'completed'} flagged=${rerouted.has(Number(takeTab.id))} outcome=${outcomeOf('bulkhead-released')}`)
    browser.proxy.onRequest.removeListener(lateListener)
    for (const tab of [takeTab, stripTab]) {
      if (tab.id !== undefined) await browser.tabs.remove(tab.id).catch(() => null)
    }
    await unassign(takeId)
    await browser.contextualIdentities.remove(takeId).catch(() => null)

    // One registered before Bulkhead's sits behind its exit as Firefox's
    // failover instead. The exit dies while still marked up: the next page
    // must fail on the refusal and take the exit down, not quietly load
    // through the other proxy.
    const fallIdent = await browser.contextualIdentities.create({ name: 'bulkhead-fallback', color: 'yellow', icon: 'circle' })
    const fallId = fallIdent.cookieStoreId
    globalThis.testForeignFirst.add(fallId)
    const fallCx = await saveCustomExit({ label: 'e2e fallback', host: '127.0.0.1', port: TEST_EXIT_PORT })
    await assign(fallId, `custom:${fallCx.id}`)
    if (!await waitFor(() => Boolean(state.containers[fallId] && state.containers[fallId].health === 'up'), 60000)) {
      t(`FAIL L exit never verified: ${JSON.stringify(state.containers[fallId])}`)
    }
    await fetch(`http://127.0.0.1:${TEST_CANARY_PORT}/kill-exit`)
    const fallBefore = await carried()
    const fallTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-fallback', cookieStoreId: fallId, active: false })
    await sleep(6000)
    const fallC = state.containers[fallId]
    t(`L fallback carried=${await carried() - fallBefore} completed=${outcomeOf('bulkhead-fallback') === 'completed'} health=${fallC && fallC.health} outcome=${outcomeOf('bulkhead-fallback')}`)
    // the request failed it, so no check has rescheduled the next one
    t(`L recheck soon=${(nextProbeAt.get(fallId) || Infinity) - Date.now() <= PROBE_INTERVAL_DOWN_MS * 1.3}`)
    globalThis.testForeignFirst.clear()
    if (fallTab.id !== undefined) await browser.tabs.remove(fallTab.id).catch(() => null)
    await unassign(fallId)
    await browser.contextualIdentities.remove(fallId).catch(() => null)

    // A flood gets routed ahead of its gates. Only routes no gate still needs
    // may go to make room.
    const floodNow = Date.now()
    noteRouted('flood-waiting', floodNow)
    noteRouted('flood-used', Infinity)
    noteRouted('flood-old', floodNow - 3600000)
    for (let i = 0; i <= ROUTED_CAP; i++) noteRouted(`flood-${i}`, floodNow)
    t(`K flood kept=${routedAt.has('flood-waiting')} swept=${!routedAt.has('flood-used') && !routedAt.has('flood-old')}`)
    for (const id of [...routedAt.keys()]) if (id.startsWith('flood-')) routedAt.delete(id)

    // Trackers Firefox cancels reach the gate routed with no proxy, the shape
    // of a strip: no flag and no log entry. The page is on loopback, so they
    // are third party to it.
    const trkIdent = await browser.contextualIdentities.create({ name: 'bulkhead-tracker', color: 'purple', icon: 'circle' })
    const trkId = trkIdent.cookieStoreId
    const trkCx = await saveCustomExit({ label: 'e2e tracker', host: '127.0.0.1', port: TEST_SOCKS_PORT })
    await assign(trkId, `custom:${trkCx.id}`)
    if (!await waitFor(() => Boolean(state.containers[trkId] && state.containers[trkId].health === 'up'), 60000)) {
      t(`FAIL M exit never verified: ${JSON.stringify(state.containers[trkId])}`)
    }
    // no proxy on a name Firefox would proxy means the classifier fired
    /** @type {Map<string, boolean>} */
    const trkSeen = new Map()
    /** @param {{ url: string, proxyInfo?: unknown }} d */
    const seeTracker = (d) => {
      if (d.url.includes('bulkhead-tracker')) trkSeen.set(d.url, !d.proxyInfo)
    }
    browser.webRequest.onBeforeRequest.addListener(seeTracker, { urls: ['<all_urls>'] })
    const trkTab = await browser.tabs.create({ url: `http://127.0.0.1:${TEST_CANARY_PORT}/tracker-page`, cookieStoreId: trkId, active: false })
    await waitFor(() => trkSeen.size > 0 && [...trkSeen.keys()].every(u => outcomes.has(u)), 10000)
    await sleep(1000)
    browser.webRequest.onBeforeRequest.removeListener(seeTracker)
    const trkOut = [...trkSeen.keys()].map(u => outcomes.get(u) || 'none')
    // ABORT is the gate's cancel; one it let through ends on the classifier's error
    const gated = trkOut.filter(o => o === 'NS_ERROR_ABORT').length
    t(`M tracker early=${trkSeen.size > 1 && [...trkSeen.values()].every(Boolean)} completed=${trkOut.includes('completed')} logged=${blockLog.some(b => b.url.includes('bulkhead-tracker'))} flagged=${rerouted.has(Number(trkTab.id))} ws=${outcomeOf('bulkhead-tracker-ws')} gated=${gated}/${trkOut.length} outcomes=${[...new Set(trkOut)].join(',')}`)
    if (trkTab.id !== undefined) await browser.tabs.remove(trkTab.id).catch(() => null)

    // Firefox preconnects ahead of tabs.update and tabs.create under the
    // caller's context, which here has no exit. A page in an unmanaged tab has
    // the label a mislabelled preconnect would, so Strict turns it away too.
    const preUrl = (/** @type {string} */ how) => `http://${how}.preconnect.bulkhead.example:${TEST_LEAK_PORT}/?bulkhead-preconnect`
    const preconnects = async () => (await fetch(`http://127.0.0.1:${TEST_CANARY_PORT}/preconnects`)).json()
    const prePage = await browser.tabs.create({ url: `http://127.0.0.1:${TEST_CANARY_PORT}/preconnect-page`, active: false })
    const preTab = await browser.tabs.create({ url: 'about:blank', cookieStoreId: trkId, active: false })
    await browser.tabs.update(Number(preTab.id), { url: preUrl('update') })
    const preNew = await browser.tabs.create({ url: preUrl('create'), cookieStoreId: trkId, active: false })
    for (let i = 0; i < 40 && (await preconnects()).pages < 2; i++) await sleep(250)
    await sleep(1000)
    const pre = await preconnects()
    t(`N preconnect direct=${pre.direct} pages=${pre.pages} page=${pre.page}`)
    await browser.tabs.remove([Number(prePage.id), Number(preTab.id), Number(preNew.id)]).catch(() => null)
    await unassign(trkId)
    await browser.contextualIdentities.remove(trkId).catch(() => null)

    // The tail depends on Firefox asking listeners in registration order with the
    // last answer standing. A stripper added after the tail must win, and must lose
    // once the tail has moved; if the order changes, one of the two lines fails.
    const lastIdent = await browser.contextualIdentities.create({ name: 'bulkhead-tail', color: 'blue', icon: 'circle' })
    const lastId = lastIdent.cookieStoreId
    const lastCx = await saveCustomExit({ label: 'e2e tail', host: '127.0.0.1', port: TEST_SOCKS_PORT })
    await assign(lastId, `custom:${lastCx.id}`)
    if (!await waitFor(() => Boolean(state.containers[lastId] && state.containers[lastId].health === 'up'), 60000)) {
      t(`FAIL O exit never verified: ${JSON.stringify(state.containers[lastId])}`)
    }
    const tailPage = `http://127.0.0.1:${TEST_CANARY_PORT}/tail-page`
    /** @type {Set<string>} */
    const stripSeen = new Set()
    /** @type {'null' | 'proxy'} */
    let stripAs = 'null'
    /** @param {browser.proxy._OnRequestDetails} d */
    const stripper = (d) => {
      const name = d.url.match(/\/\/(tail-[a-z]+)\./)
      if (!name || (d.type !== 'speculative' && d.type !== 'websocket')) return undefined
      stripSeen.add(name[1])
      return stripAs === 'null' ? null : { type: 'socks', host: '127.0.0.1', port: TEST_FOREIGN_PORT, proxyDNS: true }
    }
    const moved = async () => {
      const at = tailMovedAt
      const until = Date.now() + 10000
      while (tailMovedAt === at && Date.now() < until) await sleep(20)
      if (tailMovedAt === at) t('FAIL O the tail stopped moving')
    }
    const tailHits = async () => (await fetch(`http://127.0.0.1:${TEST_CANARY_PORT}/tail-hits`)).json()
    const blockedTail = (/** @type {string} */ name) => blockLog.some(b => b.url.includes(`${name}.`))
    const lastTab = Number((await browser.tabs.create({ url: tailPage, cookieStoreId: lastId, active: false })).id)
    await sleep(1000)
    const act = (/** @type {string} */ what, tab = lastTab) => browser.tabs.update(tab, { url: `${tailPage}#${what}` })
    // every build preconnects ahead of tabs.update; the load this starts is inside the rate limit,
    // unless it comes more than TAIL_OVERLAP_MS after a move
    const navTab = Number((await browser.tabs.create({ url: 'about:blank', cookieStoreId: lastId, active: false })).id)
    const preconnectTo = (/** @type {string} */ name) => browser.tabs.update(navTab, { url: preUrl(name) })

    // just after a move, so the stripper stays last for the whole check
    const lastBefore = (await preconnects()).direct
    await moved()
    browser.proxy.onRequest.addListener(stripper, { urls: ['<all_urls>'] })
    await act('ws:tail-strip')
    await preconnectTo('tail-window')
    await sleep(1500)
    t(`O window leaked=${(await preconnects()).direct > lastBefore} seen=${stripSeen.has('tail-window')} ws=${outcomeOf('bulkhead-tail-strip')}`)

    // moved on the timer: nothing here loads a page
    const lastDirect = (await preconnects()).direct
    await moved()
    const oldTail = tail
    await act('ws:tail-ws')
    await preconnectTo('tail-moved')
    await sleep(1500)
    t(`O last direct=${(await preconnects()).direct - lastDirect} seen=${stripSeen.has('tail-moved')} ws=${(await tailHits()).includes('/?bulkhead-tail-ws')} logged=${blockedTail('tail-ws')}`)

    // the old listener stays for the overlap, then goes
    await moved()
    const oldKept = oldTail.api.hasListener(oldTail.fn)
    await sleep(TAIL_OVERLAP_MS + 200)
    t(`O swap kept=${oldKept} old=${oldTail.api.hasListener(oldTail.fn)} current=${tail.api.hasListener(tail.fn)}`)

    // the frame goes once it has added enough, and a listener from the next one still wins
    const oldFrame = tailFrame
    const frameDirect = (await preconnects()).direct
    tailFrameMoves = TAIL_FRAME_MOVES
    await moved()
    const frameReplaced = await waitFor(() => tailFrame !== oldFrame, 5000)
    const frameKept = oldFrame.isConnected
    // once the old frame is gone, with no timer move since: only the swap's own listener is left
    const frameGone = await waitFor(() => !oldFrame.isConnected, TAIL_OVERLAP_MS + 1000)
    await preconnectTo('tail-frame')
    await sleep(1500)
    t(`O frame new=${frameReplaced} kept=${frameKept} restarted=${tailFrameMoves < TAIL_FRAME_MOVES} gone=${frameGone} frames=${document.querySelectorAll('iframe').length} direct=${(await preconnects()).direct - frameDirect} seen=${stripSeen.has('tail-frame')}`)

    // a frame that can't add a listener goes, and the one that holds the listener stays
    const badFrame = /** @type {any} */ (Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow'))
    const goodFrame = tailFrame
    const badDirect = (await preconnects()).direct
    let triedBad = false
    const frameWindow = (/** @type {(frame: HTMLIFrameElement) => object} */ pick) => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get () {
        return pick(this)
      }
    })
    frameWindow((frame) => {
      if (frame === goodFrame) return badFrame.get.call(frame)
      triedBad = true
      // no next one, so the count below is only this one
      tailFrameMoves = 0
      return {}
    })
    tailFrameMoves = TAIL_FRAME_MOVES
    const badTried = await waitFor(() => triedBad, 12000)
    await sleep(TAIL_OVERLAP_MS + 200)
    await preconnectTo('tail-bad')
    await sleep(1500)
    t(`O frame bad tried=${badTried} kept=${tailFrame === goodFrame && goodFrame.isConnected} frames=${document.querySelectorAll('iframe').length} direct=${(await preconnects()).direct - badDirect} seen=${stripSeen.has('tail-bad')}`)
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', badFrame)
    tailFrameMoves = TAIL_FRAME_MOVES
    t(`O frame bad retried=${await waitFor(() => tailFrame !== goodFrame, 12000)} single=${await waitFor(() => document.querySelectorAll('iframe').length === 1, TAIL_OVERLAP_MS + 1000)}`)

    // a frame that stops adding is replaced, not kept for the rest of its moves
    const deadFrame = tailFrame
    const deadTail = tail
    let tailAfterThrow = null
    const throwing = () => {
      // runs once the add has failed, ahead of the next frame's load
      queueMicrotask(() => {
        tailAfterThrow = tail
      })
      throw new Error('test')
    }
    frameWindow(frame => frame === deadFrame ? { browser: { proxy: { onRequest: { addListener: throwing } } } } : badFrame.get.call(frame))
    const deadReplaced = await waitFor(() => tailFrame !== deadFrame, 12000)
    t(`O frame dead replaced=${deadReplaced} kept=${tailAfterThrow === deadTail}`)
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', badFrame)

    // a frame that never loads is dropped, and the next move starts another
    const stuckFrame = tailFrame
    // its load listener never gets added, so it stays there unused
    HTMLIFrameElement.prototype.addEventListener = function () {
      delete HTMLIFrameElement.prototype.addEventListener
    }
    tailFrameMoves = TAIL_FRAME_MOVES
    const stuckStarted = await waitFor(() => tailFrameLoading, 8000)
    // the tail keeps moving while that frame hangs
    const stuckTail = tail
    const stuckMoved = await waitFor(() => tail !== stuckTail, TAIL_PERIOD_MS + 1000)
    // a move can land just ahead of the limit and miss it, so give it the one after
    const stuckReplaced = await waitFor(() => tailFrame !== stuckFrame, TAIL_FRAME_LOAD_MS + 2 * TAIL_PERIOD_MS + 1000)
    const stuckSingle = await waitFor(() => document.querySelectorAll('iframe').length === 1, TAIL_OVERLAP_MS + 1000)
    // the frame that did load outlives the time limit
    const stayFrame = tailFrame
    await sleep(TAIL_FRAME_LOAD_MS + 500)
    t(`O frame stuck started=${stuckStarted} moved=${stuckMoved} replaced=${stuckReplaced} single=${stuckSingle} stayed=${tailFrame === stayFrame && stayFrame.isConnected}`)

    // a frame that can't be put in doesn't throw at the caller, and the next move tries again
    await waitFor(() => !tailFrameLoading, 5000)
    const unputFrame = tailFrame
    document.body.append = () => {
      delete document.body.append
      throw new Error('test')
    }
    tailFrameMoves = TAIL_FRAME_MOVES
    let moveThrew = false
    try {
      moveTail()
    } catch {
      moveThrew = true
    }
    const unputLoading = tailFrameLoading
    const unputReplaced = await waitFor(() => tailFrame !== unputFrame, 12000)
    t(`O frame throw threw=${moveThrew} loading=${unputLoading} replaced=${unputReplaced} single=${await waitFor(() => document.querySelectorAll('iframe').length === 1, TAIL_OVERLAP_MS + 1000)}`)

    // a route on a websocket is overruled, not flagged, and an unmanaged tab keeps it
    stripAs = 'proxy'
    const overTab = Number((await browser.tabs.create({ url: tailPage, cookieStoreId: lastId, active: false })).id)
    const keptTab = Number((await browser.tabs.create({ url: tailPage, active: false })).id)
    await sleep(1000)
    await moved()
    await act('ws:tail-over', overTab)
    await act('ws:tail-other', keptTab)
    await sleep(1500)
    t(`O overruled foreign=${await carried('tail-over.preconnect.bulkhead.example')} exit=${(await tailHits()).includes('/?bulkhead-tail-over')} logged=${blockedTail('tail-over')} flagged=${rerouted.has(overTab)}`)
    t(`O unmanaged foreign=${await carried('tail-other.preconnect.bulkhead.example') > 0}`)
    stripAs = 'null'

    // moved by the page load, well clear of the timer and the rate limit
    await moved()
    await sleep(TAIL_OVERLAP_MS + 100)
    browser.proxy.onRequest.removeListener(stripper)
    browser.proxy.onRequest.addListener(stripper, { urls: ['<all_urls>'] })
    const loadMoved = tailMovedAt
    const loadTab = Number((await browser.tabs.create({ url: `${tailPage}#ws:tail-load`, cookieStoreId: lastId, active: false })).id)
    await sleep(1000)
    t(`O load ws=${(await tailHits()).includes('/?bulkhead-tail-load')} logged=${blockedTail('tail-load')} moved=${tailMovedAt !== loadMoved}`)

    // only a page load the gate allows moves it, and no more than once per overlap
    const limitMoved = tailMovedAt
    const rateTab = Number((await browser.tabs.create({ url: tailPage, cookieStoreId: lastId, active: false })).id)
    await sleep(500)
    const rate = tailMovedAt === limitMoved
    await moved()
    await sleep(TAIL_OVERLAP_MS + 100)
    const quietMoved = tailMovedAt
    await act('img:tail-img')
    await waitFor(() => outcomeOf('bulkhead-tail-img') !== 'none', 1000)
    const sub = outcomeOf('bulkhead-tail-img') === 'completed' && tailMovedAt === quietMoved
    const quietTab = Number((await browser.tabs.create({ url: tailPage, active: false })).id)
    await sleep(500)
    t(`O limit rate=${rate} sub=${sub} unmanaged=${tailMovedAt === quietMoved}`)

    browser.proxy.onRequest.removeListener(stripper)
    await browser.tabs.remove([lastTab, navTab, overTab, keptTab, loadTab, rateTab, quietTab]).catch(() => null)
    await unassign(lastId)
    await browser.contextualIdentities.remove(lastId).catch(() => null)

    if (TEST_TUNNEL) {
      // The same server a relay assignment would use, typed in by hand.
      // Proves the custom path routes and verifies, not merely that it
      // blocks when broken.
      const memo = await refreshRelays(false)
      const relay = memo.relays.find((/** @type {Relay} */ r) => r.active)
      await assign(cxId, relay.host)
      // assign() returns once storage is written; the in-memory config
      // catches up on the storage event, and reading it too early yields the
      // address of the exit being replaced.
      await waitFor(() => {
        const c = state.containers[cxId]
        return Boolean(c && c.host === relay.host)
      }, 10000)
      const resolved = state.containers[cxId]
      const liveCx = await saveCustomExit({ label: 'e2e live', host: resolved ? resolved.ip : '', port: 1080 })
      await assign(cxId, `custom:${liveCx.id}`)
      await waitFor(() => {
        const c = state.containers[cxId]
        return Boolean(c && c.health && c.health !== 'unknown')
      }, 30000)
      const cxLive = state.containers[cxId]
      t(`H custom live health=${cxLive && cxLive.health} custom=${Boolean(cxLive && cxLive.custom)} host=${relay.host} detail=${cxLive && cxLive.healthDetail}`)
    } else {
      t('SKIP H (no tunnel)')
    }
    await unassign(cxId)
    await browser.contextualIdentities.remove(cxId).catch(() => null)

    // Default context on the tunnel's own endpoint. Tunnel down: ordinary
    // tabs AND the extension's own fetches must fail closed. Tunnel up: the
    // probe accepts any Mullvad exit and traffic passes.
    const defAssign = await assign('firefox-default', 'mullvad-direct')
    if (!defAssign.ok) t(`FAIL default assign: ${defAssign.error}`)
    await waitFor(() => {
      const c = state.containers['firefox-default']
      return Boolean(c && c.health && c.health !== 'unknown')
    }, 18000)
    const defC = state.containers['firefox-default']
    const defTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-default', active: false })
    await sleep(5000)
    const defHit = blockLog.find(b => b.container === 'firefox-default' && b.url.includes('bulkhead-default'))
    if (!TEST_TUNNEL) {
      t(`D health=${defC && defC.health} blocked=${Boolean(defHit)} reason=${defHit ? defHit.reason : 'NONE-LEAKED'}`)
      const defOutcome = outcomeOf('bulkhead-default')
      t(`D cancelled=${defOutcome !== 'completed' && defOutcome !== 'none'} outcome=${defOutcome}`)
      await waitFor(() => Boolean(lastBlockedPage && lastBlockedPage.container === 'firefox-default'), 6000)
      t(`D blockedpage shown=${Boolean(lastBlockedPage && lastBlockedPage.container === 'firefox-default')}`)
      let selfFetchThrew = false
      try {
        await refreshRelays(true)
      } catch {
        selfFetchThrew = true
      }
      const selfHit = blockLog.find(b => b.container === 'firefox-default' && b.url.includes('mullvad.net'))
      t(`D self-fetch blocked=${selfFetchThrew && Boolean(selfHit)}`)
      t(`D self-fetch notices=${blockLog.some(b => b.url.includes('__data.json'))}`)
    } else {
      t(`D health=${defC && defC.health} passed=${!defHit}`)
    }
    if (defTab.id !== undefined) await browser.tabs.remove(defTab.id)
    await unassign('firefox-default')
    await sleep(1000)

    // status messages go through the exit when pinned, no cookies sent
    const noticeCx = await saveCustomExit({ label: 'e2e notices', host: '127.0.0.1', port: TEST_FOREIGN_PORT })
    await assign('firefox-default', `custom:${noticeCx.id}`)
    if (!await waitFor(() => Boolean(state.containers['firefox-default'] && state.containers['firefox-default'].health === 'up'), 60000)) {
      t(`FAIL P exit never verified: ${JSON.stringify(state.containers['firefox-default'])}`)
    }
    // a list refresh just before this can still have its fetch waiting
    await sleep(Math.max(0, relayMemo.ts + PROBE_SPREAD_MS + 1000 - Date.now()))
    /** @type {string[][]} */
    const noticeHeaders = []
    /** @param {browser.webRequest._OnBeforeSendHeadersDetails} d */
    const noticeListener = (d) => {
      noticeHeaders.push((d.requestHeaders || []).map(h => h.name.toLowerCase()))
    }
    browser.webRequest.onBeforeSendHeaders.addListener(noticeListener, { urls: ['https://mullvad.net/en/__data.json'] }, ['requestHeaders'])
    await browser.cookies.set({ url: 'https://mullvad.net/', name: 'bulkhead_e2e', value: '1' })
    const noticeBefore = await carried('mullvad.net')
    await refreshNotices()
    t(`P notices carried=${await carried('mullvad.net') > noticeBefore} requests=${noticeHeaders.length} cookie=${noticeHeaders.flat().includes('cookie')} origin=${noticeHeaders.flat().includes('origin')} logged=${blockLog.some(b => b.url.includes('__data.json'))}`)
    browser.webRequest.onBeforeSendHeaders.removeListener(noticeListener)
    await browser.cookies.remove({ url: 'https://mullvad.net/', name: 'bulkhead_e2e' })

    // fake notices answer from here on, list fetches stay real
    const realFetchJson = fetchJson
    let noticeAsks = 0
    let noticeText = 'e2e first'
    /** @param {string} url @param {number} ms */
    fetchJson = async (url, ms) => {
      if (url !== NOTICES_URL) return realFetchJson(url, ms)
      noticeAsks++
      await sleep(500)
      if (!noticeText) throw new Error('e2e')
      return { type: 'data', nodes: [{ type: 'data', data: [{ statusMessages: 1 }, [2], { text: 3, display_area: 4 }, noticeText, 'SERVERS'] }] }
    }

    noticesAsked = false
    noticeAsks = 0
    await Promise.all([settingsOpened(), settingsOpened()])
    await settingsOpened()
    const askedOnce = noticeAsks === 1
    noticesAsked = false
    installOpened = true
    await settingsOpened()
    const skippedInstall = noticeAsks === 1 && !installOpened
    const noticeExit = state.containers['firefox-default']
    const noticeHealth = noticeExit.health
    for (const health of ['unknown', 'down', 'misrouted', 'taken', undefined]) {
      noticesAsked = false
      noticeExit.health = health
      await settingsOpened()
    }
    noticeExit.health = noticeHealth
    const skippedNotUp = noticeAsks === 1 && !noticesAsked
    state.ready = false
    await settingsOpened()
    state.ready = true
    const skippedNotReady = noticeAsks === 1 && !noticesAsked

    // waits right after browser start, 2 s here
    const realRandom = Math.random
    Math.random = () => 0.1
    performance.now = () => 0
    noticeAsks = 0
    const spreadAsk = settingsOpened()
    Math.random = realRandom
    performance.now = realNow
    await sleep(1000)
    const spreadHeld = noticeAsks === 0
    await spreadAsk
    t(`P settings once=${askedOnce} install=${skippedInstall} notup=${skippedNotUp} notready=${skippedNotReady} spread=${spreadHeld && noticeAsks === 1}`)

    // page asks on open and shows the answer
    noticesAsked = false
    noticeAsks = 0
    noticeText = 'e2e page'
    const pageTab = await browser.tabs.create({ url: browser.runtime.getURL('options/options.html') })
    const pageDoc = () => browser.extension.getViews({ tabId: pageTab.id }).map(v => v.document)[0]
    const pageBanner = () => {
      const el = pageDoc() && pageDoc().getElementById('relay-notices')
      return el ? el.textContent : null
    }
    const pageAsked = await waitFor(() => noticeAsks === 1, 8000)
    const pageShown = await waitFor(() => pageBanner() === 'From Mullvad: “e2e page”', 8000)
    noticeText = ''
    await refreshNotices()
    const pageCleared = await waitFor(() => pageBanner() === '', 8000)
    t(`P page asked=${pageAsked} shown=${pageShown} cleared=${pageCleared}`)
    if (pageTab.id !== undefined) await browser.tabs.remove(pageTab.id)

    await unassign('firefox-default')
    await waitFor(() => !state.containers['firefox-default'], 5000)
    noticesAsked = false
    noticeAsks = 0
    await settingsOpened()
    t(`P unpinned=${noticeAsks === 1}`)
    fetchJson = realFetchJson
    await sleep(1000)

    if (!TEST_TUNNEL) {
      t('SKIP B (no tunnel)')
      t('SKIP C (no tunnel)')
    } else {
      // Live relay through the real assignment path: resolve, validate the
      // tunnel address, probe, and verify the exit hostname end to end.
      const live = await browser.contextualIdentities.create({ name: 'bulkhead-live', color: 'green', icon: 'circle' })
      const liveId = live.cookieStoreId
      const out = await assign(liveId, 'se-got-wg-001')
      if (!out.ok) {
        t(`FAIL assign: ${out.error}`)
      } else {
        await waitFor(() => {
          const c = state.containers[liveId]
          return Boolean(c && c.health !== 'unknown')
        }, 20000)
        const liveC = state.containers[liveId]
        const liveTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-live', cookieStoreId: liveId, active: false })
        await sleep(6000)
        const liveHit = blockLog.find(b => b.container === liveId && b.url.includes('bulkhead-live'))
        t(`B health=${liveC && liveC.health} passed=${!liveHit}`)
        if (liveTab.id !== undefined) await browser.tabs.remove(liveTab.id)

        // Misroute: keep the live address, claim a different exit. The
        // probe must flag the mismatch, not just liveness.
        const wrong = { ...state.containers[liveId] }
        wrong.socksHost = 'test-wrong-exit-000'
        wrong.health = undefined
        await browser.storage.local.set({ containers: { [deadId]: stored, [liveId]: wrong } })
        await waitFor(() => {
          const c = state.containers[liveId]
          return Boolean(c && c.health === 'misrouted')
        }, 20000)
        const wrongC = state.containers[liveId]
        t(`C health=${wrongC && wrongC.health} detail=${wrongC && wrongC.healthDetail}`)
      }
      await browser.contextualIdentities.remove(liveId).catch(() => null)
    }

    // The reassignment race: a probe in flight against one relay must not
    // leave its verdict on the relay that replaces it.
    const raceId = deadId
    await browser.storage.local.set({ containers: { [raceId]: { ...stored, ip: '10.124.255.253' } } })
    await waitFor(() => {
      const c = state.containers[raceId]
      return Boolean(c && c.ip === '10.124.255.253')
    }, 5000)
    probe(raceId)
    await sleep(300)
    await browser.storage.local.set({ containers: { [raceId]: { ...stored, ip: '10.124.255.252', socksHost: 'test-other' } } })
    await sleep(12000)
    // The property is that the replacement relay never inherits the old
    // one's verdict. Before the fix this read 'up' without the new relay
    // having been contacted at all.
    const raced = state.containers[raceId]
    t(`E race notup=${Boolean(raced) && raced.health !== 'up'} health=${raced && raced.health}`)

    await browser.contextualIdentities.remove(deadId).catch(() => null)

    // Only the once-per-event warnings may fire: a retired server (with a
    // tunnel, test-dead is one) and DoH. A verdict never does.
    const stray = notified.filter(n => !n.startsWith('bulkhead-offline-') && n !== 'bulkhead-doh')
    t(`notifications stray=${stray.length} total=${notified.length}${stray.length ? ` ids=${stray.join(',')}` : ''}`)
    t('done')
  }

  setTimeout(() => {
    run().catch((e) => {
      log(`[test] FAIL ${e && e.stack ? e.stack : e}`)
      log('[test] done')
    })
  }, 3000)
})()
