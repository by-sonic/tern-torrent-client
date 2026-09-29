'use strict'

const { EventEmitter } = require('node:events')

const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * @typedef {{status: 'disabled'|'idle'|'checking'|'available'|'downloading'|'ready'|'error',
 *            version: string|null, percent: number, error: string|null, checkedAt: number|null}} UpdateState
 */

/**
 * A small state machine over electron-updater's autoUpdater, so the UI only renders
 * states. Updates come from the GitHub Releases repository baked into app-update.yml
 * at build time; nothing here lets the renderer choose a feed.
 *
 * Emits 'state' with the current UpdateState.
 */
class Updater extends EventEmitter {
  /**
   * @param {import('electron-updater').AppUpdater | null} autoUpdater  null when running unpackaged
   * @param {{ isAutomatic: () => boolean }} options
   */
  constructor (autoUpdater, { isAutomatic }) {
    super()
    this.autoUpdater = autoUpdater
    this.isAutomatic = isAutomatic
    this.timer = null
    this.firstTimer = null
    /** @type {UpdateState} */
    this.state = { status: autoUpdater ? 'idle' : 'disabled', version: null, percent: 0, error: null, checkedAt: null }
    if (autoUpdater) this._wire(autoUpdater)
  }

  _wire (updater) {
    updater.autoDownload = true
    // A downloaded update installs when the app quits, but only while automatic updates are on.
    updater.autoInstallOnAppQuit = this.isAutomatic()
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.logger = null

    updater.on('checking-for-update', () => this._set({ status: 'checking', error: null }))
    updater.on('update-available', (info) => this._set({ status: 'downloading', version: info.version, percent: 0 }))
    updater.on('update-not-available', () => this._set({ status: 'idle', version: null, checkedAt: Date.now() }))
    updater.on('download-progress', (p) => this._set({ status: 'downloading', percent: Math.round(p.percent || 0) }))
    updater.on('update-downloaded', (info) => this._set({ status: 'ready', version: info.version, percent: 100 }))
    updater.on('error', (err) => this._set({ status: 'error', error: String((err && err.message) || err).slice(0, 300), checkedAt: Date.now() }))
  }

  /** Call after the automatic-update setting changes. */
  refresh () {
    if (this.autoUpdater) this.autoUpdater.autoInstallOnAppQuit = this.isAutomatic()
  }

  _set (patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  /** Begin the automatic schedule (a first check shortly after start, then every few hours). */
  start () {
    if (!this.autoUpdater) return
    this.firstTimer = setTimeout(() => this._auto(), FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => this._auto(), CHECK_INTERVAL_MS)
  }

  stop () {
    clearTimeout(this.firstTimer)
    clearInterval(this.timer)
  }

  _auto () {
    if (this.isAutomatic()) void this.check()
  }

  /** Check now. Safe to call while a check or download is already running. */
  async check () {
    if (!this.autoUpdater) return this.state
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state
    try {
      await this.autoUpdater.checkForUpdates()
    } catch (err) {
      this._set({ status: 'error', error: String((err && err.message) || err).slice(0, 300), checkedAt: Date.now() })
    }
    return this.state
  }

  /** Close the app, run the installer and start the new version. Only valid once an update is ready. */
  installNow () {
    if (!this.autoUpdater || this.state.status !== 'ready') throw new Error('no-update-ready')
    // silent install, then start the new version
    this.autoUpdater.quitAndInstall(true, true)
  }
}

module.exports = { Updater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS }
