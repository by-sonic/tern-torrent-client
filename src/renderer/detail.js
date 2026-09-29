import { $, el, run, toast, icon } from './dom.js'
import { renderFiles } from './files-list.js'
import { drawMosaic, drawPieceMap } from './canvas.js'
import { fmtBytes, fmtRate, fmtEta, plural } from './format.js'
import { STATE_LABEL, ERRORS } from './strings.js'

const LIVE = new Set(['downloading', 'connecting', 'checking'])

/**
 * The panel under the table: mosaic, progress, stats and the Files / Trackers / Details tabs
 * for the selected torrent.
 */
export function createDetail ({ onMove, onRemoved }) {
  const panel = $('detail')
  let id = null
  let torrent = null
  let tab = 'files'
  let info = null
  let filesBusy = false
  let selection = null

  const mosaic = $('mosaic')
  const strip = $('detail-strip')
  const paint = () => {
    if (!torrent) return
    const mode = LIVE.has(torrent.state) ? 'live' : 'quiet'
    drawMosaic(mosaic, torrent.pieces, mode)
    drawPieceMap(strip, torrent.pieces, mode, { tick: 3, gap: 2 })
  }
  new ResizeObserver(paint).observe(strip)

  // ---- tabs
  const setTab = (next) => {
    tab = next
    for (const button of document.querySelectorAll('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === tab))
    for (const node of panel.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== tab
    render()
  }
  for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => setTab(button.dataset.tab))

  // ---- actions
  $('detail-toggle').addEventListener('click', () => {
    if (torrent) run(torrent.paused ? window.tern.resume(id) : window.tern.pause(id))
  })
  $('detail-reveal').addEventListener('click', () => run(window.tern.reveal(id)))
  $('detail-up').addEventListener('click', () => onMove(id, 'up'))
  $('detail-down').addEventListener('click', () => onMove(id, 'down'))
  $('detail-remove').addEventListener('click', () => removeSelected(false))
  $('detail-trash').addEventListener('click', () => { $('detail-confirm').hidden = false })
  $('detail-confirm-no').addEventListener('click', () => { $('detail-confirm').hidden = true })
  $('detail-confirm-yes').addEventListener('click', () => removeSelected(true))

  async function removeSelected (trash) {
    const target = id
    $('detail-confirm').hidden = true
    onRemoved(target)
    await run(window.tern.remove(target, trash))
  }

  // ---- rendering
  function chip (text, tone) {
    const node = el('span', 'chip', text)
    if (tone) node.dataset.tone = tone
    return node
  }

  function renderHeader () {
    const t = torrent
    $('detail-name').textContent = t.name
    $('detail-name').title = t.name
    const tone = t.state === 'error' ? 'error' : LIVE.has(t.state) ? 'live' : ''
    const label = t.state === 'error' ? ERRORS[t.error] || t.error : STATE_LABEL[t.state]
    const chips = [chip(label, tone)]
    if (t.fileCount) chips.push(chip(`${t.fileCount} ${plural(t.fileCount, ['файл', 'файла', 'файлов'])}`))
    if (t.peers) chips.push(chip(`${t.peers} ${plural(t.peers, ['пир', 'пира', 'пиров'])}`))
    chips.push(chip(fmtBytes(t.size)))
    $('detail-chips').replaceChildren(...chips)

    $('detail-pct').textContent = `${Math.floor(t.progress * 100)}%`
    const stat = (text, value) => { const n = el('span'); n.append(text, el('b', '', value)); return n }
    const stats = [stat('↓ ', fmtRate(t.down)), stat('↑ ', fmtRate(t.up))]
    if (t.eta !== null && t.state === 'downloading') stats.push(stat('осталось ', fmtEta(t.eta)))
    stats.push(stat('скачано ', `${fmtBytes(t.size * t.progress)} из ${fmtBytes(t.size)}`))
    if (t.uploaded) stats.push(stat('отдано ', fmtBytes(t.uploaded)))
    $('detail-stats').replaceChildren(...stats)

    $('detail-toggle').textContent = t.paused ? 'Продолжить' : 'Приостановить'
    paint()
  }

  async function renderFilesTab () {
    if (filesBusy || !id) return
    filesBusy = true
    const requested = id
    try {
      const files = await window.tern.files(requested)
      if (requested !== id) return
      selection = files.map((f) => f.selected)
      renderFiles($('detail-files'), files, {
        showProgress: true,
        onToggle: async (index, checked) => {
          const next = [...selection]
          next[index] = checked
          if (!next.some(Boolean)) { toast('', 'error', 'Нужен хотя бы один файл'); return }
          selection = next
          await run(window.tern.select(requested, next))
        }
      })
    } catch (err) {
      console.error(err)
    } finally {
      filesBusy = false
    }
  }

  function renderTrackers () {
    const list = $('detail-trackers')
    const trackers = info ? info.trackers : []
    if (!trackers.length) {
      const empty = el('li', 'tab-empty', 'В торренте нет трекеров. Пиры ищутся через DHT и по magnet-ссылке.')
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(...trackers.map((url) => {
      const li = el('li', 'tracker')
      const [proto, rest] = url.split('://')
      li.append(icon('globe'), el('span', 'proto', `${proto}://`), rest)
      return li
    }))
  }

  function renderFacts () {
    const t = torrent
    const rows = [
      ['Хеш', t.id],
      ['Папка', t.dir],
      ['Размер', t.size === t.total ? fmtBytes(t.total) : `${fmtBytes(t.size)} из ${fmtBytes(t.total)}`],
      ['Отдано за сеанс', fmtBytes(t.uploaded)]
    ]
    if (info) {
      rows.push(['Добавлен', new Date(info.addedAt).toLocaleString('ru-RU')])
      if (info.pieceCount) rows.push(['Куски', `${info.pieceCount} × ${fmtBytes(info.pieceLength)}`])
    }
    $('detail-facts').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]))
  }

  function render () {
    if (!torrent) return
    if (tab === 'files') renderFilesTab()
    else if (tab === 'trackers') renderTrackers()
    else renderFacts()
  }

  async function loadInfo (forId) {
    info = null
    try {
      const loaded = await window.tern.info(forId)
      if (forId === id) { info = loaded; if (tab !== 'files') render() }
    } catch (err) {
      console.error(err)
    }
  }

  return {
    get id () { return id },
    select (torrentId) {
      if (torrentId === id) return
      id = torrentId
      torrent = null
      selection = null
      $('detail-files').dataset.sig = ''
      $('detail-confirm').hidden = true
      panel.hidden = false
      if (torrentId) loadInfo(torrentId)
    },
    clear () {
      id = null
      torrent = null
      panel.hidden = true
    },
    update (state) {
      if (!id) return
      torrent = state.torrents.find((t) => t.id === id) || null
      if (!torrent) { this.clear(); return }
      renderHeader()
      render()
    }
  }
}
