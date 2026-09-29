'use strict'

// Node's I/O thread pool (default 4 threads) is shared by file writes, DNS lookups and hashing.
// A few slow disk operations used to starve it, which also stalled tracker and peer lookups.
// Must be set before anything uses the pool.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16'

// The interface is light (lists, a few canvases). Software rendering removes the GPU process's
// ~100 MB of memory and its idle work, and needs no GPU acceleration to stay smooth. Must run before ready.
require('electron').app.disableHardwareAcceleration()

const path = require('node:path')
const {
  app, BrowserWindow, Menu, Tray, Notification, dialog, ipcMain, nativeImage, nativeTheme, shell, session
} = require('electron')
const { Engine } = require('./engine')
const { JsonStore } = require('./store')
const { classifyInput, extractLaunchInputs } = require('./input')
const { registerAsHandler } = require('./association')
const { Updater } = require('./updater')

const ROOT = path.join(__dirname, '..', '..')
const ICON = path.join(ROOT, 'assets', 'icon.png')
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png')
// Windows groups taskbar buttons and picks their icon by this id. It must match build.appId in package.json.
const APP_ID = 'io.github.bysonic.tern'
// A real .ico on disk (not inside the asar): the taskbar needs a file it can open.
const ICON_ICO = app.isPackaged ? path.join(process.resourcesPath, 'tern.ico') : path.join(ROOT, 'assets', 'icon.ico')
const THEME = {
  light: { bg: '#e9edf1', fg: '#0f1720' },
  dark: { bg: '#0a1017', fg: '#e6edf3' }
}
const TITLEBAR_HEIGHT = 44
const QUIT_FALLBACK_MS = 10_000

/** @type {BrowserWindow | null} */
let win = null
/** @type {Tray | null} */
let tray = null
/** @type {Engine | null} */
let engine = null
/** @type {Updater | null} */
let updater = null
let quitting = false
let lastState = null
let ready = false
/** Files and links that arrive while the engine is still starting. */
const pendingInputs = []
/** Folders the person picked in the native dialog: the only folders the UI may ask us to write to. */
const pickedDirs = new Set()

// Test hooks (development only): throwaway profile and download folder, and a log file.
if (!app.isPackaged) {
  if (process.env.TERN_USER_DATA) app.setPath('userData', process.env.TERN_USER_DATA)
  if (process.env.TERN_LOG) {
    const logFile = process.env.TERN_LOG
    const append = (chunk) => { try { require('node:fs').appendFileSync(logFile, String(chunk)) } catch { /* ignore */ } return true }
    process.stdout.write = append
    process.stderr.write = append
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const inputs = extractLaunchInputs(argv, workingDirectory)
    if (!ready) { pendingInputs.push(...inputs); return }
    showWindow()
    void openInputs(inputs)
  })
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('Tern could not start', String(err && err.stack ? err.stack : err))
    app.exit(1)
  })
}

async function start () {
  app.setAppUserModelId(APP_ID)
  lockDownSession()

  const userData = app.getPath('userData')
  engine = new Engine({
    stateStore: new JsonStore(path.join(userData, 'state.json'), () => ({ torrents: [], settings: {} })),
    torrentsDir: path.join(userData, 'torrents'),
    defaultDir: (!app.isPackaged && process.env.TERN_DOWNLOADS) || app.getPath('downloads'),
    trash: (target) => shell.trashItem(target)
  })
  engine.on('state', (state) => {
    lastState = state
    if (win && !win.isDestroyed()) win.webContents.send('state', state)
    updateTray({ down: state.speed.down, up: state.speed.up, active: state.torrents.filter((t) => t.state === 'downloading' || t.state === 'connecting').length })
  })
  engine.on('stats', updateTray) // window closed: only a few numbers for the tray tooltip
  engine.on('completed', ({ name }) => {
    if (!Notification.isSupported()) return
    const note = new Notification({ title: 'Загрузка завершена', body: name, icon: ICON, silent: false })
    note.on('click', showWindow)
    note.show()
  })
  await engine.init()
  applyLoginItem(engine.settings.launchAtLogin)

  createUpdater()
  registerIpc()
  createTray()
  // Started in the tray (login item): no window, so no renderer or GPU process until it is opened.
  if (!process.argv.includes('--hidden')) createWindow(true)
  ready = true
  await openInputs([...extractLaunchInputs(process.argv), ...pendingInputs.splice(0)])
}

function createUpdater () {
  // Updates exist only in the installed app: the feed (our GitHub Releases) is baked in at build time.
  const autoUpdater = app.isPackaged ? require('electron-updater').autoUpdater : null
  updater = new Updater(autoUpdater, { isAutomatic: () => engine.settings.autoUpdate })
  updater.on('state', (state) => send('update', state))
  updater.start()
}

/** The UI is local files only: no remote content, no permission prompts, no popups. */
function lockDownSession () {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function themeKey () { return nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }

function createWindow (show) {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    show: false,
    title: 'Tern',
    icon: process.platform === 'win32' ? ICON_ICO : ICON,
    backgroundColor: THEME[themeKey()].bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: THEME[themeKey()].bg, symbolColor: THEME[themeKey()].fg, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.setMenuBarVisibility(false)
  if (process.platform === 'win32') {
    // Pin the taskbar icon to our .ico explicitly; without this Windows can show Electron's default atom.
    win.setAppDetails({ appId: APP_ID, appIconPath: ICON_ICO, appIconIndex: 0 })
  }
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'))
  win.once('ready-to-show', () => { if (show) win.show() })
  // Closing to the tray really closes the window: the renderer and GPU processes exit and give their
  // memory back. Opening it again from the tray takes a fraction of a second. 'window-all-closed' decides
  // whether the app keeps running (tray) or quits.
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, syncObservation)
  win.on('closed', () => { win = null; syncObservation() })
  win.webContents.on('did-finish-load', () => { if (lastState) win.webContents.send('state', lastState) })
}

/** The engine builds list snapshots only while a visible, non-minimised window is watching. */
function syncObservation () {
  const watching = Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
  if (engine) engine.setObserved(watching)
}

nativeTheme.on('updated', () => {
  if (!win || win.isDestroyed()) return
  const t = THEME[themeKey()]
  win.setBackgroundColor(t.bg)
  win.setTitleBarOverlay({ color: t.bg, symbolColor: t.fg, height: TITLEBAR_HEIGHT })
})

function showWindow () {
  if (!win || win.isDestroyed()) createWindow(true)
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

// ---------------------------------------------------------------- tray

const formatRate = (bytes) => {
  if (bytes < 1024) return `${Math.round(bytes)} Б/с`
  const units = ['КБ/с', 'МБ/с', 'ГБ/с']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

function createTray () {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
  tray.setToolTip('Tern')
  tray.on('click', showWindow)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Tern', click: showWindow },
    { type: 'separator' },
    { label: 'Приостановить всё', click: () => engine.pauseAll() },
    { label: 'Продолжить всё', click: () => engine.resumeAll() },
    { type: 'separator' },
    { label: 'Выйти', click: quit }
  ]))
}

let trayLine = ''

/** @param {{down: number, up: number, active: number}} stats */
function updateTray ({ down, up, active }) {
  if (!tray) return
  const line = active ? `Tern · ↓ ${formatRate(down)} · ↑ ${formatRate(up)}` : 'Tern'
  if (line === trayLine) return // the native call is not free; skip it when nothing changed
  trayLine = line
  tray.setToolTip(line)
}

function quit () {
  quitting = true
  app.quit()
}

/** Save state and stop every torrent, once. Safe to call again while it is running. */
function stopEngine () {
  if (!engine) return Promise.resolve()
  if (!engine.stopping) {
    quitting = true
    engine.isShuttingDown = true
    engine.stopping = Promise.race([engine.shutdown(), new Promise((resolve) => setTimeout(resolve, 4000))])
      .catch((err) => console.error('[shutdown]', err))
  }
  return engine.stopping
}

app.on('before-quit', (event) => {
  if (!engine || engine.isShuttingDown) return
  event.preventDefault()
  stopEngine()
    .finally(() => {
      app.quit() // a normal quit lets 'quit' listeners run, such as the updater's install-on-quit
      // Last resort if quitting hangs. app.exit skips 'quit' listeners, so a pending update would be
      // lost: keep this generous.
      setTimeout(() => app.exit(0), QUIT_FALLBACK_MS)
    })
})

app.on('window-all-closed', () => {
  // With "close to tray" on we keep running in the tray; with it off, closing the window quits.
  if (!engine || !engine.settings.closeToTray) quit()
})

// ---------------------------------------------------------------- opening things

async function openInputs (inputs) {
  for (const input of inputs) {
    try {
      const result = await engine.add(input)
      if (result.duplicate) send('toast', { kind: 'info', key: 'duplicate' })
    } catch (err) {
      console.error('[add]', err.message)
      send('toast', { kind: 'error', key: 'badTorrent' })
    }
  }
}

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function applyLoginItem (enabled) {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] })
}

// ---------------------------------------------------------------- IPC

const isId = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v)
const MAX_ADD_AT_ONCE = 50

/** The UI may only point downloads at a folder the person chose in the native dialog (or the current default). */
function isAllowedDir (dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false
  const resolved = path.resolve(dir)
  return pickedDirs.has(resolved) || resolved === path.resolve(engine.settings.downloadDir)
}

function handle (channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('untrusted sender')
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}

function registerIpc () {
  handle('state:get', () => engine.snapshot())
  handle('add:text', async (text) => {
    const input = classifyInput(text)
    if (!input) throw new Error('not-a-torrent')
    await openInputs([input])
  })
  handle('add:paths', async (paths) => {
    if (!Array.isArray(paths) || paths.length > MAX_ADD_AT_ONCE) throw new Error('bad-args')
    await openInputs(paths.map(classifyInput).filter((i) => i && i.kind === 'file'))
  })
  handle('add:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Открыть .torrent',
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (!canceled) await openInputs(filePaths.map(classifyInput).filter(Boolean))
  })
  handle('folder:pick', async (current) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Папка для загрузок',
      defaultPath: typeof current === 'string' ? current : undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled) return null
    pickedDirs.add(path.resolve(filePaths[0]))
    return filePaths[0]
  })
  handle('torrent:confirm', (id, options) => {
    if (!isId(id) || !options) throw new Error('bad-args')
    const dir = typeof options.dir === 'string' ? options.dir : ''
    if (dir && !isAllowedDir(dir)) throw new Error('bad-dir')
    return engine.confirm(id, { selected: options.selected, dir })
  })
  handle('torrent:pause', (id) => isId(id) && engine.pause(id))
  handle('torrent:resume', (id) => isId(id) && engine.resume(id))
  handle('torrent:pause-all', () => engine.pauseAll())
  handle('torrent:resume-all', () => engine.resumeAll())
  handle('torrent:move', (id, where) => {
    if (!isId(id) || !['up', 'down', 'top'].includes(where)) throw new Error('bad-args')
    engine.move(id, where)
  })
  handle('torrent:remove', (id, trash) => isId(id) && engine.remove(id, { trash: trash === true }))
  handle('torrent:files', (id) => (isId(id) ? engine.files(id) : []))
  handle('torrent:info', (id) => (isId(id) ? engine.info(id) : null))
  handle('torrent:select', (id, selected) => {
    if (!isId(id)) throw new Error('bad-args')
    engine.setSelection(id, selected)
  })
  handle('torrent:reveal', (id) => {
    const target = isId(id) ? engine.contentPath(id) : null
    if (!target) throw new Error('no-path')
    shell.showItemInFolder(target)
  })
  handle('settings:set', (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('bad-args')
    if (patch.downloadDir !== undefined && !isAllowedDir(patch.downloadDir)) throw new Error('bad-dir')
    engine.setSettings(patch)
    updater.refresh()
    applyLoginItem(engine.settings.launchAtLogin)
  })
  handle('handler:register', () => registerAsHandler())
  handle('app:info', () => ({ version: app.getVersion(), update: updater.state }))
  handle('update:check', () => updater.check())
  handle('update:install', async () => {
    if (updater.state.status !== 'ready') throw new Error('no-update-ready')
    // stop torrents first: the installer starts immediately and must find no open files
    await stopEngine()
    updater.installNow()
  })
}
