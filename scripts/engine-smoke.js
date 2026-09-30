'use strict'

// Run with `electron scripts/engine-smoke.js`; uses only a disposable profile and an offline torrent.
// TERN_SMOKE_PACKAGE points at a packaged app.asar for the same native-runtime check after packaging.
if (process.parentPort) {
  const OFFLINE = { dht: false, lsd: false, tracker: true, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
  let seeder
  let tracker
  process.parentPort.on('message', async ({ data }) => {
    try {
      if (data.type === 'seed') {
        const { default: WebTorrent } = await import('webtorrent')
        const { Server } = await import('bittorrent-tracker')
        tracker = new Server({ udp: false, http: true, ws: false, stats: false })
        await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve))
        const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`
        seeder = new WebTorrent(OFFLINE)
        seeder.throttleUpload(1024 * 1024)
        const torrent = await new Promise((resolve) => seeder.seed(data.source, { announce: [announce], pieceLength: 16 * 1024 }, resolve))
        process.parentPort.postMessage({ magnet: `${torrent.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`, torrentFile: Buffer.from(torrent.torrentFile) })
      } else if (data.type === 'stop' && seeder) {
        await new Promise((resolve) => seeder.destroy(resolve))
        await new Promise((resolve) => tracker.close(resolve))
        process.parentPort.postMessage({ stopped: true })
      }
    } catch (err) { process.parentPort.postMessage({ error: err.stack }) }
  })
} else {
const { app, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { monitorEventLoopDelay } = require('node:perf_hooks')
const { EngineService } = require(path.join(process.env.TERN_SMOKE_APP_ROOT || process.env.TERN_SMOKE_PACKAGE || path.join(__dirname, '..'), 'src/main/engine-service'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-engine-smoke-'))
const downloads = path.join(root, 'downloads')
const userData = path.join(root, 'profile')
const originalTorrent = path.join(root, 'fixture.torrent')
const OFFLINE = { dht: false, lsd: false, tracker: true, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
fs.mkdirSync(downloads)
app.setPath('userData', path.join(root, 'electron-profile'))
let engine
let timeout
let seeder
const trashed = []
const loop = monitorEventLoopDelay({ resolution: 10 })

async function waitForState (id, state, predicate = () => true, ms = 15_000) {
  const until = Date.now() + ms
  let last
  while (Date.now() < until) {
    const snapshot = await engine.snapshot()
    const torrent = snapshot.torrents.find((entry) => entry.id === id)
    last = torrent
    if ((!state || torrent?.state === state) && torrent && predicate(torrent)) return torrent
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`smoke state timeout: ${state}; last=${JSON.stringify(last)}`)
}

function startService () {
  engine = new EngineService({
    userData, defaultDir: downloads, clientOptions: OFFLINE,
    trash: async (target) => {
      const original = fs.realpathSync(originalTorrent)
      assert.ok([path.join(downloads, 'fixture.bin'), original].includes(target))
      trashed.push(target)
      await fs.promises.rename(target, path.join(root, target === original ? 'trashed-original.torrent' : 'trashed.bin'))
    }
  })
  return engine.init()
}

app.whenReady().then(async () => {
  console.log(`ENGINE_SMOKE_ROOT ${root}`)
  timeout = setTimeout(() => { console.error('ENGINE_SMOKE_TIMEOUT'); app.exit(1) }, 45_000)
  const source = path.join(root, 'fixture.bin')
  const content = crypto.randomBytes(8 * 1024 * 1024)
  fs.writeFileSync(source, content)
  seeder = utilityProcess.fork(__filename, [], { serviceName: 'Tern smoke loopback seeder', stdio: 'pipe' })
  const seed = await new Promise((resolve, reject) => {
    seeder.once('message', (message) => message.error ? reject(new Error(message.error)) : resolve(message))
    seeder.once('exit', (code) => reject(new Error(`seeder exited: ${code}`)))
    seeder.postMessage({ type: 'seed', source })
  })
  const magnet = seed.magnet
  fs.writeFileSync(originalTorrent, Buffer.from(seed.torrentFile))

  await startService()
  loop.enable()
  assert.equal((await engine.snapshot()).torrents.length, 0)
  await engine.setSettings({ autoUpdate: false, maxActive: 1, downLimitKB: 1234, seedAfterDone: false })
  assert.equal(engine.settings.downLimitKB, 1234)
  engine.setObserved(true)
  const { id } = await engine.add({ kind: 'magnet', uri: magnet })
  await waitForState(id, 'choosing')
  assert.equal((await engine.files(id)).length, 1)
  assert.ok((await engine.info(id)).pieceCount > 1)
  await engine.confirm(id, { selected: [true], dir: downloads })
  await waitForState(id, null, (torrent) => torrent.progress > 0 && torrent.progress < 1)
  await engine.pause(id)
  await waitForState(id, 'paused')
  assert.equal((await engine.add({ kind: 'file', path: originalTorrent })).duplicate, true)
  assert.equal(await engine.contentPath(id), path.join(downloads, 'fixture.bin'))
  await engine.setSelection(id, [true])
  await engine.shutdown()
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.torrents[0].id, id)
  assert.equal(saved.torrents[0].paused, true)
  assert.equal(saved.torrents[0].sourceTorrent.path, fs.realpathSync(originalTorrent))
  assert.ok(saved.torrents[0].progressBytes > 0)

  await startService()
  assert.equal(engine.settings.downLimitKB, 1234)
  await waitForState(id, 'paused')
  await engine.resume(id)
  await waitForState(id, 'done', (torrent) => torrent.progress === 1, 20_000)
  assert.ok(fs.readFileSync(path.join(downloads, 'fixture.bin')).equals(content))
  await engine.pauseAll()
  await waitForState(id, 'paused')
  await engine.move(id, 'top')
  fs.writeFileSync(path.join(downloads, 'keep.txt'), 'unrelated file must survive')
  const removal = await engine.remove(id, { trash: true })
  assert.deepEqual(removal, { removed: true, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 2 })
  assert.equal(trashed.length, 2)
  assert.ok(fs.readFileSync(path.join(root, 'trashed.bin')).equals(content))
  assert.ok(fs.readFileSync(path.join(root, 'trashed-original.torrent')).equals(Buffer.from(seed.torrentFile)))
  assert.ok(!fs.existsSync(originalTorrent))
  assert.ok(!fs.existsSync(path.join(userData, 'torrents', `${id}.torrent`)))
  assert.equal(fs.readFileSync(path.join(downloads, 'keep.txt'), 'utf8'), 'unrelated file must survive')
  assert.equal((await engine.snapshot()).torrents.length, 0)
  await engine.shutdown()
  loop.disable()
  console.log(`ENGINE_SMOKE_MAIN_LOOP ${JSON.stringify({ p99ms: loop.percentile(99) / 1e6, maxms: loop.max / 1e6 })}`)
  console.log('ENGINE_SMOKE_OK utility native runtime, loopback download byte equality, RPC, settings, selection, pause/resume, persisted source restart, exact-file content+original trash and shutdown')
}).catch((err) => { console.error(err.stack); process.exitCode = 1 }).finally(async () => {
  clearTimeout(timeout)
  try { if (engine) await engine.shutdown() } catch {}
  if (seeder) seeder.kill()
  // Electron keeps its profile locked until it exits on Windows. The caller removes ENGINE_SMOKE_ROOT
  // after the process exits; every path here is inside that explicitly printed throwaway directory.
  app.exit(process.exitCode || 0)
})
}
