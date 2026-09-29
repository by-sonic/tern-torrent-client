'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Updater } = require('../src/main/updater')

const tick = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function token () { return { cancelled: false, cancel () { this.cancelled = true } } }
function available (cancellationToken = token()) { return { isUpdateAvailable: true, updateInfo: { version: '1.2.0' }, cancellationToken } }
function fakeAutoUpdater ({ onCheck, onDownload, onInstall } = {}) {
  const fake = new EventEmitter()
  fake.checks = 0; fake.downloads = 0; fake.installed = null; fake.installOnDownloaded = null
  fake.checkForUpdates = async () => { fake.checks += 1; return onCheck ? onCheck(fake) : { isUpdateAvailable: false } }
  fake.downloadUpdate = async (cancel) => {
    fake.downloads += 1
    if (onDownload) await onDownload(fake, cancel)
    else fake.emit('update-downloaded', { version: '1.2.0' })
    // BaseUpdater adds its quit handler after dispatching update-downloaded.
    fake.installOnDownloaded = fake.autoInstallOnAppQuit
    return ['installer.exe']
  }
  fake.quitAndInstall = (silent, forceRun) => { fake.installed = { silent, forceRun }; if (onInstall) onInstall(fake) }
  return fake
}
function make (t, fake, options = {}) {
  const updater = new Updater(fake, { isAutomatic: () => true, startupInstaller: {
    async launch () { fake.installed = { silent: true, forceRun: true } }
  }, ...options })
  t.after(() => updater.stop())
  return updater
}

test('unpackaged startup remains disabled without network or installation', async (t) => {
  const updater = make(t, null)
  updater.beginStartup()
  assert.equal((await updater.check()).status, 'disabled')
  assert.throws(() => updater.installNow(), /no-update-ready/)
})

test('pins safe updater policy and downloads only after an explicit check', (t) => {
  const fake = fakeAutoUpdater()
  make(t, fake)
  assert.equal(fake.autoDownload, false)
  assert.equal(fake.autoInstallOnAppQuit, true)
  assert.equal(fake.allowPrerelease, false)
  assert.equal(fake.allowDowngrade, false)
  assert.equal(fake.downloads, 0)
})

test('checks, awaits download, reports progress, then installs silently with restart', async (t) => {
  const gate = deferred()
  const fake = fakeAutoUpdater({ onCheck: () => available(), onDownload: async (f) => {
    f.emit('download-progress', { percent: 42.4, transferred: 42, total: 100, bytesPerSecond: 20 })
    await gate.promise
    f.emit('update-downloaded', { version: '1.2.0' })
  } })
  const updater = make(t, fake)
  const seen = []; updater.on('state', (s) => seen.push(s.status))
  let settled = false
  const checking = updater.check().then((state) => { settled = true; return state })
  await tick()
  assert.equal(settled, false)
  assert.equal(updater.state.status, 'downloading')
  assert.equal(updater.state.percent, 42)
  assert.equal(updater.state.transferred, 42)
  gate.resolve()
  await checking
  assert.deepEqual(seen, ['checking', 'downloading', 'downloading', 'ready'])
  assert.equal(fake.installOnDownloaded, true)
  updater.installNow()
  assert.deepEqual(fake.installed, { silent: true, forceRun: true })
  assert.equal(updater.state.status, 'installing')
})

test('no new version becomes idle with a check timestamp', async (t) => {
  const updater = make(t, fakeAutoUpdater())
  assert.equal((await updater.check()).status, 'idle')
  assert.ok(updater.state.checkedAt > 0)
})

test('network rejection is a recoverable bounded error', async (t) => {
  const updater = make(t, fakeAutoUpdater({ onCheck: () => { throw new Error('ENOTFOUND ' + 'x'.repeat(1000)) } }))
  const state = await updater.check()
  assert.equal(state.status, 'error')
  assert.match(state.error, /ENOTFOUND/)
  assert.equal(state.error.length, 300)
})

test('one in-flight check is shared and a ready update is never redownloaded', async (t) => {
  const gate = deferred()
  const fake = fakeAutoUpdater({ onCheck: async () => { await gate.promise; return available() } })
  const updater = make(t, fake)
  const first = updater.check()
  assert.equal(updater.check(), first)
  assert.equal(fake.checks, 1)
  gate.resolve(); await first; await updater.check()
  assert.equal(fake.checks, 1)
  assert.equal(fake.downloads, 1)
})

test('startup checks ignore the background setting but never arm install-on-quit', async (t) => {
  const fake = fakeAutoUpdater({ onCheck: () => available() })
  const updater = make(t, fake, { isAutomatic: () => false })
  updater.beginStartup()
  await updater.check()
  assert.equal(fake.downloads, 1)
  assert.equal(fake.installOnDownloaded, false)
  assert.equal(fake.autoInstallOnAppQuit, false)
  updater.installNow()
  assert.ok(fake.installed)
})

test('a timed-out metadata response cannot start a late download', async (t) => {
  const gate = deferred(); const cancel = token()
  const fake = fakeAutoUpdater({ onCheck: () => gate.promise })
  const updater = make(t, fake, { checkTimeoutMs: 10 })
  updater.beginStartup()
  assert.equal((await updater.check()).error, 'update-check-timeout')
  updater.finishStartup()
  gate.resolve(available(cancel)); await tick()
  assert.equal(fake.downloads, 0)
  assert.equal(cancel.cancelled, false, 'an abandoned metadata token may also belong to a coalesced Retry')
  assert.equal(updater.state.status, 'error')
})

test('stalled download is cancelled and late events cannot install on quit', async (t) => {
  const gate = deferred(); const cancel = token()
  const fake = fakeAutoUpdater({ onCheck: () => available(cancel), onDownload: async (f) => {
    await gate.promise
    f.emit('download-progress', { percent: 99 })
    f.emit('update-downloaded', { version: '1.2.0' })
  } })
  const updater = make(t, fake, { downloadIdleTimeoutMs: 10 })
  updater.beginStartup()
  assert.equal((await updater.check()).error, 'update-download-timeout')
  assert.equal(cancel.cancelled, true)
  updater.finishStartup()
  assert.equal(fake.autoInstallOnAppQuit, false)
  gate.resolve(); await tick()
  assert.equal(fake.installOnDownloaded, false)
  assert.equal(updater.state.status, 'error')
  assert.equal(fake.installed, null)
})

test('Retry can reuse a coalesced metadata result without the abandoned check cancelling its token', async (t) => {
  const gate = deferred(); const shared = token()
  const fake = fakeAutoUpdater({ onCheck: () => gate.promise, onDownload: (f, cancel) => {
    if (cancel.cancelled) throw new Error('retry token cancelled')
    f.emit('update-downloaded', { version: '1.2.0' })
  } })
  const updater = make(t, fake, { checkTimeoutMs: 20 })
  updater.beginStartup()
  assert.equal((await updater.check()).error, 'update-check-timeout')
  const retry = updater.check()
  gate.resolve(available(shared))
  assert.equal((await retry).status, 'ready')
  assert.equal(shared.cancelled, false)
  assert.equal(fake.downloads, 1)
})

test('startup waits for confirmed spawn and ignores a cancelled install acknowledgement', async (t) => {
  const gate = deferred(); let started = 0; let nativeCalls = 0
  const fake = fakeAutoUpdater({ onCheck: () => available(), onInstall: () => { nativeCalls++ } })
  const updater = make(t, fake, { startupInstaller: { launch: () => gate.promise } })
  updater.on('installer-started', () => { started++ })
  updater.beginStartup(); await updater.check(); updater.installNow()
  await tick()
  assert.equal(nativeCalls, 0)
  assert.equal(started, 0)
  gate.resolve(); await tick()
  assert.equal(started, 1)
  const cancelled = deferred()
  const other = make(t, fakeAutoUpdater({ onCheck: () => available() }), { startupInstaller: { launch: () => cancelled.promise } })
  other.on('installer-started', () => { started++ })
  other.beginStartup(); await other.check(); other.installNow(); other.cancelInstall()
  cancelled.resolve(); await tick()
  assert.equal(started, 1)
})

test('download progress renews its idle deadline', async (t) => {
  const fake = fakeAutoUpdater({ onCheck: () => available(), onDownload: async (f) => {
    for (let i = 0; i < 4; i++) { await delay(8); f.emit('download-progress', { percent: i * 20 }) }
    f.emit('update-downloaded', { version: '1.2.0' })
  } })
  const updater = make(t, fake, { downloadIdleTimeoutMs: 24 })
  assert.equal((await updater.check()).status, 'ready')
})

test('cancelled downloads drain before a retry takes event ownership', async (t) => {
  const gate = deferred(); const firstToken = token(); let attempt = 0
  const fake = fakeAutoUpdater({ onCheck: () => available(attempt++ === 0 ? firstToken : token()), onDownload: async (f) => {
    if (f.downloads === 1) await gate.promise
    f.emit('update-downloaded', { version: '1.2.0' })
  } })
  const updater = make(t, fake, { downloadIdleTimeoutMs: 10, checkTimeoutMs: 100 })
  updater.beginStartup()
  await updater.check()
  const retry = updater.check()
  await tick()
  assert.equal(fake.checks, 1)
  gate.resolve()
  assert.equal((await retry).status, 'ready')
  assert.equal(fake.downloads, 2)
  assert.equal(fake.installOnDownloaded, false)
})

test('installer errors and failure to quit return to a visible error', async (t) => {
  const fake = fakeAutoUpdater({ onCheck: () => available(), onInstall: (f) => f.emit('error', new Error('installer denied')) })
  const updater = make(t, fake)
  await updater.check(); updater.installNow()
  assert.equal(updater.state.status, 'error')
  assert.equal(updater.state.error, 'installer denied')
  const stalled = make(t, fakeAutoUpdater({ onCheck: () => available() }), { installTimeoutMs: 10 })
  await stalled.check(); stalled.installNow(); await delay(20)
  assert.equal(stalled.state.error, 'update-install-timeout')
})

test('background schedule and changed setting retain their existing behavior', async (t) => {
  const fake = fakeAutoUpdater(); let automatic = false
  const updater = make(t, fake, { isAutomatic: () => automatic })
  updater._auto(); await tick(); assert.equal(fake.checks, 0)
  automatic = true; updater.refresh(); updater._auto(); await tick()
  assert.equal(fake.checks, 1)
  assert.equal(fake.autoInstallOnAppQuit, true)
  automatic = false; updater.refresh(); assert.equal(fake.autoInstallOnAppQuit, false)
  assert.throws(() => updater.installNow(), /no-update-ready/)
})
