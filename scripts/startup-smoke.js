'use strict'

// Real main.js + Chromium startup page, using a fake fixed-feed updater and a
// sentinel engine. No network, installer, registry change or user profile access.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { app, BrowserWindow, session } = require('electron')

const WORKSPACE = path.join(__dirname, '..')
const ROOT = process.env.TERN_SMOKE_APP_ROOT || WORKSPACE
const MAIN = path.join(ROOT, 'src', 'main', 'main.js')
const currentVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const nextVersion = currentVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1))
const scratch = path.join(WORKSPACE, '.scratch')
fs.mkdirSync(scratch, { recursive: true })
const profile = fs.mkdtempSync(path.join(scratch, 'startup-smoke-profile-'))
app.setPath('userData', profile)
const sentinel = '{"version":1,"settings":{"autoUpdate":false},"torrents":[]}'
fs.writeFileSync(path.join(profile, 'state.json'), sentinel)
Object.defineProperty(app, 'isPackaged', { value: true })
app.getVersion = () => currentVersion
app.setLoginItemSettings = () => {}
const launchInput = `magnet:?xt=urn:btih:${'b'.repeat(40)}`
process.argv.push(launchInput)

const metrics = { constructors: 0, initializations: 0, imports: [], installs: 0, nativeQuits: 0 }
class SentinelEngine extends EventEmitter {
  constructor () {
    super(); metrics.constructors += 1
    this.settings = { downloadDir: profile, downLimitKB: 0, upLimitKB: 0, maxActive: 3, seedAfterDone: true, closeToTray: false, launchAtLogin: false, autoUpdate: false }
    this.isShuttingDown = false
  }
  async init () { metrics.initializations += 1; this.emit('state', this.snapshot()) }
  snapshot () { return { settings: this.settings, torrents: [], speed: { down: 0, up: 0 } } }
  setObserved () {}
  async add (input) { metrics.imports.push(input); return { duplicate: false } }
  async shutdown () { this.isShuttingDown = true }
}

let failDownload
const downloadGate = new Promise((_resolve, reject) => { failDownload = reject })
// A rejection handler exists before the test triggers failure.
downloadGate.catch(() => {})
const fake = new EventEmitter()
fake.checks = 0; fake.downloads = 0
fake.checkForUpdates = async () => { fake.checks += 1; return { isUpdateAvailable: true, updateInfo: { version: nextVersion }, cancellationToken: { cancel () {} } } }
fake.downloadUpdate = async () => {
  fake.downloads += 1
  if (fake.downloads === 1) await downloadGate
  fake.emit('update-downloaded', { version: nextVersion })
  return ['smoke-installer-never-run.exe']
}
fake.quitAndInstall = () => { metrics.nativeQuits += 1 }

const load = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && path.normalize(parent.filename) === path.normalize(MAIN)) {
    if (request === './engine-service') return { EngineService: SentinelEngine }
    if (request === 'electron-updater') return { autoUpdater: fake }
    if (request === './nsis-installer') return { createNsisInstaller: () => ({ async launch () {
      metrics.installs += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      throw new Error('smoke installer denied')
    } }) }
  }
  return load.call(this, request, parent, isMain)
}
require(MAIN)

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (predicate, label) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await pause(20) }
  throw new Error(`Timed out: ${label}`)
}
let startup
const evaluate = (code) => startup.webContents.executeJavaScript(`(async () => { ${code} })()`)

async function run () {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }))
  await until(() => {
    startup = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('/startup.html'))
    return startup && !startup.webContents.isLoading()
  }, 'startup window')
  await until(async () => (await evaluate('return document.body.dataset.status')) === 'downloading', 'download page')
  assert.equal(startup.isFullScreen(), false)
  assert.equal(startup.isMaximized(), false)
  assert.deepEqual(startup.getMinimumSize(), [620, 480])
  assert.equal(metrics.constructors, 0)
  assert.equal(metrics.initializations, 0)
  assert.equal(fake.autoDownload, false)
  assert.equal(fake.autoInstallOnAppQuit, false)
  fake.emit('download-progress', { percent: 37, transferred: 37 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 12 * 1024 * 1024 })
  await until(async () => (await evaluate('return document.getElementById("startup-percent").textContent')) === '37%', 'download percent')
  const security = await evaluate('return { node: typeof window.require, torrentApi: typeof window.tern, keys: Object.keys(window.ternStartup).sort(), overflow: document.documentElement.scrollWidth > innerWidth, progress: document.getElementById("startup-progress").getAttribute("aria-valuenow") }')
  assert.equal(security.node, 'undefined')
  assert.equal(security.torrentApi, 'undefined')
  assert.deepEqual(security.keys, ['continue', 'getState', 'onState', 'quit', 'retry'])
  assert.equal(security.overflow, false)
  assert.equal(security.progress, '37')
  await pause(250) // capture the painted progress after its CSS transition
  fs.writeFileSync(path.join(scratch, 'startup-download.png'), (await startup.webContents.capturePage()).toPNG())

  // The same secure preload loaded in another webContents has no authority.
  const stranger = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'startup.js'), contextIsolation: true, sandbox: true } })
  await stranger.loadFile(path.join(ROOT, 'src', 'renderer', 'startup.html'))
  const rejection = await stranger.webContents.executeJavaScript('window.ternStartup.getState().then(() => "unexpected", error => error.message)')
  assert.match(rejection, /untrusted sender/)
  stranger.destroy()

  failDownload(new Error('smoke offline'))
  await until(async () => (await evaluate('return document.body.dataset.status')) === 'error', 'offline error')
  assert.equal(metrics.constructors, 0)
  assert.equal(await evaluate('return document.getElementById("startup-actions").hidden'), false)
  assert.equal(await evaluate('return document.activeElement.id'), 'startup-continue')
  await evaluate('document.getElementById("startup-retry").click()')
  await until(() => metrics.installs === 1, 'installation attempted after retry')
  await until(async () => (await evaluate('return document.body.dataset.status')) === 'error', 'installer error')
  assert.equal(metrics.constructors, 0)
  assert.equal(fake.checks, 2)
  assert.equal(metrics.nativeQuits, 0)
  assert.equal(fake.autoInstallOnAppQuit, false)
  const journal = JSON.parse(fs.readFileSync(path.join(profile, 'startup-inputs.json'), 'utf8'))
  assert.deepEqual(journal.inputs, [{ kind: 'magnet', uri: launchInput }])
  fs.writeFileSync(path.join(scratch, 'startup-error.png'), (await startup.webContents.capturePage()).toPNG())
  // The update view fills the app window, including its minimum size.
  startup.setSize(620, 480)
  await pause(100)
  assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight'), false)
  await evaluate('document.getElementById("startup-continue").click()')
  await until(() => metrics.initializations === 1 && metrics.imports.length === 1, 'explicit continuation starts the engine')
  assert.equal(metrics.constructors, 1)
  assert.deepEqual(metrics.imports, [{ kind: 'magnet', uri: launchInput }])
  assert.equal(startup.isDestroyed(), true)
  assert.equal(fs.existsSync(path.join(profile, 'startup-inputs.json')), false)
  assert.equal(fs.readFileSync(path.join(profile, 'state.json'), 'utf8'), sentinel)
  console.log(JSON.stringify({ ok: true, root: process.env.TERN_SMOKE_APP_ROOT ? 'packaged' : 'source', fullscreen: false, windowed: true, noEngineBeforeContinue: true, scopedIpc: true, downloadProgress: 37, retry: true, installationError: true, preservedImport: true, ...metrics }))
}

app.whenReady().then(run).then(() => { Module._load = load; app.quit() }).catch((err) => {
  console.error(err.stack || err); Module._load = load; app.exit(1)
})
