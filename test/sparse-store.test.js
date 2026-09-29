'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { loadSparseStore, SPARSE_MIN_BYTES } = require('../src/main/sparse-store')
const { torrentOptions, dropRarityMap, STORE_CACHE_SLOTS } = require('../src/main/torrent-tuning')

const MB = 1024 * 1024
const isWindows = process.platform === 'win32'

/** Language-independent: read the SparseFile attribute (fsutil's text is localised). */
function isSparse (file) {
  const attrs = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:TERN_TEST_FILE).Attributes.ToString()'], {
    encoding: 'utf8', env: { ...process.env, TERN_TEST_FILE: file }
  })
  return /SparseFile/.test(attrs)
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tern-sparse-'))
const call = (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))))

/** Open a two-file store: one big file (sparse candidate) and one small. */
async function openStore (dir, bigLength) {
  const Store = await loadSparseStore()
  return new Store(MB, {
    path: dir,
    files: [{ path: 'big.bin', length: bigLength }, { path: 'small.bin', length: MB }]
  })
}

test('writes far into a big file without filling the gap, and reads it back', { skip: !isWindows && 'NTFS behaviour' }, async () => {
  const dir = tmp()
  const store = await openStore(dir, 2048 * MB)
  try {
    const far = crypto.randomBytes(MB)
    const started = process.hrtime.bigint()
    await call((cb) => store.put(2040, far, cb))
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    assert.ok(isSparse(path.join(dir, 'big.bin')), 'big files are created sparse')
    // A plain file takes ~0.65 s per 2 GB gap on a fast NVMe disk and far longer elsewhere.
    assert.ok(elapsedMs < 400, `first far write took ${Math.round(elapsedMs)} ms`)

    const back = await call((cb) => store.get(2040, cb))
    assert.ok(Buffer.from(back).equals(far), 'data written far into the file reads back')
    const hole = await call((cb) => store.get(10, cb))
    assert.ok(Buffer.from(hole).every((byte) => byte === 0), 'an unwritten region reads as zeros')
  } finally {
    await call((cb) => store.destroy(cb)).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('small files are left as ordinary files', { skip: !isWindows && 'NTFS behaviour' }, async () => {
  const dir = tmp()
  const store = await openStore(dir, 2048 * MB)
  try {
    await call((cb) => store.put(2048, Buffer.alloc(MB, 1), cb)) // the chunk that lands in small.bin
    assert.ok(!isSparse(path.join(dir, 'small.bin')), 'small files stay ordinary')
    assert.ok(MB < SPARSE_MIN_BYTES)
  } finally {
    await call((cb) => store.destroy(cb)).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the store keeps fs-chunk-store semantics (closed store rejects, destroy removes files)', async () => {
  const dir = tmp()
  const store = await openStore(dir, 64 * MB)
  await call((cb) => store.put(0, crypto.randomBytes(MB), cb))
  assert.ok(fs.existsSync(path.join(dir, 'big.bin')))
  await call((cb) => store.close(cb))
  await assert.rejects(call((cb) => store.put(1, crypto.randomBytes(MB), cb)), /closed/i)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('torrentOptions picks sequential order, our store and a small piece cache', () => {
  const store = class {}
  const opts = torrentOptions({ path: 'D:\\dl', store })
  assert.equal(opts.strategy, 'sequential')
  assert.equal(opts.store, store)
  assert.equal(opts.deselect, true)
  assert.equal(opts.storeCacheSlots, STORE_CACHE_SLOTS)
  assert.ok(STORE_CACHE_SLOTS < 20, 'smaller than WebTorrent default of 20')
})

test('dropRarityMap destroys the map once and tolerates torrents without one', () => {
  let destroyed = 0
  const torrent = { _rarityMap: { destroy: () => { destroyed += 1 } } }
  assert.equal(dropRarityMap(torrent), true)
  assert.equal(torrent._rarityMap, null)
  assert.equal(destroyed, 1)
  assert.equal(dropRarityMap(torrent), false)
  assert.equal(dropRarityMap(null), false)
  assert.equal(dropRarityMap({ _rarityMap: {} }), false)
})
