'use strict'

// Real Chromium renderer with a mocked preload, isolated from the installed app.
// Run: node_modules/.bin/electron scripts/renderer-smoke.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { app, BrowserWindow, nativeTheme, session } = require('electron')

const ROOT = path.join(__dirname, '..')
const smokeData = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-renderer-smoke-'))
if (path.dirname(path.resolve(smokeData)) !== path.resolve(os.tmpdir()) || !path.basename(smokeData).startsWith('tern-renderer-smoke-')) throw new Error('Unexpected smoke profile path')
app.setPath('userData', smokeData)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let win

async function evaluate (code) {
  return win.webContents.executeJavaScript(`(async () => { ${code} })()`)
}

async function run () {
  // The real page has connect-src 'none'; also block network at the session level.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }))
  nativeTheme.themeSource = 'dark'
  win = new BrowserWindow({ width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, 'renderer-smoke-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'))
  await evaluate(`
    window.expect = (value, message) => { if (!value) throw new Error(message) }
    window.until = async (test) => {
      for (let i = 0; i < 100; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
      throw new Error('Timed out waiting for the renderer: ' + String(test) + '; ' + JSON.stringify({ scheme: document.documentElement.dataset.scheme, dark: matchMedia('(prefers-color-scheme: dark)').matches, hidden: document.hidden, width: innerWidth }))
    }
    await until(() => document.querySelectorAll('#detail-files input').length === 2)
    await new Promise(resolve => setTimeout(resolve, 100))
    window.smokeNow = performance.now()
    performance.now = () => window.smokeNow
    window.metrics = { mutations: 0, clears: 0 }
    window.smokeObserver = new MutationObserver(records => { metrics.mutations += records.length })
    smokeObserver.observe(document.querySelector('.app'), { subtree: true, childList: true, attributes: true, characterData: true })
    const clear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (...args) { metrics.clears += 1; return clear.apply(this, args) }
  `)

  const burst = await evaluate(`
    const before = ternSmoke.snapshot().calls.files.length
    metrics.mutations = 0; metrics.clears = 0
    for (let i = 0; i < 200; i++) ternSmoke.push()
    await Promise.resolve()
    expect(ternSmoke.snapshot().calls.files.length === before, 'Rapid state pushes requested Files repeatedly')
    expect(metrics.mutations === 0, 'Unchanged state mutated the DOM: ' + metrics.mutations)
    expect(metrics.clears <= 1, 'Unchanged piece canvases repainted: ' + metrics.clears)
    return { snapshots: 200, filesRequests: 0, mutations: metrics.mutations, canvasClears: metrics.clears }
  `)

  await evaluate(`
    const { A, B } = ternSmoke.ids
    const before = ternSmoke.snapshot().calls.files.length
    smokeNow += 3100; ternSmoke.push()
    await Promise.resolve()
    expect(ternSmoke.snapshot().calls.files.length === before, 'Large torrent refreshed sooner than its 5s cadence')
    smokeNow += 2000; ternSmoke.progress(A, 0.6); ternSmoke.push()
    await until(() => document.querySelector('#detail-files .file-bar > i').style.getPropertyValue('--p') === '0.6')
    expect(ternSmoke.snapshot().calls.files.length === before + 1, 'Large torrent did not refresh at 5s')
    document.querySelectorAll('#list .row')[1].click()
    await until(() => document.querySelectorAll('#detail-files input').length === 3)
    const smallBefore = ternSmoke.snapshot().calls.files.length
    smokeNow += 3100; ternSmoke.push()
    await until(() => ternSmoke.snapshot().calls.files.length === smallBefore + 1)
    document.querySelectorAll('#list .row')[0].click()
    await until(() => document.querySelectorAll('#detail-files input').length === 2)
    const transitionBefore = ternSmoke.snapshot().calls.files.length
    ternSmoke.push({ id: A, state: 'done', progress: 1 })
    await until(() => ternSmoke.snapshot().calls.files.length === transitionBefore + 1)
    ternSmoke.push({ id: A, state: 'downloading', progress: 0.5 })
    await until(() => ternSmoke.snapshot().calls.files.length === transitionBefore + 2)
  `)

  // A -> B -> A before two delayed responses resolve. ID alone is insufficient.
  await evaluate(`
    const { A } = ternSmoke.ids
    ternSmoke.hold('files', A); ternSmoke.hold('info', A)
    document.querySelectorAll('#list .row')[1].click()
    await until(() => document.querySelectorAll('#detail-files input').length === 3)
    ternSmoke.progress(A, 0.2)
    document.querySelectorAll('#list .row')[0].click()
    await until(() => ternSmoke.snapshot().pending.files.length === 1)
    const old = ternSmoke.snapshot().pending.files[0].serial
    const oldInfo = ternSmoke.snapshot().pending.info[0].serial
    document.querySelectorAll('#list .row')[1].click()
    await until(() => document.querySelectorAll('#detail-files input').length === 3)
    ternSmoke.progress(A, 0.8)
    document.querySelectorAll('#list .row')[0].click()
    await until(() => ternSmoke.snapshot().pending.files.length === 2)
    const fresh = ternSmoke.snapshot().pending.files[1].serial
    const freshInfo = ternSmoke.snapshot().pending.info[1].serial
    ternSmoke.release('files', fresh); ternSmoke.release('info', freshInfo)
    await until(() => document.querySelectorAll('#detail-files input').length === 2)
    expect(document.querySelector('#detail-files .file-bar > i').style.getPropertyValue('--p') === '0.8', 'Newest files result was not displayed')
    ternSmoke.release('files', old); ternSmoke.release('info', oldInfo)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.querySelector('#detail-files .file-bar > i').style.getPropertyValue('--p') === '0.8', 'Old A response overwrote newly selected A')
    ternSmoke.unhold('files', A); ternSmoke.unhold('info', A)
  `)

  await evaluate(`
    const { A } = ternSmoke.ids
    ternSmoke.hold('files', A)
    document.querySelector('[data-tab="trackers"]').click()
    document.querySelector('[data-tab="files"]').click()
    await until(() => ternSmoke.snapshot().pending.files.length === 1)
    const stale = ternSmoke.snapshot().pending.files[0].serial
    ternSmoke.hold('select', A)
    const boxes = document.querySelectorAll('#detail-files input')
    boxes[0].click()
    await until(() => ternSmoke.snapshot().pending.select.length === 1)
    ternSmoke.release('files', stale)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(!boxes[0].checked, 'Stale files progress overwrote an in-flight selection')
    ternSmoke.unhold('files', A)
    const before = ternSmoke.snapshot().calls.files.length
    ternSmoke.release('select', ternSmoke.snapshot().pending.select[0].serial)
    await until(() => ternSmoke.snapshot().calls.files.length === before + 1 && !boxes[0].dataset.busy)
    expect(!boxes[0].checked, 'Committed selection was not displayed')
    const selectedBefore = ternSmoke.snapshot().calls.select.length
    boxes[1].click()
    await until(() => !boxes[1].dataset.busy)
    expect(boxes[1].checked, 'Refusing to uncheck the last file left the checkbox wrong')
    expect(ternSmoke.snapshot().calls.select.length === selectedBefore, 'Empty file selection reached the engine')
    // Repeated clicks on one checkbox must preserve their order.
    boxes[0].click()
    await until(() => ternSmoke.snapshot().pending.select.length === 1)
    boxes[0].click()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ternSmoke.snapshot().pending.select.length === 1, 'Selection writes were sent concurrently')
    ternSmoke.release('select', ternSmoke.snapshot().pending.select[0].serial)
    await until(() => ternSmoke.snapshot().pending.select.length === 1)
    expect(!boxes[0].checked && boxes[0].dataset.busy, 'First selection acknowledgement erased the later click')
    ternSmoke.unhold('select', A)
    ternSmoke.release('select', ternSmoke.snapshot().pending.select[0].serial)
    await until(() => !boxes[0].dataset.busy)
    expect(!boxes[0].checked, 'Last click was not retained after ordered selections')
  `)

  await evaluate(`
    document.querySelector('[data-tab="trackers"]').click()
    const tracker = document.querySelector('#detail-trackers').firstChild
    const before = ternSmoke.snapshot().calls.files.length
    metrics.mutations = 0
    for (let i = 0; i < 30; i++) { smokeNow += 1000; ternSmoke.push() }
    await Promise.resolve()
    expect(document.querySelector('#detail-trackers').firstChild === tracker, 'Unchanged tracker nodes were rebuilt')
    expect(ternSmoke.snapshot().calls.files.length === before, 'Hidden Files tab kept querying progress')
    document.querySelector('[data-tab="info"]').click()
    const fact = document.querySelector('#detail-facts').firstChild
    await Promise.resolve()
    metrics.mutations = 0
    for (let i = 0; i < 30; i++) ternSmoke.push()
    await Promise.resolve()
    expect(document.querySelector('#detail-facts').firstChild === fact, 'Unchanged facts were rebuilt')
    expect(metrics.mutations === 0, 'Unchanged details state mutated DOM: ' + metrics.mutations)
    document.querySelector('[data-tab="files"]').click()
    await until(() => ternSmoke.snapshot().calls.files.length === before + 1)
    metrics.clears = 0
  `)

  nativeTheme.themeSource = 'light'
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await win.webContents.capturePage()
  await evaluate(`
    await until(() => document.documentElement.dataset.scheme === 'light')
    expect(metrics.clears > 0, 'Changing theme did not repaint canvases')
    const before = metrics.clears
    window.smokeResizeBefore = before
  `)
  win.setSize(1120, 760)
  await evaluate(`await until(() => metrics.clears > smokeResizeBefore)`)
  win.setSize(900, 700)
  await sleep(100)
  const geometry = await evaluate(`
    const width = document.documentElement.clientWidth
    expect(document.documentElement.scrollWidth <= width, 'Responsive layout overflowed the window')
    expect(getComputedStyle(document.querySelector('#mosaic')).display === 'none', 'Narrow layout did not hide mosaic')
    return { width, scrollWidth: document.documentElement.scrollWidth }
  `)
  assert.equal(geometry.width, geometry.scrollWidth)
  console.log(JSON.stringify({ ok: true, burst, checks: ['large/small files cadence', 'state and tab refresh', 'A-B-A async response race', 'file selection stale-response and ordered-click races', 'refused last-file deselection', 'stable trackers/facts', 'theme and resize repaint', 'responsive layout'], geometry }, null, 2))
}

app.whenReady().then(run).then(() => { win.destroy(); app.quit() }).catch((err) => {
  console.error(err)
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(1)
})

app.on('quit', () => {
  // Delete only the exact directory created above, after Electron has closed it.
  try { fs.rmSync(smokeData, { recursive: true, force: true }) } catch { /* Windows may release Chromium files a little later. */ }
})
