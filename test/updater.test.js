'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Updater } = require('../src/main/updater')

/** A stand-in for electron-updater's autoUpdater. */
function fakeAutoUpdater ({ onCheck } = {}) {
  const fake = new EventEmitter()
  fake.checks = 0
  fake.installed = null
  fake.checkForUpdates = async () => { fake.checks += 1; if (onCheck) await onCheck(fake) }
  fake.quitAndInstall = (silent, forceRun) => { fake.installed = { silent, forceRun } }
  return fake
}

test('is disabled and does nothing when not packaged', async () => {
  const updater = new Updater(null, { isAutomatic: () => true })
  assert.equal(updater.state.status, 'disabled')
  await updater.check()
  assert.equal(updater.state.status, 'disabled')
  assert.throws(() => updater.installNow(), /no-update-ready/)
})

test('configures the updater safely', () => {
  const fake = fakeAutoUpdater()
  new Updater(fake, { isAutomatic: () => true }) // eslint-disable-line no-new
  assert.equal(fake.autoDownload, true)
  assert.equal(fake.autoInstallOnAppQuit, true)
  assert.equal(fake.allowPrerelease, false)
  assert.equal(fake.allowDowngrade, false)
})

test('walks checking → downloading → ready and installs silently, then restarts the app', async () => {
  const fake = fakeAutoUpdater({
    onCheck: async (f) => {
      f.emit('checking-for-update')
      f.emit('update-available', { version: '1.2.0' })
      f.emit('download-progress', { percent: 42.4 })
      f.emit('update-downloaded', { version: '1.2.0' })
    }
  })
  const updater = new Updater(fake, { isAutomatic: () => true })
  const seen = []
  updater.on('state', (s) => seen.push(s.status))

  await updater.check()
  assert.deepEqual(seen, ['checking', 'downloading', 'downloading', 'ready'])
  assert.equal(updater.state.version, '1.2.0')
  assert.equal(updater.state.percent, 100)

  updater.installNow()
  assert.deepEqual(fake.installed, { silent: true, forceRun: true })
})

test('goes back to idle with a timestamp when there is no update', async () => {
  const fake = fakeAutoUpdater({ onCheck: async (f) => { f.emit('checking-for-update'); f.emit('update-not-available', {}) } })
  const updater = new Updater(fake, { isAutomatic: () => true })
  await updater.check()
  assert.equal(updater.state.status, 'idle')
  assert.ok(updater.state.checkedAt > 0)
})

test('a failing check becomes an error state instead of throwing', async () => {
  const fake = fakeAutoUpdater({ onCheck: async () => { throw new Error('getaddrinfo ENOTFOUND github.com') } })
  const updater = new Updater(fake, { isAutomatic: () => true })
  const state = await updater.check()
  assert.equal(state.status, 'error')
  assert.match(state.error, /ENOTFOUND/)
})

test('error events are truncated and do not leak long text', () => {
  const fake = fakeAutoUpdater()
  const updater = new Updater(fake, { isAutomatic: () => true })
  fake.emit('error', new Error('x'.repeat(1000)))
  assert.equal(updater.state.error.length, 300)
})

test('does not start a second check while one is running or an update is ready', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fake = fakeAutoUpdater({ onCheck: async (f) => { f.emit('checking-for-update'); await gate } })
  const updater = new Updater(fake, { isAutomatic: () => true })
  const first = updater.check()
  await updater.check()
  assert.equal(fake.checks, 1)
  release()
  await first
  fake.emit('update-downloaded', { version: '2.0.0' })
  await updater.check()
  assert.equal(fake.checks, 1)
})

test('a downloaded update is not installed on quit when automatic updates are off', () => {
  const fake = fakeAutoUpdater()
  let automatic = true
  const updater = new Updater(fake, { isAutomatic: () => automatic })
  assert.equal(fake.autoInstallOnAppQuit, true)
  automatic = false
  updater.refresh()
  assert.equal(fake.autoInstallOnAppQuit, false)
})

test('installNow refuses until an update is downloaded', () => {
  const updater = new Updater(fakeAutoUpdater(), { isAutomatic: () => true })
  assert.throws(() => updater.installNow(), /no-update-ready/)
})

test('the automatic schedule respects the setting', async () => {
  const fake = fakeAutoUpdater()
  let automatic = false
  const updater = new Updater(fake, { isAutomatic: () => automatic })
  updater._auto()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.checks, 0)
  automatic = true
  updater._auto()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.checks, 1)
})
