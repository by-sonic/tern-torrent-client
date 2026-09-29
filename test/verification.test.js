'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { installTorrentVerification, createVerificationBudget, VERIFY_CONCURRENCY } = require('../src/main/verification')

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')
const immediate = () => new Promise((resolve) => setImmediate(resolve))

function fixture ({ buffers = [Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('ij')], bits, files, get, hashes } = {}) {
  const torrent = new EventEmitter()
  torrent.destroyed = false
  torrent.pieceLength = 4
  torrent.lastPieceLength = buffers.at(-1)?.length || 2
  torrent.pieces = buffers.map(() => ({}))
  torrent._hashes = hashes || buffers.map((buffer) => buffer ? sha1(buffer) : sha1(Buffer.from('abcd')))
  const verified = bits || buffers.map(() => false)
  torrent.bitfield = {
    get: (index) => Boolean(verified[index]),
    set: (index, value) => { verified[index] = Boolean(value) }
  }
  torrent.files = files || [{ _startPiece: 0, _endPiece: buffers.length - 1 }]
  torrent.reads = []
  torrent.marks = []
  torrent.store = {
    get (index, opts, cb) {
      torrent.reads.push({ index, opts })
      if (get) return get(index, opts, cb)
      const buffer = buffers[index]
      cb(buffer ? null : new Error('ENOENT'), buffer && (opts.length ? buffer.subarray(0, opts.length) : buffer))
    }
  }
  torrent._markVerified = (index) => {
    torrent.marks.push([index, true])
    torrent.pieces[index] = null
    torrent.bitfield.set(index, true)
    torrent.emit('verified', index)
  }
  torrent._markUnverified = (index) => {
    torrent.marks.push([index, false])
    torrent.pieces[index] = {}
    torrent.bitfield.set(index, false)
  }
  torrent._verifyPiece = () => { throw new Error('unwrapped verification') }
  torrent._verifyPiecesUsingHash = () => { throw new Error('unwrapped hash pass') }
  torrent._verifyPiecesUsingBitfield = () => { throw new Error('unwrapped bitfield pass') }
  return torrent
}

function hashPass (torrent, pieces = torrent.pieces) {
  return new Promise((resolve, reject) => torrent._verifyPiecesUsingHash(pieces, (err) => err ? reject(err) : resolve()))
}

function bitfieldPass (torrent) {
  return new Promise((resolve, reject) => torrent._verifyPiecesUsingBitfield((err) => err ? reject(err) : resolve()))
}

test('verification installs once and leaves incompatible contracts untouched', () => {
  assert.equal(installTorrentVerification(null), false)
  const incompatible = fixture()
  delete incompatible._verifyPiecesUsingBitfield
  assert.equal(installTorrentVerification(incompatible), false)
  assert.equal(incompatible._ternVerification, undefined)
  const torrent = fixture()
  assert.throws(() => installTorrentVerification(torrent, { hashMode: 'unknown' }), /invalid-verification-hash-mode/)
  assert.equal(installTorrentVerification(torrent), true)
  const method = torrent._verifyPiece
  assert.equal(installTorrentVerification(torrent), false)
  assert.equal(torrent._verifyPiece, method)
  assert.deepEqual(torrent._ternVerification, { active: false, checked: 0, total: 0, bytes: 0, totalBytes: 0, phase: 'idle' })
})

for (const hashMode of ['async', 'sync']) {
  test(`${hashMode} digest preserves SHA-1 results, last-piece reads and cache buffers`, async () => {
    const buffers = [Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('ijXX')]
    const expected = buffers.map((buffer) => Buffer.from(buffer))
    const torrent = fixture({ buffers, hashes: [sha1(buffers[0]), sha1(buffers[1]), sha1(Buffer.from('ij'))] })
    torrent.lastPieceLength = 2
    installTorrentVerification(torrent, { hashMode })
    await hashPass(torrent)
    assert.deepEqual(torrent.reads, [{ index: 0, opts: {} }, { index: 1, opts: {} }, { index: 2, opts: { length: 2 } }])
    assert.deepEqual(torrent.marks.sort((a, b) => a[0] - b[0]), [[0, true], [1, true], [2, true]])
    assert.deepEqual(buffers, expected, 'digest must not mutate or detach cached store buffers')
    assert.deepEqual(torrent._ternVerification, { active: false, checked: 3, total: 3, bytes: 10, totalBytes: 10, phase: 'full' })
    assert.equal(torrent.listenerCount('close'), 0)
  })
}

test('missing and corrupt pieces count as checked without marking them verified', async () => {
  const torrent = fixture({ buffers: [Buffer.from('xxxx'), null, Buffer.from('ij')], hashes: [sha1(Buffer.from('abcd')), sha1(Buffer.from('efgh')), sha1(Buffer.from('ij'))] })
  installTorrentVerification(torrent)
  await hashPass(torrent)
  assert.deepEqual(torrent.marks.sort((a, b) => a[0] - b[0]), [[0, false], [1, false], [2, true]])
  assert.equal(torrent._ternVerification.checked, 3)
  assert.equal(torrent._ternVerification.bytes, 10)
  assert.equal(torrent._ternVerification.active, false)
})

test('a large missing-data scan yields to the event loop and keeps two reads in flight', async () => {
  const count = 1024
  let concurrent = 0
  let maximum = 0
  const torrent = fixture({
    buffers: Array(count).fill(null),
    get (_index, _opts, cb) {
      maximum = Math.max(maximum, ++concurrent)
      queueMicrotask(() => { concurrent--; cb(new Error('ENOENT')) })
    }
  })
  installTorrentVerification(torrent)
  const complete = hashPass(torrent)
  let yields = 0
  while (torrent._ternVerification.active) { await immediate(); yields++ }
  await complete
  assert.equal(maximum, VERIFY_CONCURRENCY)
  assert.ok(yields > 10, `scan should yield repeatedly (got ${yields})`)
  assert.equal(torrent._ternVerification.checked, count)
})

test('startup probes exactly the second verified piece per file and shares boundary probes', async () => {
  const torrent = fixture({
    buffers: Array.from({ length: 7 }, (_, index) => Buffer.from(`aaa${index}`)),
    bits: [true, false, true, true, false, true, false],
    files: [{ _startPiece: 0, _endPiece: 2 }, { _startPiece: 2, _endPiece: 3 }, { _startPiece: 4, _endPiece: 6 }, { _startPiece: 2, _endPiece: 2 }]
  })
  installTorrentVerification(torrent)
  await bitfieldPass(torrent)
  assert.deepEqual(torrent.reads.map((read) => read.index), [2, 3, 5])
  assert.deepEqual(torrent._ternVerification, { active: false, checked: 3, total: 3, bytes: 12, totalBytes: 12, phase: 'probe' })
})

test('an invalid shared probe rechecks every affected file once per piece', async () => {
  const buffers = Array.from({ length: 5 }, (_, index) => Buffer.from(`aaa${index}`))
  const hashes = buffers.map(sha1)
  buffers[1] = Buffer.from('oops')
  const torrent = fixture({
    buffers,
    hashes,
    bits: [true, true, true, true, true],
    files: [{ _startPiece: 0, _endPiece: 1 }, { _startPiece: 1, _endPiece: 1 }, { _startPiece: 1, _endPiece: 3 }, { _startPiece: 4, _endPiece: 4 }]
  })
  installTorrentVerification(torrent)
  await bitfieldPass(torrent)
  assert.deepEqual(torrent.reads.map((read) => read.index), [1, 2, 4, 0, 1, 2, 3])
  assert.deepEqual(torrent._ternVerification, { active: false, checked: 4, total: 4, bytes: 16, totalBytes: 16, phase: 'fallback' })
  assert.equal(torrent.bitfield.get(1), false)
  assert.equal(torrent.bitfield.get(4), true)
})

test('an empty bitfield completes an empty probe without claiming downloaded data', async () => {
  const torrent = fixture()
  installTorrentVerification(torrent)
  await bitfieldPass(torrent)
  assert.deepEqual(torrent.reads, [])
  assert.deepEqual(torrent._ternVerification, { active: false, checked: 0, total: 0, bytes: 0, totalBytes: 0, phase: 'probe' })
})

test('closing a scan cancels it once and ignores late reads', async () => {
  const callbacks = []
  const torrent = fixture({ get (_index, _opts, cb) { callbacks.push(cb) } })
  installTorrentVerification(torrent)
  let calls = 0
  const complete = new Promise((resolve) => torrent._verifyPiecesUsingHash(torrent.pieces, (err) => { calls++; resolve(err) }))
  await immediate()
  assert.equal(callbacks.length, 2)
  torrent.destroyed = true
  torrent.emit('close')
  assert.match((await complete).message, /torrent is destroyed/)
  for (const callback of callbacks) callback(null, Buffer.from('abcd'))
  await immediate()
  assert.equal(calls, 1)
  assert.deepEqual(torrent.marks, [])
  assert.equal(torrent._ternVerification.active, false)
  assert.equal(torrent.listenerCount('close'), 0)
})

test('destroying before a digest finishes cannot verify a piece', async () => {
  const torrent = fixture()
  installTorrentVerification(torrent)
  const complete = new Promise((resolve) => torrent._verifyPiece(0, (err, valid) => resolve({ err, valid })))
  torrent.destroyed = true
  const { err, valid } = await complete
  assert.match(err.message, /torrent is destroyed/)
  assert.equal(valid, undefined)
  assert.deepEqual(torrent.marks, [])
})

test('a thrown store error finishes the pass once and removes cancellation hooks', async () => {
  const torrent = fixture({ get () { throw new Error('store read failed') } })
  installTorrentVerification(torrent)
  await assert.rejects(hashPass(torrent), /store read failed/)
  assert.equal(torrent._ternVerification.active, false)
  assert.equal(torrent._ternVerification.checked, 0)
  assert.equal(torrent.listenerCount('close'), 0)
})

test('a shared budget spaces hashes fairly across torrents and preserves data', async () => {
  const budget = createVerificationBudget(200)
  const started = performance.now()
  const reads = []
  const marks = []
  const buffers = [Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('ij')]
  const make = (id) => fixture({
    buffers,
    get (index, _opts, cb) {
      reads.push({ id, index, at: performance.now() - started })
      queueMicrotask(() => cb(null, buffers[index]))
    }
  })
  const a = make('a')
  const b = make('b')
  a.on('verified', (index) => marks.push({ id: 'a', index, at: performance.now() - started }))
  b.on('verified', (index) => marks.push({ id: 'b', index, at: performance.now() - started }))
  installTorrentVerification(a, { budget })
  installTorrentVerification(b, { budget })
  await Promise.all([hashPass(a), hashPass(b)])
  assert.equal(reads.length, 6)
  assert.ok(marks.at(-1).at >= 40, `shared 200 B/s budget did not pace hashes (${marks.at(-1).at} ms)`)
  assert.ok(marks.findIndex((read) => read.id === 'b') < marks.findIndex((read) => read.id === 'a' && read.index === 2), 'one torrent must not monopolise the budget')
  assert.equal(a._ternVerification.checked, 3)
  assert.equal(b._ternVerification.checked, 3)
  assert.ok(a.pieces.every((piece) => piece === null))
  assert.ok(b.pieces.every((piece) => piece === null))
  assert.equal(budget.pending, 0)
})

test('closing a paced verification releases waiting hash buffers and removes timers', async () => {
  const budget = createVerificationBudget(1)
  const torrent = fixture()
  installTorrentVerification(torrent, { budget })
  const complete = hashPass(torrent)
  // Attach before cancellation to avoid treating the expected error as an
  // unhandled rejection while checking the synchronous cleanup assertions.
  const rejected = assert.rejects(complete, /torrent is destroyed/)
  await immediate()
  assert.ok(budget.pending > 0)
  torrent.destroyed = true
  torrent.emit('close')
  await rejected
  assert.equal(budget.pending, 0)
  assert.equal(torrent.listenerCount('close'), 0)
  assert.equal(torrent.reads.length, VERIFY_CONCURRENCY)
  assert.equal(torrent._ternVerification.active, false)
})

test('a 150 GiB missing-data scan bypasses a one-byte-per-second budget', { timeout: 5000 }, async (t) => {
  const budget = createVerificationBudget(1)
  t.after(() => budget.setRate(0))
  const count = 38_400
  const torrent = fixture({ buffers: Array(count).fill(null) })
  torrent.pieceLength = 4 * 1024 * 1024
  torrent.lastPieceLength = torrent.pieceLength
  installTorrentVerification(torrent, { budget })
  const started = performance.now()
  await hashPass(torrent)
  assert.ok(performance.now() - started < 3000, 'absent data was charged as a full read')
  assert.equal(torrent._ternVerification.checked, count)
  assert.equal(torrent._ternVerification.bytes, 150 * 1024 ** 3)
  assert.equal(torrent._ternVerification.totalBytes, 150 * 1024 ** 3)
  assert.equal(budget.pending, 0)
  assert.ok(torrent.marks.every(([, valid]) => valid === false))
})

test('a mixed scan charges only buffers actually read, including a short final piece', async () => {
  const budget = createVerificationBudget(10_000)
  const sizes = []
  const schedule = budget.schedule
  budget.schedule = (bytes, run) => { sizes.push(bytes); return schedule(bytes, run) }
  const torrent = fixture({ buffers: [Buffer.from('abcd'), null, Buffer.from('ij')] })
  installTorrentVerification(torrent, { budget })
  await hashPass(torrent)
  assert.deepEqual(sizes, [4, 2])
  assert.equal(torrent._ternVerification.checked, 3)
  assert.equal(torrent._ternVerification.bytes, 10, 'checking counters still include the missing attempt')
  assert.deepEqual(torrent.marks.sort((a, b) => a[0] - b[0]), [[0, true], [1, false], [2, true]])
})

test('small pieces share a byte window instead of paying a Windows timer per hash', async () => {
  const size = 16 * 1024
  const buffer = Buffer.alloc(size, 0x61)
  const torrent = fixture({ buffers: Array(256).fill(buffer) })
  torrent.pieceLength = size
  torrent.lastPieceLength = size
  const budget = createVerificationBudget(256 * 1024 * 1024)
  installTorrentVerification(torrent, { budget })
  const started = performance.now()
  await hashPass(torrent)
  const elapsed = performance.now() - started
  // The old per-piece Windows timeout took roughly 1.4 seconds for 4 MiB.
  // This broad functional guard detects that timer cliff, not disk speed.
  assert.ok(elapsed < 200, `small pieces paid per-hash timer overhead (${elapsed} ms)`)
  assert.equal(torrent._ternVerification.bytes, 4 * 1024 * 1024)
  assert.equal(budget.pending, 0)
})

test('changing the budget to unlimited immediately releases old waiting reads', async () => {
  const budget = createVerificationBudget(1)
  const torrent = fixture()
  installTorrentVerification(torrent, { budget })
  const complete = hashPass(torrent)
  await immediate()
  assert.ok(budget.pending > 0)
  const changed = performance.now()
  budget.setRate(0)
  await complete
  assert.ok(performance.now() - changed < 500, 'old low-rate deadlines survived setRate(0)')
  assert.equal(torrent._ternVerification.checked, 3)
  assert.equal(budget.pending, 0)
})

test('nonpositive and nonfinite budget rates are unlimited', () => {
  const budget = createVerificationBudget(-1)
  for (const rate of [0, -1, Infinity, NaN]) {
    budget.setRate(rate)
    let called = false
    const cancel = budget.schedule(4, () => { called = true })
    assert.equal(called, true)
    cancel()
    assert.equal(budget.pending, 0)
  }
})

test('real WebTorrent installs on metadata before its initial verification and ready', async (t) => {
  const [{ default: WebTorrent }, { default: createTorrent }] = await Promise.all([import('webtorrent'), import('create-torrent')])
  const pieceLength = 16 * 1024
  const content = Buffer.alloc(pieceLength * 3 + 17, 0x6a)
  content.name = 'verification.bin'
  const metadata = await new Promise((resolve, reject) => createTorrent(content, { name: 'verification.bin', pieceLength, announceList: [] }, (err, bytes) => err ? reject(err) : resolve(bytes)))
  class ReadOnlyFixtureStore {
    constructor (chunkLength) { this.chunkLength = chunkLength }
    get (index, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      const offset = index * this.chunkLength + (opts.offset || 0)
      const length = opts.length || Math.min(this.chunkLength, content.length - offset)
      queueMicrotask(() => cb(null, content.subarray(offset, offset + length)))
    }
    put (_index, _buffer, cb) { queueMicrotask(() => cb(new Error('fixture is read only'))) }
    close (cb) { queueMicrotask(() => cb(null)) }
    destroy (cb) { queueMicrotask(() => cb(null)) }
  }
  const client = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false })
  t.after(() => new Promise((resolve) => client.destroy(resolve)))
  const torrent = client.add(metadata, { store: ReadOnlyFixtureStore, storeCacheSlots: 0, deselect: true })
  let installed = false
  let markedBeforeReady = 0
  torrent.on('metadata', () => { installed = installTorrentVerification(torrent) })
  torrent.on('verified', () => { assert.equal(torrent.ready, false); markedBeforeReady++ })
  await new Promise((resolve, reject) => {
    torrent.once('ready', resolve)
    torrent.once('error', reject)
  })
  assert.equal(installed, true)
  assert.equal(markedBeforeReady, 4)
  assert.deepEqual(torrent._ternVerification, { active: false, checked: 4, total: 4, bytes: content.length, totalBytes: content.length, phase: 'full' })
  assert.ok(torrent.pieces.every((piece) => piece === null))
  for (let index = 0; index < 4; index++) assert.equal(torrent.bitfield.get(index), true)
})
