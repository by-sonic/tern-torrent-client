'use strict'

const { EventEmitter } = require('node:events')

const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 20_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 15_000

/**
 * The feed is fixed by app-update.yml. Downloads are started explicitly so a late
 * response cannot begin a download after the person has left the startup screen.
 * Emits state: disabled|idle|checking|downloading|ready|installing|error.
 */
class Updater extends EventEmitter {
  constructor (autoUpdater, { isAutomatic, startupInstaller = null, checkTimeoutMs = CHECK_TIMEOUT_MS, downloadIdleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS, installTimeoutMs = INSTALL_TIMEOUT_MS }) {
    super()
    this.autoUpdater = autoUpdater
    this.isAutomatic = isAutomatic
    this.checkTimeoutMs = checkTimeoutMs
    this.downloadIdleTimeoutMs = downloadIdleTimeoutMs
    this.installTimeoutMs = installTimeoutMs
    this.startupInstaller = startupInstaller
    this.installOperation = null
    this.timer = null
    this.firstTimer = null
    this.installTimer = null
    this.operation = null
    this.downloadOwner = null
    this.downloadTask = null
    this.startup = false
    this.state = { status: autoUpdater ? 'idle' : 'disabled', version: null, percent: 0, error: null, checkedAt: null, transferred: 0, total: 0, bytesPerSecond: 0 }
    if (autoUpdater) this._wire(autoUpdater)
  }

  _wire (updater) {
    updater.autoDownload = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.logger = null
    this.refresh()

    updater.on('download-progress', (p) => {
      const op = this.downloadOwner
      if (!this._current(op)) return
      this._arm(op, this.downloadIdleTimeoutMs, 'update-download-timeout')
      this._set({ status: 'downloading', percent: Math.min(100, Math.max(0, Math.round(Number(p.percent) || 0))),
        transferred: Math.max(0, Number(p.transferred) || 0), total: Math.max(0, Number(p.total) || 0), bytesPerSecond: Math.max(0, Number(p.bytesPerSecond) || 0) })
    })
    updater.on('update-downloaded', (info) => {
      if (!this._current(this.downloadOwner)) return
      this._set({ status: 'ready', version: info.version, percent: 100, checkedAt: Date.now() })
      // BaseUpdater adds its quit listener just after this event returns.
      this.refresh()
    })
    // Checks and downloads reject their promises as well as emitting error. Handle
    // those in their owning operation; only installation has no returned promise.
    updater.on('error', (err) => {
      if (this.state.status === 'installing') {
        clearTimeout(this.installTimer)
        this.installTimer = null
        this.cancelInstall()
        this._error(err)
      }
    })
  }

  beginStartup () { this.startup = true; this.refresh() }
  finishStartup () { this.startup = false; this.refresh() }

  /** A cancelled download must finish unwinding before install-on-quit is enabled. */
  refresh () {
    const validReadyDownload = this._current(this.downloadOwner) && this.state.status === 'ready'
    if (this.autoUpdater) this.autoUpdater.autoInstallOnAppQuit = Boolean(this.isAutomatic() && !this.startup && (!this.downloadTask || validReadyDownload))
  }

  _set (patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state) }
  _error (err) { this._set({ status: 'error', error: String((err && err.message) || err).slice(0, 300), checkedAt: Date.now() }) }

  start () {
    if (!this.autoUpdater || this.timer) return
    this.firstTimer = setTimeout(() => this._auto(), FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => this._auto(), CHECK_INTERVAL_MS)
  }

  stop () {
    clearTimeout(this.firstTimer); clearInterval(this.timer); clearTimeout(this.installTimer)
    this.firstTimer = this.timer = this.installTimer = null
    this.cancelCheck()
    this.cancelInstall()
  }

  _auto () { if (this.isAutomatic()) void this.check() }
  _current (op) { return Boolean(op && op.active && this.operation === op) }

  _arm (op, ms, error) {
    clearTimeout(op.timer)
    op.timer = setTimeout(() => {
      if (!this._current(op)) return
      this._error(new Error(error))
      this._finish(op, true)
    }, ms)
  }

  _finish (op, cancel = false) {
    if (!this._current(op)) return
    op.active = false
    clearTimeout(op.timer)
    this.operation = null
    if (cancel && op.token) op.token.cancel()
    op.resolve(this.state)
  }

  /** Used only by the startup screen's explicit continue/close action. */
  cancelCheck () { if (this.operation) this._finish(this.operation, true) }

  /** Resolves only after the check AND its download have completed, or timed out. */
  check () {
    if (!this.autoUpdater) return Promise.resolve(this.state)
    if (this.operation) return this.operation.promise
    if (this.state.status === 'ready' || this.state.status === 'installing') return Promise.resolve(this.state)
    const op = { active: true, token: null, timer: null, resolve: null, promise: null }
    op.promise = new Promise((resolve) => { op.resolve = resolve })
    this.operation = op
    this._set({ status: 'checking', error: null, version: null, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
    this._arm(op, this.checkTimeoutMs, 'update-check-timeout')
    void this._execute(op)
    return op.promise
  }

  async _execute (op) {
    try {
      // A previous cancelled download can still emit its last events. Drain it
      // before giving this operation ownership of any download events.
      if (this.downloadTask) await this.downloadTask.catch(() => {})
      if (!this._current(op)) return
      const result = await this.autoUpdater.checkForUpdates()
      // AppUpdater coalesces checks: Retry may be awaiting this SAME result and
      // token. With autoDownload off an abandoned metadata request has nothing
      // to cancel; touching its token would cancel the active retry's download.
      if (!this._current(op)) return
      if (!result || !result.isUpdateAvailable) {
        this._set({ status: 'idle', version: null, checkedAt: Date.now() })
        this._finish(op)
        return
      }
      op.token = result.cancellationToken
      this.downloadOwner = op
      this._set({ status: 'downloading', version: result.updateInfo.version, percent: 0 })
      this._arm(op, this.downloadIdleTimeoutMs, 'update-download-timeout')
      // Keep install disabled during download. It is restored after a successful
      // background download, never while the startup gate is still open.
      this.autoUpdater.autoInstallOnAppQuit = false
      const task = Promise.resolve(this.autoUpdater.downloadUpdate(op.token))
      this.downloadTask = task
      try {
        await task
        if (!this._current(op)) return
        if (this.state.status !== 'ready') throw new Error('update-download-incomplete')
        this._finish(op)
      } finally {
        if (this.downloadTask === task) this.downloadTask = null
        if (this.downloadOwner === op) this.downloadOwner = null
        this.refresh()
      }
    } catch (err) {
      if (!this._current(op)) return
      this._error(err)
      this._finish(op, true)
    }
  }

  installNow () {
    if (!this.autoUpdater || this.state.status !== 'ready') throw new Error('no-update-ready')
    this._set({ status: 'installing', error: null })
    if (this.startup) {
      this._installAtStartup()
      return this.state
    }
    this.installTimer = setTimeout(() => {
      this.installTimer = null
      if (this.state.status === 'installing') this._error(new Error('update-install-timeout'))
    }, this.installTimeoutMs)
    try { this.autoUpdater.quitAndInstall(true, true) } catch (err) {
      clearTimeout(this.installTimer); this.installTimer = null; this._error(err)
    }
    return this.state
  }

  _installAtStartup () {
    const op = { active: true, abort: new AbortController() }
    this.installOperation = op
    const current = () => op.active && this.installOperation === op
    const fail = (err) => {
      if (!current()) return
      clearTimeout(this.installTimer); this.installTimer = null
      this.cancelInstall()
      this._error(err)
    }
    this.installTimer = setTimeout(() => fail(new Error('update-install-timeout')), this.installTimeoutMs)
    void (async () => {
      try {
        if (!this.startupInstaller) throw new Error('startup-installer-unavailable')
        await this.startupInstaller.launch({ signal: op.abort.signal, version: this.state.version })
        if (!current()) return
        clearTimeout(this.installTimer); this.installTimer = null
        op.active = false
        this.installOperation = null
        this.emit('installer-started')
      } catch (err) { fail(err) }
    })()
  }

  cancelInstall () {
    const op = this.installOperation
    if (!op || !op.active) return
    op.active = false
    this.installOperation = null
    clearTimeout(this.installTimer); this.installTimer = null
    op.abort.abort()
  }
}

module.exports = { Updater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS, CHECK_TIMEOUT_MS, DOWNLOAD_IDLE_TIMEOUT_MS, INSTALL_TIMEOUT_MS }
