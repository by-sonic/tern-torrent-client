'use strict'

// `node scripts/verification-smoke.js` owns cleanup after Electron exits.
// TERN_SMOKE_APP_ROOT loads the engine from a packaged app.asar as well.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const PREFIX = 'tern-verification-smoke-'
const TIMEOUT_MS = 30_000

function disposableRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
}

function validateRoot (root) {
  const temp = fs.realpathSync(os.tmpdir())
  const absolute = fs.realpathSync(root)
  assert.equal(path.dirname(absolute).toLowerCase(), temp.toLowerCase(), 'smoke directory must be directly inside Temp')
  assert.ok(path.basename(absolute).startsWith(PREFIX), 'unexpected smoke directory name')
  return absolute
}

if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const root = disposableRoot()
  const env = { ...process.env, TERN_VERIFICATION_SMOKE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; electron.kill() }, TIMEOUT_MS)
  electron.once('error', (err) => { console.error(err.stack); process.exitCode = 1 })
  electron.once('close', (code, signal) => {
    clearTimeout(timer)
    process.exitCode = timedOut || signal ? 1 : code || process.exitCode || 0
    if (timedOut) console.error('VERIFICATION_SMOKE_TIMEOUT')
    try {
      // The target is exactly the directory created by this launcher. Never
      // enumerate arbitrary Temp paths or remove a directory while Electron
      // still holds its profile files open.
      fs.rmSync(validateRoot(root), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (err) {
      console.error(`VERIFICATION_SMOKE_CLEANUP_FAILED ${root}: ${err.message}`)
      process.exitCode = 1
    }
  })
} else {
  const { app } = require('electron')
  const crypto = require('node:crypto')
  const { performance } = require('node:perf_hooks')
  const { pathToFileURL } = require('node:url')
  const appRoot = process.env.TERN_SMOKE_APP_ROOT || process.env.TERN_SMOKE_PACKAGE || path.join(__dirname, '..')
  const { EngineService } = require(path.join(appRoot, 'src/main/engine-service'))
  const root = validateRoot(process.env.TERN_VERIFICATION_SMOKE_ROOT || disposableRoot())
  const downloads = path.join(root, 'downloads')
  const userData = path.join(root, 'profile')
  const stateFile = path.join(userData, 'state.json')
  const OFFLINE = { dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
  fs.mkdirSync(downloads)
  fs.mkdirSync(userData)
  fs.mkdirSync(path.join(userData, 'torrents'))
  app.setPath('userData', path.join(root, 'electron-profile'))
  let engine
  let timer

  async function startService () {
    engine = new EngineService({
      userData, defaultDir: downloads, clientOptions: OFFLINE,
      trash: async () => { throw new Error('verification smoke must not trash files') }
    })
    await engine.init()
    engine.setObserved(true)
  }

  async function waitFor (id, predicate, label) {
    const until = performance.now() + 10_000
    while (performance.now() < until) {
      const started = performance.now()
      const snapshot = await engine.snapshot()
      assert.ok(performance.now() - started < 5000, 'snapshot RPC became unresponsive during verification')
      const torrent = snapshot.torrents.find((item) => item.id === id)
      if (torrent && predicate(torrent)) return torrent
      // One outstanding RPC at a time. Allow Electron to process native events
      // rather than filling EngineService's bounded pending-request map.
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error(`verification smoke timed out waiting for ${label}`)
  }

  const partial = (torrent) => torrent.state === 'checking' && torrent.verification?.checked > 0 && torrent.verification.checked < torrent.verification.total
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

  app.whenReady().then(async () => {
    console.log(`VERIFICATION_SMOKE_ROOT ${root}`)
    timer = setTimeout(() => { console.error('VERIFICATION_SMOKE_TIMEOUT'); app.exit(1) }, TIMEOUT_MS - 1000)
    const [{ default: createTorrent }, { default: parseTorrent }] = await Promise.all(
      // These pinned packages export only the ESM import condition. CommonJS
      // require.resolve cannot select it; load their official index.js entries
      // from the selected source or packaged app root instead.
      ['create-torrent', 'parse-torrent'].map((name) => import(pathToFileURL(path.join(appRoot, 'node_modules', name, 'index.js')).href))
    )
    const content = crypto.randomBytes(32 * 1024 * 1024)
    content.name = 'fixture.bin'
    const expectedDigest = digest(content)
    const source = path.join(downloads, 'fixture.bin')
    fs.writeFileSync(source, content)
    const torrentBytes = await new Promise((resolve, reject) => createTorrent(content, {
      name: 'fixture.bin', pieceLength: 16 * 1024, announceList: []
    }, (err, bytes) => err ? reject(err) : resolve(bytes)))
    const parsed = await parseTorrent(torrentBytes)
    const id = parsed.infoHash
    fs.writeFileSync(path.join(userData, 'torrents', `${id}.torrent`), torrentBytes)
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      settings: { downloadDir: downloads, maxActive: 1, seedAfterDone: false, autoUpdate: false },
      torrents: [{
        id, name: parsed.name, path: downloads, magnet: null,
        length: parsed.length, pieceLength: parsed.pieceLength, pieceCount: parsed.pieces.length,
        files: parsed.files.map(({ path: filePath, length }) => ({ path: filePath, length })),
        selected: parsed.files.map(() => true), bitfield: null, fp: null,
        progressBytes: 0, paused: false, done: false, trackers: [], order: 0, createdAt: Date.now()
      }]
    }))
    assert.equal(parsed.pieces.length, 2048)

    // Verify changing counters across the real utility-process RPC boundary.
    await startService()
    const first = await waitFor(id, partial, 'partial verification')
    const second = await waitFor(id, (torrent) => partial(torrent) && torrent.verification.checked > first.verification.checked, 'advancing verification counters')
    assert.equal(second.progress, 0, 'checked attempts must not become downloaded bytes')
    assert.ok(second.verification.bytes > first.verification.bytes)
    const pauseStart = performance.now()
    await engine.pause(id)
    const pauseMs = performance.now() - pauseStart
    assert.ok(pauseMs < 5000, 'pause RPC became unresponsive during verification')
    await waitFor(id, (torrent) => torrent.state === 'paused', 'paused verification')
    await engine.shutdown()
    engine = null
    const paused = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(paused.torrents[0].paused, true)
    assert.equal(paused.torrents[0].bitfield, null, 'unfinished verification must not persist optimistic trust')
    paused.torrents[0].paused = false
    fs.writeFileSync(stateFile, JSON.stringify(paused))

    // Shutdown must also settle while verification reads/hashes are pending.
    await startService()
    await waitFor(id, partial, 'verification before shutdown')
    const shutdownStart = performance.now()
    await engine.shutdown()
    const shutdownMs = performance.now() - shutdownStart
    assert.ok(shutdownMs < 5000, 'shutdown did not settle before its 6-second budget')
    engine = null

    // A third clean start completes the same existing data without any swarm.
    await startService()
    const complete = await waitFor(id, (torrent) => torrent.state === 'done' && torrent.progress === 1, 'full existing-data verification')
    assert.equal(complete.verification, null)
    assert.equal(complete.peers, 0)
    assert.equal(complete.down, 0)
    await engine.shutdown()
    engine = null
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.torrents[0].done, true)
    assert.equal(saved.torrents[0].progressBytes, content.length)
    assert.deepEqual(saved.torrents[0].fp, [1])
    assert.deepEqual(Buffer.from(saved.torrents[0].bitfield, 'base64'), Buffer.alloc(parsed.pieces.length / 8, 0xff))
    assert.equal(digest(fs.readFileSync(source)), expectedDigest, 'verification changed fixture data')
    console.log(`VERIFICATION_SMOKE_OK ${JSON.stringify({ bytes: content.length, pieces: parsed.pieces.length, partialCounters: [first.verification.checked, second.verification.checked], pauseMs, shutdownMs, sha256: expectedDigest, packaged: appRoot.endsWith('.asar') })}`)
  }).catch((err) => { console.error(err.stack); process.exitCode = 1 }).finally(async () => {
    clearTimeout(timer)
    try { if (engine) await engine.shutdown() } catch (err) { console.error(err.message); process.exitCode = 1 }
    // The Node launcher cleans the owned directory after this process exits.
    app.exit(process.exitCode || 0)
  })
}
