'use strict'
// Appended to background.scripts by test/e2e/run.mjs, never shipped. Runs in
// the background context, so it reaches the real state, the real listeners
// and the real probe path. Results go to stdout as "[test] ..." lines via
// the same dump()-backed log the runner captures.
//
// TEST_TUNNEL is set by a generated test-config.js: cases that need live
// Mullvad relays are skipped without a tunnel, everything else runs anywhere.

/* global state, blockLog, lastBlockedPage, assign, unassign, probe, probesInFlight, RECHECK_DELAY_MS, refreshRelays, applyHardening, saveCustomExit, log, TEST_TUNNEL, TEST_CANARY_PORT, TEST_SOCKS_PORT */

;(() => {
  /** @param {string} line */
  const t = line => log(`[test] ${line}`)
  /** @param {number} ms */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

    // No managed containers yet: the extension must be inert for a normal
    // tab. Its request must pass and leave no trace in the block log.
    const inertTab = await browser.tabs.create({ url: 'https://example.com/?bulkhead-inert', active: false })
    await sleep(6000)
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
    await browser.storage.local.set({ containers: { [deadId]: stored } })
    await waitFor(() => {
      const c = state.containers[deadId]
      return Boolean(c && c.health === 'down')
    }, 15000)
    const deadHealth = state.containers[deadId] && state.containers[deadId].health
    t(`A health=${deadHealth}`)

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
      t(`H custom live health=${cxLive && cxLive.health} custom=${Boolean(cxLive && cxLive.custom)}`)
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
    } else {
      t(`D health=${defC && defC.health} passed=${!defHit}`)
    }
    if (defTab.id !== undefined) await browser.tabs.remove(defTab.id)
    await unassign('firefox-default')
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
    t('done')
  }

  setTimeout(() => {
    run().catch((e) => {
      log(`[test] FAIL ${e && e.stack ? e.stack : e}`)
      log('[test] done')
    })
  }, 3000)
})()
