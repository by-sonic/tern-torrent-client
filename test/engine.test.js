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
  await engine.remove(id, { trash: true })

  assert.deepEqual(trashed.map((p) => path.basename(p)).sort(), ['a.bin', 'b.bin'])
  assert.ok(fs.existsSync(keep), 'a file that merely shares the folder is untouched')
  assert.ok(fs.existsSync(path.dirname(keep)), 'a non-empty folder is kept')
  assert.equal(stateOf(engine, id), undefined)
  assert.equal(engine.client.torrents.length, 0)
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
