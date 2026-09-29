import { $, el, icon, toast, run } from './dom.js'
import { drawPieceMap, drawSpark, refreshColors } from './canvas.js'
import { fmtBytes, fmtEta, plural, rateParts, fmtRate } from './format.js'
import { STATE_LABEL, ERRORS } from './strings.js'
import { initAddDialog, createPicker, initSettings, registerHandler } from './dialogs.js'
import { createDetail } from './detail.js'
import { initUpdates } from './update.js'
import { visibleProgress, visiblePieces } from './verification-progress.js'

const HINT_KEY = 'tern.handlerHint'
const SPARK_SAMPLES = 60
const SAMPLE_MS = 900
const FALLBACK_LOGO = '../../assets/icon.png'

const LIVE_STATES = new Set(['downloading', 'connecting', 'checking'])
const FILTERS = {
  all: () => true,
  downloading: (t) => ['downloading', 'connecting', 'checking', 'metadata', 'choosing'].includes(t.state),
  seeding: (t) => t.state === 'seeding',
  finished: (t) => t.state === 'seeding' || t.state === 'done',
  paused: (t) => ['paused', 'queued', 'error'].includes(t.state)
}
const STATE_ICON = {
  metadata: 'hourglass', choosing: 'file', checking: 'hourglass', connecting: 'globe', downloading: 'down',
  seeding: 'up', done: 'check', paused: 'pause', queued: 'queue', error: 'alert'
}
const STATE_RANK = ['downloading', 'connecting', 'checking', 'metadata', 'choosing', 'seeding', 'done', 'queued', 'paused', 'error']
const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }),
  status: (a, b) => STATE_RANK.indexOf(a.state) - STATE_RANK.indexOf(b.state),
  progress: (a, b) => visibleProgress(a) - visibleProgress(b),
  speed: (a, b) => (a.down + a.up) - (b.down + b.up),
  size: (a, b) => a.size - b.size
}

let state = { torrents: [], settings: {}, speed: { down: 0, up: 0 } }
let filter = 'all'
let query = ''
let sort = { key: null, dir: 'asc' }
let selectedId = null
let lastSample = 0
const rows = new Map()
const speeds = []

const picker = createPicker()
const detail = createDetail({
  onMove: (id, where) => run(window.tern.move(id, where)),
  onRemoved: (id) => { if (selectedId === id) selectedId = null }
})

const current = (id) => state.torrents.find((t) => t.id === id)
const isSelectable = (t) => t.state !== 'metadata' && t.state !== 'choosing'

// ------------------------------------------------------------------ rows

function actionFor (t) {
  if (t.state === 'metadata' || t.state === 'choosing') return { icon: 'close', label: 'Отменить', run: () => window.tern.remove(t.id, false) }
  if (t.state === 'done') return null
  if (t.paused || t.state === 'queued' || t.state === 'error') return { icon: 'play', label: 'Продолжить', run: () => window.tern.resume(t.id) }
  return { icon: 'pause', label: 'Приостановить', run: () => window.tern.pause(t.id) }
}

function buildRow (id) {
  const li = el('li', 'row')
  li.tabIndex = 0
  li.setAttribute('role', 'row')

  const act = el('button', 'act')
  act.type = 'button'
  const name = el('div', 'name')
  const sub = el('div', 'sub')
  const nameCell = el('div', 'name-cell')
  nameCell.append(name, sub)
  const status = el('div', 'status')
  const strip = el('canvas', 'strip')
  strip.setAttribute('aria-hidden', 'true')
  const pct = el('span', 'pct')
  const prog = el('div', 'prog')
  prog.append(strip, pct)
  const speed = el('div', 'num-cell')
  const size = el('div', 'num-cell')
  li.append(act, nameCell, status, prog, speed, size)

  const view = { li, act, name, sub, status, strip, pct, prog, speed, size, last: {}, observer: null, torrent: null }
  act.addEventListener('click', (event) => {
    event.stopPropagation()
    const action = view.torrent && actionFor(view.torrent)
    if (action) run(action.run())
  })
  li.addEventListener('click', () => choose(id))
  li.addEventListener('keydown', (event) => {
    if (event.target !== li) return
    if (event.key === 'Enter') { event.preventDefault(); choose(id) }
    if (event.key === ' ') { event.preventDefault(); act.click() }
  })
  view.observer = new ResizeObserver(() => paintStrip(view))
  view.observer.observe(strip)
  return view
}

function choose (id) {
  const t = current(id)
  if (!t) return
  if (t.state === 'choosing') { picker.reopen(state, id); return }
  if (!isSelectable(t)) return
  selectedId = id
  detail.select(id)
  detail.update(state)
  markSelection()
}

function markSelection () {
  for (const [id, view] of rows) {
    const selected = String(id === selectedId)
    if (view.li.getAttribute('aria-selected') !== selected) view.li.setAttribute('aria-selected', selected)
  }
}

function paintStrip (view) {
  const t = view.torrent
  if (!t) return
  drawPieceMap(view.strip, visiblePieces(t), LIVE_STATES.has(t.state) ? 'live' : 'quiet', { tick: 3, gap: 1.5 })
}

function setText (node, text, view, key) {
  if (view.last[key] === text) return
  view.last[key] = text
  node.textContent = text
}

function subText (t) {
  const peers = `${t.peers} ${plural(t.peers, ['пир', 'пира', 'пиров'])}`
  switch (t.state) {
    case 'downloading': return t.eta !== null ? `${peers} · осталось ${fmtEta(t.eta)}` : peers
    case 'connecting': return 'Ищу пиров…'
    case 'checking': return t.verification
      ? `${t.verification.phase === 'fallback' ? 'Повторно проверено' : 'Проверено'} ${fmtBytes(t.verification.bytes)} из ${fmtBytes(t.verification.totalBytes)}`
      : 'Проверяю файлы на диске…'
    case 'seeding': return `${peers} · отдано ${fmtBytes(t.uploaded)}`
    case 'queued': return 'Ждёт своей очереди'
    case 'paused': return `${fmtBytes(t.size * t.progress)} из ${fmtBytes(t.size)}`
    case 'error': return ERRORS[t.error] || t.error
    case 'metadata': return 'Получаю данные о торренте…'
    case 'choosing': return 'Ждёт выбора файлов. Нажми, чтобы выбрать'
    default: return fmtBytes(t.size)
  }
}

function updateRow (view, t) {
  view.torrent = t
  if (view.li.dataset.state !== t.state) view.li.dataset.state = t.state
  setText(view.name, t.name, view, 'name')
  if (view.name.title !== t.name) view.name.title = t.name
  setText(view.sub, subText(t), view, 'sub')

  if (view.last.state !== t.state) {
    view.last.state = t.state
    view.status.replaceChildren(icon(STATE_ICON[t.state]), el('span', '', STATE_LABEL[t.state]))
  }
  const action = actionFor(t)
  const actKey = action ? action.icon : 'none'
  if (view.last.act !== actKey) {
    view.last.act = actKey
    view.act.replaceChildren(icon(action ? action.icon : 'check'))
    view.act.disabled = !action
    if (action) { view.act.title = action.label; view.act.setAttribute('aria-label', action.label) }
  }

  const hasProgress = isSelectable(t)
  const visibility = hasProgress ? 'visible' : 'hidden'
  if (view.prog.style.visibility !== visibility) view.prog.style.visibility = visibility
  setText(view.pct, `${Math.floor(visibleProgress(t) * 100)}%`, view, 'pct')
  const rate = t.state === 'downloading' ? `↓ ${fmtRate(t.down)}` : t.state === 'seeding' && t.up > 0 ? `↑ ${fmtRate(t.up)}` : '—'
  setText(view.speed, rate, view, 'speed')
  if (view.last.dim !== (rate === '—')) {
    view.last.dim = rate === '—'
    view.speed.classList.toggle('dim', view.last.dim)
  }
  setText(view.size, fmtBytes(t.size), view, 'size')

  const key = `${visiblePieces(t)}|${t.state}|${document.documentElement.dataset.scheme || ''}`
  if (view.last.map !== key) {
    view.last.map = key
    view.needsPaint = true
  }
}

// ------------------------------------------------------------------ list

function visibleTorrents () {
  const needle = query.trim().toLowerCase()
  const list = state.torrents.filter((t) => FILTERS[filter](t) && (!needle || t.name.toLowerCase().includes(needle)))
  if (!sort.key) return list
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => sign * SORTERS[sort.key](a, b))
}

function renderList () {
  const list = $('list')
  const visible = visibleTorrents()
  const ids = new Set(state.torrents.map((t) => t.id))
  for (const [id, view] of rows) {
    if (!ids.has(id)) { view.observer.disconnect(); view.li.remove(); rows.delete(id) }
  }
  const shown = new Set(visible.map((t) => t.id))
  for (const [id, view] of rows) if (!shown.has(id)) view.li.remove()

  let previous = null
  for (const t of visible) {
    let view = rows.get(t.id)
    if (!view) { view = buildRow(t.id); rows.set(t.id, view) }
    updateRow(view, t)
    const expected = previous ? previous.nextSibling : list.firstChild
    if (view.li !== expected) list.insertBefore(view.li, expected)
    previous = view.li
  }
  // Finish row mutations before reading canvas geometry, avoiding a forced
  // layout for each individual row in a long torrent list.
  for (const t of visible) {
    const view = rows.get(t.id)
    if (view.needsPaint) { view.needsPaint = false; paintStrip(view) }
  }

  // keep a sensible selection
  const selectable = visible.filter(isSelectable)
  if (!selectedId || !selectable.some((t) => t.id === selectedId)) {
    selectedId = selectable.length ? selectable[0].id : null
    if (selectedId) detail.select(selectedId)
    else detail.clear()
  }
  markSelection()

  const none = state.torrents.length === 0
  const empty = !(none || visible.length === 0)
  if ($('empty').hidden !== empty) $('empty').hidden = empty
  text('empty-title', none ? 'Здесь пока пусто' : 'Ничего не найдено')
  text('empty-text', none
    ? 'Перетащи сюда .torrent-файл, вставь magnet-ссылку через Ctrl+V или нажми «Добавить торрент».'
    : 'Попробуй другой запрос или выбери другой список слева.')
  if ($('empty-logo').hidden !== !none) $('empty-logo').hidden = !none
}

function text (id, value) {
  const node = $(id)
  if (node.textContent !== value) node.textContent = value
}

function renderNav () {
  for (const [name, test] of Object.entries(FILTERS)) {
    const node = document.querySelector(`[data-count="${name}"]`)
    const count = String(state.torrents.filter(test).length)
    if (node && node.textContent !== count) node.textContent = count
  }
  for (const button of document.querySelectorAll('.nav-item[data-filter]')) {
    const current = String(button.dataset.filter === filter)
    if (button.getAttribute('aria-current') !== current) button.setAttribute('aria-current', current)
  }
}

function renderSpeed () {
  const down = rateParts(state.speed.down)
  text('speed-down', down.num)
  text('speed-down-unit', down.unit)
  text('speed-up', fmtRate(state.speed.up))

  // one sample per second, however often the engine pushes state
  const now = Date.now()
  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now
    speeds.push(state.speed.down)
    if (speeds.length > SPARK_SAMPLES) speeds.shift()
  }
  drawSpark($('spark'), speeds)

  const running = state.torrents.some((t) => LIVE_STATES.has(t.state) || t.state === 'seeding')
  const toggle = $('toggle-all')
  const mode = running ? 'pause' : 'resume'
  if (toggle.dataset.mode !== mode) {
    toggle.dataset.mode = mode
    $('toggle-all-icon').replaceChildren(icon(mode === 'pause' ? 'pause' : 'play').firstChild)
  }
  const label = running ? 'Приостановить все' : 'Запустить все'
  text('toggle-all-label', label)
  if (toggle.title !== label) toggle.title = label
}

function apply (next) {
  state = next
  renderList()
  renderNav()
  renderSpeed()
  picker.update(state)
  detail.update(state)
}

// ------------------------------------------------------------------ input

function initNavAndSort () {
  for (const button of document.querySelectorAll('.nav-item[data-filter]')) {
    button.addEventListener('click', () => { filter = button.dataset.filter; renderList(); renderNav() })
  }
  $('search').addEventListener('input', (event) => { query = event.target.value; renderList() })
  for (const th of document.querySelectorAll('.th[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort
      if (sort.key !== key) sort = { key, dir: 'asc' }
      else if (sort.dir === 'asc') sort = { key, dir: 'desc' }
      else sort = { key: null, dir: 'asc' }
      for (const other of document.querySelectorAll('.th[data-sort]')) {
        if (other.dataset.sort === sort.key) other.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending')
        else other.removeAttribute('aria-sort')
      }
      renderList()
    })
  }
}

async function addText (text) {
  try { await window.tern.addText(text) } catch { toast('notTorrent', 'error') }
}

function initKeyboard () {
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      $('search').focus()
      $('search').select()
      return
    }
    const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
    if (inField || document.querySelector('dialog[open]')) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const selectable = visibleTorrents().filter(isSelectable)
    if (!selectable.length) return
    const at = selectable.findIndex((t) => t.id === selectedId)
    const next = selectable[Math.min(selectable.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]
    event.preventDefault()
    choose(next.id)
    rows.get(next.id)?.li.scrollIntoView({ block: 'nearest' })
  })
}

function initPasteAndDrop () {
  document.addEventListener('paste', (event) => {
    const target = event.target
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return
    const text = event.clipboardData.getData('text')
    if (text.trim()) { event.preventDefault(); addText(text) }
  })

  const overlay = $('drop')
  let depth = 0
  const hasPayload = (event) => Array.from(event.dataTransfer?.types || []).some((t) => t === 'Files' || t === 'text/plain')
  window.addEventListener('dragenter', (event) => { if (hasPayload(event)) { depth += 1; overlay.hidden = false } })
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true })
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', async (event) => {
    const inField = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
    depth = 0
    overlay.hidden = true
    if (inField) return // text moved inside a field is editing, not adding
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files).filter((f) => /\.torrent$/i.test(f.name))
    if (files.length) {
      await run(window.tern.addPaths(files.map((f) => window.tern.pathForFile(f))), 'badTorrent')
      return
    }
    const text = event.dataTransfer.getData('text/plain')
    if (text.trim()) addText(text)
  })
}

function initHint () {
  let dismissed = false
  try { dismissed = localStorage.getItem(HINT_KEY) === '1' } catch { /* storage unavailable */ }
  const hint = $('handler-hint')
  hint.hidden = dismissed
  const dismiss = () => {
    hint.hidden = true
    try { localStorage.setItem(HINT_KEY, '1') } catch { /* fine */ }
  }
  $('hint-yes').addEventListener('click', async () => { dismiss(); await registerHandler() })
  $('hint-no').addEventListener('click', dismiss)
}

/** Use the bundled mark until assets/logo.png exists, so the brand slot is never broken. */
function initLogo () {
  for (const id of ['logo', 'empty-logo']) {
    const img = $(id)
    const fallback = () => { if (!img.src.endsWith('icon.png')) img.src = FALLBACK_LOGO }
    img.addEventListener('error', fallback, { once: true })
    // the error may already have fired before this script ran
    if (img.complete && img.naturalWidth === 0) fallback()
  }
}

// ------------------------------------------------------------------ boot

function initTheme () {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = () => {
    document.documentElement.dataset.scheme = query.matches ? 'dark' : 'light'
    refreshColors()
    for (const view of rows.values()) view.last.map = ''
    renderList()
    renderSpeed()
    detail.update(state)
  }
  query.addEventListener('change', sync)
  refreshColors()
  document.documentElement.dataset.scheme = query.matches ? 'dark' : 'light'
}

async function boot () {
  initLogo()
  initTheme()
  initNavAndSort()
  initAddDialog()
  initSettings(() => state.settings)
  initKeyboard()
  initPasteAndDrop()
  initHint()
  initUpdates().catch((err) => console.error('updates:', err))
  new ResizeObserver(() => drawSpark($('spark'), speeds)).observe($('spark'))

  $('toggle-all').addEventListener('click', () => {
    run($('toggle-all').dataset.mode === 'pause' ? window.tern.pauseAll() : window.tern.resumeAll())
  })
  window.tern.onState(apply)
  window.tern.onToast(({ kind, key }) => toast(key, kind))
  apply(await window.tern.getState())
}

boot().catch((err) => {
  console.error(err)
  document.body.textContent = `Tern не смог запуститься: ${err.message}`
})
