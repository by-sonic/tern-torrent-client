'use strict'

// Integration tests: a real swarm of two clients over loopback, no internet needed.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Engine } = require('../src/main/engine')
const { JsonStore } = require('../src/main/store')

const OFFLINE = { dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
const stateOf = (engine, id) => engine.snapshot().torrents.find((t) => t.id === id)

function waitFor (predicate, label, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const value = predicate()
      if (value) { clearInterval(timer); resolve(value) } else if (Date.now() - started > ms) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for: ${label}`))
      }
    }, 50)
  })
}

function withTimeout (promise, label, ms = 20_000) {
  return Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms))])
}

async function makeEngine (root, { trash, ...extra } = {}) {
  const engine = new Engine({
    stateStore: new JsonStore(path.join(root, 'state.json'), () => ({ torrents: [], settings: {} })),
    torrentsDir: path.join(root, 'torrents'),
    defaultDir: path.join(root, 'downloads'),
    trash: trash || (async () => {}),
    clientOptions: OFFLINE,
    ...extra
  })
  fs.mkdirSync(path.join(root, 'downloads'), { recursive: true })
  await engine.init()
  return engine
}

/** Seeds album/{a.bin,b.bin} (300 kB each) and returns everything a test needs. */
async function makeSwarm (t) {
  const { default: WebTorrent } = await import('webtorrent')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-test-'))
  const content = path.join(root, 'seed', 'album')
  fs.mkdirSync(content, { recursive: true })
  const a = crypto.randomBytes(300_000)
  const b = crypto.randomBytes(300_000)
  fs.writeFileSync(path.join(content, 'a.bin'), a)
  fs.writeFileSync(path.join(content, 'b.bin'), b)

  const seeder = new WebTorrent(OFFLINE)
  const seeded = await new Promise((resolve) => seeder.seed(content, { announce: [] }, resolve))
  const torrentPath = path.join(root, 'album.torrent')
  fs.writeFileSync(torrentPath, seeded.torrentFile)
  await waitFor(() => seeder.torrentPort, 'seeder listening')

  const swarm = { root, a, b, torrentPath, seeder, engines: [] }
  swarm.engine = async (options) => {
    const engine = await makeEngine(root, options)
    swarm.engines.push(engine)
    return engine
  }
  swarm.connect = (engine, id) => waitFor(() => engine.entries.get(id).live, 'live torrent')
    .then((live) => live.addPeer(`127.0.0.1:${seeder.torrentPort}`))
  t.after(async () => {
    for (const engine of swarm.engines) await engine.shutdown()
    await new Promise((resolve) => seeder.destroy(resolve))
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('tern-test-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return swarm
}

const downloaded = (swarm, name) => path.join(swarm.root, 'downloads', 'album', name)

async function addAndPick (swarm, engine) {
  const { id } = await engine.add({ kind: 'file', path: swarm.torrentPath })
  await waitFor(() => stateOf(engine, id).state === 'choosing', 'file picker state')
  await swarm.connect(engine, id)
  return { id, listed: stateOf(engine, id).files }
}

test('downloads only the selected files, then survives a restart', async (t) => {
  const swarm = await makeSwarm(t)
  let engine = await swarm.engine()
  const { id, listed } = await addAndPick(swarm, engine)
  assert.equal((await engine.add({ kind: 'file', path: swarm.torrentPath })).duplicate, true)
  assert.deepEqual(listed.map((f) => path.basename(f.path)).sort(), ['a.bin', 'b.bin'])

  const wantA = listed.map((f) => f.path.endsWith('a.bin'))
  await assert.rejects(engine.confirm(id, { selected: listed.map(() => false), dir: '' }), /nothing-selected/)
  const completed = new Promise((resolve) => engine.once('completed', resolve))
  await engine.confirm(id, { selected: wantA, dir: '' })
  await withTimeout(completed, 'completed')

  assert.ok(fs.readFileSync(downloaded(swarm, 'a.bin')).equals(swarm.a), 'selected file is byte-identical')
  const bPath = downloaded(swarm, 'b.bin')
  assert.ok(!fs.existsSync(bPath) || !fs.readFileSync(bPath).equals(swarm.b), 'unselected file was not downloaded')
  assert.equal(stateOf(engine, id).progress, 1)
  assert.equal(stateOf(engine, id).state, 'seeding')

  engine.pause(id)
  await waitFor(() => stateOf(engine, id).state === 'paused', 'paused')
  assert.equal(stateOf(engine, id).progress, 1)

  await engine.shutdown()
  engine = await swarm.engine()
  const restored = stateOf(engine, id)
  assert.equal(restored.state, 'paused')
  assert.equal(restored.progress, 1)
  assert.ok(restored.pieces.includes('9'), 'piece map is restored from the saved bitfield')

  engine.resume(id)
  await waitFor(() => stateOf(engine, id).state === 'seeding', 'seeding after restart')
})

test('finishing with seeding disabled closes stores after WebTorrent completes its callbacks', async (t) => {
  const swarm = await makeSwarm(t)
  const engine = await swarm.engine()
  engine.setSettings({ seedAfterDone: false })
  const { id, listed } = await addAndPick(swarm, engine)
  const completed = new Promise((resolve) => engine.once('completed', resolve))
  await engine.confirm(id, { selected: listed.map(() => true), dir: '' })
  await withTimeout(completed, 'completion with no seeding')
  await waitFor(() => stateOf(engine, id).state === 'done', 'completed torrent is stopped')
  assert.ok(fs.readFileSync(downloaded(swarm, 'a.bin')).equals(swarm.a))
  assert.ok(fs.readFileSync(downloaded(swarm, 'b.bin')).equals(swarm.b))
  assert.equal(engine.entries.get(id).error, null)
})

test('full initial verification publishes attempts separately from downloaded bytes', async (t) => {
  const swarm = await makeSwarm(t)
  const engine = await swarm.engine({ tickMs: 10 })
  engine.setObserved(true)
  const { id, listed } = await addAndPick(swarm, engine)
  const completed = new Promise((resolve) => engine.once('completed', resolve))
  await engine.confirm(id, { selected: listed.map(() => true), dir: '' })
  await withTimeout(completed, 'fixture download')
  engine.pause(id)
  await waitFor(() => !engine.entries.get(id).stopping, 'paused stores closed')
  const entry = engine.entries.get(id)
  entry.bitfield = null // require a real full check of the existing files
  entry.done = false
  entry.progressBytes = 0
  entry.fp = null
  const BaseStore = engine.store
  engine.store = class SlowReadStore extends BaseStore {
    get (index, opts, callback) {
      if (typeof opts === 'function') { callback = opts; opts = null }
      super.get(index, opts, (err, bytes) => setTimeout(() => callback(err, bytes), 15))
    }
  }
  const published = []
  engine.on('state', (state) => {
    const row = state.torrents.find((torrent) => torrent.id === id)
    if (row?.state === 'checking' && row.verification?.checked > 0) published.push(row.verification.checked)
  })
  engine.resume(id)
  const checking = await waitFor(() => {
    const state = stateOf(engine, id)
    return state.state === 'checking' && state.verification?.checked > 0 && state.verification.checked < state.verification.total && state
  }, 'incremental verification snapshot')
  assert.equal(checking.progress, 0, 'attempts do not count as downloaded bytes')
  assert.ok(checking.verification.bytes > 0)
  assert.ok(checking.verification.totalBytes >= checking.verification.bytes)
  await waitFor(() => stateOf(engine, id).state === 'seeding', 'valid files verified')
  assert.ok(new Set(published).size >= 2, 'visible observers receive changing checking snapshots')
  assert.equal(stateOf(engine, id).progress, 1)
  assert.equal(stateOf(engine, id).verification, null)
})

test('widening the selection of a finished, stopped torrent downloads the new file', async (t) => {
  const swarm = await makeSwarm(t)
  const engine = await swarm.engine()
  const { id, listed } = await addAndPick(swarm, engine)
  const completed = new Promise((resolve) => engine.once('completed', resolve))
  await engine.confirm(id, { selected: listed.map((f) => f.path.endsWith('a.bin')), dir: '' })
  await withTimeout(completed, 'first completion')

  engine.pause(id)
  await waitFor(() => stateOf(engine, id).state === 'paused', 'paused')
  engine.setSelection(id, listed.map(() => true))
  assert.equal(engine.entries.get(id).done, false, 'done is recomputed while stopped')
  assert.ok(stateOf(engine, id).progress < 1)

  const secondCompletion = new Promise((resolve) => engine.once('completed', resolve))
  engine.resume(id)
  await swarm.connect(engine, id)
  await withTimeout(secondCompletion, 'second completion')
  assert.ok(fs.readFileSync(downloaded(swarm, 'b.bin')).equals(swarm.b), 'newly selected file is byte-identical')
})

test('removing with "delete files" trashes only the torrent\'s own files', async (t) => {
  const swarm = await makeSwarm(t)
  const trashed = []
  const engine = await swarm.engine({ trash: async (p) => { trashed.push(p); fs.rmSync(p, { force: true }) } })
  const { id, listed } = await addAndPick(swarm, engine)
  const completed = new Promise((resolve) => engine.once('completed', resolve))
  await engine.confirm(id, { selected: listed.map(() => true), dir: '' })
  await withTimeout(completed, 'completed')

  const keep = downloaded(swarm, 'keep.txt')
  fs.writeFileSync(keep, 'not part of the torrent')
  const result = await engine.remove(id, { trash: true })

  assert.deepEqual(trashed.map((p) => path.basename(p)).sort(), ['a.bin', 'album.torrent', 'b.bin'])
  assert.deepEqual(result, { removed: true, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 3 })
  assert.ok(fs.existsSync(keep), 'a file that merely shares the folder is untouched')
  assert.ok(fs.existsSync(path.dirname(keep)), 'a non-empty folder is kept')
  assert.equal(stateOf(engine, id), undefined)
  assert.equal(engine.client.torrents.length, 0)
})

async function pausedRemovalFixture (t, options) {
  const swarm = await makeSwarm(t)
  const engine = await swarm.engine(options)
  const { id, listed } = await addAndPick(swarm, engine)
  fs.mkdirSync(path.dirname(downloaded(swarm, 'a.bin')), { recursive: true })
  fs.writeFileSync(downloaded(swarm, 'a.bin'), swarm.a)
  fs.writeFileSync(downloaded(swarm, 'b.bin'), swarm.b)
  await engine.confirm(id, { selected: listed.map(() => true), dir: '' })
  engine.pause(id)
  await waitFor(() => !engine.entries.get(id).live && !engine.entries.get(id).stopping, 'fixture stores paused')
  if (engine.entries.get(id).persistingTorrent) await engine.entries.get(id).persistingTorrent
  return { swarm, engine, id }
}

test('list-only removal preserves downloaded files and original even with a pending cache write', async (t) => {
  const calls = []
  const { swarm, engine, id } = await pausedRemovalFixture(t, { trash: async (target) => calls.push(target) })
  const entry = engine.entries.get(id)
  entry.persistingTorrent = new Promise((resolve) => setTimeout(async () => {
    await fs.promises.writeFile(engine._torrentFile(id), entry.torrentBuffer)
    resolve()
  }, 30))
  const result = await engine.remove(id, { trash: false })
  assert.deepEqual(result, { removed: true, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 0 })
  assert.deepEqual(calls, [])
  assert.ok(fs.readFileSync(downloaded(swarm, 'a.bin')).equals(swarm.a))
  assert.ok(fs.existsSync(swarm.torrentPath))
  assert.ok(!fs.existsSync(engine._torrentFile(id)), 'pending write cannot resurrect the cache')
  assert.equal(stateOf(engine, id), undefined)
})

test('original source receipt persists across restart and prepared removal survives a checkpoint', async (t) => {
  const calls = []
  const { swarm, engine: first, id } = await pausedRemovalFixture(t)
  const plan = await first.removalPlan(id)
  assert.ok(plan.token)
  first.checkpoint()
  const saved = JSON.parse(fs.readFileSync(path.join(swarm.root, 'state.json'), 'utf8'))
  assert.equal(saved.torrents[0].id, id, 'preparation does not drop the persistent record')
  assert.equal(saved.torrents[0].paused, true)
  assert.equal(saved.torrents[0].sourceTorrent.path, swarm.torrentPath)
  await first.shutdown()
  const restarted = await swarm.engine({ trash: async (target) => { calls.push(target); fs.rmSync(target) } })
  const result = await restarted.remove(id, { trash: true })
  assert.equal(result.trashed, 3)
  assert.deepEqual(calls.map((target) => path.basename(target)).sort(), ['a.bin', 'album.torrent', 'b.bin'])
})

test('failed or cancelled preparation leaves a paused retryable record', async (t) => {
  const { engine, id } = await pausedRemovalFixture(t)
  const originalPlan = engine._removalPlan
  engine._removalPlan = async () => { throw new Error('fixture-plan-failed') }
  await assert.rejects(engine.removalPlan(id), /fixture-plan-failed/)
  assert.equal(engine.entries.get(id).preparingRemoval, false)
  assert.equal(stateOf(engine, id).state, 'paused')
  assert.equal(engine._serialize().torrents[0].id, id)
  engine._removalPlan = originalPlan
  const plan = await engine.removalPlan(id)
  engine.cancelRemovalPlan(id, plan.token)
  assert.equal(engine.entries.get(id).preparingRemoval, false)
  const retried = await engine.removalPlan(id)
  const result = await engine.remove(id, { trash: true, planToken: retried.token })
  assert.equal(result.removed, true)
})

test('trusted metadata owns deletion targets while modified state paths and shared files stay intact', async (t) => {
  const calls = []
  const { swarm, engine, id } = await pausedRemovalFixture(t, { trash: async (target) => { calls.push(target); fs.rmSync(target) } })
  const keep = downloaded(swarm, 'keep.txt')
  fs.writeFileSync(keep, 'unrelated')
  const entry = engine.entries.get(id)
  entry.files.push({ path: 'album/keep.txt', length: 9 })
  const other = engine._fromRecord({ id: 'f'.repeat(40), name: 'other', path: entry.path, files: [{ path: 'album/a.bin', length: swarm.a.length }], paused: true })
  engine.entries.set(other.id, other)
  const result = await engine.remove(id, { trash: true })
  assert.equal(result.skipped, 1)
  assert.deepEqual(calls.map((target) => path.basename(target)).sort(), ['album.torrent', 'b.bin'])
  assert.ok(fs.existsSync(downloaded(swarm, 'a.bin')))
  assert.equal(fs.readFileSync(keep, 'utf8'), 'unrelated')
  assert.ok(engine.entries.has(other.id))
})

test('replaced or missing original and native trash failures produce an honest partial result', async (t) => {
  for (const scenario of ['replaced', 'missing', 'native-failure']) {
    await t.test(scenario, async (st) => {
      const { swarm, engine, id } = await pausedRemovalFixture(st, { trash: async (target) => {
        if (scenario === 'native-failure' && target.endsWith('a.bin')) throw new Error('fixture-native-denied')
        fs.rmSync(target)
      } })
      if (scenario === 'replaced') fs.writeFileSync(swarm.torrentPath, 'unrelated replacement')
      if (scenario === 'missing') fs.rmSync(swarm.torrentPath)
      const result = await engine.remove(id, { trash: true })
      assert.equal(result.removed, true)
      assert.equal(result.failed, scenario === 'native-failure' ? 1 : 0)
      assert.equal(result.skipped, scenario === 'replaced' ? 1 : 0)
      assert.equal(stateOf(engine, id), undefined)
      if (scenario === 'replaced') assert.equal(fs.readFileSync(swarm.torrentPath, 'utf8'), 'unrelated replacement')
      if (scenario === 'native-failure') assert.ok(fs.existsSync(downloaded(swarm, 'a.bin')))
    })
  }
})

test('legacy records can remember a reimported source; unconfirmed imports preserve pre-existing content', async (t) => {
  const { swarm, engine, id } = await pausedRemovalFixture(t)
  engine.entries.get(id).sourceTorrent = null
  assert.equal((await engine.add({ kind: 'file', path: swarm.torrentPath })).duplicate, true)
  assert.equal(engine.entries.get(id).sourceTorrent.path, swarm.torrentPath)
  engine.entries.get(id).stage = 'choosing'
  const result = await engine.remove(id, { trash: true })
  assert.equal(result.trashed, 1, 'only the tracked original is eligible before confirming a download')
  assert.ok(fs.readFileSync(downloaded(swarm, 'a.bin')).equals(swarm.a))
})

test('changed shared ownership during an asynchronous scan conservatively leaves content intact', async (t) => {
  const calls = []
  const { swarm, engine, id } = await pausedRemovalFixture(t, { trash: async (target) => calls.push(target) })
  const plan = await engine.removalPlan(id)
  engine._sharedTargets = async () => { engine.entriesRevision++; return new Set() }
  const result = await engine.remove(id, { trash: true, planToken: plan.token })
  assert.equal(result.skipped, plan.targets.length)
  assert.deepEqual(calls, [])
  assert.ok(fs.existsSync(downloaded(swarm, 'a.bin')))
})

test('another paused torrent using a local junction keeps ownership of the same physical content', async (t) => {
  const calls = []
  const { swarm, engine, id } = await pausedRemovalFixture(t, { trash: async (target) => { calls.push(target); fs.rmSync(target) } })
  const alias = path.join(swarm.root, 'download-alias')
  fs.symlinkSync(path.join(swarm.root, 'downloads'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const other = engine._fromRecord({ id: 'f'.repeat(40), name: 'other', path: alias, files: [{ path: 'album/a.bin', length: swarm.a.length }], paused: true })
  engine.entries.set(other.id, other)
  engine.entriesRevision++
  const result = await engine.remove(id, { trash: true })
  assert.equal(result.skipped, 1)
  assert.deepEqual(calls.map((target) => path.basename(target)).sort(), ['album.torrent', 'b.bin'])
  assert.ok(fs.readFileSync(downloaded(swarm, 'a.bin')).equals(swarm.a))
  fs.rmSync(alias)
})

test('torrents run sequentially, without the rarity map, on the sparse store', async (t) => {
  const swarm = await makeSwarm(t)
  const engine = await swarm.engine()
  const { id, listed } = await addAndPick(swarm, engine)
  const live = engine.entries.get(id).live
  assert.equal(live.strategy, 'sequential')
  assert.equal(live._rarityMap, null, 'the O(peers x pieces) rarity map is dropped')
  const completed = new Promise((resolve) => engine.once('completed', resolve))
  await engine.confirm(id, { selected: listed.map(() => true), dir: '' })
  await withTimeout(completed, 'completed')
  assert.equal(engine.entries.get(id).live._rarityMap, null, 'still dropped after the restart at the final folder')
  assert.ok(fs.readFileSync(downloaded(swarm, 'a.bin')).equals(swarm.a))
  assert.ok(fs.readFileSync(downloaded(swarm, 'b.bin')).equals(swarm.b))
})

test('confirm refuses folders that are not local absolute directories', async (t) => {
  const swarm = await makeSwarm(t)
  const engine = await swarm.engine()
  const { id, listed } = await addAndPick(swarm, engine)
  const all = listed.map(() => true)
  for (const dir of ['\\\\attacker\\share', 'relative\\dir', path.join(swarm.root, 'does-not-exist')]) {
    await assert.rejects(engine.confirm(id, { selected: all, dir }), /bad-dir/, dir)
  }
  assert.equal(stateOf(engine, id).state, 'choosing')
})

test('snapshots are built only while a window watches; otherwise the engine ticks slowly and emits cheap stats', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-tick-'))
  const engine = await makeEngine(root, { tickMs: 20, backgroundTickMs: 120 })
  let states = 0
  let stats = 0
  engine.on('state', () => { states += 1 })
  engine.on('stats', () => { stats += 1 })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    await sleep(500)
    assert.equal(states, 0, 'no snapshot is built with nobody watching')
    assert.ok(stats >= 2 && stats <= 6, `slow background ticks (got ${stats})`)
    assert.deepEqual(Object.keys(engine.stats()).sort(), ['active', 'down', 'up'])

    engine.setObserved(true)
    await sleep(400)
    assert.ok(states >= 8, `fast ticks while observed (got ${states})`)

    engine.setObserved(false)
    const frozen = states
    await sleep(300)
    assert.equal(states, frozen, 'snapshots stop as soon as the window is gone')
  } finally {
    await engine.shutdown()
    const after = { states, stats }
    await sleep(300)
    assert.deepEqual({ states, stats }, after, 'no timer keeps running after shutdown')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- queue behaviour, with magnet entries that never resolve metadata -------------------------

async function magnetPair (t, maxActive) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-queue-'))
  const engine = await makeEngine(root)
  t.after(async () => { await engine.shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  engine.setSettings({ maxActive })
  const ids = []
  for (const i of [0, 1]) {
    const { id } = await engine.add({ kind: 'magnet', uri: `magnet:?xt=urn:btih:${'b'.repeat(39)}${i}` })
    ids.push(id)
    const entry = engine.entries.get(id)
    Object.assign(entry, { stage: 'ready', order: i, files: [{ path: 'x', length: 10 }], selected: [true], length: 10, pieceCount: 1 })
  }
  engine.resumeAll()
  return { engine, ids }
}

test('the queue holds torrents beyond the active limit and follows list order', async (t) => {
  const { engine, ids } = await magnetPair(t, 1)
  assert.ok(engine.entries.get(ids[0]).live, 'first torrent runs')
  assert.equal(stateOf(engine, ids[1]).state, 'queued')
  engine.move(ids[1], 'top')
  await waitFor(() => engine.entries.get(ids[1]).live && !engine.entries.get(ids[0]).live, 'queue swaps')
  assert.equal(stateOf(engine, ids[0]).state, 'queued')
})

test('a torrent in error does not hold a queue slot', async (t) => {
  const { engine, ids } = await magnetPair(t, 1)
  const first = engine.entries.get(ids[0])
  first.error = 'ENOSPC'
  await engine._stop(first, { keepBitfield: false })
  engine._reconcile()
  await waitFor(() => engine.entries.get(ids[1]).live, 'second torrent takes the slot')
  assert.equal(stateOf(engine, ids[0]).state, 'error')
})

test('a reconcile during removal does not bring the torrent back', async (t) => {
  const { engine, ids } = await magnetPair(t, 2)
  assert.equal(engine.client.torrents.length, 2)
  const removal = engine.remove(ids[0])
  engine.setSettings({ maxActive: 3 }) // triggers _reconcile while the stop is in flight
  engine.resumeAll()
  await removal
  await waitFor(() => engine.client.torrents.length === 1, 'only the other torrent is left')
  assert.equal(stateOf(engine, ids[0]), undefined)
})
