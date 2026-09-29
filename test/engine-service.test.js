'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { EngineService, MAX_PENDING } = require('../src/main/engine-service')

class FakeChild extends EventEmitter {
  constructor () { super(); this.messages = []; this.killed = false }
  postMessage (message) { this.messages.push(message); if (this.reply) this.reply(message) }
  kill () { this.killed = true; this.emit('exit', 0) }
  result (message, value, settings) { this.emit('message', { type: 'result', id: message.id, ok: true, value, settings }) }
}

function makeService (options = {}) {
  const child = new FakeChild()
  const service = new EngineService({ userData: path.join(os.tmpdir(), 'tern-service-profile'), defaultDir: os.tmpdir(), trash: async () => {}, fork: () => child, ...options })
  const initial = { torrents: [{ id: 'a'.repeat(40), state: 'downloading', down: 12 }], settings: { downloadDir: os.tmpdir(), autoUpdate: true }, speed: { down: 12, up: 0 } }
  child.reply = (message) => { if (message.method === 'init') child.result(message, initial, initial.settings) }
  return { child, service, initial }
}

test('utility bridge mirrors settings and state, and waits for async control replies', async () => {
  const { child, service, initial } = makeService()
  await service.init()
  assert.equal(service.settings, initial.settings)
  const settings = { ...initial.settings, autoUpdate: false, launchAtLogin: true }
  const pending = service.setSettings({ autoUpdate: false, launchAtLogin: true })
  const message = child.messages.at(-1)
  assert.equal(message.method, 'setSettings')
  assert.deepEqual(message.args, [{ autoUpdate: false, launchAtLogin: true }])
  child.result(message, undefined, settings)
  await pending
  assert.equal(service.settings, settings)
  assert.equal(service.lastState.settings, settings)
  const next = { ...initial, settings, speed: { down: 60_000_000, up: 0 } }
  let emitted
  service.once('state', (state) => { emitted = state })
  child.emit('message', { type: 'event', event: 'state', value: next })
  assert.equal(emitted, next)
  service.setObserved(false)
  assert.deepEqual(child.messages.at(-1), { type: 'observe', value: false })
  child.reply = (request) => child.result(request)
  await service.shutdown()
})

test('process exit rejects pending requests and exposes a stopped snapshot', async () => {
  const { child, service } = makeService()
  await service.init()
  const request = service.pause('a'.repeat(40))
  let failure
  service.once('failure', (err) => { failure = err })
  child.emit('exit', 7)
  await assert.rejects(request, /engine-process-exited/)
  assert.match(failure.message, /7/)
  const snapshot = await service.snapshot()
  assert.equal(snapshot.torrents[0].state, 'error')
  assert.equal(snapshot.torrents[0].error, 'engine-process-exited')
  assert.deepEqual(snapshot.speed, { down: 0, up: 0 })
  await assert.rejects(service.resume('a'.repeat(40)), /engine-process-exited/)
  assert.doesNotThrow(() => service.setObserved(true))
  await service.shutdown()
})

test('bounded RPC queue refuses extra work and timed out engine is terminated', async () => {
  const { child, service } = makeService({ requestTimeoutMs: 20 })
  await service.init()
  const requests = Array.from({ length: MAX_PENDING }, () => service.files('a'.repeat(40)).catch((err) => err.message))
  await assert.rejects(service.info('a'.repeat(40)), /engine-busy/)
  const results = await Promise.all(requests)
  assert.ok(results.some((message) => /engine-request-timeout/.test(message)))
  assert.equal(child.killed, true)
  assert.equal(service.pending.size, 0)
  await service.shutdown()
})

test('shutdown flush request is sent once and a stuck child is killed', async () => {
  const { child, service } = makeService({ shutdownTimeoutMs: 20 })
  await service.init()
  const pending = service.files('a'.repeat(40)).catch((err) => err.message)
  const first = service.shutdown()
  assert.equal(first, service.shutdown())
  await assert.rejects(first, /engine-request-timeout/)
  assert.equal(await pending, 'engine-stopped')
  assert.equal(child.messages.filter((message) => message.method === 'shutdown').length, 1)
  assert.equal(child.killed, true)
})

test('native trash accepts only exact torrent files requested by remove-with-trash', async () => {
  const calls = []
  const { child, service } = makeService({ trash: async (target) => calls.push(target) })
  await service.init()
  const dir = path.join(os.tmpdir(), 'tern-service-downloads')
  const target = path.join(dir, 'album', 'a.bin')
  child.reply = (message) => {
    if (message.method === 'info') child.result(message, { dir })
    if (message.method === 'files') child.result(message, [{ path: 'album/a.bin' }, { path: '../unrelated.bin' }])
  }
  const removal = service.remove('a'.repeat(40), { trash: true })
  await new Promise((resolve) => setImmediate(resolve))
  const request = child.messages.findLast((message) => message.method === 'remove')
  child.emit('message', { type: 'trash', id: 1, requestId: request.id, target: path.join(dir, 'other.bin') })
  child.emit('message', { type: 'trash', id: 2, requestId: request.id, target })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [target])
  assert.deepEqual(child.messages.at(-1), { type: 'trash-result', id: 2, ok: true, error: undefined })
  child.result(request)
  await removal
  child.reply = (message) => child.result(message)
  await service.shutdown()
})

test('snapshot and observation handle transport failures without hanging', async () => {
  const { child, service } = makeService()
  await service.init()
  child.postMessage = () => { throw new Error('transport closed') }
  service.setObserved(true)
  assert.equal(child.killed, true)
  assert.equal((await service.snapshot()).torrents[0].state, 'error')
  await assert.rejects(service.pauseAll(), /transport closed/)
  await service.shutdown()
})

test('healthy multi-file trash renews its watchdog instead of stopping all downloads', async () => {
  const dir = path.join(os.tmpdir(), 'tern-service-many-files')
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `${i}.bin` }))
  const calls = []
  const { child, service } = makeService({ requestTimeoutMs: 25, trash: async (target) => {
    await new Promise((resolve) => setTimeout(resolve, 12))
    calls.push(target)
  } })
  await service.init()
  child.reply = (message) => {
    if (message.method === 'info') child.result(message, { dir })
    if (message.method === 'files') child.result(message, files)
    if (message.method === 'shutdown') child.result(message)
  }
  const started = Date.now()
  const removal = service.remove('a'.repeat(40), { trash: true })
  await new Promise(setImmediate)
  const request = child.messages.findLast((message) => message.method === 'remove')
  for (let i = 0; i < files.length; i++) {
    await service._trash({ type: 'trash', id: i + 1, requestId: request.id, target: path.join(dir, files[i].path) })
  }
  child.result(request)
  await removal
  assert.ok(Date.now() - started > 25)
  assert.equal(calls.length, 6)
  assert.equal(child.killed, false)
  assert.equal(service.failed, null)
  await service.shutdown()
})
