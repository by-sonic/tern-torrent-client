'use strict'

const { EventEmitter } = require('node:events')
const path = require('node:path')
const { MAX_TORRENT_FILES } = require('./input')
const { pathKey, validateTrashTarget } = require('./torrent-removal')

const REQUEST_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 6000
const MAX_PENDING = 128
const NATIVE_TRASH_TIMEOUT_MS = 35_000 // the child has a separate 30 s per-file timeout

/** The Electron main process only exchanges small messages; torrent work lives in a utility process. */
class EngineService extends EventEmitter {
  constructor ({ userData, defaultDir, trash, fork, clientOptions, requestTimeoutMs = REQUEST_TIMEOUT_MS, shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS, removalPlanTimeoutMs = INIT_TIMEOUT_MS }) {
    super()
    this.options = { userData, defaultDir, clientOptions }
    this.trash = trash
    this.fork = fork || ((file, args, options) => require('electron').utilityProcess.fork(file, args, options))
    this.requestTimeoutMs = requestTimeoutMs
    this.shutdownTimeoutMs = shutdownTimeoutMs
    this.removalPlanTimeoutMs = removalPlanTimeoutMs
    this.settings = { downloadDir: defaultDir, closeToTray: true, autoUpdate: true, launchAtLogin: false }
    this.lastState = { torrents: [], settings: this.settings, speed: { down: 0, up: 0 } }
    this.pending = new Map()
    this.sequence = 0
    this.observed = false
    this.child = null
    this.failed = null
    this.isShuttingDown = false
    this.exited = false
    this.shutdownPromise = null
    this.trashing = new Set()
  }

  async init () {
    if (this.child) throw new Error('engine-already-started')
    this.child = this.fork(path.join(__dirname, 'engine-process.js'), [], { serviceName: 'Tern torrent engine', stdio: 'pipe' })
    this.child.on('message', (message) => this._receive(message))
    this.child.on('exit', (code) => {
      this.exited = true
      if (this.isShuttingDown) this._rejectPending(new Error('engine-stopped'))
      else this._fail(new Error(`engine-process-exited (${code})`))
    })
    // Utility-process output is diagnostic only; the engine never inherits terminal input.
    if (this.child.stdout) this.child.stdout.on('data', (data) => console.log('[engine]', String(data).trimEnd()))
    if (this.child.stderr) this.child.stderr.on('data', (data) => console.error('[engine]', String(data).trimEnd()))
    try {
      const snapshot = await this._request('init', [this.options], INIT_TIMEOUT_MS)
      this._acceptState(snapshot)
      this.setObserved(this.observed)
    } catch (err) {
      this._fail(err)
      this.child.kill()
      throw err
    }
  }

  _acceptState (state) {
    if (!state || !Array.isArray(state.torrents) || !state.settings || !state.speed) return
    this.lastState = state
    this.settings = state.settings
  }

  _receive (message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'result') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.settings) {
        this.settings = message.settings
        this.lastState = { ...this.lastState, settings: this.settings }
      }
      if (message.ok) request.resolve(message.value)
      else request.reject(new Error(message.error || 'engine-request-failed'))
    } else if (message.type === 'event' && ['state', 'stats', 'completed'].includes(message.event)) {
      if (this.failed || this.isShuttingDown) return
      if (message.event === 'state') this._acceptState(message.value)
      this.emit(message.event, message.value)
    } else if (message.type === 'trash') {
      void this._trash(message)
    } else if (message.type === 'removal-progress') {
      const request = this.pending.get(message.requestId)
      if (!request || !['removalPlan', 'remove'].includes(request.method) || !Number.isSafeInteger(message.completed) || message.completed <= (request.progress || 0)) return
      request.progress = message.completed
      request.renew()
    } else if (message.type === 'fatal') {
      if (message.stack) console.error('[engine-process]', message.stack)
      this._fail(new Error(message.error || 'engine-process-failed'))
      this.child.kill()
    }
  }

  async _trash (message) {
    // Native operations are allowed only while servicing the person's remove-with-trash request.
    const request = this.pending.get(message.requestId)
    if (!request || request.method !== 'remove') return
    if (!Number.isSafeInteger(message.id) || this.trashing.has(message.id)) return
    this.trashing.add(message.id)
    // Removing many files is healthy progress, even if the whole operation
    // exceeds a normal RPC deadline. Each native operation remains bounded.
    request.renew(Math.max(this.requestTimeoutMs, NATIVE_TRASH_TIMEOUT_MS))
    let error
    try {
      const allowed = typeof message.target === 'string' && request.allowedTrash?.get(pathKey(message.target))
      if (!allowed) throw new Error('trash-unsafe')
      request.allowedTrash.delete(pathKey(message.target))
      const checked = await validateTrashTarget(allowed)
      if (checked.status !== 'ready') throw new Error(`trash-${checked.status === 'missing' ? 'missing' : checked.status === 'failed' ? 'failed' : 'unsafe'}`)
      await this.trash(allowed.path)
    } catch (err) { error = err.message }
    finally { this.trashing.delete(message.id) }
    if (this.pending.get(message.requestId) === request) request.renew()
    if (!this.exited) {
      try { this.child.postMessage({ type: 'trash-result', id: message.id, ok: !error, error }) } catch (err) { this._fail(err) }
    }
  }

  _request (method, args = [], timeoutMs = this.requestTimeoutMs, duringShutdown = false, allowedTrash) {
    if (this.failed) return Promise.reject(this.failed)
    if (!this.child || this.exited || (this.isShuttingDown && !duringShutdown)) return Promise.reject(new Error('engine-unavailable'))
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('engine-busy'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const request = { method, args, resolve, reject, timer: null, allowedTrash }
      const expire = () => {
        if (this.pending.get(id) !== request) return
        this.pending.delete(id)
        const err = new Error(`engine-request-timeout (${method})`)
        reject(err)
        if (!this.isShuttingDown) this._fail(err)
        if (this.child && !this.exited) this.child.kill()
      }
      request.renew = (delay = timeoutMs) => { clearTimeout(request.timer); request.timer = setTimeout(expire, delay) }
      this.pending.set(id, request)
      request.renew()
      try { this.child.postMessage({ type: 'request', id, method, args }) } catch (err) {
        this.pending.delete(id)
        clearTimeout(request.timer)
        reject(err)
        this._fail(err)
      }
    })
  }

  _rejectPending (err) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(err) }
    this.pending.clear()
  }

  _fail (err) {
    if (this.failed || this.isShuttingDown) return
    this.failed = err
    this._rejectPending(err)
    this.lastState = {
      ...this.lastState,
      torrents: this.lastState.torrents.map((torrent) => ({ ...torrent, state: 'error', error: 'engine-process-exited', down: 0, up: 0, peers: 0 })),
      speed: { down: 0, up: 0 }
    }
    this.emit('state', this.lastState)
    this.emit('stats', { down: 0, up: 0, active: 0 })
    this.emit('failure', err)
    if (this.child && !this.exited) this.child.kill()
  }

  setObserved (observed) {
    this.observed = Boolean(observed)
    if (!this.child || this.exited || this.failed || this.isShuttingDown) return
    try { this.child.postMessage({ type: 'observe', value: this.observed }) } catch (err) { this._fail(err) }
  }

  async snapshot () {
    if (this.failed || this.isShuttingDown) return this.lastState
    const state = await this._request('snapshot')
    this._acceptState(state)
    return state
  }

  async remove (id, options = {}) {
    let allowedTrash
    let planToken
    const trash = options.trash === true
    if (trash) {
      const plan = await this._request('removalPlan', [id], this.removalPlanTimeoutMs)
      if (!plan) return { removed: false, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 0 }
      if (typeof plan.token !== 'string' || !/^[a-f0-9]{32}$/.test(plan.token) || !Array.isArray(plan.targets) || plan.targets.length > MAX_TORRENT_FILES + 1 || plan.targets.some((target) => !target || typeof target.path !== 'string')) {
        await this._request('cancelRemovalPlan', [id, plan.token]).catch(() => {})
        throw new Error('bad-removal-plan')
      }
      planToken = plan.token
      allowedTrash = new Map(plan.targets.map((target) => [pathKey(target.path), target]))
    }
    try { return await this._request('remove', [id, { trash, ...(planToken ? { planToken } : {}) }], this.requestTimeoutMs, false, allowedTrash) } catch (err) {
      if (planToken) await this._request('cancelRemovalPlan', [id, planToken]).catch(() => {})
      throw err
    }
  }

  shutdown () {
    if (this.shutdownPromise) return this.shutdownPromise
    this.isShuttingDown = true
    this.shutdownPromise = (async () => {
      try {
        if (this.child && !this.exited && !this.failed) await this._request('shutdown', [], this.shutdownTimeoutMs, true)
      } finally {
        this._rejectPending(new Error('engine-stopped'))
        if (this.child && !this.exited) this.child.kill()
      }
    })()
    return this.shutdownPromise
  }
}

for (const method of ['add', 'confirm', 'pause', 'resume', 'pauseAll', 'resumeAll', 'move', 'files', 'info', 'contentPath', 'setSelection', 'setSettings']) {
  EngineService.prototype[method] = function (...args) { return this._request(method, args) }
}

module.exports = { EngineService, MAX_PENDING }
