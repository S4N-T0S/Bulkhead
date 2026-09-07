'use strict'
// The server switcher, shared by the popup and the options page. Pure DOM,
// no framework; the list rebuilds on every keystroke, which for ~600 rows is
// cheaper than being clever.

/* global relaylib, fmt */

;(function () {
  /** @param {PickerOptions} opts */
  function createPicker (opts) {
    const el = document.createElement('div')
    el.className = 'picker'

    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = 'Search country, city or server'

    const chips = document.createElement('div')
    chips.className = 'picker-chips'

    const list = document.createElement('div')
    list.className = 'picker-list'

    /** @type {{ ownedOnly: boolean }} */
    const filters = { ownedOnly: false }
    const favorites = new Set(opts.favorites)
    const customs = Array.isArray(opts.customExits) ? opts.customExits : []
    const assigned = opts.assigned || {}

    // The open "share it?" block. Any re-render drops it rather than putting
    // it back: a rebuilt list starts at the top, so there is nothing to keep.
    /** @type {{ row: HTMLButtonElement, block: HTMLElement, origin: 'row' | 'search', openedAt: number } | null} */
    let pending = null

    const filterDefs = /** @type {const} */ ([
      ['Mullvad-owned', () => { filters.ownedOnly = !filters.ownedOnly }, () => filters.ownedOnly]
    ])

    function renderChips () {
      chips.textContent = ''
      for (const [label, toggle, isOn] of filterDefs) {
        const b = document.createElement('button')
        b.className = 'chip'
        b.textContent = label
        b.setAttribute('aria-pressed', String(isOn()))
        b.addEventListener('click', () => {
          toggle()
          renderChips()
          renderList()
        })
        chips.append(b)
      }
    }

    /** @param {string} cc @returns {HTMLElement} */
    function flag (cc) {
      const src = fmt.flagSrc(cc)
      if (src) {
        const img = document.createElement('img')
        img.className = 'flag'
        img.src = src
        img.alt = ''
        img.addEventListener('error', () => {
          img.replaceWith(letterFlag(cc))
        }, { once: true })
        return img
      }
      return letterFlag(cc)
    }

    /** @param {string} cc @returns {HTMLElement} */
    function letterFlag (cc) {
      const b = document.createElement('span')
      b.className = 'flagb'
      b.textContent = cc.slice(0, 2)
      return b
    }

    /** @param {string} host @returns {string[] | undefined} */
    function inUse (host) {
      const names = assigned[host]
      return Array.isArray(names) && names.length ? names : undefined
    }

    // The current host only shows up in `assigned` when it is already
    // shared; re-picking it never asks.
    /** @param {string} host @returns {string[] | undefined} */
    function confirmable (host) {
      return host === opts.currentHost ? undefined : inUse(host)
    }

    /** @param {string} host @returns {string} */
    function displayName (host) {
      const cx = customs.find(e => `custom:${e.id}` === host)
      return cx ? cx.label : host
    }

    /** @param {HTMLButtonElement} b @param {string} host */
    function markInUse (b, host) {
      const names = inUse(host)
      if (!names) return
      const who = document.createElement('span')
      who.className = 'inuse'
      who.textContent = `used by ${fmt.nameList(names)}`
      who.title = `Used by ${fmt.nameList(names)}`
      b.append(who)
      if (confirmable(host)) b.setAttribute('aria-expanded', 'false')
    }

    // A pointer click this soon after opening is the tail of a double-click:
    // on the row it would toggle the block away, and on "Share anyway" it
    // would assign. Keyboard activation arrives with detail 0 and is never
    // held back.
    /** @param {MouseEvent} e @returns {boolean} */
    function bounce (e) {
      return e.detail > 0 && pending !== null && performance.now() - pending.openedAt < 400
    }

    /** @param {HTMLButtonElement} b @param {string} host @param {MouseEvent} e */
    function pick (b, host, e) {
      const names = confirmable(host)
      if (!names) opts.onPick(host)
      else if (!pending || pending.row !== b) openConfirm(b, host, names, 'row')
      else if (!bounce(e)) closeConfirm()
    }

    /** @param {HTMLButtonElement} row @param {string} host @param {string[]} names @param {'row' | 'search'} origin */
    function openConfirm (row, host, names, origin) {
      closeConfirm()
      const wrap = row.closest('.picker-rowwrap')
      if (!wrap) return

      const block = document.createElement('div')
      block.className = 'picker-confirm'
      block.id = 'picker-confirm'
      block.setAttribute('role', 'group')
      block.setAttribute('aria-label', `Share ${displayName(host)}?`)
      const why = document.createElement('p')
      why.id = 'picker-confirm-why'
      why.textContent = `Already used by ${fmt.nameList(names)}. Share it and ${names.length > 1 ? 'all of them' : 'both'} come out at the same address, which links them together.`

      const keep = document.createElement('button')
      keep.textContent = 'Keep looking'
      keep.setAttribute('aria-describedby', why.id)
      keep.addEventListener('click', () => {
        closeConfirm()
        ;(origin === 'search' ? search : row).focus()
      })
      const share = document.createElement('button')
      share.className = 'quiet'
      share.textContent = 'Share anyway'
      share.setAttribute('aria-describedby', why.id)
      share.addEventListener('click', (e) => {
        if (!bounce(e)) opts.onPick(host)
      })
      const actions = document.createElement('div')
      actions.className = 'row'
      actions.append(keep, share)
      block.append(why, actions)

      wrap.after(block)
      wrap.classList.add('open')
      row.setAttribute('aria-expanded', 'true')
      row.setAttribute('aria-controls', block.id)
      pending = { row, block, origin, openedAt: performance.now() }
      block.scrollIntoView({ block: 'nearest' })
      keep.focus({ preventScroll: true })
    }

    function closeConfirm () {
      if (!pending) return
      const { row, block } = pending
      block.remove()
      row.closest('.picker-rowwrap')?.classList.remove('open')
      row.setAttribute('aria-expanded', 'false')
      row.removeAttribute('aria-controls')
      pending = null
    }

    // A row is a button plus a sibling star, never a button inside a button:
    // nesting interactive content is undefined for assistive tech, and the
    // outer control swallows the inner one's name.
    /** @param {Relay} r @returns {HTMLElement} */
    function row (r) {
      const wrap = document.createElement('div')
      wrap.className = 'picker-rowwrap'

      const b = document.createElement('button')
      b.className = 'picker-row'
      b.dataset.host = r.host
      if (r.host === opts.currentHost) b.setAttribute('aria-current', 'true')

      const name = document.createElement('span')
      name.textContent = r.host
      b.append(name)

      for (const t of fmt.relayTags(r)) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = t
        if (t === 'owned') tag.title = 'Runs on Mullvad-owned hardware'
        b.append(tag)
      }

      if (r.messages.length) {
        const note = document.createElement('span')
        note.className = 'note'
        note.textContent = r.messages.join(' · ')
        // ellipsised at popup width, so the full notice needs somewhere to live
        note.title = r.messages.join(' · ')
        b.append(note)
      }

      markInUse(b, r.host)

      b.addEventListener('click', e => pick(b, r.host, e))

      const star = document.createElement('button')
      star.className = 'star'
      const on = favorites.has(r.host)
      star.setAttribute('aria-pressed', String(on))
      star.setAttribute('aria-label', `Favourite ${r.host}`)
      star.textContent = on ? '★' : '☆'
      star.addEventListener('click', () => {
        if (on) favorites.delete(r.host)
        else favorites.add(r.host)
        opts.onFavorite(r.host, !on)
        renderList()
      })

      wrap.append(b, star)
      return wrap
    }

    // Same shape as a relay row, minus the star: favourites order the relay
    // list, while custom exits already sit in their own pinned group.
    /** @param {Omit<CustomExit, 'password'>} e @returns {HTMLElement} */
    function customRow (e) {
      const wrap = document.createElement('div')
      wrap.className = 'picker-rowwrap'
      const host = `custom:${e.id}`
      const b = document.createElement('button')
      b.className = 'picker-row'
      b.dataset.host = host
      if (opts.currentHost === host) b.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.textContent = e.label
      const sub = document.createElement('span')
      sub.className = 'sub'
      sub.textContent = `${e.host}:${e.port}`
      b.append(name, sub)
      markInUse(b, host)
      b.addEventListener('click', e => pick(b, host, e))
      wrap.append(b)
      return wrap
    }

    function renderList () {
      closeConfirm()
      const q = search.value
      const matches = relaylib.searchRelays(opts.relays, q, filters)
      const needle = q.trim().toLowerCase()
      const customMatches = filters.ownedOnly
        ? []
        : customs.filter(e => !needle
          || String(e.label || '').toLowerCase().includes(needle)
          || String(e.host || '').toLowerCase().includes(needle))
      list.textContent = ''

      if (!matches.length && !customMatches.length) {
        const empty = document.createElement('div')
        empty.className = 'picker-empty'
        empty.textContent = 'No servers match.'
        list.append(empty)
        return
      }

      const frag = document.createDocumentFragment()

      // Favourites and recent picks first, but only while browsing -- a
      // search should return exactly what was asked for.
      if (!q.trim()) {
        const md = document.createElement('button')
        md.className = 'picker-row picker-tunnel'
        md.dataset.host = 'mullvad-direct'
        if (opts.currentHost === 'mullvad-direct') md.setAttribute('aria-current', 'true')
        const name = document.createElement('span')
        name.textContent = 'Mullvad tunnel exit'
        name.className = 'label'
        const sub = document.createElement('span')
        sub.className = 'sub'
        sub.textContent = 'follows the app’s server'
        sub.title = 'Routes through 10.64.0.1, the SOCKS endpoint of whatever server the Mullvad app is connected to. Unreachable — and therefore blocked — whenever the app is off.'
        md.append(name, sub)
        md.addEventListener('click', () => opts.onPick('mullvad-direct'))
        frag.append(md)
        const quick = [...new Set([...favorites, ...opts.recents])]
          .map(h => matches.find(r => r.host === h))
          .filter(Boolean)
          .slice(0, 6)
        if (quick.length) {
          const head = document.createElement('div')
          head.className = 'picker-city'
          head.textContent = 'Quick picks'
          frag.append(head)
          for (const r of quick) frag.append(row(/** @type {Relay} */ (r)))
        }
      }

      if (customMatches.length) {
        const head = document.createElement('div')
        head.className = 'picker-city'
        head.textContent = 'Custom exits'
        frag.append(head)
        for (const e of customMatches) frag.append(customRow(e))
      }

      for (const g of relaylib.groupByLocation(matches)) {
        const country = document.createElement('div')
        country.className = 'picker-country'
        country.append(flag(g.cc))
        const label = document.createElement('span')
        label.textContent = g.country
        const count = document.createElement('span')
        count.className = 'sub'
        count.textContent = String(g.cities.reduce((n, c) => n + c.relays.length, 0))
        country.append(label, count)
        frag.append(country)

        for (const c of g.cities) {
          const city = document.createElement('div')
          city.className = 'picker-city'
          city.textContent = c.city
          frag.append(city)
          for (const r of c.relays) frag.append(row(r))
        }
      }
      list.append(frag)
    }

    search.addEventListener('input', renderList)
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const first = list.querySelector('.picker-row')
        if (first instanceof HTMLElement) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      // Only commit to a search result. With an empty box the first row is
      // the pinned tunnel entry, and Enter would silently reassign to it.
      if (e.key === 'Enter' && search.value.trim()) {
        // Consumed here, or Gecko hands this Enter's keypress to whichever
        // button gets focus below.
        e.preventDefault()
        const first = list.querySelector('.picker-row:not(.picker-tunnel)')
        if (!(first instanceof HTMLButtonElement) || !first.dataset.host) return
        const host = first.dataset.host
        const names = confirmable(host)
        if (names) openConfirm(first, host, names, 'search')
        else opts.onPick(host)
      }
    })

    // Arrow keys walk the list; without this, reaching a server near the end
    // of ~600 rows means hundreds of Tab presses.
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const rows = [...list.querySelectorAll('.picker-row')]
      if (pending && pending.block.contains(document.activeElement)) {
        e.preventDefault()
        const { row, origin } = pending
        const next = rows[rows.indexOf(row) + 1]
        closeConfirm()
        if (e.key === 'ArrowUp') (origin === 'search' ? search : row).focus()
        else (next instanceof HTMLElement ? next : row).focus()
        return
      }
      const i = rows.indexOf(/** @type {Element} */ (document.activeElement))
      if (i === -1) return
      e.preventDefault()
      const next = rows[e.key === 'ArrowDown' ? i + 1 : i - 1]
      if (next instanceof HTMLElement) next.focus()
      else if (e.key === 'ArrowUp') search.focus()
    })

    renderChips()
    renderList()
    el.append(search, chips, list)
    return { el, focus: () => search.focus() }
  }

  globalThis.createPicker = createPicker
})()
