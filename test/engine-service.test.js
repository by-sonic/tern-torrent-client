'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const { EngineService, MAX_PENDING } = require('../src/main/engine-service')
const { readTorrentFile } = require('../src/main/torrent-removal')

function removeFixture (root, prefix) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith(prefix))
  fs.rmSync(root, { recursive: true, force: true })
}

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

test('native trash accepts only exact validated torrent files requested by remove-with-trash', async (t) => {
  const calls = []
  const { child, service } = makeService({ trash: async (target) => calls.push(target) })
  await service.init()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-service-downloads-'))
  t.after(() => removeFixture(dir, 'tern-service-downloads-'))
  const target = path.join(dir, 'album', 'a.bin')
  fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, 'fixture')
  child.reply = (message) => {
    if (message.method === 'removalPlan') child.result(message, { token: 'b'.repeat(32), targets: [{ kind: 'content', root: dir, path: target }] })
  }
  const removal = service.remove('a'.repeat(40), { trash: true })
  await new Promise((resolve) => setImmediate(resolve))
  const request = child.messages.findLast((message) => message.method === 'remove')
  await service._trash({ type: 'trash', id: 1, requestId: request.id, target: path.join(dir, 'other.bin') })
  await service._trash({ type: 'trash', id: 2, requestId: request.id, target })
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

test('healthy multi-file trash renews its watchdog instead of stopping all downloads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-service-many-files-'))
  t.after(() => removeFixture(dir, 'tern-service-many-files-'))
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `${i}.bin` }))
  for (const file of files) fs.writeFileSync(path.join(dir, file.path), 'fixture')
  const calls = []
  const { child, service } = makeService({ requestTimeoutMs: 25, trash: async (target) => {
    await new Promise((resolve) => setTimeout(resolve, 12))
    calls.push(target)
  } })
  await service.init()
  child.reply = (message) => {
    if (message.method === 'removalPlan') child.result(message, { token: 'b'.repeat(32), targets: files.map((file) => ({ kind: 'content', root: dir, path: path.join(dir, file.path) })) })
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

test('source torrent outside the content root requires an exact unchanged backend receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-service-source-'))
  t.after(() => removeFixture(root, 'tern-service-source-'))
  const original = path.join(root, 'original.torrent')
  fs.writeFileSync(original, 'fixture torrent bytes')
  const read = await readTorrentFile(original)
  const calls = []
  const { child, service } = makeService({ trash: async (target) => calls.push(target) })
  await service.init()
  const source = { kind: 'source', path: original, sha256: read.sha256, identity: read.identity }
  child.reply = (message) => {
    if (message.method === 'removalPlan') child.result(message, { token: 'b'.repeat(32), targets: [source] })
  }
  const removal = service.remove('a'.repeat(40), { trash: true, path: path.join(root, 'unrelated.torrent') })
  await new Promise(setImmediate)
  const request = child.messages.findLast((message) => message.method === 'remove')
  assert.deepEqual(request.args, ['a'.repeat(40), { trash: true, planToken: 'b'.repeat(32) }])
  await service._trash({ id: 1, requestId: request.id, target: path.join(root, 'unrelated.torrent') })
  assert.equal(calls.length, 0)
  fs.writeFileSync(original, 'replacement unrelated bytes')
  await service._trash({ id: 2, requestId: request.id, target: original })
  assert.equal(calls.length, 0)
  assert.equal(child.messages.at(-1).error, 'trash-unsafe')
  child.result(request, { removed: true, skipped: 1 })
  await removal
  child.reply = (message) => child.result(message)
  await service.shutdown()
})

test('an unchanged original is accepted once and remove without trash grants no file authority', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-service-original-'))
  t.after(() => removeFixture(root, 'tern-service-original-'))
  const original = path.join(root, 'original.torrent')
  fs.writeFileSync(original, 'fixture bytes')
  const read = await readTorrentFile(original)
  const calls = []
  const { child, service } = makeService({ trash: async (target) => calls.push(target) })
  await service.init()
  child.reply = (message) => {
    if (message.method === 'removalPlan') child.result(message, { token: 'b'.repeat(32), targets: [{ kind: 'source', path: original, sha256: read.sha256, identity: read.identity }] })
  }
  const removal = service.remove('a'.repeat(40), { trash: true })
  await new Promise(setImmediate)
  let request = child.messages.findLast((message) => message.method === 'remove')
  await Promise.all([service._trash({ id: 1, requestId: request.id, target: original }), service._trash({ id: 2, requestId: request.id, target: original })])
  assert.deepEqual(calls, [original])
  assert.ok(child.messages.some((message) => message.type === 'trash-result' && message.id === 2 && message.error === 'trash-unsafe'))
  child.result(request); await removal
  const listOnly = service.remove('a'.repeat(40), { trash: false })
  request = child.messages.findLast((message) => message.method === 'remove')
  await service._trash({ id: 3, requestId: request.id, target: original })
  assert.deepEqual(calls, [original])
  child.result(request); await listOnly
  child.reply = (message) => child.result(message)
  await service.shutdown()
})

test('counted preparation progress renews only a live removal request; repeated pulses cannot hide a stall', async () => {
  const { child, service } = makeService({ removalPlanTimeoutMs: 35 })
  await service.init()
  child.reply = (message) => {
    if (message.method === 'removalPlan') {
      let completed = 0
      const timer = setInterval(() => {
        child.emit('message', { type: 'removal-progress', requestId: message.id, completed: ++completed })
        if (completed === 5) { clearInterval(timer); child.result(message, { token: 'b'.repeat(32), targets: [] }) }
      }, 15)
    } else if (['remove', 'shutdown'].includes(message.method)) child.result(message, { removed: true })
  }
  const started = Date.now()
  assert.equal((await service.remove('a'.repeat(40), { trash: true })).removed, true)
  assert.ok(Date.now() - started > 35)
  assert.equal(child.killed, false)
  await service.shutdown()

  const stalled = makeService({ removalPlanTimeoutMs: 30 })
  await stalled.service.init()
  let timer
  stalled.child.reply = (message) => {
    if (message.method !== 'removalPlan') return
    timer = setInterval(() => stalled.child.emit('message', { type: 'removal-progress', requestId: message.id, completed: 1 }), 5)
  }
  try {
    await assert.rejects(stalled.service.remove('a'.repeat(40), { trash: true }), /engine-request-timeout/)
    assert.equal(stalled.child.killed, true)
  } finally { clearInterval(timer); await stalled.service.shutdown() }
})

test('rejected backend plans release preparation before reporting failure', async () => {
  const { child, service } = makeService()
  await service.init()
  child.reply = (message) => {
    if (message.method === 'removalPlan') child.result(message, { token: 'b'.repeat(32), targets: [null] })
    if (['cancelRemovalPlan', 'shutdown'].includes(message.method)) child.result(message)
  }
  await assert.rejects(service.remove('a'.repeat(40), { trash: true }), /bad-removal-plan/)
  assert.ok(child.messages.some((message) => message.method === 'cancelRemovalPlan'))
  assert.ok(!child.messages.some((message) => message.method === 'remove'))
  await service.shutdown()
})
