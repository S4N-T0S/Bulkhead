'use strict'
/* global fmt */
;(() => {
  const q = new URLSearchParams(location.search)
  const reason = q.get('reason') || 'unknown'
  const container = q.get('container') || ''
  const url = q.get('url') || ''

  // First sentence is always what to do next; the explanation follows.
  /** @type {Record<string, string>} */
  const EXPLAIN = {
    'proxy-unverified': 'Nothing to do — this should clear itself in a second or two. Bulkhead checks a container\'s server before it lets anything through, and the check has not finished. This is normal right after Firefox starts, or after Mullvad reconnects. The page will load on its own when the check passes.',
    'proxy-down': 'Check the Mullvad app is connected, then press Re-check and retry. This container\'s Mullvad server did not answer, so Bulkhead cancelled the request rather than let Firefox find another way out. Servers go quiet for a few seconds on every reconnect, so this often clears by itself.',
    'misrouted': 'Press Re-check and retry — if it keeps happening, pick a different server in Settings. The server answered, but your traffic came out somewhere else, so this container would not have looked like the identity you set up for it.',
    'not-ready': 'Wait a moment, then press Re-check and retry. Firefox had only just started and Bulkhead had not finished loading its settings. Until it has, it blocks everything rather than guess which containers are meant to be protected.',
    'unattributed': 'If this keeps happening on a site you trust, turn off Strict mode in Bulkhead\'s settings. Firefox did not say which container this request belonged to, so there was no way to tell whether it came from a protected one.',
    'speculative': 'Nothing to do — this was not a page you asked for. Firefox was connecting to a site in advance, in case you clicked something. Those early connections do not reliably say which container they belong to, so Strict mode turns them away.',
    'no-proxy': 'Open Settings and pick a Mullvad server for this container. It is set to be protected, but there is no working server saved for it, so there is nowhere for its traffic to go.',
    'error': 'Press Re-check and retry. Something went wrong inside Bulkhead itself, and it blocked rather than let traffic through — so nothing escaped. If it keeps happening, "Recently blocked" in Settings has the details worth reporting.'
  }

  /** @param {string} id @returns {HTMLElement} */
  const $ = id => /** @type {HTMLElement} */ (document.getElementById(id))

  // keep the slug for bug reports, but it is not an explanation
  $('reason').textContent = fmt.reasonLabel(reason)
  $('reason').title = reason
  $('reason').classList.remove('mono')
  $('url').textContent = url || '—'
  $('explain').textContent = EXPLAIN[reason] || 'Bulkhead blocked this request but did not record why. Press Re-check and retry.'
  browser.runtime.sendMessage({ cmd: 'blockedShown', container, reason }).catch(() => null)

  if (container === 'firefox-default') {
    $('container').textContent = 'No container'
  } else if (container === 'firefox-private') {
    $('container').textContent = 'Private windows'
  } else if (container) {
    browser.contextualIdentities.get(container).then((ident) => {
      $('container').textContent = ident.name
    }, () => {
      $('container').textContent = container
    })
  }

  // The target came in via a query parameter; only ever navigate somewhere
  // that plainly came out of the address bar.
  const safeTarget = /^https?:\/\//i.test(url) ? url : ''

  $('options').addEventListener('click', () => browser.runtime.openOptionsPage())

  const retry = /** @type {HTMLButtonElement} */ ($('retry'))
  retry.addEventListener('click', async () => {
    retry.style.minWidth = `${retry.offsetWidth}px`
    retry.disabled = true
    retry.textContent = 'Checking…'
    if (container) await browser.runtime.sendMessage({ cmd: 'probe', cookieStoreId: container })
    const st = await browser.runtime.sendMessage({ cmd: 'getState' })
    const c = st.containers[container]
    if (c && c.health === 'up' && safeTarget) {
      location.replace(safeTarget)
      return
    }
    retry.disabled = false
    retry.textContent = 'Re-check and retry'
    // with no container there is nothing to re-check
    $('status').textContent = c
      ? `Still blocked. ${fmt.explainDetail(c.healthDetail) || ''}`.trim()
      : container
        ? 'This container no longer has a server set.'
        : 'This request had no container, so there is nothing to re-check. Turn off Strict mode in Settings if you need it through.'
  })

  // The background probes on its own schedule; when the exit comes back, say
  // so instead of leaving a stale error page. On the unverified path there
  // was never a failure to report, so recovery just continues the
  // navigation the user already asked for.
  const poll = setInterval(async () => {
    if (!container) return
    const st = await browser.runtime.sendMessage({ cmd: 'getState' })
    const c = st.containers[container]
    if (!c || c.health !== 'up') return
    clearInterval(poll)
    if (reason === 'proxy-unverified' && safeTarget) {
      location.replace(safeTarget)
      return
    }
    $('status').textContent = 'exit verified'
    retry.textContent = safeTarget ? 'Exit is back — reload page' : 'Exit is back'
    retry.disabled = false
  }, 2000)
})()
