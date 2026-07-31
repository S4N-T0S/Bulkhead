'use strict'
// Appended by test/e2e/transition.mjs, never shipped. Measures the
// transition window: the default context is pinned to a live relay, a
// steady stream of exit checks runs, and the runner drops the tunnel in the
// middle of it. Any check that completes from outside Mullvad is a direct
// fallback -- the leak this extension exists to prevent. Timings are
// logged; addresses never are.

/* global state, blockLog, assign, log, TEST_RELAY, TEST_DURATION_MS, TEST_MODE */

;(() => {
  /** @param {string} line */
  const t = line => log(`[t] ${line}`)
  /** @param {number} ms */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const CADENCE_MS = 500
  const FETCH_ABORT_MS = 140000

  const counts = { proxied: 0, leaked: 0, rejected: 0 }
  let issued = 0
  let downAt = 0

  const cfg = () => state.containers['firefox-default']
  const gateBlocked = () => blockLog.filter(b => b.url.includes('bkh_t=')).length

  /** @param {() => boolean} cond @param {number} ms */
  async function waitFor (cond, ms) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (cond()) return true
      await sleep(250)
    }
    return cond()
  }

  /** @param {number} i */
  async function canary (i) {
    const issuedAt = Date.now()
    try {
      const res = await fetch(`https://am.i.mullvad.net/json?bkh_t=${i}`, {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(FETCH_ABORT_MS)
      })
      const j = await res.json()
      if (j.mullvad_exit_ip === true) {
        counts.proxied++
      } else {
        counts.leaked++
        t(`LEAK canary=${i} issued=${downAt ? `${issuedAt - downAt}ms-after-drop` : 'pre-drop'} completed=${downAt ? `${Date.now() - downAt}ms-after-drop` : 'pre-drop'}`)
      }
    } catch {
      counts.rejected++
    }
  }

  function tick () {
    const c = cfg()
    t(`tick issued=${issued} proxied=${counts.proxied} leaked=${counts.leaked} rejected=${counts.rejected} gate-blocked=${gateBlocked()} health=${c && c.health}`)
  }

  // Dropping the tunnel black-holes the relay address, so connections hang
  // and Firefox never reaches the failover list. A listener that answers
  // with RST is the other failure mode -- relay decommissioned, SOCKS
  // listener down, tunnel still up -- and it is the one that can actually
  // elect DIRECT. 127.0.0.1:9 is closed on a stock machine, so a connect
  // there is refused immediately.
  async function assignRefused () {
    const containers = {
      'firefox-default': {
        ip: '127.0.0.1',
        port: 9,
        host: 'test-refused',
        socksHost: 'test-refused-socks5',
        city: '',
        country: '',
        cc: ''
      }
    }
    await browser.storage.local.set({ containers })
    return waitFor(() => Boolean(state.containers['firefox-default']), 5000)
  }

  async function run () {
    await waitFor(() => state.ready, 8000)

    if (TEST_MODE === 'refused') {
      // No tunnel drop here: the proxy is dead from the start and answers
      // fast, which is precisely the case the black-hole run cannot produce.
      await assignRefused()
      t('up')
      downAt = Date.now()
      const t0 = Date.now()
      let lastTick = 0
      while (Date.now() - t0 < TEST_DURATION_MS) {
        canary(issued++)
        if (Date.now() - lastTick > 10000) {
          lastTick = Date.now()
          tick()
        }
        await sleep(CADENCE_MS)
      }
      await sleep(3000)
      const settled = counts.proxied + counts.leaked + counts.rejected
      t(`summary issued=${issued} proxied=${counts.proxied} leaked=${counts.leaked} rejected=${counts.rejected} gate-blocked=${gateBlocked()} still-hanging=${issued - settled}`)
      t('done')
      return
    }

    const out = await assign('firefox-default', TEST_RELAY)
    if (!out.ok) {
      t(`FAIL assign: ${out.error}`)
      t('done')
      return
    }
    if (!await waitFor(() => Boolean(cfg() && cfg().health === 'up'), 25000)) {
      t(`FAIL never up (${cfg() && cfg().health})`)
      t('done')
      return
    }
    t('up')

    const t0 = Date.now()
    let lastTick = 0
    while (Date.now() - t0 < TEST_DURATION_MS) {
      canary(issued++)
      const c = cfg()
      if (!downAt && c && c.health !== 'up') {
        downAt = Date.now()
        t(`healthflip ${c.health} issued=${issued}`)
      }
      if (Date.now() - lastTick > 10000) {
        lastTick = Date.now()
        tick()
      }
      await sleep(CADENCE_MS)
    }

    await sleep(3000)
    tick()
    const settled = counts.proxied + counts.leaked + counts.rejected
    t(`summary issued=${issued} proxied=${counts.proxied} leaked=${counts.leaked} rejected=${counts.rejected} gate-blocked=${gateBlocked()} still-hanging=${issued - settled}`)
    t('done')
  }

  setTimeout(() => {
    run().catch((e) => {
      log(`[t] FAIL ${e && e.stack ? e.stack : e}`)
      log('[t] done')
    })
  }, 2000)
})()
