'use strict'
/* global fmt */
;(() => {
  const q = new URLSearchParams(location.search)
  const reason = q.get('reason') || 'unknown'
  const container = q.get('container') || ''
  const url = q.get('url') || ''

  // First sentence is always what to do next; the explanation follows.
  /** @type {Record<string, string>} */
  const EXPLAIN = Object.assign(Object.create(null), {
    'proxy-unverified': 'Nothing to do — the page will load on its own once the check passes, usually within a second or two. Bulkhead checks a container\'s server before it lets anything through, and this check has not finished. Normal right after Firefox starts or after Mullvad reconnects.',
    'proxy-down': 'Check this container\'s server is running — for a Mullvad exit, that the app is connected — then press Re-check and retry. The server did not answer, so Bulkhead cancelled the request rather than let Firefox find another way out. On a Mullvad exit this often clears by itself — its servers go quiet for a few seconds on every reconnect.',
    'misrouted': 'Press Re-check and retry — if it keeps happening, pick a different server in Settings. The server answered, but traffic came out at a different exit than the one you chose.',
    'not-ready': 'Nothing to do — the page will load on its own once Bulkhead has finished starting, usually within a second or two. Firefox had only just started and Bulkhead had not finished loading its settings. Until it has, it blocks everything rather than guess which containers are meant to be protected.',
    'unattributed': 'If this keeps happening on a site you trust, turn off Strict mode in Bulkhead\'s settings. Firefox did not say which container this request belonged to, so there was no way to tell whether it came from a protected one.',
    'speculative': 'Nothing to do — this was not a page you asked for. Firefox was connecting to a site in advance, in case you clicked something. Those early connections do not reliably say which container they belong to, so Strict mode turns them away.',
    'no-proxy': 'Open Settings and pick a server for this container. It is set to be protected, but there is no working server saved for it, so there is nowhere for its traffic to go.',
    'error': 'Press Re-check and retry. Something went wrong inside Bulkhead itself, and it blocked rather than let traffic through — so nothing escaped. If it keeps happening, "Recently blocked" in Settings has the details worth reporting.'
  })

  const HINT = 'If the Mullvad app is connected and this keeps failing, close Firefox completely and open it yourself. None of your Mullvad servers is answering, which is what a Firefox outside the tunnel looks like: one opened by an app that Mullvad\'s split tunnelling excludes (a link clicked in Steam, say). Tabs with no server set are then on your real connection.'

  /** @param {string} id @returns {HTMLElement} */
  const $ = id => /** @type {HTMLElement} */ (document.getElementById(id))

  // the reason on screen; a page opened on a wait keeps up with the exit,
  // so this can differ from the one in the URL
  let shown = ''
  /** @param {string} r */
  function render (r) {
    shown = r
    // keep the slug for bug reports, but it is not an explanation
    $('reason').textContent = fmt.reasonLabel(r)
    $('reason').title = r
    $('explain').textContent = EXPLAIN[r] || 'Press Re-check and retry. Bulkhead blocked this request but did not record why.'
  }
  render(reason)
  $('reason').classList.remove('mono')
  $('url').textContent = url || '—'
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

  // a server has been seen set here since the page opened
  let managed = false
  // healthAt when this page first saw the exit down, and whether its own
  // Re-check has failed since
  /** @type {number | undefined} */
  let downAt
  let rechecked = false
  let poll = 0
  // a click and a poll tick can both find the exit up; navigate once
  let leaving = false

  function leave () {
    leaving = true
    clearInterval(poll)
    location.replace(safeTarget)
  }

  /** @param {StateSnapshot} st */
  const own = st => Object.hasOwn(st.containers, container) ? st.containers[container] : undefined

  /** @param {StateSnapshot} st @returns {'wait' | 'go' | 'back' | 'stop'} */
  function follow (st) {
    const step = fmt.blockedNext(reason, st, container, managed)
    const c = own(st)
    if (c) managed = true
    if (!c || c.health !== 'down') {
      downAt = undefined
      rechecked = false
    } else if (downAt === undefined) {
      downAt = c.healthAt
    }
    if (step.show && step.show !== shown) {
      render(step.show)
      // the banner is not a live region, and unlike a page opened on the
      // failure this one still loads by itself
      $('status').textContent = step.show === 'proxy-unverified'
        ? ''
        : 'The check failed. This page will still load on its own once one passes.'
    }
    return step.next
  }

  /** @param {StateSnapshot} st */
  function hint (st) {
    const text = shown === 'proxy-down' && fmt.tunnelHint(st, container, downAt, rechecked) ? HINT : ''
    // a live region reads out every write, changed or not
    if ($('hint').textContent !== text) $('hint').textContent = text
  }

  $('options').addEventListener('click', () => browser.runtime.openOptionsPage())

  const retry = /** @type {HTMLButtonElement} */ ($('retry'))
  retry.addEventListener('click', async () => {
    retry.style.minWidth = `${retry.offsetWidth}px`
    retry.disabled = true
    retry.textContent = 'Checking…'
    /** @type {StateSnapshot} */
    let st
    try {
      if (container) await browser.runtime.sendMessage({ cmd: 'probe', cookieStoreId: container })
      st = await browser.runtime.sendMessage({ cmd: 'getState' })
    } catch (e) {
      // a background that cannot answer would otherwise leave a dead button
      retry.disabled = false
      retry.textContent = 'Re-check and retry'
      $('status').textContent = `Bulkhead did not answer: ${e instanceof Error ? e.message : String(e)}`
      return
    }
    if (leaving) return
    const next = follow(st)
    if ((next === 'go' || next === 'back') && safeTarget) {
      leave()
      return
    }
    retry.disabled = false
    retry.textContent = 'Re-check and retry'
    const c = own(st)
    if (c && c.health === 'down') rechecked = true
    // with no container there is nothing to re-check
    $('status').textContent = !st.ready
      ? `Bulkhead is still starting. ${st.hydrateError ? `It cannot read its settings: ${st.hydrateError}` : ''}`.trim()
      : c
        ? `Still blocked. ${fmt.explainDetail(c.healthDetail, c.custom) || ''}`.trim()
        : container
          ? 'This container no longer has a server set.'
          : 'This request had no container, so there is nothing to re-check. Turn off Strict mode in Settings if you need it through.'
    hint(st)
  })

  // The background probes on its own schedule; when the exit comes back, say
  // so instead of leaving a stale error page. A page that was only waiting
  // continues the navigation the user already asked for. With no container
  // there is nothing to follow, so no poll at all.
  if (container) {
    const tick = async () => {
      const st = await browser.runtime.sendMessage({ cmd: 'getState' })
      if (leaving) return
      const next = follow(st)
      hint(st)
      if (next === 'wait') return
      clearInterval(poll)
      if (next === 'go' && safeTarget) {
        leave()
        return
      }
      if (next === 'stop') {
        // a page that was waiting must not go on promising to load
        $('status').textContent = 'This container no longer has a server set.'
        return
      }
      if (!managed) return
      // the button carries the news; a second announcement next to it would
      // just compete, and any stale "Still blocked" line is now wrong
      $('status').textContent = ''
      retry.textContent = safeTarget ? 'Exit is back — reload page' : 'Exit is back'
      retry.disabled = false
    }
    poll = setInterval(tick, 2000)
    tick()
  }
})()
