import { $, el, run, toast, icon } from './dom.js'
import { renderFiles } from './files-list.js'
import { drawMosaic, drawPieceMap } from './canvas.js'
import { fmtBytes, fmtRate, fmtEta, plural } from './format.js'
import { STATE_LABEL, ERRORS } from './strings.js'

const LIVE = new Set(['downloading', 'connecting', 'checking'])
const FILE_REFRESH_MS = 3000
const LARGE_FILE_REFRESH_MS = 5000
const LARGE_PIECE_COUNT = 50_000

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
  let generation = 0
  let filesFlight = null
  let filesDirty = true
  let lastFilesAt = -Infinity
  let selectionBusy = 0
  let selectionRevision = 0
  let selectionWrites = Promise.resolve()
  let selection = null
  let last = {}
  let statValues = []
  let factValues = []

  const mosaic = $('mosaic')
  const strip = $('detail-strip')
  const paint = () => {
    if (!torrent) return
    const mode = LIVE.has(torrent.state) ? 'live' : 'quiet'
    drawMosaic(mosaic, torrent.pieces, mode)
    drawPieceMap(strip, torrent.pieces, mode, { tick: 3, gap: 2 })
  }
  const observer = new ResizeObserver(paint)
  observer.observe(strip)
  observer.observe(mosaic)

  const text = (nodeId, value) => {
    const node = $(nodeId)
    if (node.textContent !== value) node.textContent = value
  }

  // ---- tabs
  const setTab = (next) => {
    tab = next
    for (const button of document.querySelectorAll('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === tab))
    for (const node of panel.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== tab
    if (tab === 'files') filesDirty = true
    render()
  }
  for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => setTab(button.dataset.tab))

  // ---- actions
  $('detail-toggle').addEventListener('click', async () => {
    if (!torrent) return
    const selectedGeneration = generation
    await run(torrent.paused ? window.tern.resume(id) : window.tern.pause(id))
    if (selectedGeneration === generation) { filesDirty = true; render() }
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
    text('detail-name', t.name)
    if ($('detail-name').title !== t.name) $('detail-name').title = t.name
    const tone = t.state === 'error' ? 'error' : LIVE.has(t.state) ? 'live' : ''
    const label = t.state === 'error' ? ERRORS[t.error] || t.error : STATE_LABEL[t.state]
    const chipsKey = JSON.stringify([label, tone, t.fileCount, t.peers, fmtBytes(t.size)])
    if (last.chips !== chipsKey) {
      last.chips = chipsKey
      const chips = [chip(label, tone)]
      if (t.fileCount) chips.push(chip(`${t.fileCount} ${plural(t.fileCount, ['файл', 'файла', 'файлов'])}`))
      if (t.peers) chips.push(chip(`${t.peers} ${plural(t.peers, ['пир', 'пира', 'пиров'])}`))
      chips.push(chip(fmtBytes(t.size)))
      $('detail-chips').replaceChildren(...chips)
    }

    text('detail-pct', `${Math.floor(t.progress * 100)}%`)
    const stats = [['↓ ', fmtRate(t.down)], ['↑ ', fmtRate(t.up)]]
    if (t.eta !== null && t.state === 'downloading') stats.push(['осталось ', fmtEta(t.eta)])
    stats.push(['скачано ', `${fmtBytes(t.size * t.progress)} из ${fmtBytes(t.size)}`])
    if (t.uploaded) stats.push(['отдано ', fmtBytes(t.uploaded)])
    const statsKey = JSON.stringify(stats.map(([label]) => label))
    if (last.stats !== statsKey) {
      last.stats = statsKey
      statValues = stats.map(() => el('b'))
      $('detail-stats').replaceChildren(...stats.map(([label], index) => {
        const node = el('span')
        node.append(label, statValues[index])
        return node
      }))
    }
    stats.forEach(([, value], index) => {
      if (statValues[index].textContent !== value) statValues[index].textContent = value
    })

    text('detail-toggle', t.paused ? 'Продолжить' : 'Приостановить')
    paint()
  }

  async function renderFilesTab () {
    if (filesFlight || selectionBusy || !id || tab !== 'files') return
    const now = performance.now()
    const interval = info?.pieceCount > LARGE_PIECE_COUNT ? LARGE_FILE_REFRESH_MS : FILE_REFRESH_MS
    if (!filesDirty && now - lastFilesAt < interval) return
    filesDirty = false
    lastFilesAt = now
    const requested = id
    const request = { generation, revision: selectionRevision }
    filesFlight = request
    try {
      const files = await window.tern.files(requested)
      if (request.generation !== generation || tab !== 'files' || request.revision !== selectionRevision || selectionBusy) return
      selection = files.map((f) => f.selected)
      renderFiles($('detail-files'), files, {
        showProgress: true,
        onToggle: async (index, checked) => {
          if (request.generation !== generation || !selection) return
          const next = [...selection]
          next[index] = checked
          if (!next.some(Boolean)) { toast('', 'error', 'Нужен хотя бы один файл'); return selection[index] }
          selection = next
          selectionRevision += 1
          selectionBusy += 1
          // Preserve click order even if several selections are made before IPC
          // acknowledges the first one. A stale files response cannot undo them.
          const write = selectionWrites.then(() => window.tern.select(requested, next))
          selectionWrites = write.catch(() => {})
          try {
            await run(write)
          } finally {
            if (request.generation === generation) {
              selectionBusy -= 1
              filesDirty = true
              if (!selectionBusy) await renderFilesTab()
            }
          }
          if (request.generation === generation) return selection[index]
        }
      })
    } catch (err) {
      console.error(err)
    } finally {
      if (filesFlight === request) {
        filesFlight = null
        if (filesDirty) renderFilesTab()
      }
    }
  }

  function renderTrackers () {
    const list = $('detail-trackers')
    const trackers = info ? info.trackers : []
    const key = JSON.stringify(trackers)
    if (last.trackers === key) return
    last.trackers = key
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
    const key = JSON.stringify(rows.map(([label]) => label))
    if (last.facts !== key) {
      last.facts = key
      factValues = rows.map(() => el('dd'))
      $('detail-facts').replaceChildren(...rows.flatMap(([label], index) => [el('dt', '', label), factValues[index]]))
    }
    rows.forEach(([, value], index) => {
      if (factValues[index].textContent !== value) factValues[index].textContent = value
    })
  }

  function render () {
    if (!torrent) return
    if (tab === 'files') renderFilesTab()
    else if (tab === 'trackers') renderTrackers()
    else renderFacts()
  }

  async function loadInfo (forId) {
    info = null
    const selectedGeneration = generation
    try {
      const loaded = await window.tern.info(forId)
      if (selectedGeneration === generation) { info = loaded; if (tab !== 'files') render() }
    } catch (err) {
      console.error(err)
    }
  }

  return {
    get id () { return id },
    select (torrentId) {
      if (torrentId === id) return
      id = torrentId
      generation += 1
      torrent = null
      selection = null
      filesFlight = null
      filesDirty = true
      lastFilesAt = -Infinity
      selectionBusy = 0
      selectionRevision = 0
      selectionWrites = Promise.resolve()
      last = {}
      $('detail-files').dataset.sig = ''
      $('detail-files').replaceChildren()
      $('detail-confirm').hidden = true
      panel.hidden = false
      if (torrentId) loadInfo(torrentId)
    },
    clear () {
      id = null
      generation += 1
      torrent = null
      filesFlight = null
      panel.hidden = true
    },
    update (state) {
      if (!id) return
      const next = state.torrents.find((t) => t.id === id) || null
      if (!torrent || next?.state !== torrent.state || next?.paused !== torrent.paused) filesDirty = true
      torrent = next
      if (!torrent) { this.clear(); return }
      renderHeader()
      render()
    }
  }
}
