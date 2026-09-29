'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyInput, extractLaunchInputs } = require('../src/main/input')
const { planQueue, moveId } = require('../src/main/queue')
const { pieceMap, bitfieldReader } = require('../src/main/pieces')

const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a'

test('classifyInput accepts magnet links and bare info hashes', () => {
  assert.deepEqual(classifyInput(`magnet:?xt=urn:btih:${HASH}&dn=Test`), { kind: 'magnet', uri: `magnet:?xt=urn:btih:${HASH}&dn=Test` })
  assert.equal(classifyInput(HASH).kind, 'magnet')
  assert.equal(classifyInput(`  "magnet:?xt=urn:btih:${HASH}"  `).kind, 'magnet')
})

test('classifyInput accepts local .torrent paths only', () => {
  assert.deepEqual(classifyInput('C:\\Downloads\\Ubuntu.TORRENT'), { kind: 'file', path: 'C:\\Downloads\\Ubuntu.TORRENT' })
  assert.equal(classifyInput('https://example.com/a.torrent'), null)
  assert.equal(classifyInput('file:///etc/a.torrent'), null)
})

test('classifyInput rejects junk', () => {
  for (const bad of ['', 'hello', 'magnet:?dn=x', 'magnet:?xt=urn:btih:zzz', 42, null, 'a'.repeat(9000)]) {
    assert.equal(classifyInput(bad), null)
  }
})

test('extractLaunchInputs skips flags and the app path', () => {
  const argv = ['tern.exe', '--hidden', 'C:\\a.torrent', `magnet:?xt=urn:btih:${HASH}`, '--flag']
  assert.deepEqual(extractLaunchInputs(argv).map((i) => i.kind), ['file', 'magnet'])
})

test('planQueue limits unfinished torrents and skips paused ones', () => {
  const entries = [
    { id: 'a', order: 0, paused: false, done: false },
    { id: 'b', order: 1, paused: true, done: false },
    { id: 'c', order: 2, paused: false, done: false },
    { id: 'd', order: 3, paused: false, done: false }
  ]
  assert.deepEqual([...planQueue(entries, { maxActive: 2, seed: true })].sort(), ['a', 'c'])
})

test('planQueue seeds finished torrents without using a slot, or not at all', () => {
  const entries = [
    { id: 'done', order: 0, paused: false, done: true },
    { id: 'a', order: 1, paused: false, done: false }
  ]
  assert.deepEqual([...planQueue(entries, { maxActive: 1, seed: true })].sort(), ['a', 'done'])
  assert.deepEqual([...planQueue(entries, { maxActive: 1, seed: false })], ['a'])
})

test('moveId moves within bounds and never mutates the input', () => {
  const ids = ['a', 'b', 'c']
  assert.deepEqual(moveId(ids, 'c', 'top'), ['c', 'a', 'b'])
  assert.deepEqual(moveId(ids, 'a', 'up'), ['a', 'b', 'c'])
  assert.deepEqual(moveId(ids, 'a', 'down'), ['b', 'a', 'c'])
  assert.deepEqual(moveId(ids, 'zzz', 'top'), ['a', 'b', 'c'])
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('pieceMap reports how complete each slice is', () => {
  const done = new Set([0, 1, 2, 3])
  assert.equal(pieceMap((i) => done.has(i), 8, 4), '9900')
  assert.equal(pieceMap(() => true, 100, 10), '9999999999')
  assert.equal(pieceMap(() => false, 3, 10), '000')
  assert.equal(pieceMap(() => true, 0, 10), '')
})

test('bitfieldReader reads MSB-first bits', () => {
  const has = bitfieldReader(Buffer.from([0b10100000]).toString('base64'))
  assert.deepEqual([0, 1, 2, 3, 100].map(has), [true, false, true, false, false])
  assert.equal(bitfieldReader(null)(0), false)
})
