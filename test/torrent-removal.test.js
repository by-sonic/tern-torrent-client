'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readTorrentFile, readImportedTorrent, resolveLocalPath, validateTrashTarget, inspectPath, safeLocalPath, cleanSourceTorrent, pruneEmptyDirectories } = require('../src/main/torrent-removal')
const { MAX_TORRENT_FILE_BYTES } = require('../src/main/input')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-removal-helper-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('tern-removal-helper-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('bounded source reads reject directories, oversized files, missing files and changed receipts', async (t) => {
  const root = fixture(t)
  const target = path.join(root, 'source.torrent')
  fs.writeFileSync(target, 'fixture')
  const read = await readTorrentFile(target)
  assert.equal(read.status, 'ready')
  assert.equal(read.buffer.toString(), 'fixture')
  const source = { kind: 'source', path: target, sha256: read.sha256, identity: read.identity }
  assert.equal((await validateTrashTarget(source)).status, 'ready')
  fs.writeFileSync(target, 'changed bytes')
  assert.equal((await validateTrashTarget(source)).status, 'unsafe')
  fs.truncateSync(target, MAX_TORRENT_FILE_BYTES + 1)
  assert.equal((await readTorrentFile(target)).status, 'unsafe')
  assert.equal((await readTorrentFile(root)).status, 'unsafe')
  assert.equal((await readTorrentFile(path.join(root, 'missing.torrent'))).status, 'missing')
})

test('an identical replacement still fails a captured filesystem identity', async (t) => {
  const root = fixture(t)
  const target = path.join(root, 'source.torrent')
  fs.writeFileSync(target, 'same bytes')
  const read = await readTorrentFile(target)
  const replacement = path.join(root, 'replacement.torrent')
  fs.writeFileSync(replacement, 'same bytes')
  fs.rmSync(target); fs.renameSync(replacement, target)
  assert.equal((await validateTrashTarget({ kind: 'source', path: target, sha256: read.sha256, identity: read.identity })).status, 'unsafe')
})

test('content targets reject traversal, changed identity, final links and junction ancestors', async (t) => {
  const root = fixture(t)
  const downloads = path.join(root, 'downloads')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(downloads); fs.mkdirSync(outside)
  const target = path.join(downloads, 'a.bin')
  fs.writeFileSync(target, 'own file')
  const checked = await inspectPath(target)
  assert.equal((await validateTrashTarget({ kind: 'content', root: downloads, path: target, identity: checked.identity })).status, 'ready')
  fs.writeFileSync(target, 'external replacement')
  assert.equal((await validateTrashTarget({ kind: 'content', root: downloads, path: target, identity: checked.identity })).status, 'unsafe')
  fs.writeFileSync(path.join(outside, 'keep.bin'), 'unrelated')
  assert.equal((await validateTrashTarget({ kind: 'content', root: downloads, path: path.join(outside, 'keep.bin') })).status, 'unsafe')
  const link = path.join(downloads, 'linked')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await validateTrashTarget({ kind: 'content', root: downloads, path: path.join(link, 'keep.bin') })).status, 'unsafe')
  assert.equal((await readTorrentFile(path.join(link, 'keep.bin'))).status, 'unsafe')
  const imported = await readImportedTorrent(path.join(link, 'keep.bin'))
  assert.equal(imported.status, 'ready', 'read-only import preserves local junction support')
  assert.equal(imported.path, await fs.promises.realpath(path.join(outside, 'keep.bin')))
  fs.rmSync(link)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.bin'), 'utf8'), 'unrelated')
})

test('read-only alias resolution rejects cyclic and remote junction targets before reading file contents', async (t) => {
  const root = fixture(t)
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  fs.symlinkSync(second, first, process.platform === 'win32' ? 'junction' : 'dir')
  fs.symlinkSync(first, second, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await resolveLocalPath(path.join(first, 'source.torrent'))).status, 'unsafe')
  fs.rmSync(first); fs.rmSync(second)
  if (process.platform === 'win32') {
    const remote = path.join(root, 'remote')
    fs.mkdirSync(remote)
    const readlink = fs.promises.readlink
    const lstat = fs.promises.lstat
    let followedRemote = false
    fs.promises.readlink = async (target) => target === remote ? '\\\\?\\UNC\\fixture-host\\share' : readlink(target)
    fs.promises.lstat = async (target, options) => {
      if (target === remote) followedRemote = true
      return lstat(target, options)
    }
    try {
      assert.equal((await resolveLocalPath(path.join(remote, 'source.torrent'))).status, 'unsafe')
      assert.equal(followedRemote, false, 'remote reparse destination is rejected before metadata following')
    } finally { fs.promises.readlink = readlink; fs.promises.lstat = lstat }
  }
})

test('empty-directory cleanup never traverses junctions or removes the download root', async (t) => {
  const root = fixture(t)
  const downloads = path.join(root, 'downloads')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(downloads, 'empty'), { recursive: true }); fs.mkdirSync(path.join(outside, 'empty'), { recursive: true })
  const link = path.join(downloads, 'linked')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await pruneEmptyDirectories(downloads, [path.join(downloads, 'empty', 'gone.bin'), path.join(link, 'empty', 'gone.bin')])
  assert.ok(fs.existsSync(downloads))
  assert.ok(!fs.existsSync(path.join(downloads, 'empty')))
  assert.ok(fs.existsSync(path.join(outside, 'empty')))
  fs.rmSync(link)
})

test('source records project only validated receipt fields and Windows paths reject native aliases', () => {
  const source = cleanSourceTorrent({ path: path.join(os.tmpdir(), 'fixture.torrent'), sha256: 'a'.repeat(64), identity: { dev: '1', ino: '2', size: 7, mtimeMs: 1, ctimeMs: 1, arbitrary: 'discard' } })
  assert.equal(source.identity.arbitrary, undefined)
  assert.equal(cleanSourceTorrent({ path: '../relative.torrent', sha256: 'a'.repeat(64) }), null)
  assert.equal(cleanSourceTorrent({ path: path.join(os.tmpdir(), 'fixture.torrent'), sha256: { toString: 'bad' } }), null)
  assert.equal(safeLocalPath(path.join(os.tmpdir(), 'bad\0.torrent')), false)
  if (process.platform === 'win32') {
    for (const target of ['C:\\Downloads\\a.bin:stream.torrent', 'C:\\Downloads\\a.bin.', 'C:\\Downloads\\a.bin ', '\\\\?\\C:\\Downloads\\a.torrent', '\\\\server\\share\\a.torrent']) assert.equal(safeLocalPath(target), false)
  }
})
