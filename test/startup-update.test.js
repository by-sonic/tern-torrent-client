'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Updater } = require('../src/main/updater')
const { StartupUpdate, cleanStartupInputs, saveStartupInputs, readStartupInputs, clearStartupInputs, MAX_STARTUP_INPUTS, MAX_JOURNAL_BYTES, JOURNAL_MAX_AGE_MS } = require('../src/main/startup-update')

const tick = () => new Promise((resolve) => setImmediate(resolve))
const until = async (test) => { for (let i = 0; i < 100; i++) { if (test()) return; await new Promise((resolve) => setTimeout(resolve, 2)) } throw new Error('startup state did not settle') }
function backend ({ check, download, install } = {}) {
  const value = new EventEmitter()
  value.checks = value.downloads = value.installs = 0
  value.checkForUpdates = async () => { value.checks += 1; return check ? check(value) : { isUpdateAvailable: false } }
  value.downloadUpdate = async () => { value.downloads += 1; if (download) await download(value); else value.emit('update-downloaded', { version: '1.2.0' }); return ['installer.exe'] }
  value.quitAndInstall = () => { value.installs += 1; if (install) install(value) }
  value.launchInstaller = async () => { value.installs += 1; if (install) return install(value) }
  return value
}
const newVersion = () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' }, cancellationToken: { cancel () {} } })
function create (t, fake, options = {}) {
  const updater = new Updater(fake, { isAutomatic: () => false, startupInstaller: { launch: () => fake.launchInstaller() }, checkTimeoutMs: 100, downloadIdleTimeoutMs: 100, installTimeoutMs: 100 })
  const startup = new StartupUpdate(updater, { version: '1.0.0', installDelayMs: 0, ...options })
  t.after(() => { startup.close(); updater.stop() })
  return { updater, startup }
}

test('latest version opens the app only after the startup check settles', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fake = backend({ check: async () => { await gate; return { isUpdateAvailable: false } } })
  const { startup } = create(t, fake)
  let launched = false
  const result = startup.run().then((outcome) => { launched = outcome === 'launch'; return outcome })
  await tick()
  assert.equal(launched, false)
  assert.equal(startup.state.status, 'checking')
  assert.equal(startup.continue(), false)
  release()
  assert.equal(await result, 'launch')
  assert.equal(startup.state.status, 'starting')
})

test('new version waits for the complete download and presents installation before invoking it', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve })
  let persisted = false
  const fake = backend({ check: newVersion, download: async (f) => { await gate; f.emit('update-downloaded', { version: '1.2.0' }) }, install: () => assert.equal(persisted, true) })
  const { startup } = create(t, fake, { beforeInstall: async () => { assert.equal(startup.state.status, 'installing'); persisted = true } })
  let outcome = null
  startup.run().then((value) => { outcome = value })
  await until(() => startup.state.status === 'downloading')
  assert.equal(fake.installs, 0)
  assert.equal(outcome, null)
  release()
  await until(() => fake.installs === 1)
  assert.equal(startup.state.status, 'installing')
  assert.equal(outcome, null)
  assert.equal(fake.autoInstallOnAppQuit, false)
})

test('offline error waits for an explicit launch and retry can recover', async (t) => {
  const fake = backend({ check: (f) => { if (f.checks === 1) throw new Error('offline'); return { isUpdateAvailable: false } } })
  const { startup } = create(t, fake)
  const result = startup.run()
  await until(() => startup.state.status === 'error')
  assert.equal(startup.done, false)
  assert.equal(startup.retry(), true)
  assert.equal(startup.retry(), false)
  assert.equal(await result, 'launch')
  assert.equal(fake.checks, 2)
  const { startup: offline } = create(t, backend({ check: () => { throw new Error('offline') } }))
  const continued = offline.run()
  await until(() => offline.state.status === 'error')
  assert.equal(offline.continue(), true)
  assert.equal(await continued, 'launch')
  assert.equal(offline.continue(), false)
})

test('closing before run is a clean quit and does not start any check', async (t) => {
  const fake = backend()
  const { startup } = create(t, fake)
  startup.close()
  assert.equal(await startup.run(), 'quit')
  assert.equal(fake.checks, 0)
})

test('closing a download or the paint interval prevents a late installation', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve })
  const fake = backend({ check: newVersion, download: async (f) => { await gate; f.emit('update-downloaded', { version: '1.2.0' }) } })
  const { startup } = create(t, fake)
  const result = startup.run()
  await until(() => startup.state.status === 'downloading')
  startup.close(); assert.equal(await result, 'quit')
  release(); await tick(); assert.equal(fake.installs, 0)
  const other = backend({ check: newVersion })
  const { startup: painting } = create(t, other, { installDelayMs: 40 })
  const painted = painting.run()
  await until(() => painting.state.status === 'installing')
  painting.close(); assert.equal(await painted, 'quit')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(other.installs, 0)
})

test('failed input persistence or installer returns an error with launch available', async (t) => {
  const fake = backend({ check: newVersion })
  const { startup } = create(t, fake, { beforeInstall: async () => { throw new Error('journal denied') } })
  const result = startup.run()
  await until(() => startup.state.status === 'error')
  assert.equal(startup.state.error, 'journal denied')
  assert.equal(fake.installs, 0)
  startup.continue(); assert.equal(await result, 'launch')
  const denied = backend({ check: newVersion, install: () => { throw new Error('installer denied') } })
  const { startup: installError } = create(t, denied)
  const failed = installError.run()
  await until(() => installError.state.status === 'error')
  assert.equal(installError.state.error, 'installer denied')
  assert.equal(installError.continue(), true)
  assert.equal(await failed, 'launch')
})

test('input journal preserves bounded validated imports and never rewrites torrent state', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-startup-journal-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = Buffer.from('{"version":1,"torrents":[{"sentinel":"unchanged"}]}')
  fs.writeFileSync(path.join(dir, 'state.json'), state)
  const hash = 'a'.repeat(40)
  const torrentFile = path.join(dir, 'fixture.torrent')
  saveStartupInputs(dir, [hash, hash, { kind: 'file', path: torrentFile }, '\\\\server\\untrusted.torrent', { kind: 'magnet', uri: 'https://example.com' }], true)
  assert.deepEqual(readStartupInputs(dir), { hidden: true, inputs: [{ kind: 'magnet', uri: `magnet:?xt=urn:btih:${hash}` }, { kind: 'file', path: torrentFile }] })
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), state)
  assert.equal(cleanStartupInputs(Array.from({ length: MAX_STARTUP_INPUTS + 100 }, (_, i) => i.toString(16).padStart(40, '0'))).length, MAX_STARTUP_INPUTS)
  clearStartupInputs(dir); assert.deepEqual(readStartupInputs(dir), { inputs: [], hidden: false })
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), state)
})

test('corrupt, oversized and stale input journals cannot import arbitrary data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-startup-journal-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'startup-inputs.json')
  for (const data of ['{', 'x'.repeat(MAX_JOURNAL_BYTES + 1), JSON.stringify({ version: 1, savedAt: Date.now() - JOURNAL_MAX_AGE_MS - 1000, inputs: ['b'.repeat(40)] }), JSON.stringify({ version: 9, savedAt: Date.now(), inputs: ['b'.repeat(40)] })]) {
    fs.writeFileSync(file, data)
    assert.deepEqual(readStartupInputs(dir), { inputs: [], hidden: false })
  }
})
