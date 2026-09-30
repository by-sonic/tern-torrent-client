'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { planQueue, moveId } = require('./queue')
const { pieceMap, bitfieldReader } = require('./pieces')
const { MAX_TORRENT_FILE_BYTES, MAX_TORRENT_FILES, isLocalAbsolutePath } = require('./input')
const { loadSparseStore } = require('./sparse-store')
const { torrentOptions, dropRarityMap, installTorrentOptimizations } = require('./torrent-tuning')
const { measureTorrentProgress } = require('./progress')
const { installTorrentVerification, createVerificationBudget } = require('./verification')
const crypto = require('node:crypto')
const { pathKey, contained, cleanSourceTorrent, inspectPath, resolveLocalPath, readTorrentFile, readImportedTorrent, validateTrashTarget, pruneEmptyDirectories } = require('./torrent-removal')

const TICK_MS = 1000 // while a window is showing the list
const BACKGROUND_TICK_MS = 5000 // tray only: nothing to draw, so wake up rarely and do almost no work
const BITFIELD_SAVE_MS = 30_000
const STOP_TIMEOUT_MS = 3000
const MAP_BUCKETS = 360
const BIG_TORRENT_PIECES = 50_000
const KB = 1024
const ID_RE = /^[a-f0-9]{40}$/

const DEFAULT_SETTINGS = Object.freeze({
  downloadDir: '',
  downLimitKB: 0,
  upLimitKB: 0,
  verifyLimitMB: 256,
  maxActive: 3,
  seedAfterDone: true,
  closeToTray: true,
  launchAtLogin: false,
  autoUpdate: true
})

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.floor(Number(value)) || 0))

/** Merge untrusted settings (UI or state.json) into a valid settings object. */
function mergeSettings (base, patch) {
  const next = { ...base }
  if (isLocalAbsolutePath(patch.downloadDir)) next.downloadDir = path.resolve(patch.downloadDir)
  for (const key of ['downLimitKB', 'upLimitKB']) {
    if (patch[key] !== undefined) next[key] = clampInt(patch[key], 0, 10_000_000)
  }
  if (patch.maxActive !== undefined) next.maxActive = clampInt(patch.maxActive, 1, 20)
  if (patch.verifyLimitMB !== undefined) next.verifyLimitMB = clampInt(patch.verifyLimitMB, 0, 4096)
  for (const key of ['seedAfterDone', 'closeToTray', 'launchAtLogin', 'autoUpdate']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key]
  }
  return next
}

const TRACKER_RE = /^(https?|udp|wss?):\/\/[^\s]{1,300}$/i
const MAX_TRACKERS = 50

/** Tracker URLs only, capped: they come from untrusted torrents and are shown in the UI. */
function cleanTrackers (list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((u) => typeof u === 'string' && TRACKER_RE.test(u)))].slice(0, MAX_TRACKERS)
}

/** A record read from state.json, or null when it is not usable. */
function cleanRecord (r, fallbackDir) {
  if (!r || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null
  const files = Array.isArray(r.files) && r.files.length <= MAX_TORRENT_FILES &&
    r.files.every((f) => f && typeof f.path === 'string' && Number.isFinite(f.length))
    ? r.files.map((f) => ({ path: f.path, length: f.length }))
    : null
  const selected = files && Array.isArray(r.selected) && r.selected.length === files.length ? r.selected.map(Boolean) : null
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name ? r.name : r.id,
    path: isLocalAbsolutePath(r.path) ? path.resolve(r.path) : fallbackDir,
    magnet: typeof r.magnet === 'string' ? r.magnet : null,
    sourceTorrent: cleanSourceTorrent(r.sourceTorrent),
    length: Number.isFinite(r.length) ? r.length : 0,
    pieceLength: Number.isFinite(r.pieceLength) ? r.pieceLength : 0,
    pieceCount: Number.isFinite(r.pieceCount) ? r.pieceCount : 0,
    files,
    selected,
    bitfield: typeof r.bitfield === 'string' ? r.bitfield : null,
    fp: Array.isArray(r.fp) && files && r.fp.length === files.length ? r.fp.map(Number) : null,
    trackers: cleanTrackers(r.trackers),
    progressBytes: Number.isFinite(r.progressBytes) ? r.progressBytes : 0,
    paused: Boolean(r.paused),
    done: Boolean(r.done),
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    order: Number.isFinite(r.order) ? r.order : 0
  }
}

/**
 * Owns every torrent. An "entry" is our record of a torrent; `entry.live` is the
 * WebTorrent object while it is running. Stopped torrents keep their bitfield, so
 * resuming does not re-hash the files.
 *
 * Emits: 'state' (snapshot), 'completed' ({name})
 */
class Engine extends EventEmitter {
  /**
   * @param {{ stateStore: import('./store').JsonStore, torrentsDir: string,
   *           defaultDir: string, trash: (p: string) => Promise<void>, clientOptions?: object,
   *           tickMs?: number, backgroundTickMs?: number }} deps
   */
  constructor ({ stateStore, torrentsDir, defaultDir, trash, clientOptions, tickMs = TICK_MS, backgroundTickMs = BACKGROUND_TICK_MS }) {
    super()
    this.stateStore = stateStore
    this.torrentsDir = torrentsDir
    this.trash = trash
    // TCP only (uTP needs a native module that is fragile to package). No web seeds:
    // they would let an untrusted magnet make this app request arbitrary URLs.
    this.clientOptions = clientOptions || { natUpnp: true, natPmp: true, lsd: true, utp: false, webSeeds: false }
    this.entries = new Map()
    this.settings = { ...DEFAULT_SETTINGS, downloadDir: defaultDir }
    this.verificationBudget = createVerificationBudget(this.settings.verifyLimitMB * 1024 ** 2)
    this.client = null
    this.parseTorrent = null
    this.tickTimer = null
    this.tickMs = tickMs
    this.backgroundTickMs = backgroundTickMs
    /** True while a visible window wants snapshots. Otherwise we build none and tick slowly. */
    this.observed = false
    this.lastBitfieldSave = 0
    this.entriesRevision = 0
  }

  async init () {
    const [{ default: WebTorrent }, { default: parseTorrent }] = await Promise.all([
      import('webtorrent'), import('parse-torrent')
    ])
    this.parseTorrent = parseTorrent
    this.store = await loadSparseStore()
    this.client = new WebTorrent(this.clientOptions)
    this.client.on('error', (err) => console.error('[client]', err.message))

    const saved = this.stateStore.load()
    if (saved.settings && typeof saved.settings === 'object') this.settings = mergeSettings(this.settings, saved.settings)
    for (const raw of Array.isArray(saved.torrents) ? saved.torrents : []) {
      const record = cleanRecord(raw, this.settings.downloadDir)
      if (record) this.entries.set(record.id, this._fromRecord(record))
    }
    this._applyLimits()
    this._reconcile()
    this._scheduleTick(0)
  }

  /**
   * Tell the engine whether anyone is looking. The list snapshot (per-torrent piece maps and byte
   * counts) is the most expensive thing that runs while idle, so it is only built for a visible window.
   */
  setObserved (observed) {
    if (this.observed === Boolean(observed)) return
    this.observed = Boolean(observed)
    this._scheduleTick(0)
  }

  _scheduleTick (delay = this.observed ? this.tickMs : this.backgroundTickMs) {
    clearTimeout(this.tickTimer)
    if (this.isShutDown) return
    this.tickTimer = setTimeout(() => { this._tick(); this._scheduleTick() }, delay)
  }

  // ---------------------------------------------------------------- adding

  /** @param {{kind: 'magnet', uri: string} | {kind: 'file', path: string}} input */
  async add (input) {
    let source
    let sourceTorrent = null
    if (input.kind === 'file') {
      if (!isLocalAbsolutePath(input.path)) throw new Error('bad-file')
      const read = await readImportedTorrent(input.path)
      if (read.status !== 'ready') throw new Error('bad-file')
      source = read.buffer
      if (read.trackSource) sourceTorrent = { path: read.path, sha256: read.sha256, identity: read.identity }
    } else {
      source = input.uri
    }
    const parsed = await this.parseTorrent(source)
    const id = parsed.infoHash
    if (this.entries.has(id)) {
      const existing = this.entries.get(id)
      // Reopening an old torrent can safely remember its original file without restarting it.
      if (sourceTorrent && !existing.sourceTorrent && !existing.removing && !existing.preparingRemoval) {
        existing.sourceTorrent = sourceTorrent
        this._changed()
      }
      return { id, duplicate: true }
    }
    if (parsed.files && parsed.files.length > MAX_TORRENT_FILES) throw new Error('too-many-files')

    const entry = {
      ...this._fromRecord({
        id,
        name: parsed.name || id,
        path: this.settings.downloadDir,
        magnet: input.kind === 'magnet' ? input.uri : null,
        sourceTorrent,
        length: parsed.length || 0,
        pieceLength: parsed.pieceLength || 0,
        pieceCount: parsed.pieces ? parsed.pieces.length : 0,
        trackers: cleanTrackers(parsed.announce),
        createdAt: Date.now()
      }),
      stage: 'metadata',
      torrentBuffer: input.kind === 'file' ? source : null
    }
    this.entries.set(id, entry)
    this.entriesRevision++
    this._start(entry)
    this._publish()
    return { id, duplicate: false }
  }

  /** Confirm a torrent that is waiting in the file picker. */
  async confirm (id, { selected, dir }) {
    const entry = this.entries.get(id)
    if (!entry || entry.stage !== 'choosing' || entry.removing || entry.preparingRemoval) throw new Error('not-choosing')
    if (!Array.isArray(selected) || selected.length !== entry.files.length) throw new Error('bad-selection')
    if (!selected.some(Boolean)) throw new Error('nothing-selected')

    if (dir && path.resolve(dir) !== path.resolve(entry.path)) {
      this._assertDirectory(dir)
      const previous = entry.path
      await this._stop(entry, { keepBitfield: false }) // restart at the new folder; nothing is downloaded yet
      if (entry.removing || entry.preparingRemoval || this.entries.get(id) !== entry) return
      await this._pruneEmptyDirs(entry, previous)
      entry.path = path.resolve(dir)
    }
    entry.selected = selected.map(Boolean)
    entry.order = this._nextOrder()
    entry.stage = 'ready'
    entry.done = false
    entry.cache = null
    this._persistTorrentFile(entry)
    if (entry.live && entry.live.ready) {
      this._applySelection(entry)
      this._checkSelectionDone(entry)
    }
    this._reconcile()
    this._changed()
  }

  // -------------------------------------------------------------- controls

  pause (id) { this._patch(id, { paused: true }) }
  resume (id) { this._patch(id, { paused: false, error: null }) }

  pauseAll () { for (const e of this._ready()) e.paused = true; this._reconcile(); this._changed() }
  resumeAll () { for (const e of this._ready()) { e.paused = false; e.error = null }; this._reconcile(); this._changed() }

  move (id, where) {
    const ids = this._ready().sort((a, b) => a.order - b.order).map((e) => e.id)
    moveId(ids, id, where).forEach((eid, i) => { this.entries.get(eid).order = i })
    this._reconcile()
    this._changed()
  }

  /** Internal utility RPC: paths originate from matching torrent metadata, never renderer input. */
  async removalPlan (id) {
    const entry = this.entries.get(id)
    if (!entry || entry.removing || entry.preparingRemoval) return null
    entry.preparingRemoval = true
    entry.paused = true
    this._publish()
    try {
      await this._stop(entry, { keepBitfield: true })
      const plan = await this._removalPlan(entry)
      if (this.entries.get(id) !== entry) return null
      plan.token = crypto.randomBytes(16).toString('hex')
      entry.removalPlan = plan
      // A lost/rejected bridge request must not reserve this paused torrent forever.
      entry.removalLease = setTimeout(() => this.cancelRemovalPlan(id, plan.token), 60_000)
      entry.removalLease.unref?.()
      this._changed()
      return plan
    } catch (err) {
      entry.preparingRemoval = false
      entry.removalPlan = null
      this._changed()
      throw err
    }
  }

  cancelRemovalPlan (id, token) {
    const entry = this.entries.get(id)
    if (!entry || entry.removing || entry.removalPlan?.token !== token) return
    clearTimeout(entry.removalLease)
    entry.preparingRemoval = false
    entry.removalPlan = null
    this._changed()
  }

  async remove (id, { trash = false, planToken } = {}) {
    const entry = this.entries.get(id)
    if (!entry || entry.removing || (entry.preparingRemoval && (!planToken || entry.removalPlan?.token !== planToken))) return { removed: false, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 0 }
    const wasReady = entry.stage === 'ready'
    entry.removing = true
    clearTimeout(entry.removalLease)
    entry.preparingRemoval = false
    this._publish()
    await this._stop(entry, { keepBitfield: false })
    const result = { removed: true, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 0 }
    if (trash) {
      const plan = planToken ? entry.removalPlan : await this._removalPlan(entry)
      if (!plan || (planToken && plan.token !== planToken)) {
        result.skipped = Math.max(1, (entry.files || []).length)
        result.sourceUnavailable = !entry.sourceTorrent
      } else {
        Object.assign(result, { failed: plan.failed, skipped: plan.skipped, sourceUnavailable: plan.sourceUnavailable })
        await this._trashContent(entry, plan, result)
      }
    }
    // A write already started before removal must finish before unlinking the fixed cache path.
    if (entry.persistingTorrent) await entry.persistingTorrent
    const cached = await inspectPath(this._torrentFile(id))
    if (cached.status === 'ready') {
      try { await fs.promises.rm(this._torrentFile(id), { force: true }) } catch { result.failed++ }
    } else if (cached.status !== 'missing') result.skipped++
    this.entries.delete(id)
    if (!trash && !wasReady) await this._pruneEmptyDirs(entry, entry.path)
    this._reconcile()
    this._changed()
    return result
  }

  setSelection (id, selected) {
    const entry = this.entries.get(id)
    if (!entry || entry.removing || entry.preparingRemoval || !entry.files || !Array.isArray(selected) || selected.length !== entry.files.length) throw new Error('bad-selection')
    if (!selected.some(Boolean)) throw new Error('nothing-selected')
    entry.selected = selected.map(Boolean)
    entry.cache = null
    if (entry.stage === 'ready') {
      if (entry.live && entry.live.ready) {
        this._applySelection(entry)
        entry.done = this._allWantedDone(entry, entry.live)
        this._checkSelectionDone(entry)
      } else {
        entry.done = Boolean(entry.done && entry.fp && entry.files.every((f, i) => !entry.selected[i] || entry.fp[i] >= 1))
      }
      this._reconcile()
      this._changed()
    } else if (entry.live && entry.live.ready) {
      this._applySelection(entry)
    }
    this._publish()
  }

  setSettings (patch) {
    if (patch.downloadDir !== undefined) this._assertDirectory(patch.downloadDir)
    this.settings = mergeSettings(this.settings, patch)
    this._applyLimits()
    this._reconcile()
    this._changed()
  }

  files (id) {
    const entry = this.entries.get(id)
    if (!entry || !entry.files) return []
    const ready = Boolean(entry.live && entry.live.ready)
    const progress = this._progressCache(entry, ready)
    return entry.files.map((file, i) => ({
      index: i,
      path: file.path,
      length: file.length,
      selected: entry.selected ? entry.selected[i] : true,
      progress: ready ? progress.files[i] : (entry.fp ? entry.fp[i] || 0 : 0)
    }))
  }

  /** Details that do not change every second: shown once when a torrent is selected. */
  info (id) {
    const entry = this.entries.get(id)
    if (!entry) return null
    return { id, trackers: entry.trackers, addedAt: entry.createdAt, dir: entry.path, pieceCount: entry.pieceCount, pieceLength: entry.pieceLength }
  }

  contentPath (id) {
    const entry = this.entries.get(id)
    return entry ? this._contentPath(entry) : null
  }

  // -------------------------------------------------------------- lifecycle

  checkpoint () {
    for (const entry of this.entries.values()) this._captureProgress(entry)
    this.stateStore.saveSoon(() => this._serialize())
    this.stateStore.flush()
  }

  async shutdown () {
    if (this.isShutDown) return
    this.isShutDown = true
    clearTimeout(this.tickTimer)
    for (const entry of this.entries.values()) clearTimeout(entry.removalLease)
    this.checkpoint()
    if (this.client) await new Promise((resolve) => this.client.destroy(() => resolve()))
  }

  // ---------------------------------------------------------------- internals

  _ready () { return [...this.entries.values()].filter((e) => e.stage === 'ready' && !e.removing && !e.preparingRemoval) }
  _nextOrder () { return this._ready().reduce((max, e) => Math.max(max, e.order), -1) + 1 }
  _torrentFile (id) { return path.join(this.torrentsDir, `${id}.torrent`) }

  _assertDirectory (dir) {
    if (!isLocalAbsolutePath(dir)) throw new Error('bad-dir')
    let stat
    try { stat = fs.statSync(dir) } catch { throw new Error('bad-dir') }
    if (!stat.isDirectory()) throw new Error('bad-dir')
  }

  _fromRecord (r) {
    return {
      id: r.id,
      name: r.name,
      path: r.path,
      magnet: r.magnet || null,
      sourceTorrent: cleanSourceTorrent(r.sourceTorrent),
      length: r.length || 0,
      pieceLength: r.pieceLength || 0,
      pieceCount: r.pieceCount || 0,
      files: r.files || null,
      selected: r.selected || null,
      bitfield: r.bitfield || null,
      fp: r.fp || null,
      trackers: r.trackers || [],
      progressBytes: r.progressBytes || 0,
      paused: Boolean(r.paused),
      done: Boolean(r.done),
      createdAt: r.createdAt || Date.now(),
      order: Number.isFinite(r.order) ? r.order : 0,
      stage: 'ready',
      live: null,
      applied: null,
      stopping: null,
      removing: false,
      cache: null,
      error: null,
      torrentBuffer: null
    }
  }

  _serialize () {
    const torrents = [...this.entries.values()].filter((e) => e.stage === 'ready' && !e.removing).map((e) => ({
      id: e.id, name: e.name, path: e.path, magnet: e.magnet, sourceTorrent: e.sourceTorrent, length: e.length,
      pieceLength: e.pieceLength, pieceCount: e.pieceCount, files: e.files, selected: e.selected,
      bitfield: e.bitfield, fp: e.fp, trackers: e.trackers, progressBytes: e.progressBytes, paused: e.paused,
      done: e.done, createdAt: e.createdAt, order: e.order
    }))
    return { version: 1, settings: this.settings, torrents }
  }

  _changed () {
    this.entriesRevision++
    this.stateStore.saveSoon(() => this._serialize())
    this._publish()
  }

  _patch (id, fields) {
    const entry = this.entries.get(id)
    if (!entry || entry.stage !== 'ready' || entry.removing || entry.preparingRemoval) return
    Object.assign(entry, fields)
    this._reconcile()
    this._changed()
  }

  _applyLimits () {
    if (!this.client) return
    const { downLimitKB, upLimitKB } = this.settings
    this.client.throttleDownload(downLimitKB > 0 ? downLimitKB * KB : -1)
    this.client.throttleUpload(upLimitKB > 0 ? upLimitKB * KB : -1)
    this.verificationBudget.setRate(this.settings.verifyLimitMB * 1024 ** 2)
  }

  /** Start or stop torrents so the running set matches the queue plan. */
  _reconcile () {
    const ready = this._ready()
    // A torrent in error must not hold a queue slot.
    const run = planQueue(ready.filter((e) => !e.error), {
      maxActive: this.settings.maxActive, seed: this.settings.seedAfterDone
    })
    for (const entry of ready) {
      if (entry.stopping) continue // reconciled again when the stop settles
      const shouldRun = run.has(entry.id)
      if (shouldRun && !entry.live) this._start(entry)
      else if (!shouldRun && entry.live) this._stop(entry, { keepBitfield: true })
    }
  }

  _start (entry) {
    if (entry.stopping || entry.live) return
    let source = entry.torrentBuffer
    if (!source) {
      try { source = fs.readFileSync(this._torrentFile(entry.id)) } catch { source = entry.magnet }
    }
    if (!source) { entry.error = 'no-source'; return }

    const opts = torrentOptions({ path: entry.path, store: this.store })
    const resumeBitfield = this._resumeBitfield(entry)
    if (resumeBitfield) opts.bitfield = resumeBitfield

    let torrent
    try {
      torrent = this.client.add(source, opts)
    } catch (err) {
      entry.error = err.message
      return
    }
    entry.live = torrent
    entry.applied = null
    entry.cache = null
    torrent.on('metadata', () => { if (entry.live === torrent) this._onMetadata(entry, torrent) })
    torrent.on('ready', () => { if (entry.live === torrent) this._onReady(entry) })
    torrent.on('done', () => { if (entry.live === torrent) this._checkSelectionDone(entry) })
    torrent.on('error', (err) => {
      if (entry.live !== torrent) return
      entry.live = null
      entry.error = err.message
      this._reconcile()
      this._changed()
    })
  }

  /**
   * The saved bitfield lets us skip re-hashing, but only if the files it describes are
   * still on disk. Otherwise drop it and let WebTorrent verify what is really there.
   */
  _resumeBitfield (entry) {
    if (!entry.bitfield) return null
    let buffer = null
    try { buffer = Buffer.from(entry.bitfield, 'base64') } catch { /* fall through */ }
    const filesPresent = !entry.files || entry.files.every((file, i) => {
      if (!entry.fp || !(entry.fp[i] > 0)) return true
      return fs.existsSync(path.join(entry.path, file.path))
    })
    if (buffer && filesPresent) return buffer
    entry.bitfield = null
    entry.fp = null
    entry.progressBytes = 0
    entry.done = false
    return null
  }

  /** Stop the live torrent (keeps the entry). Safe to call twice; resolves when it is really gone. */
  _stop (entry, { keepBitfield }) {
    if (entry.stopping) return entry.stopping
    const torrent = entry.live
    if (!torrent) return Promise.resolve()
    if (keepBitfield) this._captureProgress(entry)
    else { entry.bitfield = null; entry.fp = null }
    entry.live = null
    entry.applied = null
    entry.cache = null

    const closed = new Promise((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS)
      try {
        torrent.destroy({ destroyStore: false }, () => { clearTimeout(timer); resolve() })
      } catch { clearTimeout(timer); resolve() }
    })
    entry.stopping = closed.then(() => {
      entry.stopping = null
      if (!entry.removing && this.entries.get(entry.id) === entry) this._reconcile()
    })
    return entry.stopping
  }

  _onMetadata (entry, torrent) {
    dropRarityMap(torrent)
    installTorrentOptimizations(torrent)
    installTorrentVerification(torrent, { budget: this.verificationBudget })
    if (torrent.files.length > MAX_TORRENT_FILES) {
      entry.error = 'too-many-files'
      this._stop(entry, { keepBitfield: false })
      this._changed()
      return
    }
    entry.name = torrent.name || entry.name
    entry.length = torrent.length
    entry.pieceLength = torrent.pieceLength
    entry.pieceCount = torrent.pieces.length
    entry.files = torrent.files.map((f) => ({ path: f.path, length: f.length }))
    entry.trackers = cleanTrackers(torrent.announce)
    if (!entry.torrentBuffer && torrent.torrentFile) entry.torrentBuffer = Buffer.from(torrent.torrentFile)
    if (entry.stage === 'metadata') entry.stage = 'choosing'
    else this._persistTorrentFile(entry)
    this._changed()
  }

  _onReady (entry) {
    const torrent = entry.live
    // WebTorrent's own 'done' means "every file", but we finish when the selected files are done.
    torrent.files.forEach((file) => file.on('done', () => { if (entry.live === torrent) this._checkSelectionDone(entry) }))
    if (entry.stage === 'ready') {
      if (entry.done && !this._allWantedDone(entry, torrent)) entry.done = false
      this._applySelection(entry)
      this._checkSelectionDone(entry)
    }
    this._publish()
  }

  _allWantedDone (entry, torrent) {
    return torrent.files.every((file, i) => (entry.selected && !entry.selected[i]) || file.done)
  }

  _checkSelectionDone (entry) {
    const torrent = entry.live
    if (entry.stage !== 'ready' || entry.done || !torrent || !torrent.ready) return
    if (this._allWantedDone(entry, torrent)) this._onDone(entry)
  }

  _onDone (entry) {
    if (entry.stage !== 'ready' || entry.done) return
    entry.done = true
    this._captureProgress(entry)
    // WebTorrent emits file 'done' in the middle of its completion routine.
    // Destroying it there (seeding disabled) leaves that routine using a null
    // client. Let it finish before advancing the queue or closing its stores.
    queueMicrotask(() => {
      if (this.isShutDown) return
      this._reconcile()
      this._changed()
    })
    this.emit('completed', { name: entry.name })
  }

  _applySelection (entry) {
    const torrent = entry.live
    if (!torrent || !torrent.ready) return
    // WebTorrent's deselect drops any selection overlapping the file, including a piece
    // shared with a neighbour we still want. So: deselect everything we applied, then
    // select what is wanted, in that order.
    const applied = entry.applied || torrent.files.map(() => false)
    const wanted = torrent.files.map((_, i) => !entry.selected || entry.selected[i])
    if (entry.applied && applied.every((v, i) => v === wanted[i])) return
    torrent.files.forEach((file, i) => { if (applied[i]) file.deselect() })
    torrent.files.forEach((file, i) => { if (wanted[i]) file.select() })
    entry.applied = wanted
  }

  _persistTorrentFile (entry) {
    if (!entry.torrentBuffer) return
    entry.persistingTorrent = (entry.persistingTorrent || Promise.resolve()).then(async () => {
      await fs.promises.mkdir(this.torrentsDir, { recursive: true })
      if (this.entries.get(entry.id) !== entry || entry.removing) return
      await fs.promises.writeFile(this._torrentFile(entry.id), entry.torrentBuffer)
    }).catch((err) => console.error('[torrent-file] save failed:', err.message))
  }

  /** Copy live progress into the record so it survives stopping and restarts. */
  _captureProgress (entry) {
    const torrent = entry.live
    if (!torrent || !torrent.ready || !torrent.bitfield) return
    entry.bitfield = Buffer.from(torrent.bitfield.buffer).toString('base64')
    entry.cache = null
    const progress = this._progressCache(entry, true)
    // floor, so a file that is 99.96% done is never stored as complete
    entry.fp = progress.files.map((p) => Math.floor(p * 1000) / 1000)
    entry.progressBytes = progress.got
  }

  _selectedBytes (entry, torrent) {
    return measureTorrentProgress(torrent, MAP_BUCKETS).files.reduce((sum, bytes, i) => sum + (!entry.selected || entry.selected[i] ? bytes : 0), 0)
  }

  _selectedLength (entry) {
    if (!entry.files) return entry.length
    return entry.files.reduce((sum, f, i) => sum + (!entry.selected || entry.selected[i] ? f.length : 0), 0)
  }

  _contentPath (entry) {
    const root = path.resolve(entry.path)
    const target = path.resolve(root, entry.name)
    if (!entry.name || target === root || !target.startsWith(root + path.sep)) return null
    return target
  }

  /**
   * Move this torrent's own files to the Recycle Bin. Only paths listed in the torrent are
   * touched (never a whole folder that merely shares the torrent's name), then empty
   * folders left behind are removed.
   */
  _removalProgressReporter () {
    let completed = 0
    let last = Date.now()
    return () => {
      completed++
      if (Date.now() - last < 1000) return
      last = Date.now()
      this.emit('removal-progress', { completed })
    }
  }

  async _sharedTargets (entry, progress = () => {}) {
    const shared = new Set()
    const remember = async (target) => {
      shared.add(pathKey(target))
      const resolved = await resolveLocalPath(target)
      const checked = resolved.status === 'ready' ? await inspectPath(resolved.path) : resolved
      if (resolved.status === 'ready') shared.add(pathKey(resolved.path))
      if (checked.status === 'ready' && checked.identity.ino !== '0') shared.add(`file:${checked.identity.dev}:${checked.identity.ino}`)
      progress()
    }
    for (const other of this.entries.values()) {
      if (other === entry) continue
      for (const file of other.files || []) {
        const target = path.resolve(other.path, file.path)
        if (contained(other.path, target)) await remember(target)
      }
      if (other.sourceTorrent) await remember(other.sourceTorrent.path)
    }
    return shared
  }

  async _removalPlan (entry) {
    const plan = { targets: [], failed: 0, skipped: 0, sourceUnavailable: !entry.sourceTorrent }
    const progress = this._removalProgressReporter()
    let parsed
    try {
      const cached = entry.torrentBuffer ? { status: 'ready', buffer: entry.torrentBuffer } : await readTorrentFile(this._torrentFile(entry.id))
      if (cached.status !== 'ready' || cached.buffer.length > MAX_TORRENT_FILE_BYTES) throw new Error('missing-metadata')
      parsed = await this.parseTorrent(cached.buffer)
      if (parsed.infoHash !== entry.id || !Array.isArray(parsed.files) || parsed.files.length > MAX_TORRENT_FILES) throw new Error('wrong-metadata')
    } catch { parsed = null; plan.skipped += (entry.files || []).length }
    const shared = await this._sharedTargets(entry, progress)
    const used = new Set()
    for (const file of entry.stage === 'ready' && parsed?.infoHash === entry.id ? parsed.files : []) {
      progress()
      const target = path.resolve(entry.path, file.path)
      if (!contained(entry.path, target) || contained(this.torrentsDir, target) || pathKey(target) === pathKey(this.torrentsDir) || shared.has(pathKey(target))) { plan.skipped++; continue }
      if (!used.has(pathKey(target))) {
        used.add(pathKey(target))
        const checked = await inspectPath(target)
        if (checked.status === 'ready' && shared.has(`file:${checked.identity.dev}:${checked.identity.ino}`)) plan.skipped++
        else if (checked.status === 'ready') plan.targets.push({ kind: 'content', root: path.resolve(entry.path), path: target, identity: checked.identity })
        else if (checked.status === 'failed') plan.failed++
        else if (checked.status !== 'missing') plan.skipped++
        progress()
      }
    }
    if (entry.sourceTorrent) {
      const source = { kind: 'source', ...entry.sourceTorrent }
      if (pathKey(source.path) === pathKey(this._torrentFile(entry.id)) || contained(this.torrentsDir, source.path)) {
        // App-owned metadata is handled only by the fixed infoHash cache unlink below.
        plan.sourceUnavailable = true
      } else if (shared.has(pathKey(source.path))) plan.skipped++
      else {
        const read = await validateTrashTarget(source)
        if (read.status === 'ready') {
          try {
            if (shared.has(`file:${read.identity.dev}:${read.identity.ino}`) || (await this.parseTorrent(read.buffer)).infoHash !== entry.id) plan.skipped++
            else if (!used.has(pathKey(source.path))) plan.targets.push(source)
          } catch { plan.skipped++ }
        } else if (read.status === 'failed') plan.failed++
        else if (read.status !== 'missing') plan.skipped++
      }
    }
    return plan
  }

  async _trashContent (entry, plan, result) {
    let shared
    let revision = -1
    const progress = this._removalProgressReporter()
    for (const target of plan.targets) {
      progress()
      if (revision !== this.entriesRevision) {
        revision = this.entriesRevision
        shared = await this._sharedTargets(entry, progress)
      }
      // Ownership changed during the async scan: leave the affected file rather than using a stale allowlist.
      if (revision !== this.entriesRevision || shared.has(pathKey(target.path)) || (target.identity && shared.has(`file:${target.identity.dev}:${target.identity.ino}`)) || (target.kind === 'content' && pathKey(entry.path) !== pathKey(target.root))) { result.skipped++; continue }
      const checked = await validateTrashTarget(target)
      if (revision !== this.entriesRevision) { result.skipped++; continue }
      if (checked.status === 'missing') continue
      if (checked.status !== 'ready') { result[checked.status === 'failed' ? 'failed' : 'skipped']++; continue }
      try { await this.trash(target.path); result.trashed++ } catch (err) {
        if (err.message === 'trash-unsafe') result.skipped++
        else if (err.message !== 'trash-missing') result.failed++
      }
    }
    await pruneEmptyDirectories(entry.path, plan.targets.filter((target) => target.kind === 'content').map((target) => target.path), progress)
  }

  /** Remove the empty folders WebTorrent creates up front (never a folder that has anything in it). */
  async _pruneEmptyDirs (entry, root) {
    await pruneEmptyDirectories(root, (entry.files || []).map((file) => path.resolve(root, file.path)))
  }

  // ---------------------------------------------------------------- snapshots

  _tick () {
    const now = Date.now()
    if (now - this.lastBitfieldSave > BITFIELD_SAVE_MS) {
      this.lastBitfieldSave = now
      let any = false
      for (const entry of this._ready()) {
        if (entry.live && entry.live.ready) { this._captureProgress(entry); any = true }
      }
      if (any) this.stateStore.saveSoon(() => this._serialize())
    }
    for (const entry of this._ready()) this._checkSelectionDone(entry)
    if (this.observed) this._publish()
    else this.emit('stats', this.stats())
  }

  _publish () {
    if (this.observed) this.emit('state', this.snapshot())
  }

  /** A few numbers for the tray tooltip: cheap, no per-torrent work. */
  stats () {
    let active = 0
    for (const entry of this.entries.values()) {
      if (entry.stage === 'ready' && entry.live && !entry.done && !entry.paused && !entry.removing) active += 1
    }
    return { down: this.client ? this.client.downloadSpeed : 0, up: this.client ? this.client.uploadSpeed : 0, active }
  }

  snapshot () {
    const torrents = [...this.entries.values()]
      .filter((e) => !e.removing)
      .sort((a, b) => (a.stage === 'ready') - (b.stage === 'ready') || a.order - b.order || a.createdAt - b.createdAt)
      .map((entry) => this._describe(entry))
    return {
      torrents,
      settings: this.settings,
      speed: this.client ? { down: this.client.downloadSpeed, up: this.client.uploadSpeed } : { down: 0, up: 0 }
    }
  }

  /** Bytes done and the piece map are O(pieces): recompute at most once per TTL, less often for huge torrents. */
  _progressCache (entry, isReady) {
    const ttl = entry.pieceCount > BIG_TORRENT_PIECES ? 5000 : 900
    const now = Date.now()
    if (entry.cache && entry.cache.ready === isReady && now - entry.cache.at < ttl) return entry.cache
    const live = entry.live
    const measured = isReady && live.bitfield ? measureTorrentProgress(live, MAP_BUCKETS) : null
    entry.cache = {
      at: now,
      ready: isReady,
      got: measured ? measured.files.reduce((sum, bytes, i) => sum + (!entry.selected || entry.selected[i] ? bytes : 0), 0) : entry.progressBytes,
      files: measured ? measured.files.map((bytes, i) => entry.files[i].length ? bytes / entry.files[i].length : 0) : entry.fp || [],
      pieces: measured ? measured.pieces : pieceMap(bitfieldReader(entry.bitfield), entry.pieceCount, MAP_BUCKETS)
    }
    return entry.cache
  }

  _describe (entry) {
    const live = entry.live
    const isReady = Boolean(live && live.ready)
    const size = this._selectedLength(entry)
    const { got, pieces } = this._progressCache(entry, isReady)
    const checking = !isReady && live && live._ternVerification?.total > 0 ? live._ternVerification : null

    return {
      id: entry.id,
      name: entry.name,
      state: this._state(entry, isReady),
      error: entry.error,
      size,
      total: entry.length,
      progress: entry.done ? 1 : size ? Math.min(1, got / size) : 0,
      // Verification attempts include invalid and missing pieces. Keep them
      // separate from downloaded bytes so a checked hole never looks complete.
      verification: checking ? { ...checking } : null,
      down: live ? live.downloadSpeed : 0,
      up: live ? live.uploadSpeed : 0,
      peers: live ? live.numPeers : 0,
      eta: isReady && !entry.done && live.downloadSpeed > 0 ? Math.max(0, (size - got) / live.downloadSpeed) : null,
      uploaded: live ? live.uploaded : 0,
      dir: entry.path,
      fileCount: entry.files ? entry.files.length : 0,
      pieces,
      paused: entry.paused,
      files: entry.stage === 'choosing' ? this.files(entry.id) : undefined
    }
  }

  _state (entry, isReady) {
    if (entry.error) return 'error'
    if (entry.stage === 'metadata') return 'metadata'
    if (entry.stage === 'choosing') return 'choosing'
    if (entry.paused) return 'paused'
    if (!entry.live) return entry.done ? 'done' : 'queued'
    if (!isReady) return 'checking'
    if (entry.done) return 'seeding'
    return entry.live.numPeers === 0 ? 'connecting' : 'downloading'
  }
}

module.exports = { Engine, DEFAULT_SETTINGS, mergeSettings, cleanRecord, cleanTrackers }
