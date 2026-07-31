'use strict'
// Appended to background.scripts by test/e2e/run.mjs, never shipped. Runs in
// the background context, so it reaches the real state, the real listeners
// and the real probe path. Results go to stdout as "[test] ..." lines via
// the same dump()-backed log the runner captures.
//
// TEST_TUNNEL is set by a generated test-config.js: cases that need live
// Mullvad relays are skipped without a tunnel, everything else runs anywhere.

/* global state, blockLog, lastBlockedPage, assign, unassign, probe, refreshRelays, applyHardening, log, TEST_TUNNEL */

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
