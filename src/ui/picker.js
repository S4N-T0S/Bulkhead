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

      b.addEventListener('click', () => opts.onPick(r.host))

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
      const b = document.createElement('button')
      b.className = 'picker-row'
      b.dataset.host = `custom:${e.id}`
      if (opts.currentHost === `custom:${e.id}`) b.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.textContent = e.label
      const sub = document.createElement('span')
      sub.className = 'sub'
      sub.textContent = `${e.host}:${e.port}`
      b.append(name, sub)
      b.addEventListener('click', () => opts.onPick(`custom:${e.id}`))
      return b
    }

    function renderList () {
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
        const first = list.querySelector('.picker-row:not(.picker-tunnel)')
        if (first instanceof HTMLElement && first.dataset.host) opts.onPick(first.dataset.host)
      }
    })

    // Arrow keys walk the list; without this, reaching a server near the end
    // of ~600 rows means hundreds of Tab presses.
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const rows = [...list.querySelectorAll('.picker-row')]
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
