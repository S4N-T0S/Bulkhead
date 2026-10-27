'use strict'
// One popup for every tab; it branches on the active tab's container. The
// popup itself is an extension page, not part of any container.

/* global relaylib, fmt, createPicker */

;(() => {
  const view = /** @type {HTMLElement} */ (document.getElementById('view'))

  /** @type {string} */
  let cookieStoreId = 'firefox-default'
  /** [bhtz] the active tab, for Verify */
  let activeTabId = -1
  /** @type {{ cookieStoreId: string, name: string, colorCode: string } | null} */
  let identity = null
  /** @type {StateSnapshot | null} */
  let snapshot = null
  /** @type {number | undefined} */
  let refreshTimer

  document.getElementById('open-options')?.addEventListener('click', () => {
    browser.runtime.openOptionsPage()
    window.close()
  })

  async function init () {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    cookieStoreId = tab?.cookieStoreId || 'firefox-default'
    activeTabId = tab?.id ?? -1 // [bhtz]
    if (cookieStoreId.startsWith('firefox-container-')) {
      identity = await browser.contextualIdentities.get(cookieStoreId).catch(() => null)
      // a container tab whose identity cannot be read still has a routable
      // cookieStoreId, so fall back to managing it by id rather than
      // pretending there is nothing here
      if (!identity) identity = { cookieStoreId, name: cookieStoreId, colorCode: '' }
    }
    await refresh()
    // keep the health pill honest while the popup sits open
    refreshTimer = window.setInterval(refresh, 3000)
  }

  async function refresh () {
    snapshot = await browser.runtime.sendMessage({ cmd: 'getState' })
    if (!picking) renderMain()
    announce()
  }

  // The screen-reader summary. Only spoken when it actually changes, so the
  // timer refresh stays silent while nothing is happening.
  let announced = ''
  function announce () {
    if (!snapshot) return
    const c = snapshot.containers[cookieStoreId]
    const who = identity ? identity.name : contextLabel()
    const line = !snapshot.ready
      ? 'Bulkhead is starting up. All traffic is blocked until it finishes.'
      : c
        ? c.health === 'up'
          ? `${who}: protected via ${fmt.exitName(c)}.`
          : `${who}: ${fmt.healthLabel(c.health)}. Nothing is being sent direct.`
        : `${who}: not protected. Traffic uses your ordinary connection.`
    if (line === announced) return
    announced = line
    const el = document.getElementById('status-line')
    if (el) el.textContent = line
  }

  let picking = false
  // [bhtz] set after a pin change; the refresh timer rebuilds the view every
  // 3s, so the reload offer has to survive renders until acted on or left
  let reloadOffer = false

  function renderMain () {
    if (!snapshot) return
    view.textContent = ''
    if (!snapshot.ready) {
      msg('Starting up — traffic stays blocked until settings load.')
      // hydrate keeps retrying on its own; without this line a persistent
      // storage failure is indistinguishable from a slow start
      if (snapshot.hydrateError) msg(`Cannot read settings: ${snapshot.hydrateError} — retrying.`)
      return
    }
    if (!identity && cookieStoreId !== 'firefox-default' && cookieStoreId !== 'firefox-private') {
      msg('Nothing to manage here — this page sits outside the container system.')
      return
    }
    const c = snapshot.containers[cookieStoreId]
    if (c) renderManaged(c)
    else if (identity) renderUnmanaged()
    else renderBuiltinUnmanaged()
    renderSetupWarning()
  }

  // Reaches people who never open the options page, which is most of them.
  function renderSetupWarning () {
    if (!snapshot) return
    if (!snapshot.dohActive && snapshot.prefsAck) return
    const strip = document.createElement('button')
    strip.className = 'banner warn setup-strip'
    strip.textContent = snapshot.dohActive
      ? 'DNS-over-HTTPS is on — it links your containers back together. Fix it →'
      : 'Setup unfinished — two about:config settings still to set →'
    strip.addEventListener('click', () => {
      browser.runtime.openOptionsPage()
      window.close()
    })
    view.append(strip)
  }

  /** @param {string} text */
  function msg (text) {
    const div = document.createElement('div')
    div.className = 'msg'
    div.textContent = text
    view.append(div)
  }

  function containerRow () {
    const row = document.createElement('div')
    row.className = 'row container-row'
    // a bar, not a dot: a coloured circle beside the health pill reads as a
    // second status light and can contradict the real one
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    if (identity) swatch.style.background = identity.colorCode
    else swatch.classList.add('builtin')
    const name = document.createElement('span')
    name.className = 'name grow'
    name.textContent = identity ? identity.name : contextLabel()
    name.title = name.textContent
    row.append(swatch, name)
    return row
  }

  function contextLabel () {
    return cookieStoreId === 'firefox-private' ? 'Private windows' : 'No container'
  }

  function renderBuiltinUnmanaged () {
    const isPrivate = cookieStoreId === 'firefox-private'
    const head = containerRow()
    const pill = document.createElement('span')
    pill.className = 'pill off'
    pill.textContent = 'Not protected'
    head.append(pill)
    view.append(head)

    const p = document.createElement('p')
    p.className = 'sub'
    p.textContent = isPrivate
      ? 'Private windows use your ordinary connection — private browsing hides nothing from the network. Give them a server of their own and they get the same treatment as everything else.'
      : 'Tabs outside any container use your ordinary connection, and so do Bulkhead\'s own background requests. Give them a server of their own and they get the same treatment as everything else.'
    view.append(p)

    const md = document.createElement('button')
    md.className = 'primary'
    md.textContent = 'Use the Mullvad tunnel exit'
    md.title = '10.64.0.1 — follows whatever server the Mullvad app is connected to'
    md.addEventListener('click', async () => {
      md.disabled = true
      await browser.runtime.sendMessage({ cmd: 'assign', cookieStoreId, host: 'mullvad-direct' })
      await refresh()
    })
    const pick = document.createElement('button')
    pick.textContent = 'Choose server…'
    pick.addEventListener('click', () => openPicker(''))
    const actions = document.createElement('div')
    actions.className = 'row wrap'
    actions.append(md, pick)
    view.append(actions)

    // [bhtz] a pin on an unassigned context is legitimate — the card says
    // plainly that nothing backs it up — but stay out of the way otherwise
    if (snapshot && snapshot.tz && (snapshot.tz.overrides[cookieStoreId] || snapshot.tz.zones[cookieStoreId])) {
      renderTzCard()
      if (reloadOffer) offerReload()
    }
  }

  function renderUnmanaged () {
    const head = containerRow()
    const pill = document.createElement('span')
    pill.className = 'pill off'
    pill.textContent = 'Not protected'
    head.append(pill)
    view.append(head)

    const p = document.createElement('p')
    p.className = 'sub'
    p.textContent = 'This container uses your ordinary connection. Give it a server of its own, and if that server ever stops working Bulkhead blocks this container instead of letting it fall back.'
    view.append(p)

    const btn = document.createElement('button')
    btn.className = 'primary'
    btn.textContent = 'Proxy this container'
    btn.addEventListener('click', () => openPicker(''))
    view.append(btn)

    // [bhtz]
    if (snapshot && snapshot.tz && (snapshot.tz.overrides[cookieStoreId] || snapshot.tz.zones[cookieStoreId])) {
      renderTzCard()
      if (reloadOffer) offerReload()
    }
  }

  /** @param {ContainerConfig} c */
  function renderManaged (c) {
    const head = containerRow()
    const pill = document.createElement('span')
    pill.className = `pill ${fmt.healthClass(c.health)}`
    pill.textContent = fmt.healthLabel(c.health)
    head.append(pill)
    view.append(head)

    const tunnelExit = c.host === 'mullvad-direct'
    const custom = c.custom === true
    const card = document.createElement('div')
    card.className = 'exit-card'

    const where = document.createElement('div')
    where.className = 'row'
    const flagSrc = fmt.flagSrc(c.cc)
    if (flagSrc) {
      const img = document.createElement('img')
      img.className = 'flag'
      img.src = flagSrc
      img.alt = ''
      where.append(img)
    }
    const place = document.createElement('span')
    place.className = 'place grow'
    place.textContent = tunnelExit || custom ? fmt.exitName(c) : `${c.city}, ${c.country}`
    const host = document.createElement('span')
    host.className = 'host mono'
    host.textContent = tunnelExit ? `${c.ip}` : custom ? `${c.ip}:${c.port}` : c.host
    where.append(place, host)
    card.append(where)

    const status = document.createElement('div')
    status.className = 'row sub'
    const checked = fmt.timeAgo(c.healthAt, Date.now())
    status.textContent = c.health === 'up' && c.exitIp
      ? `exit ${c.exitIp} · verified ${checked}`
      : checked
        ? `last checked ${checked}`
        : 'not checked yet'
    card.append(status)
    view.append(card)

    renderTzCard() // [bhtz]
    if (reloadOffer) offerReload() // [bhtz]

    if (c.health !== 'up') {
      const note = document.createElement('div')
      note.className = `banner ${c.health === 'unknown' ? 'warn' : 'danger'}`
      if (c.health === 'unknown') {
        note.textContent = 'Verifying this exit. Traffic here is blocked until it checks out.'
      } else {
        const lead = document.createElement('div')
        lead.textContent = fmt.explainDetail(c.healthDetail, c.custom) || 'This server is not answering.'
        note.append(lead)
        const raw = fmt.rawDetail(c.healthDetail, c.custom)
        if (raw) {
          const code = document.createElement('div')
          code.className = 'sub mono'
          code.textContent = raw
          note.append(code)
        }
      }
      view.append(note)
    }

    const actions = document.createElement('div')
    actions.className = 'row wrap'
    const recheck = document.createElement('button')
    recheck.textContent = 'Re-check'
    recheck.addEventListener('click', async () => {
      recheck.style.minWidth = `${recheck.offsetWidth}px`
      recheck.disabled = true
      recheck.textContent = 'Checking…'
      await browser.runtime.sendMessage({ cmd: 'probe', cookieStoreId })
      await refresh()
    })
    const change = document.createElement('button')
    change.textContent = 'Change server'
    change.addEventListener('click', () => openPicker(c.host))
    const stop = document.createElement('button')
    stop.className = 'quiet danger'
    stop.textContent = identity ? 'Stop proxying' : 'Use direct'
    stop.title = 'Remove this exit — traffic here goes over your ordinary connection'
    stop.addEventListener('click', async () => {
      stop.disabled = true
      await browser.runtime.sendMessage({ cmd: 'unassign', cookieStoreId })
      await refresh()
    })
    actions.append(recheck, change, stop)
    view.append(actions)
  }

  /* ---- [bhtz] timezone matching ----------------------------------------
   * One card, two subviews. The card states what pages in this context
   * present and why; the subviews change the pin and check the live page
   * realm. All of it is additive: nothing here touches the exit UI above. */

  function renderTzCard () {
    if (!snapshot) return
    const tz = snapshot.tz
    if (!tz) return

    const d = tz.zones[cookieStoreId]
    const ov = tz.overrides[cookieStoreId]

    const card = document.createElement('div')
    card.className = 'exit-card tz-card'

    const row = document.createElement('div')
    row.className = 'row'
    const globe = document.createElement('span')
    globe.className = 'tz-glyph'
    globe.setAttribute('aria-hidden', 'true')
    globe.textContent = '🕐'
    const name = document.createElement('span')
    name.className = 'place grow mono'
    name.textContent = d ? d.zone : ov === 'off' ? 'System zone' : tz.enabled ? '—' : 'Matching off'
    row.append(globe, name)
    card.append(row)

    const why = document.createElement('div')
    why.className = 'sub'
    why.textContent = fmt.tzSourceText(d ? d.source : ov === 'off' ? 'off' : tz.enabled ? 'unknown' : 'disabled', d && d.approx)
    card.append(why)

    // A refused MAIN-world registration means pages run with the machine's
    // real zone while the exit says otherwise — say so instead of showing a
    // zone that is not being presented.
    if (tz.enabled && tz.supported === false) {
      const b = document.createElement('div')
      b.className = 'banner danger'
      b.textContent = 'This Firefox refused main-world script injection, so no timezone can be installed. Bulkhead TZ needs Firefox 128 or newer.'
      card.append(b)
    } else if (tz.enabled && tz.error) {
      const b = document.createElement('div')
      b.className = 'banner warn'
      b.textContent = `Timezone injection failed: ${tz.error}`
      card.append(b)
    }

    const actions = document.createElement('div')
    actions.className = 'row wrap'
    const pin = document.createElement('button')
    pin.className = 'quiet'
    pin.textContent = d && d.source === 'pin' ? 'Change pin…' : ov === 'off' ? 'Pinned off…' : 'Pin zone…'
    pin.addEventListener('click', () => openZonePicker())
    const verify = document.createElement('button')
    verify.className = 'quiet'
    verify.textContent = 'Verify'
    verify.title = 'Read what the current page actually reports — the same derivations CreepJS uses'
    verify.addEventListener('click', () => openVerify())
    actions.append(pin, verify)
    card.append(actions)

    view.append(card)
  }

  async function openZonePicker () {
    picking = true
    reloadOffer = false
    view.textContent = ''

    const back = document.createElement('div')
    back.className = 'row backbar'
    const backBtn = document.createElement('button')
    backBtn.className = 'quiet'
    backBtn.textContent = '‹ Back'
    backBtn.addEventListener('click', () => {
      picking = false
      renderMain()
    })
    const title = document.createElement('span')
    title.className = 'sub grow'
    title.textContent = `Timezone for ${identity ? identity.name : contextLabel()}`
    back.append(backBtn, title)
    view.append(back)

    const tz = snapshot && snapshot.tz
    const current = tz ? tz.overrides[cookieStoreId] : undefined
    const d = tz ? tz.zones[cookieStoreId] : undefined

    const note = document.createElement('p')
    note.className = 'sub'
    note.textContent = 'Pins stand until you clear them and outrank every lookup. A pin on a context with no exit of its own is a claim the network will not back up — sites see your real IP with it.'
    view.append(note)

    /** @param {string} label @param {string | null} sub @param {string} value @param {boolean} isCurrent */
    const mk = (label, sub, value, isCurrent) => {
      const b = document.createElement('button')
      b.className = `tz-entry row${isCurrent ? ' current' : ''}`
      const l = document.createElement('span')
      l.className = 'grow'
      l.textContent = label
      b.append(l)
      if (sub) {
        const s = document.createElement('span')
        s.className = 'sub mono'
        s.textContent = sub
        b.append(s)
      }
      b.addEventListener('click', async () => {
        b.disabled = true
        await browser.runtime.sendMessage({ cmd: 'tzOverride', cookieStoreId, value })
        picking = false
        reloadOffer = true
        await refresh()
      })
      return b
    }

    const specials = document.createElement('div')
    specials.className = 'tz-specials'
    specials.append(
      mk('Match the exit', 'auto', 'auto', current === undefined && Boolean(d)),
      mk('Off — system zone', 'never spoof here', 'off', current === 'off')
    )
    view.append(specials)

    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = 'Search zones — oslo, tokyo, america/…'
    search.setAttribute('aria-label', 'Search timezones')
    search.className = 'tz-search'
    view.append(search)

    const list = document.createElement('div')
    list.className = 'tz-list scroller'
    view.append(list)

    // The engine's own list, from the same ICU the patch delegates to: a
    // zone that appears here is a zone the realm patch can install.
    /** @type {string[]} */
    let zones = []
    try {
      zones = Intl.supportedValuesOf('timeZone')
    } catch {
      zones = []
    }
    const pinned = typeof current === 'string' && current !== 'off' ? current : null

    function renderList () {
      const q = search.value.trim().toLowerCase().replace(/_/g, ' ')
      list.textContent = ''
      const shown = zones
        .filter(z => !q || z.toLowerCase().replace(/_/g, ' ').includes(q))
        .slice(0, 400)
      for (const z of shown) {
        const b = document.createElement('button')
        b.className = `tz-entry${z === pinned ? ' current' : ''}`
        b.textContent = z
        b.addEventListener('click', async () => {
          b.disabled = true
          await browser.runtime.sendMessage({ cmd: 'tzOverride', cookieStoreId, value: z })
          picking = false
          reloadOffer = true
          await refresh()
        })
        list.append(b)
      }
      if (!shown.length) {
        const empty = document.createElement('div')
        empty.className = 'msg'
        empty.textContent = 'No zone matches that.'
        list.append(empty)
      }
    }
    search.addEventListener('input', renderList)
    renderList()
    search.focus()
  }

  // Open documents were loaded under the old zone; the registration only
  // reaches NEW documents. Offer the reload instead of surprising anyone.
  // Re-rendered by renderMain while reloadOffer stands, so the 3s refresh
  // timer cannot wipe it; back-navigation and the click itself clear it.
  function offerReload () {
    const bar = document.createElement('div')
    bar.className = 'banner row'
    const msgSpan = document.createElement('span')
    msgSpan.className = 'sub grow'
    msgSpan.textContent = 'Open tabs still run the old zone.'
    const go = document.createElement('button')
    go.textContent = 'Reload them'
    go.addEventListener('click', async () => {
      go.disabled = true
      reloadOffer = false
      await browser.runtime.sendMessage({ cmd: 'tzReloadTabs', cookieStoreId })
      window.close()
    })
    bar.append(msgSpan, go)
    view.append(bar)
  }

  async function openVerify () {
    picking = true
    view.textContent = ''
    reloadOffer = false

    const back = document.createElement('div')
    back.className = 'row backbar'
    const backBtn = document.createElement('button')
    backBtn.className = 'quiet'
    backBtn.textContent = '‹ Back'
    backBtn.addEventListener('click', () => {
      picking = false
      renderMain()
    })
    const title = document.createElement('span')
    title.className = 'sub grow'
    title.textContent = 'What the page actually reports'
    back.append(backBtn, title)
    view.append(back)

    const busy = document.createElement('div')
    busy.className = 'msg'
    busy.textContent = 'Reading the page realm…'
    view.append(busy)

    const expected = snapshot && snapshot.tz ? (snapshot.tz.zones[cookieStoreId] || {}).zone || null : null
    /** @type {{ ok: boolean, error?: string, result?: Record<string, any> }} */
    const res = await browser.runtime.sendMessage({ cmd: 'tzVerify', tabId: activeTabId })
      .catch(e => ({ ok: false, error: String(e) }))
    busy.remove()

    if (!res || !res.ok || !res.result) {
      const b = document.createElement('div')
      b.className = 'banner warn'
      b.textContent = `Cannot verify this tab: ${(res && res.error) || 'no answer'}. Verification needs an ordinary web page open in this context.`
      view.append(b)
      return
    }

    const r = res.result
    const rows = [
      ['reported zone', r.tz, expected ? r.tz === expected : null],
      ['getTimezoneOffset()', String(r.offset), null],
      ['offset from string parsing (CreepJS)', String(r.offsetComputed), r.offsetComputed === r.offset],
      ['year-1113 LMT probe (CreepJS "computed location")', r.lmtMatch === true ? 'system = resolvedOptions' : r.lmtMatch === false ? `MISMATCH (${r.lmtSystem} vs ${r.lmtResolved})` : 'error', r.lmtMatch === true ? true : r.lmtMatch === false ? false : null],
      ['about:blank probe realm (CreepJS lie inspection)', r.iframeTz == null ? 'error' : `${r.iframeTz} · offset ${r.iframeOffset}`, r.iframeTz == null ? null : r.iframeTz === r.tz],
      ['local getters vs Intl', r.gettersAgree === null ? 'error' : r.gettersAgree ? 'agree' : 'DISAGREE', r.gettersAgree === null ? null : Boolean(r.gettersAgree)],
      ['Date#toString zone name', String(r.dateToString).replace(/^.*\((.*)\).*$/, '$1'), null],
      ['injection', r.stamp ? (r.stamp.late ? 'LATE — page ran first' : 'document-start, clean') : 'no stamp — engine not present', r.stamp ? !r.stamp.late : false]
    ]

    const table = document.createElement('div')
    table.className = 'tz-verify'
    for (const [label, value, ok] of rows) {
      const row = document.createElement('div')
      row.className = 'row tz-vrow'
      const mark = document.createElement('span')
      mark.className = ok === true ? 'good' : ok === false ? 'bad' : 'sub'
      mark.textContent = ok === true ? '✓' : ok === false ? '✗' : '·'
      const l = document.createElement('span')
      l.className = 'sub grow'
      l.textContent = label
      const v = document.createElement('span')
      v.className = 'mono'
      v.textContent = value
      row.append(mark, l, v)
      table.append(row)
    }
    view.append(table)

    const clean = rows.every(([, , ok]) => ok !== false)
    const verdict = document.createElement('div')
    verdict.className = `banner ${clean ? '' : 'danger'}`
    verdict.textContent = expected
      ? clean
        ? `Consistent — the page presents ${expected} everywhere a fingerprinter looks.`
        : 'Inconsistent — something on this page is not presenting the installed zone. Reload the tab; if it persists, check for another timezone-spoofing extension or userscript.'
      : 'No zone is expected here (unmanaged or matching off), so nothing to pass or fail — the values above are what the page reports.'
    view.append(verdict)
  }

  /** @param {string} currentHost */
  async function openPicker (currentHost) {
    picking = true
    view.textContent = ''

    const back = document.createElement('div')
    back.className = 'row backbar'
    const backBtn = document.createElement('button')
    backBtn.className = 'quiet'
    backBtn.textContent = '‹ Back'
    backBtn.addEventListener('click', () => {
      picking = false
      renderMain()
    })
    const title = document.createElement('span')
    title.className = 'sub grow'
    title.textContent = identity
      ? `Exit for ${identity.name}`
      : cookieStoreId === 'firefox-private' ? 'Exit for private windows' : 'Exit for default traffic'
    back.append(backBtn, title)
    view.append(back)

    const loading = document.createElement('div')
    loading.className = 'msg'
    loading.textContent = 'Loading server list…'
    view.append(loading)

    /** @type {{ relays?: Relay[], error?: string }} */
    const res = await browser.runtime.sendMessage({ cmd: 'getRelays' }).catch(e => ({ error: String(e) }))
    loading.remove()
    if (!snapshot) return

    const errBox = document.createElement('div')
    if (!res.relays) {
      // Custom exits neither come from that list nor need the tunnel, so the
      // picker still has something to offer.
      const err = document.createElement('div')
      err.className = 'banner danger'
      err.textContent = 'Could not load the Mullvad server list. Check the Mullvad app is connected. Custom exits are still listed below.'
      errBox.append(err)
    }

    const picker = createPicker({
      relays: res.relays || [],
      customExits: snapshot.customExits,
      recents: snapshot.recents,
      favorites: snapshot.favorites,
      currentHost,
      assigned: fmt.usedBy(relaylib.assignedElsewhere(snapshot.containers, cookieStoreId), snapshot.names),
      onFavorite: (host, on) => {
        browser.runtime.sendMessage({ cmd: 'favorite', host, on })
      },
      onPick: async (host) => {
        errBox.textContent = ''
        const out = await browser.runtime.sendMessage({ cmd: 'assign', cookieStoreId, host })
        if (!out.ok) {
          errBox.textContent = ''
          const err = document.createElement('div')
          err.className = 'banner danger'
          err.textContent = out.error || 'Assignment failed.'
          errBox.append(err)
          return
        }
        picking = false
        await refresh()
      }
    })
    view.append(errBox, picker.el)
    picker.focus()
  }

  init().catch(e => msg(`Bulkhead could not load: ${e instanceof Error ? e.message : String(e)}`))

  window.addEventListener('unload', () => window.clearInterval(refreshTimer))
})()
