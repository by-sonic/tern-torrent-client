'use strict'

// Real Chromium renderer with a mocked preload, isolated from the installed app.
// Run: node_modules/.bin/electron scripts/renderer-smoke.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { app, BrowserWindow, nativeTheme, session } = require('electron')
// Match the installed app's software-rendering path, not only Chromium's default.
app.disableHardwareAcceleration()

const ROOT = process.env.TERN_SMOKE_APP_ROOT || path.join(__dirname, '..')
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
  await evaluate(`
    const { A } = ternSmoke.ids
    ternSmoke.push({ id: A, state: 'checking', verification: { active: true, phase: 'full', checked: 25, total: 100, bytes: 25 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 } })
    document.querySelectorAll('#list .row')[0].click()
    await until(() => document.querySelector('#detail-pct').textContent === '25%')
    expect(document.querySelector('#detail-stats').textContent.includes('проверено'), 'Checking progress was labelled as downloaded data')
    expect(!document.querySelector('#detail-stats').textContent.includes('скачано'), 'Checked invalid pieces looked downloaded')
    ternSmoke.push({ id: A, state: 'checking', verification: { active: true, phase: 'full', checked: 80, total: 100, bytes: 80 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 } })
    await until(() => document.querySelector('#detail-pct').textContent === '80%')
    expect(document.querySelector('#list').textContent.includes('Проверено'), 'The list did not show checked byte counts')
    ternSmoke.push({ id: A, state: 'downloading', verification: null, progress: 0.2 })
    await until(() => document.querySelector('#detail-pct').textContent === '20%')
    expect(document.querySelector('#detail-stats').textContent.includes('скачано'), 'Download progress did not return after checking')
  `)

  await evaluate(`
    window.rowNamed = (name) => [...document.querySelectorAll('#list .row')].find(row => row.querySelector('.name').textContent === name)
    window.largeName = 'Large Linux image bundle (150 GB)'
    const { A } = ternSmoke.ids
    ternSmoke.push({ id: A, name: '<img src=x onerror=alert(1)>' })
    document.querySelector('#detail-remove').click()
    expect(document.querySelector('#dlg-remove').open, 'Removal did not open a confirmation dialog')
    expect(document.querySelector('#remove-name').textContent === '<img src=x onerror=alert(1)>', 'The torrent name was not displayed literally')
    expect(!document.querySelector('#remove-name img'), 'Torrent name was interpreted as HTML')
    expect(!document.querySelector('#remove-files').checked, 'Destructive checkbox was enabled by default')
    expect(document.activeElement.id === 'remove-cancel', 'Confirmation did not focus Cancel')
    document.querySelector('#remove-files').click()
    document.querySelector('#remove-cancel').click()
    expect(!document.querySelector('#dlg-remove').open, 'Cancel left the confirmation open')
    expect(ternSmoke.snapshot().calls.remove.length === 0, 'Cancel removed a torrent')
    ternSmoke.push({ id: A, name: largeName })
    document.querySelector('#detail-remove').click()
    expect(!document.querySelector('#remove-files').checked, 'Checkbox was not reset after a cancelled removal')
    document.querySelector('#dlg-remove').dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(!document.querySelector('#dlg-remove').open, 'Escape cancellation left the confirmation open')
    expect(ternSmoke.snapshot().calls.remove.length === 0, 'Escape removed a torrent')
  `)

  // Chromium may omit the native dialog top layer from a hidden-window capture.
  // Optional visual QA shows only this isolated fixture without taking focus.
  if (process.env.TERN_SMOKE_SCREENSHOT) win.showInactive()
  win.setSize(620, 480)
  await sleep(100)
  const removalGeometry = await evaluate(`
    const { A } = ternSmoke.ids
    ternSmoke.push({ id: A, name: largeName.repeat(24) })
    document.querySelector('#detail-remove').click()
    await new Promise(resolve => setTimeout(resolve, 200))
    const dialog = document.querySelector('#dlg-remove')
    const body = dialog.querySelector('.dlg-body')
    const rect = dialog.getBoundingClientRect()
    expect(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'Removal dialog overflowed the minimum app window')
    expect(body.scrollWidth <= body.clientWidth, 'Long torrent name overflowed the removal dialog horizontally')
    document.querySelector('#remove-confirm').scrollIntoView({ block: 'nearest' })
    const button = document.querySelector('#remove-confirm').getBoundingClientRect()
    expect(button.top >= rect.top && button.bottom <= rect.bottom, 'Removal buttons were clipped instead of reachable by scrolling')
    return { width: innerWidth, height: innerHeight, dialogWidth: rect.width, dialogHeight: rect.height }
  `)
  if (process.env.TERN_SMOKE_SCREENSHOT) {
    const screenshot = path.resolve(process.env.TERN_SMOKE_SCREENSHOT)
    const extension = path.extname(screenshot)
    const minimum = screenshot.slice(0, -extension.length) + '-minimum.png'
    fs.writeFileSync(minimum, (await win.webContents.capturePage()).toPNG())
  }
  await evaluate(`document.querySelector('#remove-cancel').click(); ternSmoke.push({ id: ternSmoke.ids.A, name: largeName })`)
  win.setSize(1440, 900)
  nativeTheme.themeSource = 'dark'
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  // Flush Chromium's rendering lifecycle so the hidden fixture delivers media-query changes.
  // matchMedia can already reflect the emulation while its change listener awaits a frame.
  await win.webContents.capturePage()
  await evaluate(`await until(() => document.documentElement.dataset.scheme === 'dark'); document.querySelector('#detail-remove').click()`)
  await sleep(200)
  if (process.env.TERN_SMOKE_SCREENSHOT) fs.writeFileSync(path.resolve(process.env.TERN_SMOKE_SCREENSHOT), (await win.webContents.capturePage()).toPNG())
  if (process.env.TERN_SMOKE_SCREENSHOT) win.hide()

  await evaluate(`
    const { A, B } = ternSmoke.ids
    document.querySelector('#remove-confirm').click()
    await until(() => !document.querySelector('#dlg-remove').open)
    const removed = ternSmoke.snapshot().calls.remove
    expect(removed.length === 1 && removed[0].id === A && removed[0].trash === false, 'Unchecked confirmation did not remove only the intended list entry')
    expect(!rowNamed(largeName), 'Removed torrent stayed in the list')
    ternSmoke.addTorrent(A, largeName)
    rowNamed(largeName).click()
    document.querySelector('#detail-remove').click()
    document.querySelector('#remove-files').click()
    rowNamed('Small image bundle').click()
    expect(document.querySelector('#remove-name').textContent === largeName, 'Changing selection changed the removal target name')
    ternSmoke.hold('remove', A)
    ternSmoke.removeResult({ removed: true, failed: 1, skipped: 1, sourceUnavailable: true, trashed: 2 })
    const before = ternSmoke.snapshot().calls.remove.length
    document.querySelector('#remove-confirm').click()
    document.querySelector('#remove-confirm').dispatchEvent(new Event('click'))
    await until(() => ternSmoke.snapshot().pending.remove.length === 1)
    const call = ternSmoke.snapshot().calls.remove[before]
    expect(call.id === A && call.trash === true, 'Confirmation removed the newly selected torrent instead of the captured target')
    expect(ternSmoke.snapshot().calls.remove.length === before + 1, 'Double confirmation sent multiple removals')
    expect(document.querySelector('#remove-files').disabled && document.querySelector('#remove-confirm').disabled && document.querySelector('#remove-cancel').disabled, 'Removal did not disable controls while busy')
    expect(document.querySelector('#remove-status').textContent.includes('корзину'), 'Removal did not show filesystem progress')
    document.querySelector('#dlg-remove').dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(document.querySelector('#dlg-remove').open, 'Escape closed an in-flight removal')
    ternSmoke.release('remove', ternSmoke.snapshot().pending.remove[0].serial)
    ternSmoke.unhold('remove', A)
    await until(() => !document.querySelector('#dlg-remove').open)
    expect(document.querySelector('#detail-name').textContent === 'Small image bundle', 'Completing a stale removal cleared the new selection')
    const warnings = document.querySelector('#toasts').textContent
    expect(warnings.includes('Не удалось удалить файлов: 1') && warnings.includes('Оставлено файлов') && warnings.includes('путь не сохранён'), 'Partial deletion result was silently discarded')
    document.querySelector('#detail-remove').click()
    expect(!document.querySelector('#remove-files').checked, 'Checkbox was not reset after completed removal')
    ternSmoke.removeResult({ error: true })
    document.querySelector('#remove-confirm').click()
    await until(() => !document.querySelector('#remove-confirm').disabled)
    expect(document.querySelector('#dlg-remove').open && document.querySelector('#remove-status').textContent.includes('Не удалось'), 'Failed removal did not remain visible for retry')
    expect(rowNamed('Small image bundle'), 'Failed removal erased the torrent from the list')
    document.querySelector('#remove-cancel').click()
  `)

  await evaluate(`
    const { C } = ternSmoke.ids
    ternSmoke.addTorrent(C, 'Metadata fixture', 'metadata')
    let before = ternSmoke.snapshot().calls.remove.length
    rowNamed('Metadata fixture').querySelector('.act').click()
    expect(document.querySelector('#dlg-remove').open, 'Metadata row bypassed removal confirmation')
    expect(ternSmoke.snapshot().calls.remove.length === before, 'Metadata row removed before confirmation')
    document.querySelector('#remove-confirm').click()
    await until(() => !rowNamed('Metadata fixture'))
    expect(ternSmoke.snapshot().calls.remove[before].trash === false, 'Metadata row enabled file deletion by default')
    ternSmoke.addTorrent(C, 'Choosing fixture', 'choosing')
    await until(() => document.querySelector('#dlg-pick').open)
    before = ternSmoke.snapshot().calls.remove.length
    rowNamed('Choosing fixture').querySelector('.act').click()
    expect(document.querySelector('#dlg-remove').open, 'Choosing row bypassed removal confirmation')
    document.querySelector('#remove-confirm').click()
    await until(() => !rowNamed('Choosing fixture') && !document.querySelector('#dlg-pick').open && !document.querySelector('#dlg-remove').open)
    expect(ternSmoke.snapshot().calls.remove[before].trash === false, 'Choosing row enabled file deletion by default')
    ternSmoke.addTorrent(C, 'Cancel import fixture', 'choosing')
    await until(() => document.querySelector('#dlg-pick').open)
    before = ternSmoke.snapshot().calls.remove.length
    document.querySelector('#pick-cancel').click()
    await until(() => !rowNamed('Cancel import fixture'))
    expect(!document.querySelector('#dlg-remove').open, 'Cancelling an unconfirmed import opened a second confirmation')
    expect(ternSmoke.snapshot().calls.remove[before].trash === false, 'Cancelling an import requested file deletion')
  `)
  console.log(JSON.stringify({ ok: true, root: process.env.TERN_SMOKE_APP_ROOT ? 'packaged' : 'source', burst, checks: ['large/small files cadence', 'state and tab refresh', 'A-B-A async response race', 'file selection stale-response and ordered-click races', 'refused last-file deselection', 'stable trackers/facts', 'theme and resize repaint', 'responsive layout', 'separate changing verification progress', 'removal confirmation, literal name, default unchecked, Cancel and Escape', 'minimum window removal dialog fit', 'unchecked preserves files and checked forwards true', 'removal target capture, busy and duplicate clicks', 'partial removal warnings and retry after error', 'metadata and choosing row confirmation, import cancellation'], geometry, removalGeometry }, null, 2))
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
