'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { measureTorrentProgress } = require('../src/main/progress')
const { pieceMap } = require('../src/main/pieces')
const { installTorrentOptimizations, REFILL_DELAY_MS } = require('../src/main/torrent-tuning')
const { Engine } = require('../src/main/engine')

test('shared progress accounts for aligned files, shared boundary pieces and empty files', () => {
  const torrent = {
    pieceLength: 10, lastPieceLength: 5, length: 25,
    pieces: [null, null, { missing: 3 }], bitfield: { get: (i) => i < 2 },
    files: [{ offset: 0, length: 10 }, { offset: 10, length: 4 }, { offset: 14, length: 11 }, { offset: 25, length: 0 }]
  }
  assert.deepEqual(measureTorrentProgress(torrent, 360), { files: [10, 4, 8, 0], pieces: '990' })
  torrent.pieces[2] = null
  torrent.bitfield.get = () => true
  assert.deepEqual(measureTorrentProgress(torrent, 360).files, [10, 4, 11, 0])
})

test('shared progress matches an independent byte-overlap oracle for verified pieces', () => {
  for (let n = 1; n <= 90; n++) {
    const pieceLength = 17
    const length = n * pieceLength - n % 13
    const count = Math.ceil(length / pieceLength)
    const has = (i) => (i * 7 + n) % 5 < 3
    const files = []
    let offset = 0
    while (offset < length) {
      const size = Math.min(length - offset, 1 + (offset * 3 + n) % 61)
      files.push({ offset, length: size })
      offset += size
    }
    const torrent = { length, pieceLength, lastPieceLength: length - (count - 1) * pieceLength,
      pieces: Array.from({ length: count }, (_, i) => has(i) ? null : { missing: i === count - 1 ? length - i * pieceLength : pieceLength }),
      bitfield: { get: has }, files }
    const expected = files.map((f) => {
      let bytes = 0
      for (let i = 0; i < count; i++) {
        if (has(i)) bytes += Math.max(0, Math.min(f.offset + f.length, length, (i + 1) * pieceLength) - Math.max(f.offset, i * pieceLength))
      }
      return bytes
    })
    const measured = measureTorrentProgress(torrent, 13)
    assert.deepEqual(measured.files, expected)
    assert.equal(measured.pieces, pieceMap(has, count, 13))
  }
})

test('list and Files tab share one piece scan; a ready transition invalidates the cache', () => {
  const engine = new Engine({ stateStore: {}, defaultDir: 'C:\\dl' })
  let reads = 0
  const live = { ready: false, length: 20, pieceLength: 10, lastPieceLength: 10,
    pieces: [null, { missing: 10 }], files: [{ offset: 0, length: 20 }],
    bitfield: { get: (i) => { reads++; return i === 0 } } }
  const entry = engine._fromRecord({ id: 'a'.repeat(40), length: 20, pieceLength: 10, pieceCount: 2,
    files: [{ path: 'file.bin', length: 20 }], selected: [true] })
  entry.live = live
  engine.entries.set(entry.id, entry)
  assert.equal(engine.files(entry.id)[0].progress, 0)
  live.ready = true
  assert.equal(engine.files(entry.id)[0].progress, 0.5)
  const afterReady = reads
  engine._progressCache(entry, true)
  engine.files(entry.id)
  assert.equal(reads, afterReady, 'no second full scan in the same update interval')
})

async function modelTorrent (length = 6, files = [[0, 2], [2, 5]]) {
  const { default: Torrent } = await import('webtorrent/lib/torrent.js')
  const torrent = new EventEmitter()
  const verified = new Set()
  Object.assign(torrent, { destroyed: false, done: false,
    pieces: Array.from({ length }, () => ({})), _reservations: Array(length), pieceLength: 1, lastPieceLength: 1,
    bitfield: { get: (i) => verified.has(i), set: (i, value) => value ? verified.add(i) : verified.delete(i) },
    files: files.map(([start, end]) => Object.assign(new EventEmitter(), {
      _startPiece: start, _endPiece: end, done: false, name: 'file', includes: (i) => i >= start && i <= end
    })),
    wires: [], _startAsDeselected: true, _debug: () => {}, gc: 0, updates: 0, announces: 0,
    _gcSelections () { this.gc++ }, _update () { this.updates++ },
    discovery: { complete: () => torrent.announces++, tracker: { start: () => torrent.announces++ } },
    _checkDone: Torrent.prototype._checkDone, _markUnverified: Torrent.prototype._markUnverified,
    _updateWireInterest: Torrent.prototype._updateWireInterest
  })
  return { torrent, verified }
}

test('completion keeps file/torrent events, shared boundaries and invalidated pieces correct', async () => {
  const { torrent, verified } = await modelTorrent()
  installTorrentOptimizations(torrent)
  let done = 0
  let filesDone = 0
  torrent.on('done', () => done++)
  for (const f of torrent.files) f.on('done', () => filesDone++)
  for (const i of [5, 2, 0, 1, 4, 3]) {
    verified.add(i)
    torrent.pieces[i] = null
    torrent._checkDone()
  }
  assert.equal(filesDone, 2)
  assert.equal(done, 1)
  assert.equal(torrent.announces, 1)
  assert.equal(torrent.gc, 6)
  torrent._markUnverified(2)
  assert.deepEqual(torrent.files.map((f) => f.done), [false, false], 'shared piece invalidates both files')
  assert.equal(torrent._checkDone(), false)
  assert.equal(torrent.done, false)
  verified.add(2)
  torrent.pieces[2] = null
  torrent._checkDone()
  assert.equal(filesDone, 4)
  assert.equal(done, 2)
})

test('large sequential completion scans the verified prefix once, rather than once per piece', async () => {
  const { torrent, verified } = await modelTorrent(10000, [[0, 9999]])
  let reads = 0
  torrent.bitfield.get = (i) => { reads++; return verified.has(i) }
  installTorrentOptimizations(torrent)
  for (let i = 0; i < 9999; i++) {
    verified.add(i)
    torrent.pieces[i] = null
    torrent._checkDone()
  }
  assert.ok(reads < 21000, `bounded scan count: ${reads}`)
  assert.equal(torrent.done, false)
})

test('peer refills have a bounded batch window and a destroyed torrent never refills', async () => {
  const { torrent } = await modelTorrent()
  assert.equal(installTorrentOptimizations(torrent), true)
  assert.equal(installTorrentOptimizations(torrent), false)
  for (let i = 0; i < 4000; i++) torrent._update()
  assert.equal(torrent.updates, 0)
  await new Promise((resolve) => setTimeout(resolve, REFILL_DELAY_MS + 5))
  assert.equal(torrent.updates, 1)
  torrent._update()
  torrent.destroyed = true
  torrent.emit('close')
  await new Promise((resolve) => setTimeout(resolve, REFILL_DELAY_MS + 5))
  assert.equal(torrent.updates, 1)
})

test('peer interest skips the verified prefix but rewinds when an earlier piece becomes missing', async () => {
  const { torrent, verified } = await modelTorrent()
  installTorrentOptimizations(torrent)
  for (const i of [0, 1, 2, 3]) { verified.add(i); torrent.pieces[i] = null }
  const reads = []
  let interested = false
  const wire = { peerPieces: { get: (i) => { reads.push(i); return i === 1 } },
    interested: () => { interested = true }, uninterested: () => { interested = false } }
  torrent._updateWireInterest(wire)
  assert.equal(interested, false)
  assert.deepEqual(reads, [4, 5])
  torrent._markUnverified(1)
  torrent._updateWireInterest(wire)
  assert.equal(interested, true)
  assert.equal(reads.at(-1), 1)
})
