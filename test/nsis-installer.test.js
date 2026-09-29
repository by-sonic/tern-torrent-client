'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { NsisUpdater } = require('electron-updater')
const { Updater } = require('../src/main/updater')
const { createNsisInstaller } = require('../src/main/nsis-installer')

const tick = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(2) } throw new Error('installer did not settle') }
function fixture (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-installer-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'Tern Setup.exe')
  // This dummy file is never executed: every test injects its own spawn.
  fs.writeFileSync(file, 'not an executable')
  const sha512 = Buffer.alloc(64).toString('base64')
  const helper = { file, downloadedFileInfo: { sha512, isAdminRightsRequired: false }, fileInfo: { info: { sha512 } }, versionInfo: { version: '1.2.0' }, packageFile: null }
  const updater = { installerPath: file, downloadedUpdateHelper: helper, quitAndInstallCalled: false, autoInstallOnAppQuit: false }
  return { dir, file, helper, updater }
}
function child () { const value = new EventEmitter(); value.unrefs = 0; value.unref = () => { value.unrefs++ }; value.kill = () => {}; return value }

test('only an OS spawn acknowledgement completes launch; fixed NSIS arguments preserve internal paths', async (t) => {
  const { dir, file, helper, updater } = fixture(t)
  updater.installDirectory = path.join(dir, 'Install folder')
  helper.packageFile = path.join(dir, 'package file.7z')
  fs.writeFileSync(helper.packageFile, 'fixture')
  let launched, command, args, options
  const adapter = createNsisInstaller(updater, { spawn: (...values) => {
    [command, args, options] = values; launched = child(); return launched
  } })
  let acknowledged = false
  const pending = adapter.launch({ version: '1.2.0' }).then(() => { acknowledged = true })
  await until(() => launched)
  assert.equal(acknowledged, false)
  assert.equal(updater.quitAndInstallCalled, false)
  assert.equal(command, file)
  assert.deepEqual(args, ['--updated', '/S', '--force-run', `/D=${updater.installDirectory}`, `--package-file=${helper.packageFile}`])
  assert.equal(options.shell, undefined)
  assert.equal(options.windowsHide, true)
  assert.equal(options.detached, true)
  launched.emit('spawn'); await pending
  assert.equal(acknowledged, true)
  assert.equal(updater.quitAndInstallCalled, true)
  assert.equal(launched.unrefs, 1)
})

test('invalid, missing, remote, elevated or mismatched installer contracts never reach spawn', async (t) => {
  const cases = [
    (u) => { u.installerPath = '\\\\server\\installer.exe'; u.downloadedUpdateHelper.file = u.installerPath },
    (u) => { u.installerPath = path.join(path.dirname(u.installerPath), 'missing.exe'); u.downloadedUpdateHelper.file = u.installerPath },
    (u) => { u.downloadedUpdateHelper.file = u.installerPath + '.changed' },
    (u) => { u.downloadedUpdateHelper.fileInfo.info.sha512 = 'wrong' },
    (u) => { u.downloadedUpdateHelper.versionInfo.version = 'another-version' },
    (u) => { u.downloadedUpdateHelper.downloadedFileInfo.isAdminRightsRequired = true },
    (u) => { u.installDirectory = 'relative-folder' },
    (u) => { u.installerPath = path.dirname(u.installerPath); u.downloadedUpdateHelper.file = u.installerPath }
  ]
  for (const mutate of cases) {
    const { updater } = fixture(t); let calls = 0
    mutate(updater)
    const adapter = createNsisInstaller(updater, { spawn: () => { calls++; throw new Error('must not launch') } })
    await assert.rejects(adapter.launch({ version: '1.2.0' }))
    assert.equal(calls, 0)
    assert.equal(updater.quitAndInstallCalled, false)
  }
  const { updater } = fixture(t)
  await assert.rejects(createNsisInstaller(updater, { updaterVersion: 'another-version' }).launch({ version: '1.2.0' }), /unsupported-update-installer/)
})

test('cancelled spawn cannot acknowledge an installation or poison the native quit flag', async (t) => {
  const { updater } = fixture(t)
  const abort = new AbortController()
  let launched
  const adapter = createNsisInstaller(updater, { spawn: (_file, _args, { signal }) => {
    launched = child()
    signal.addEventListener('abort', () => { const err = new Error('aborted'); err.code = 'ABORT_ERR'; launched.emit('error', err) }, { once: true })
    return launched
  } })
  const pending = adapter.launch({ signal: abort.signal, version: '1.2.0' })
  const rejected = assert.rejects(pending, /aborted/)
  await until(() => launched)
  abort.abort(); await rejected
  launched.emit('spawn')
  assert.equal(updater.quitAndInstallCalled, false)
  assert.equal(launched.unrefs, 0)
})

test('real NSIS schedules native quit before an async failure; startup adapter avoids that path and remains recoverable', async (t) => {
  const { helper } = fixture(t)
  const nativeElectron = new EventEmitter()
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename.endsWith(`${path.sep}BaseUpdater.js`)) return { autoUpdater: nativeElectron }
    return originalLoad.call(this, request, parent, isMain)
  }
  t.after(() => { Module._load = originalLoad })
  let nativeQuits = 0
  const legacy = new NsisUpdater(null, { version: '1.1.0', isPackaged: true, quit () { nativeQuits++ }, onQuit () {} })
  legacy.downloadedUpdateHelper = helper
  legacy.logger = null
  legacy.spawnLog = async () => { await delay(20); const err = new Error('native delayed spawn failure'); err.code = 'EPERM'; throw err }
  const oldState = new Updater(legacy, { isAutomatic: () => false })
  t.after(() => oldState.stop())
  oldState._set({ status: 'ready', version: '1.2.0' })
  oldState.installNow()
  await tick()
  assert.equal(nativeQuits, 1, 'the native implementation quits before async spawn rejection')
  assert.equal(oldState.state.status, 'installing')
  await delay(30)
  assert.equal(oldState.state.status, 'error')
  assert.equal(legacy.quitAndInstallCalled, true)

  let safeQuits = 0; let forbiddenCalls = 0
  const safeNative = new NsisUpdater(null, { version: '1.1.0', isPackaged: true, quit () { safeQuits++ }, onQuit () {} })
  safeNative.downloadedUpdateHelper = helper
  const nativeInstall = safeNative.quitAndInstall
  safeNative.quitAndInstall = (...args) => { forbiddenCalls++; return nativeInstall.apply(safeNative, args) }
  const adapter = createNsisInstaller(safeNative, { spawn: () => {
    const value = child()
    setTimeout(() => { const err = new Error('safe delayed spawn failure'); err.code = 'EPERM'; value.emit('error', err) }, 20)
    return value
  } })
  const safe = new Updater(safeNative, { isAutomatic: () => false, startupInstaller: adapter })
  t.after(() => safe.stop())
  safe.on('installer-started', () => { safeQuits++ })
  safe.beginStartup(); safe._set({ status: 'ready', version: '1.2.0' }); safe.installNow()
  await until(() => safe.state.status === 'error')
  assert.equal(safeQuits, 0)
  assert.equal(forbiddenCalls, 0)
  assert.equal(safeNative.quitAndInstallCalled, false)
  assert.match(safe.state.error, /safe delayed spawn failure/)
  // Retrying the same downloaded installer can succeed without the old flag.
  safe.startupInstaller = createNsisInstaller(safeNative, { spawn: () => { const value = child(); queueMicrotask(() => value.emit('spawn')); return value } })
  safe._set({ status: 'ready', version: '1.2.0' }); safe.installNow()
  await until(() => safeQuits === 1)
  assert.equal(forbiddenCalls, 0)
  assert.equal(safeNative.quitAndInstallCalled, true)
})
