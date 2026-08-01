'use strict'
/* global fmt, createPicker */

;(() => {
  /** @param {string} id @returns {HTMLElement} */
  const $ = id => /** @type {HTMLElement} */ (document.getElementById(id))

  /** @type {StateSnapshot | null} */
  let snapshot = null
  /** @type {browser.contextualIdentities.ContextualIdentity[]} */
  let identities = []

  async function refresh () {
    const [st, ids] = await Promise.all([
      browser.runtime.sendMessage({ cmd: 'getState' }),
      // rejects outright when privacy.userContext.enabled is false; the page
      // still has work to do for the default and private contexts
      browser.contextualIdentities.query({}).catch(() => [])
    ])
    snapshot = st
    identities = ids
    // one bad section should not blank the whole page
    for (const render of [renderSetup, renderOffline, renderContainers, renderRelayMeta, renderCustom, renderLog]) {
      try {
        render()
      } catch (e) {
        console.error('bulkhead: render failed', e)
      }
    }
    const strict = /** @type {HTMLInputElement} */ ($('strict'))
    strict.checked = st.strict
    const allowLocal = /** @type {HTMLInputElement} */ ($('allow-local'))
    allowLocal.checked = st.allowLocal
    $('version').textContent = `v${st.version}`
  }

  // -- setup gate

  let setupOpen = false

  function renderSetup () {
    if (!snapshot) return
    // DoH being observably on overrides the acknowledgement: the card stays
    // open until it is actually fixed.
    const done = snapshot.prefsAck && !snapshot.dohActive
    $('setup').classList.toggle('pending', !done)
    const body = $('setup-body')
    const ack = /** @type {HTMLInputElement} */ ($('prefs-ack'))
    ack.checked = snapshot.prefsAck
    $('setup-state').hidden = !done
    $('setup-toggle').hidden = !done
    body.hidden = done && !setupOpen
    $('setup-toggle').textContent = body.hidden ? 'Show' : 'Hide'

    // Only ever a warning. A quiet result is not proof DoH is off, so it
    // never claims one.
    const doh = $('doh-state')
    doh.textContent = ''
    if (snapshot.dohActive) {
      const mark = document.createElement('span')
      mark.className = 'badmark'
      mark.textContent = '✗ '
      doh.append(mark, document.createTextNode(
        'DNS-over-HTTPS is active — Firefox answered a lookup from a trusted recursive resolver, so this pref is not at 5.'
      ))
    } else {
      doh.textContent = 'No DoH seen on the last check. Firefox exposes no way to read this pref directly, so this is not a confirmation — only the absence of a warning.'
    }
  }

  $('setup-toggle').addEventListener('click', () => {
    setupOpen = !setupOpen
    renderSetup()
  })

  $('prefs-ack').addEventListener('change', async (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked
    await browser.runtime.sendMessage({ cmd: 'ackPrefs', on })
    setupOpen = false
    await refresh()
  })

  for (const btn of document.querySelectorAll('button.copy')) {
    btn.addEventListener('click', async () => {
      const name = /** @type {HTMLElement} */ (btn).dataset.copy || ''
      await navigator.clipboard.writeText(name)
      const label = btn.textContent
      btn.textContent = 'Copied'
      setTimeout(() => {
        btn.textContent = label
      }, 1200)
    })
  }

  /** @param {string} id @returns {string} */
  function contextName (id) {
    if (id === 'firefox-default') return 'No container'
    if (id === 'firefox-private') return 'Private windows'
    return id
  }

  // -- offline warnings

  function renderOffline () {
    const box = $('offline-banner')
    box.textContent = ''
    if (!snapshot) return

    // Without the private-windows grant the listeners never fire there, so
    // an assignment would be a promise the extension cannot keep. Say so
    // where the user is already looking at their contexts.
    if (!snapshot.privateAllowed && snapshot.containers['firefox-private']) {
      const b = document.createElement('div')
      b.className = 'banner warn'
      b.textContent = 'Private windows are assigned, but Bulkhead is not allowed to run in them — so they are browsing unprotected. Open about:addons → Bulkhead → Details and turn on "Run in Private Windows".'
      box.append(b)
    }

    // A server Mullvad renamed reads as "wrong exit" to the probe, which is
    // alarming and not what happened. Say which it is, and let the user
    // accept the new name -- never accept it for them.
    for (const [id, host] of Object.entries(snapshot.renamed || {})) {
      const c = snapshot.containers[id]
      if (!c || c.health !== 'misrouted') continue
      const ident = identities.find(i => i.cookieStoreId === id)
      const who = ident ? ident.name : contextName(id)
      const b = document.createElement('div')
      b.className = 'banner warn'
      const p = document.createElement('div')
      p.textContent = host
        ? `Mullvad appears to have renamed ${c.host} to ${host}. Traffic for “${who}” is blocked until you confirm, because a different server name is also what a real misroute looks like.`
        : `“${who}” is blocked: traffic came out at a different server than ${c.host}. Its server may have been retired. Pick another to carry on.`
      b.append(p)
      const row = document.createElement('div')
      row.className = 'row'
      if (host) {
        const accept = document.createElement('button')
        accept.textContent = `Move to ${host}`
        accept.addEventListener('click', async () => {
          accept.disabled = true
          await browser.runtime.sendMessage({ cmd: 'assign', cookieStoreId: id, host })
          await refresh()
        })
        row.append(accept)
      }
      const pick = document.createElement('button')
      pick.className = 'quiet'
      pick.textContent = 'Choose another…'
      pick.addEventListener('click', () => openPicker(id))
      row.append(pick)
      b.append(row)
      box.append(b)
    }

    if (!snapshot.relays.offline.length) return

    for (const o of snapshot.relays.offline) {
      const ident = identities.find(i => i.cookieStoreId === o.cookieStoreId)
      const who = ident ? ident.name : contextName(o.cookieStoreId)
      const banner = document.createElement('div')
      banner.className = 'banner danger'
      const p = document.createElement('div')
      const b = document.createElement('strong')
      b.textContent = o.host
      p.append(b, document.createTextNode(
        ` — the server assigned to “${who}” is out of service. Its traffic stays blocked until you move it.`
      ))
      banner.append(p)

      const row = document.createElement('div')
      row.className = 'row'
      if (o.alternative) {
        const move = document.createElement('button')
        move.textContent = `Move to ${o.alternative.host} (${o.alternative.city})`
        move.addEventListener('click', async () => {
          move.disabled = true
          await browser.runtime.sendMessage({ cmd: 'assign', cookieStoreId: o.cookieStoreId, host: o.alternative?.host })
          await refresh()
        })
        row.append(move)
      }
      const pick = document.createElement('button')
      pick.className = 'quiet'
      pick.textContent = 'Choose another…'
      pick.addEventListener('click', () => openPicker(o.cookieStoreId))
      row.append(pick)
      banner.append(row)
      box.append(banner)
    }
  }

  // -- containers table

  function renderContainers () {
    if (!snapshot) return
    const tbody = $('container-rows')
    tbody.textContent = ''
    $('no-containers').hidden = identities.length > 0

    // the two built-in contexts first: the default one covers every tab
    // outside a container plus the extension's own requests, and private
    // windows are the one place traffic would otherwise always go direct
    const rows = [
      { cookieStoreId: 'firefox-default', name: 'No container', colorCode: '' },
      { cookieStoreId: 'firefox-private', name: 'Private windows', colorCode: '' },
      ...identities
    ]
    let primaryUsed = false
    for (const ident of rows) {
      const c = snapshot.containers[ident.cookieStoreId]
      const tr = document.createElement('tr')

      const isPrivate = ident.cookieStoreId === 'firefox-private'
      const nameCell = tr.insertCell()
      const nameRow = document.createElement('div')
      nameRow.className = 'row'
      const swatch = document.createElement('span')
      // the container's own colour, drawn as a tab-style bar rather than a
      // circle: a small green dot beside a red health pill reads as a status
      // light and contradicts it
      swatch.className = 'swatch'
      if (ident.colorCode) swatch.style.background = ident.colorCode
      else swatch.classList.add('builtin')
      const name = document.createElement('span')
      name.textContent = ident.name
      nameRow.append(swatch, name)
      nameCell.append(nameRow)

      const exitCell = tr.insertCell()
      if (c) {
        const tunnelExit = c.host === 'mullvad-direct'
        const customExit = c.custom === true
        const wrap = document.createElement('div')
        wrap.className = 'exitcell'
        const src = fmt.flagSrc(c.cc)
        if (src) {
          const img = document.createElement('img')
          img.className = 'flag'
          img.src = src
          img.alt = ''
          wrap.append(img)
        }
        const place = document.createElement('span')
        place.className = 'place'
        place.textContent = tunnelExit ? 'Tunnel exit' : customExit ? (c.label || 'Custom exit') : c.city
        const host = document.createElement('span')
        host.className = 'mono hostname'
        host.textContent = tunnelExit ? c.ip : customExit ? `${c.ip}:${c.port}` : c.host
        place.append(host)
        wrap.append(place)
        exitCell.append(wrap)
      } else {
        exitCell.textContent = 'Not set'
      }
      // do not wipe an assignment the user made; the status cell covers it
      if (isPrivate && !snapshot.privateAllowed && !c) exitCell.textContent = '—'

      const statusCell = tr.insertCell()
      const pill = document.createElement('span')
      pill.className = `pill ${fmt.healthClass(c && c.health)}`
      pill.textContent = fmt.healthLabel(c && c.health)
      statusCell.append(pill)
      if (c) {
        const sub = document.createElement('span')
        sub.className = 'sub'
        const ago = fmt.timeAgo(c.healthAt, Date.now())
        const why = c.health === 'up'
          ? (c.exitIp ? `exit ${c.exitIp}` : '')
          : fmt.explainDetail(c.healthDetail, c.custom)
        sub.textContent = [why, ago].filter(Boolean).join(' · ')
        statusCell.append(sub)
        const raw = c.health === 'up' ? '' : fmt.rawDetail(c.healthDetail, c.custom)
        if (raw) {
          const code = document.createElement('code')
          code.className = 'sub'
          code.textContent = raw
          statusCell.append(code)
        }
      }
      if (isPrivate && !snapshot.privateAllowed) {
        const why = document.createElement('span')
        why.className = 'sub'
        why.textContent = 'Firefox hides private windows from extensions until you allow it.'
        statusCell.append(why)
      }

      const actions = tr.insertCell()
      const actionRow = document.createElement('div')
      actionRow.className = 'row'
      if (c) {
        const check = document.createElement('button')
        check.textContent = 'Re-check'
        check.addEventListener('click', async () => {
          check.style.minWidth = `${check.offsetWidth}px`
          check.disabled = true
          check.textContent = '…'
          await browser.runtime.sendMessage({ cmd: 'probe', cookieStoreId: ident.cookieStoreId })
          await refresh()
        })
        const change = document.createElement('button')
        change.textContent = 'Change'
        change.addEventListener('click', () => openPicker(ident.cookieStoreId))
        const stop = document.createElement('button')
        stop.className = 'quiet danger'
        stop.textContent = ident.colorCode ? 'Stop proxying' : 'Use direct'
        stop.title = 'Remove this exit — traffic here goes over your ordinary connection'
        stop.addEventListener('click', async () => {
          stop.disabled = true
          await browser.runtime.sendMessage({ cmd: 'unassign', cookieStoreId: ident.cookieStoreId })
          await refresh()
        })
        actionRow.append(check, change, stop)
      } else if (isPrivate && !snapshot.privateAllowed) {
        // extensions cannot open about:addons, so hand over the address
        const copy = document.createElement('button')
        copy.textContent = 'Copy about:addons'
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText('about:addons')
          copy.textContent = 'Copied — paste in a new tab'
          setTimeout(() => {
            copy.textContent = 'Copy about:addons'
          }, 4000)
        })
        actionRow.append(copy)
      } else {
        const add = document.createElement('button')
        // one primary action per page, and not while the setup gate is open
        const ready = snapshot.prefsAck && !snapshot.dohActive
        add.className = ready && !primaryUsed ? 'primary' : ''
        if (ready) primaryUsed = true
        add.textContent = 'Choose server…'
        add.addEventListener('click', () => openPicker(ident.cookieStoreId))
        actionRow.append(add)
      }
      actions.append(actionRow)
      tbody.append(tr)
    }
  }

  $('recheck-all').addEventListener('click', async () => {
    const btn = /** @type {HTMLButtonElement} */ ($('recheck-all'))
    btn.disabled = true
    await browser.runtime.sendMessage({ cmd: 'probeAll' })
    btn.disabled = false
    await refresh()
  })

  // -- picker dialog

  const dialog = /** @type {HTMLDialogElement} */ ($('picker-dialog'))
  $('picker-close').addEventListener('click', () => dialog.close())
  // ~600 rows and the relay list behind them would otherwise sit in the
  // closed dialog until the next time it opens.
  dialog.addEventListener('close', () => {
    $('picker-mount').textContent = ''
  })

  /** @param {string} cookieStoreId */
  async function openPicker (cookieStoreId) {
    if (!snapshot) return
    const ident = identities.find(i => i.cookieStoreId === cookieStoreId)
    $('picker-title').textContent = ident
      ? `Exit for ${ident.name}`
      : cookieStoreId === 'firefox-default'
        ? 'Exit for default traffic'
        : cookieStoreId === 'firefox-private' ? 'Exit for private windows' : 'Choose exit'
    const mount = $('picker-mount')
    const errBox = $('picker-error')
    errBox.textContent = ''
    mount.textContent = 'Loading server list…'
    dialog.showModal()

    const res = await browser.runtime.sendMessage({ cmd: 'getRelays' }).catch(e => ({ error: String(e) }))
    mount.textContent = ''
    if (!res.relays) {
      // Custom exits do not come from that list and do not need the tunnel,
      // so the picker still has something to offer -- returning here would
      // put the one thing that still works behind the one thing that failed.
      showPickerError('Could not load the Mullvad server list. Check the Mullvad app is connected. Custom exits are still listed below.')
    }

    const current = snapshot.containers[cookieStoreId]
    const picker = createPicker({
      relays: res.relays || [],
      customExits: snapshot.customExits,
      recents: snapshot.recents,
      favorites: snapshot.favorites,
      currentHost: current ? current.host : '',
      onFavorite: (host, on) => {
        browser.runtime.sendMessage({ cmd: 'favorite', host, on })
      },
      onPick: async (host) => {
        errBox.textContent = ''
        const out = await browser.runtime.sendMessage({ cmd: 'assign', cookieStoreId, host })
        if (!out.ok) {
          showPickerError(out.error || 'Assignment failed.')
          return
        }
        dialog.close()
        await refresh()
      }
    })
    mount.append(picker.el)
    picker.focus()
  }

  /** @param {string} text */
  function showPickerError (text) {
    const errBox = $('picker-error')
    errBox.textContent = ''
    const err = document.createElement('div')
    err.className = 'banner danger'
    err.textContent = text
    errBox.append(err)
  }

  // -- protection

  $('strict').addEventListener('change', async (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked
    await browser.runtime.sendMessage({ cmd: 'setStrict', on })
  })

  $('allow-local').addEventListener('change', async (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked
    await browser.runtime.sendMessage({ cmd: 'setAllowLocal', on })
  })

  async function renderHardening () {
    const h = await browser.runtime.sendMessage({ cmd: 'getHardening' })
    const box = /** @type {HTMLInputElement} */ ($('harden'))
    box.checked = h.enabled

    const rows = [
      ['WebRTC routing', String(h.webRTC.value), h.webRTC.ok, 'proxy_only', h.webRTC.levelOfControl],
      ['Prefetch / prerender', String(h.prediction.value), h.prediction.ok, 'false', h.prediction.levelOfControl]
    ]
    const ul = $('harden-state')
    ul.textContent = ''
    for (const [label, value, ok, want, control] of rows) {
      const li = document.createElement('li')
      const mark = document.createElement('span')
      mark.className = ok ? 'okmark' : 'badmark'
      mark.textContent = ok ? '✓ ' : '✗ '
      li.append(mark, document.createTextNode(`${label}: `))
      const code = document.createElement('code')
      code.textContent = value
      li.append(code)
      if (!ok) li.append(document.createTextNode(` (want ${want})`))
      if (control && control !== 'controlled_by_this_extension' && control !== 'controllable_by_this_extension') {
        // another extension owns the setting; a toggle that silently does
        // nothing would look broken
        li.append(document.createTextNode(` — controlled elsewhere (${control})`))
      }
      ul.append(li)
    }
  }

  $('harden').addEventListener('change', async (e) => {
    const box = /** @type {HTMLInputElement} */ (e.target)
    box.disabled = true
    await browser.runtime.sendMessage({ cmd: 'setHardening', on: box.checked })
    box.disabled = false
    renderHardening()
  })

  // -- server list & activity

  function renderRelayMeta () {
    if (!snapshot) return
    const { count, source, ts } = snapshot.relays
    $('relay-meta').textContent = count
      ? `${count} active servers · ${source === 'tunnel' ? 'in-tunnel API' : 'public API'} · ${fmt.timeAgo(ts, Date.now())}`
      : 'not fetched yet'
  }

  $('refresh-relays').addEventListener('click', async () => {
    const btn = /** @type {HTMLButtonElement} */ ($('refresh-relays'))
    btn.style.minWidth = `${btn.offsetWidth}px`
    btn.disabled = true
    btn.textContent = 'Refreshing…'
    await browser.runtime.sendMessage({ cmd: 'getRelays', force: true }).catch(() => null)
    btn.disabled = false
    btn.textContent = 'Refresh'
    await refresh()
  })

  // -- custom exits

  /** @param {string} id @returns {HTMLInputElement} */
  const input = id => /** @type {HTMLInputElement} */ ($(id))

  // '' means the form is adding; an id means it is editing that exit.
  let editingCustom = ''

  function renderCustom () {
    if (!snapshot) return
    const box = $('custom-list')
    box.textContent = ''
    for (const e of snapshot.customExits) {
      const row = document.createElement('div')
      row.className = 'custom-exit'
      const name = document.createElement('strong')
      name.textContent = e.label
      const addr = document.createElement('code')
      addr.className = 'sub addr'
      addr.textContent = `${e.host}:${e.port}${e.username ? ' · credentials' : ''}`
      const grow = document.createElement('span')
      grow.className = 'grow'
      const edit = document.createElement('button')
      edit.className = 'quiet'
      edit.textContent = 'Edit'
      edit.addEventListener('click', () => {
        $('custom-error').textContent = ''
        editingCustom = e.id
        input('cx-label').value = e.label
        input('cx-host').value = e.host
        input('cx-port').value = String(e.port)
        input('cx-user').value = e.username
        // The stored password never comes back from the background page, so
        // the box starts empty and an empty box means "leave it as it is".
        input('cx-pass').value = ''
        input('cx-pass').placeholder = e.username ? 'Password — unchanged' : 'Password'
        $('cx-save').textContent = 'Save'
        $('cx-cancel').hidden = false
        input('cx-label').focus()
      })
      const del = document.createElement('button')
      del.className = 'quiet danger'
      del.textContent = 'Delete'
      del.addEventListener('click', async () => {
        $('custom-error').textContent = ''
        del.disabled = true
        const out = await browser.runtime.sendMessage({ cmd: 'customDelete', id: e.id })
        if (!out.ok) showCustomError(out.error || 'Could not delete this exit.')
        await refresh()
      })
      row.append(name, addr, grow, edit, del)
      box.append(row)
    }
  }

  function resetCustomForm () {
    editingCustom = ''
    for (const id of ['cx-label', 'cx-host', 'cx-port', 'cx-user', 'cx-pass']) input(id).value = ''
    input('cx-pass').placeholder = 'Password'
    $('cx-save').textContent = 'Add'
    $('cx-cancel').hidden = true
  }

  /** @param {string} text */
  function showCustomError (text) {
    const box = $('custom-error')
    box.textContent = ''
    const err = document.createElement('div')
    err.className = 'banner danger'
    err.textContent = text
    box.append(err)
  }

  $('cx-cancel').addEventListener('click', resetCustomForm)

  $('custom-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    $('custom-error').textContent = ''
    const save = /** @type {HTMLButtonElement} */ ($('cx-save'))
    // a second submit while the first is in flight adds the exit twice
    if (save.disabled) return
    const label = save.textContent
    save.style.minWidth = `${save.offsetWidth}px`
    save.disabled = true
    save.textContent = 'Saving…'
    try {
      const out = await browser.runtime.sendMessage({
        cmd: 'customSave',
        exit: {
          id: editingCustom || undefined,
          label: input('cx-label').value.trim(),
          host: input('cx-host').value.trim(),
          // valueAsNumber, not parseInt: the field accepts 1e3, and parseInt
          // would quietly save that as port 1
          port: input('cx-port').valueAsNumber,
          username: input('cx-user').value,
          password: input('cx-pass').value
        }
      })
      if (!out.ok) {
        showCustomError(out.error || 'Could not save this exit.')
        save.textContent = label
        return
      }
      // puts the label back to Add, along with the rest of the form
      resetCustomForm()
    } finally {
      save.disabled = false
    }
    await refresh()
  })

  // This is where the extension shows its work, so it gets the same
  // treatment as the tables above it rather than a console dump.
  function renderLog () {
    if (!snapshot) return
    const el = $('block-log')
    el.textContent = ''
    const names = new Map(identities.map(i => [i.cookieStoreId, i.name]))
    names.set('firefox-default', 'No container')
    names.set('firefox-private', 'Private windows')

    if (!snapshot.blockLog.length) {
      el.textContent = 'Nothing blocked yet.'
      el.className = 'sub'
      return
    }
    el.className = ''

    const table = document.createElement('table')
    const head = table.createTHead().insertRow()
    for (const h of ['Time', 'Why', 'Container', 'Type', 'Request']) {
      const th = document.createElement('th')
      th.textContent = h
      head.append(th)
    }
    const body = table.createTBody()
    for (const b of snapshot.blockLog) {
      const tr = body.insertRow()
      tr.insertCell().textContent = new Date(b.t).toLocaleTimeString()
      tr.insertCell().textContent = fmt.reasonLabel(b.reason)
      tr.insertCell().textContent = names.get(b.container) || (b.container ? 'Deleted container' : '—')
      tr.insertCell().textContent = b.type || ''
      const urlCell = tr.insertCell()
      urlCell.className = 'urlcell'
      urlCell.textContent = b.url
      urlCell.title = b.url
    }
    el.append(table)
  }

  $('clear-log').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ cmd: 'clearBlockLog' })
    await refresh()
  })

  // Without this the page renders its empty skeleton and says nothing: the
  // tables, the version and the log all come from one call, so one rejection
  // takes the lot, and the per-section guards above never get to run.
  /** @param {unknown} e */
  function refreshFailed (e) {
    const box = $('offline-banner')
    box.textContent = ''
    const b = document.createElement('div')
    b.className = 'banner danger'
    b.setAttribute('role', 'alert')
    b.textContent = `Bulkhead could not read its own settings: ${e instanceof Error ? e.message : String(e)}`
    box.append(b)
  }

  refresh().then(renderHardening).catch(refreshFailed)
  setInterval(() => {
    if (!dialog.open) refresh().catch(refreshFailed)
  }, 5000)
})()
