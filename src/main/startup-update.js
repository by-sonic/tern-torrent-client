'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { classifyInput } = require('./input')

const MAX_STARTUP_INPUTS = 50
const MAX_JOURNAL_BYTES = 512 * 1024
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const JOURNAL_NAME = 'startup-inputs.json'

/** No engine dependency: the only successful outcomes are launch or quit. */
class StartupUpdate extends EventEmitter {
  constructor (updater, { beforeInstall = async () => {}, version = '', installDelayMs = 150 } = {}) {
    super()
    this.updater = updater
    this.beforeInstall = beforeInstall
    this.version = version
    this.installDelayMs = installDelayMs
    this.state = { ...updater.state, status: 'checking', currentVersion: version }
    this.generation = 0
    this.done = false
    this.promise = null
    this.resolve = null
    this.onUpdate = (state) => {
      if (this.done) return
      if (['checking', 'downloading', 'installing', 'error'].includes(state.status)) this._set(state)
    }
    updater.on('state', this.onUpdate)
  }

  _set (state) {
    if (state.status === 'error' && this.state.status !== 'error') state = { ...state, failedStage: this.state.status }
    if (state.status === 'checking') state = { ...state, failedStage: null }
    this.state = { ...this.state, ...state, currentVersion: this.version }
    this.emit('state', this.state)
  }

  run () {
    if (this.done) return Promise.resolve(this.outcome)
    if (this.promise) return this.promise
    this.updater.beginStartup()
    this.promise = new Promise((resolve) => { this.resolve = resolve })
    void this._check()
    return this.promise
  }

  async _check () {
    const generation = ++this.generation
    this._set({ status: 'checking', error: null, percent: 0 })
    const state = await this.updater.check()
    if (this.done || generation !== this.generation) return
    if (state.status === 'disabled' || state.status === 'idle') {
      this._set({ status: 'starting', error: null })
      this._finish('launch')
    } else if (state.status === 'ready') {
      try {
        this._set({ ...state, status: 'installing', error: null })
        // Let Chromium present the final stage before the installer quits us.
        await new Promise((resolve) => setTimeout(resolve, this.installDelayMs))
        if (this.done || generation !== this.generation) return
        await this.beforeInstall()
        if (this.done || generation !== this.generation) return
        this.updater.installNow()
      } catch (err) {
        this._set({ status: 'error', error: String(err.message || err).slice(0, 300) })
      }
    } else if (state.status === 'error') this._set(state)
  }

  retry () {
    if (this.done || this.state.status !== 'error') return false
    void this._check()
    return true
  }

  continue () {
    if (this.done || this.state.status !== 'error') return false
    this.generation += 1
    this.updater.cancelCheck()
    this.updater.cancelInstall()
    this._set({ status: 'starting', error: null })
    this._finish('launch')
    return true
  }

  close () {
    if (this.done) return
    this.generation += 1
    this.updater.cancelCheck()
    this.updater.cancelInstall()
    this._finish('quit')
  }

  _finish (outcome) {
    if (this.done) return
    this.done = true
    this.outcome = outcome
    this.updater.removeListener('state', this.onUpdate)
    if (this.resolve) this.resolve(outcome)
  }
}

/** The journal holds only validated launch requests, never torrent state or resume bits. */
function cleanStartupInputs (inputs) {
  if (!Array.isArray(inputs)) return []
  const valid = []
  const seen = new Set()
  for (const raw of inputs.slice(0, MAX_STARTUP_INPUTS)) {
    const value = typeof raw === 'string' ? raw : raw && (raw.kind === 'file' ? raw.path : raw.kind === 'magnet' ? raw.uri : '')
    const input = classifyInput(value)
    if (!input) continue
    const key = input.kind === 'file' ? input.path : input.uri
    if (seen.has(key)) continue
    seen.add(key)
    valid.push(input)
  }
  return valid
}

function saveStartupInputs (userData, inputs, hidden = false) {
  const file = path.join(userData, JOURNAL_NAME)
  const payload = { version: 1, savedAt: Date.now(), hidden: hidden === true, inputs: cleanStartupInputs(inputs) }
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload))
  fs.renameSync(`${file}.tmp`, file)
}

function readStartupInputs (userData) {
  const empty = { inputs: [], hidden: false }
  try {
    const file = path.join(userData, JOURNAL_NAME)
    if (fs.statSync(file).size > MAX_JOURNAL_BYTES) return empty
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    const age = Date.now() - Number(payload.savedAt)
    if (payload.version !== 1 || !Number.isFinite(age) || age < -60_000 || age > JOURNAL_MAX_AGE_MS) return empty
    return { inputs: cleanStartupInputs(payload.inputs), hidden: payload.hidden === true }
  } catch { return empty }
}

function clearStartupInputs (userData) {
  try { fs.unlinkSync(path.join(userData, JOURNAL_NAME)) } catch (err) { if (err.code !== 'ENOENT') console.error('[startup-inputs]', err.message) }
}

/** A separately scoped sandbox. Its IPC cannot invoke the torrent or settings API. */
function createStartupWindow ({ BrowserWindow, ipcMain, controller, root, icon, backgroundColor, onClose }) {
  const win = new BrowserWindow({
    width: 980, height: 720, fullscreen: true, frame: false, show: false, title: 'Tern — обновление', icon, backgroundColor,
    webPreferences: { preload: path.join(root, 'src', 'preload', 'startup.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  })
  win.setMenuBarVisibility(false)
  const handlers = ['startup:get', 'startup:retry', 'startup:continue', 'startup:quit']
  const methods = [() => controller.state, () => controller.retry(), () => controller.continue(), () => { win.close(); return true }]
  handlers.forEach((channel, index) => {
    ipcMain.handle(channel, (event) => {
      if (win.isDestroyed() || event.sender !== win.webContents) throw new Error('untrusted sender')
      return methods[index]()
    })
  })
  let handedOff = false
  const send = (state) => { if (!win.isDestroyed()) win.webContents.send('startup:state', state) }
  controller.on('state', send)
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show() })
  win.webContents.on('did-finish-load', () => send(controller.state))
  win.on('close', () => {
    if (!handedOff) { controller.close(); if (onClose) onClose() }
  })
  const cleanup = () => { controller.removeListener('state', send); handlers.forEach((channel) => ipcMain.removeHandler(channel)) }
  win.once('closed', cleanup)
  const loaded = win.loadFile(path.join(root, 'src', 'renderer', 'startup.html'))
  return { window: win, loaded, destroy () { handedOff = true; cleanup(); if (!win.isDestroyed()) win.destroy() } }
}

module.exports = { StartupUpdate, createStartupWindow, cleanStartupInputs, saveStartupInputs, readStartupInputs, clearStartupInputs, MAX_STARTUP_INPUTS, MAX_JOURNAL_BYTES, JOURNAL_MAX_AGE_MS }
