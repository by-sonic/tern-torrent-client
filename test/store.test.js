'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { JsonStore } = require('../src/main/store')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tern-store-'))

test('saves atomically and loads back', () => {
  const file = path.join(tmp(), 'state.json')
  const store = new JsonStore(file, () => ({ n: 0 }))
  store.saveSoon(() => ({ n: 1 }))
  store.flush()
  assert.deepEqual(new JsonStore(file, () => ({ n: 0 })).load(), { n: 1 })
  assert.ok(!fs.existsSync(`${file}.tmp`))
})

test('a corrupt file is moved aside and the fallback is used', () => {
  const dir = tmp()
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(new JsonStore(file, () => ({ n: 0 })).load(), { n: 0 })
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-')))
})

test('a missing file gives the fallback without moving anything', () => {
  const dir = tmp()
  assert.deepEqual(new JsonStore(path.join(dir, 'state.json'), () => ({ n: 0 })).load(), { n: 0 })
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('a throwing serializer does not crash flush', () => {
  const store = new JsonStore(path.join(tmp(), 'state.json'), () => ({}))
  store.saveSoon(() => { throw new Error('boom') })
  assert.doesNotThrow(() => store.flush())
})
