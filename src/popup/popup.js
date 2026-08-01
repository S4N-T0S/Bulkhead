'use strict'
// One popup for every tab; it branches on the active tab's container. The
// popup itself is an extension page, not part of any container.

/* global fmt, createPicker */

;(() => {
  const view = /** @type {HTMLElement} */ (document.getElementById('view'))

  /** @type {string} */
  let cookieStoreId = 'firefox-default'
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
          ? `${who}: protected via ${c.host}.`
          : `${who}: ${fmt.healthLabel(c.health)}. Nothing is being sent direct.`
        : `${who}: not protected. Traffic uses your normal connection.`
    if (line === announced) return
    announced = line
    const el = document.getElementById('status-line')
    if (el) el.textContent = line
  }

  let picking = false

  function renderMain () {
    if (!snapshot) return
    view.textContent = ''
    if (!snapshot.ready) {
      msg('Starting up — verifying proxies…')
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
      : 'Setup unfinished — two Firefox settings still need setting →'
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
    return cookieStoreId === 'firefox-private' ? 'Private window' : 'No container'
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
      ? 'Private windows use your ordinary connection. Private browsing hides history from this computer — it hides nothing from the network. Give them a Mullvad server and they get the same treatment as everything else.'
      : 'Tabs outside any container use your ordinary connection, and so do Bulkhead\'s own background requests. Give them a Mullvad server and they get the same treatment as everything else.'
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
    pick.textContent = 'Pick a server…'
    pick.addEventListener('click', () => openPicker(''))
    const actions = document.createElement('div')
    actions.className = 'row wrap'
    actions.append(md, pick)
    view.append(actions)
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
    p.textContent = 'This container uses your ordinary connection. Give it its own Mullvad server, and if that server ever stops working Bulkhead blocks this container instead of letting it fall back.'
    view.append(p)

    const btn = document.createElement('button')
    btn.className = 'primary'
    btn.textContent = 'Proxy this container'
    btn.addEventListener('click', () => openPicker(''))
    view.append(btn)
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
    place.textContent = tunnelExit ? 'Mullvad tunnel exit' : `${c.city}, ${c.country}`
    const host = document.createElement('span')
    host.className = 'host mono'
    host.textContent = tunnelExit ? `${c.ip}` : c.host
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

    if (c.health !== 'up') {
      const note = document.createElement('div')
      note.className = `banner ${c.health === 'unknown' ? 'warn' : 'danger'}`
      if (c.health === 'unknown') {
        note.textContent = 'Verifying this exit. Traffic here is blocked until it checks out.'
      } else {
        const lead = document.createElement('div')
        lead.textContent = fmt.explainDetail(c.healthDetail) || 'This exit is not answering.'
        note.append(lead)
        const raw = fmt.rawDetail(c.healthDetail)
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
    stop.title = 'Remove this exit — traffic here goes over your normal connection'
    stop.addEventListener('click', async () => {
      stop.disabled = true
      await browser.runtime.sendMessage({ cmd: 'unassign', cookieStoreId })
      await refresh()
    })
    actions.append(recheck, change, stop)
    view.append(actions)
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
    title.textContent = identity ? `Exit for ${identity.name}` : 'Exit for default traffic'
    back.append(backBtn, title)
    view.append(back)

    const loading = document.createElement('div')
    loading.className = 'msg'
    loading.textContent = 'Loading server list…'
    view.append(loading)

    /** @type {{ relays?: Relay[], error?: string }} */
    const res = await browser.runtime.sendMessage({ cmd: 'getRelays' }).catch(e => ({ error: String(e) }))
    loading.remove()
    if (!res.relays || !snapshot) {
      const err = document.createElement('div')
      err.className = 'banner danger'
      err.textContent = `Could not load the server list. ${res.error || 'Is the Mullvad tunnel up?'}`
      view.append(err)
      return
    }

    const errBox = document.createElement('div')

    const picker = createPicker({
      relays: res.relays,
      recents: snapshot.recents,
      favorites: snapshot.favorites,
      currentHost,
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

  init().catch(e => msg(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`))

  window.addEventListener('unload', () => window.clearInterval(refreshTimer))
})()
