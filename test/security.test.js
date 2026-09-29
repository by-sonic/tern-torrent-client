'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyInput, extractLaunchInputs } = require('../src/main/input')
const { mergeSettings, cleanRecord } = require('../src/main/engine')

test('classifyInput refuses UNC and relative .torrent paths', () => {
  const bad = ['\\\\attacker\\share\\x.torrent', '//attacker/share/x.torrent', '\\\\?\\UNC\\host\\s\\x.torrent', 'relative\\x.torrent', 'x.torrent']
  for (const value of bad) assert.equal(classifyInput(value), null, value)
})

test('extractLaunchInputs resolves a relative .torrent argument against the working directory', () => {
  const [input] = extractLaunchInputs(['tern.exe', 'a.torrent'], 'C:\\Users\\me\\Downloads')
  assert.equal(input.kind, 'file')
  assert.match(input.path, /Downloads[\\/]a\.torrent$/)
  assert.deepEqual(extractLaunchInputs(['tern.exe', '\\\\host\\s\\a.torrent'], 'C:\\x'), [])
})

test('mergeSettings clamps numbers, checks types and ignores junk', () => {
  const base = { downloadDir: 'C:\\dl', downLimitKB: 0, upLimitKB: 0, maxActive: 3, seedAfterDone: true, closeToTray: true, launchAtLogin: false }
  const next = mergeSettings(base, { downLimitKB: -5, upLimitKB: '512', maxActive: 999, seedAfterDone: 'no', evil: 1, downloadDir: '\\\\host\\share' })
  assert.deepEqual(next, { ...base, upLimitKB: 512, maxActive: 20 })
  assert.equal(mergeSettings(base, { maxActive: 'abc' }).maxActive, 1)
})

test('cleanRecord rejects bad ids and repairs bad fields', () => {
  const good = 'a'.repeat(40)
  assert.equal(cleanRecord({ id: '../../x' }, 'C:\\dl'), null)
  assert.equal(cleanRecord(null, 'C:\\dl'), null)
  const record = cleanRecord({ id: good, name: 42, path: 'relative', files: 'nope', selected: [true], bitfield: 7, order: 'x' }, 'C:\\dl')
  assert.equal(record.name, good)
  assert.equal(record.path, 'C:\\dl')
  assert.equal(record.files, null)
  assert.equal(record.selected, null)
  assert.equal(record.bitfield, null)
  assert.equal(record.order, 0)
})
