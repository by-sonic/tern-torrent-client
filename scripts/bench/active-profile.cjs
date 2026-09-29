'use strict'

// Bounded replacement for the historical rarest-first stress test. Never runs
// the old rarest strategy. All peers are loopback, all discovery is disabled.
// node scripts/bench/active-profile.cjs --mode baseline
// node scripts/bench/active-profile.cjs --mode both --profile --out .scratch/active-profile
// Optional: --size-mib 256 (max 256), --piece-kib 4096, --peers 6, --repeat 2.
// Add --electron to run the harness in the app's bundled Node runtime.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const inspector = require('node:inspector')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { monitorEventLoopDelay, performance } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')

const MiB = 1024 * 1024
const TIMEOUT_MS = 45_000
const RATE_LIMIT = 60 * MiB
const TEMP_PREFIX = 'tern-active-profile-'
const OFF = Object.freeze({
  dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false,
  utp: false, webSeeds: false, utPex: false, maxConns: 12
})
const round = (n) => Math.round(n * 1000) / 1000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function belowNormal () {
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
}

function contained (root, candidate) {
  const base = path.resolve(root)
  const target = path.resolve(candidate)
  assert(target !== base && target.startsWith(base + path.sep), 'path outside benchmark root')
  return target
}

function cleanup (root) {
  const base = fs.realpathSync(os.tmpdir())
  const target = fs.realpathSync(root)
  contained(base, target)
  assert(path.basename(target).startsWith(TEMP_PREFIX), 'unexpected temp directory')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function loopbackClient (WebTorrent) {
  // WebTorrent 3 does not expose a listen host. Restrict only the synchronous
  // constructor's listen call, in this disposable benchmark child process.
  const original = net.Server.prototype.listen
  net.Server.prototype.listen = function (port, callback) {
    assert.equal(typeof port, 'number')
    return original.call(this, { port, host: '127.0.0.1' }, callback)
  }
  try { return new WebTorrent(OFF) } finally { net.Server.prototype.listen = original }
}

function baselineOptions (base) {
  // Exact v1.0.2 settings; independent of edits to the current tuning module.
  return { ...base, deselect: true, strategy: 'sequential', storeCacheSlots: 4 }
}

function baselineDropRarity (torrent) {
  if (torrent._rarityMap) torrent._rarityMap.destroy()
  torrent._rarityMap = null
}

function applyMode (torrent, mode) {
  baselineDropRarity(torrent)
  if (mode === 'baseline') return
  const { installTorrentOptimizations } = require('../../src/main/torrent-tuning')
  assert.equal(typeof installTorrentOptimizations, 'function', 'optimized installer missing')
  assert.notEqual(installTorrentOptimizations(torrent), false, 'optimization was not installed')
}

function baselineSelectedBytes (entry, torrent) {
  let bytes = 0
  torrent.files.forEach((file, i) => { if (!entry.selected || entry.selected[i]) bytes += file.downloaded })
  return bytes
}

async function startProfile (enabled) {
  if (!enabled) return async () => null
  const session = new inspector.Session()
  session.connect()
  const post = (method, params = {}) => new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => err ? reject(err) : resolve(result))
  })
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: 1000 })
  await post('Profiler.start')
  return async (output) => {
    const { profile } = await post('Profiler.stop')
    session.disconnect()
    fs.writeFileSync(output, JSON.stringify(profile))
    const sampled = profile.nodes.reduce((sum, node) => sum + (node.hitCount || 0), 0)
    return profile.nodes.filter((node) => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 15).map((node) => ({
      function: node.callFrame.functionName || '(anonymous)',
      source: node.callFrame.url.replace(/^file:\/\//, ''),
      samples: node.hitCount,
      sharePct: round(100 * node.hitCount / sampled)
    }))
  }
}

function digestFile (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function seeder (config) {
  const { default: WebTorrent } = await import('webtorrent')
  const folder = contained(config.root, path.join(config.root, 'seed'))
  fs.mkdirSync(folder)
  const file = contained(config.root, path.join(folder, 'data.bin'))
  const fd = fs.openSync(file, 'wx')
  const block = Buffer.alloc(MiB)
  const hash = crypto.createHash('sha256')
  try {
    for (let i = 0; i < config.sizeMiB; i++) {
      crypto.randomFillSync(block)
      fs.writeSync(fd, block)
      hash.update(block)
    }
  } finally { fs.closeSync(fd) }
  const client = loopbackClient(WebTorrent)
  client.throttleUpload(RATE_LIMIT / config.peers)
  client.on('error', (err) => { console.error(err.message); process.exit(1) })
  const torrent = await new Promise((resolve) => client.seed(file, {
    pieceLength: config.pieceKiB * 1024, announce: [], private: true, storeCacheSlots: 1
  }, resolve))
  const torrentPath = contained(config.root, path.join(config.root, 'input.torrent'))
  fs.writeFileSync(torrentPath, torrent.torrentFile)
  const clients = [client]
  const ports = [client.torrentPort]
  for (let i = 1; i < config.peers; i++) {
    const peer = loopbackClient(WebTorrent)
    peer.throttleUpload(RATE_LIMIT / config.peers)
    peer.on('error', (err) => { console.error(err.message); process.exit(1) })
    await new Promise((resolve, reject) => {
      const seeded = peer.add(torrent.torrentFile, { path: folder, skipVerify: true, storeCacheSlots: 1 })
      seeded.once('ready', resolve)
      seeded.once('error', reject)
    })
    clients.push(peer)
    ports.push(peer.torrentPort)
  }
  process.send({ kind: 'ready', ports, pieces: torrent.pieces.length, digest: hash.digest('hex') })
  process.on('message', async (msg) => {
    if (msg.kind !== 'stop') return
    await Promise.all(clients.map((peer) => new Promise((resolve) => peer.destroy(resolve))))
    process.exit(0)
  })
}

function engineFor (torrent, mode, root) {
  const { Engine } = require('../../src/main/engine')
  const engine = new Engine({
    stateStore: { saveSoon () {}, flush () {} }, torrentsDir: root, defaultDir: root, trash: async () => {}
  })
  const entry = engine._fromRecord({
    id: 'a'.repeat(40), name: torrent.name, path: root, length: torrent.length,
    pieceLength: torrent.pieceLength, pieceCount: torrent.pieces.length,
    files: torrent.files.map((file) => ({ path: file.path, length: file.length })), selected: torrent.files.map(() => true)
  })
  entry.live = torrent
  entry.applied = torrent.files.map(() => true)
  engine.client = { downloadSpeed: 0, uploadSpeed: 0 }
  engine.entries.set(entry.id, entry)
  if (mode === 'baseline') {
    engine._selectedBytes = baselineSelectedBytes
    engine.files = function (id) {
      const target = this.entries.get(id)
      return target.files.map((file, i) => ({
        index: i, path: file.path, length: file.length, selected: true, progress: target.live.files[i].progress
      }))
    }
    engine._progressCache = function (target, isReady) {
      const { pieceMap, bitfieldReader } = require('../../src/main/pieces')
      const ttl = target.pieceCount > 50_000 ? 5000 : 900
      const now = Date.now()
      if (target.cache && now - target.cache.at < ttl) return target.cache
      const live = target.live
      const has = isReady && live.bitfield ? (i) => live.bitfield.get(i) : bitfieldReader(target.bitfield)
      target.cache = { at: now, got: isReady ? this._selectedBytes(target, live) : target.progressBytes, pieces: pieceMap(has, target.pieceCount, 360) }
      return target.cache
    }
  }
  return { engine, entry }
}

async function leecher (config) {
  const { default: WebTorrent } = await import('webtorrent')
  const { loadSparseStore } = require('../../src/main/sparse-store')
  const downloadDir = contained(config.root, path.join(config.root, `download-${config.mode}-${config.run}`))
  fs.mkdirSync(downloadDir)
  const client = loopbackClient(WebTorrent)
  client.throttleDownload(RATE_LIMIT)
  const torrent = client.add(fs.readFileSync(contained(config.root, path.join(config.root, 'input.torrent'))),
    baselineOptions({ path: downloadDir, store: await loadSparseStore() }))
  client.on('error', (err) => { console.error(err.message); process.exit(1) })
  torrent.once('metadata', () => applyMode(torrent, config.mode))
  await new Promise((resolve, reject) => { torrent.once('ready', resolve); torrent.once('error', reject) })
  const { engine } = engineFor(torrent, config.mode, downloadDir)
  const lag = monitorEventLoopDelay({ resolution: 2 })
  lag.enable()
  // Seed the histogram with its resolution before the measured transfer.
  await delay(20)
  lag.reset()
  const stopProfile = await startProfile(config.profile)
  let peakRss = process.memoryUsage().rss
  const samples = []
  let lastBytes = 0
  let lastAt = performance.now()
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const now = performance.now()
    const bytes = torrent.received
    samples.push({ elapsedMs: round(now - started), MiBps: round((bytes - lastBytes) / MiB / ((now - lastAt) / 1000)) })
    lastBytes = bytes
    lastAt = now
  }, 250)
  const snapshots = setInterval(() => engine.snapshot(), 1000)
  const cpu0 = process.cpuUsage()
  const started = performance.now()
  const complete = new Promise((resolve, reject) => { torrent.once('done', resolve); torrent.once('error', reject) })
  torrent.files.forEach((file) => file.select())
  for (const port of config.ports) torrent.addPeer(`127.0.0.1:${port}`)
  await complete
  const elapsedMs = performance.now() - started
  const cpu = process.cpuUsage(cpu0)
  clearInterval(sampler)
  clearInterval(snapshots)
  lag.disable()
  const hotFunctions = await stopProfile(path.join(config.output, `${config.mode}-${config.run}.cpuprofile`))
  await new Promise((resolve) => client.destroy(resolve))
  const digest = await digestFile(contained(config.root, path.join(downloadDir, 'data.bin')))
  assert.equal(digest, config.digest, 'downloaded SHA-256 differs from source')
  const result = {
    mode: config.mode, run: config.run, bytes: config.sizeMiB * MiB, pieces: torrent.pieces.length,
    pieceKiB: config.pieceKiB, peers: config.peers, rateLimitMiBps: RATE_LIMIT / MiB, elapsedMs: round(elapsedMs),
    throughputMiBps: round(config.sizeMiB / (elapsedMs / 1000)),
    cpuSeconds: round((cpu.user + cpu.system) / 1e6), cpuUserSeconds: round(cpu.user / 1e6), cpuSystemSeconds: round(cpu.system / 1e6),
    cpuPctOfOneCore: round(100 * (cpu.user + cpu.system) / (elapsedMs * 1000)),
    lagMs: { p50: round(lag.percentile(50) / 1e6), p95: round(lag.percentile(95) / 1e6), p99: round(lag.percentile(99) / 1e6), max: round(lag.max / 1e6) },
    peakRssMiB: round(peakRss / MiB), sha256Correct: true, speedSamples: samples, hotFunctions
  }
  fs.rmSync(downloadDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  process.send({ kind: 'result', result })
}

async function synthetic (config) {
  const webtorrentRoot = path.dirname(require.resolve('webtorrent'))
  const [{ default: Torrent }, { default: File }, { default: BitField }] = await Promise.all([
    import(pathToFileURL(path.join(webtorrentRoot, 'lib/torrent.js')).href),
    import(pathToFileURL(path.join(webtorrentRoot, 'lib/file.js')).href), import('bitfield')
  ])
  const count = 38_400
  const pieceLength = 4 * MiB
  const prefix = count - 1024
  let reads = 0
  function makeTorrent () {
    const torrent = Object.assign(new EventEmitter(), {
      name: 'synthetic-150GiB.bin', length: count * pieceLength - 17, pieceLength, lastPieceLength: pieceLength - 17,
      pieces: Array.from({ length: count }, (_, index) => index < prefix ? null : { length: pieceLength, missing: pieceLength }),
      _reservations: Array.from({ length: count }, () => null), bitfield: new BitField(count), files: [],
      wires: [], ready: true, destroyed: false, done: false, strategy: 'sequential', _selections: [], _startAsDeselected: true,
      _debug () {}, _gcSelections () {}, _updateWireWrapper () {}, select () {}, _rarityMap: null,
      client: {}, discovery: { complete () {}, tracker: { start () {} } },
      _checkDone: Torrent.prototype._checkDone, _updateWireInterest: Torrent.prototype._updateWireInterest,
      _update: Torrent.prototype._update, _markVerified: Torrent.prototype._markVerified, _markUnverified: Torrent.prototype._markUnverified
    })
    for (let i = 0; i < prefix; i++) torrent.bitfield.set(i, true)
    const originalGet = torrent.bitfield.get.bind(torrent.bitfield)
    torrent.bitfield.get = (i) => { reads++; return originalGet(i) }
    torrent.files.push(new File(torrent, { name: torrent.name, path: torrent.name, length: torrent.length, offset: 0 }))
    applyMode(torrent, config.mode)
    return torrent
  }
  const stopProfile = await startProfile(config.profile)
  const cpu0 = process.cpuUsage()
  const completionTorrent = makeTorrent()
  let fileDone = 0
  let torrentDone = 0
  completionTorrent.files[0].on('done', () => fileDone++)
  completionTorrent.on('done', () => torrentDone++)
  completionTorrent._checkDone() // include one initial cursor pass outside measured loop
  reads = 0
  const completionStart = performance.now()
  for (let index = prefix; index < count; index++) {
    completionTorrent._markVerified(index)
    completionTorrent._checkDone()
  }
  const completionMs = performance.now() - completionStart
  const completionReads = reads
  assert.equal(completionTorrent.done, true)
  assert.equal(fileDone, 1)
  assert.equal(torrentDone, 1)

  const interestTorrent = makeTorrent()
  const wires = Array.from({ length: 12 }, () => ({
    peerPieces: { get: () => true }, interested () { this.amInterested = true }, uninterested () { this.amInterested = false }
  }))
  wires.forEach((wire) => interestTorrent._updateWireInterest(wire))
  const interestStart = performance.now()
  for (let round = 0; round < 512; round++) for (const wire of wires) interestTorrent._updateWireInterest(wire)
  const interestMs = performance.now() - interestStart
  assert(wires.every((wire) => wire.amInterested))

  const progressTorrent = makeTorrent()
  const { engine, entry } = engineFor(progressTorrent, config.mode, config.root)
  const file = progressTorrent.files[0]
  let fileReads = 0
  Object.defineProperty(file, 'downloaded', { get () { fileReads++; return Object.getOwnPropertyDescriptor(File.prototype, 'downloaded').get.call(this) } })
  const expected = prefix * pieceLength
  assert.equal(engine._progressCache(entry, true).got, expected)
  reads = 0
  const progressStart = performance.now()
  for (let i = 0; i < 1024; i++) {
    assert.equal(engine._progressCache(entry, true).got, expected)
    assert.equal(engine.files(entry.id)[0].progress, expected / file.length)
  }
  const progressMs = performance.now() - progressStart
  const progressReads = reads

  const updateTorrent = makeTorrent()
  let updatePasses = 0
  updateTorrent._updateWireWrapper = () => updatePasses++
  for (let i = 0; i < 4096; i++) updateTorrent._update()
  await delay(8)
  assert(updatePasses >= 1 && updatePasses <= 4096)
  const cpu = process.cpuUsage(cpu0)
  const hotFunctions = await stopProfile(path.join(config.output, `${config.mode}-synthetic.cpuprofile`))
  process.send({ kind: 'result', result: {
    mode: config.mode, scenario: 'synthetic-late-download', pieceCount: count, nominalGiB: 150,
    prefixPieces: prefix, verifiedEvents: 1024, interestUpdates: 512 * 12, progressRequests: 1024,
    completionMs: round(completionMs), completionBitfieldReads: completionReads,
    interestMs: round(interestMs), progressMs: round(progressMs), progressBitfieldReads: progressReads, fileDownloadedReads: fileReads,
    updateRequests: 4096, schedulerPasses: updatePasses,
    cpuSeconds: round((cpu.user + cpu.system) / 1e6), correctness: { fileDoneEvents: fileDone, torrentDoneEvents: torrentDone, selectedBytesCorrect: true }, hotFunctions
  } })
}

function startChild (task, config, marker) {
  const child = spawn(process.execPath, [__filename, '--child', task, Buffer.from(JSON.stringify(config)).toString('base64')], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-5000) })
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${task} exceeded ${TIMEOUT_MS / 1000}s`)) }, TIMEOUT_MS)
    child.on('message', (msg) => {
      if (msg.kind !== marker) return
      clearTimeout(timer)
      resolve(msg)
    })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${task} exited ${code}: ${stderr}`)) })
  })
  return { child, promise }
}

async function endChild (child, graceful = false) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  if (graceful && child.connected) child.send({ kind: 'stop' })
  else child.kill()
  const timer = setTimeout(() => child.kill(), 2500)
  await exited
  clearTimeout(timer)
}

function parseArgs () {
  const args = process.argv.slice(2)
  const get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  const mode = get('--mode', 'both')
  assert(['baseline', 'optimized', 'both'].includes(mode), 'bad mode')
  const sizeMiB = Number(get('--size-mib', '256'))
  const pieceKiB = Number(get('--piece-kib', '4096'))
  const repeat = Number(get('--repeat', '1'))
  const peers = Number(get('--peers', '6'))
  assert(Number.isInteger(sizeMiB) && sizeMiB >= 32 && sizeMiB <= 256, 'size must be 32..256 MiB')
  assert(Number.isInteger(pieceKiB) && pieceKiB >= 16 && pieceKiB <= 4096 && (pieceKiB & (pieceKiB - 1)) === 0, 'piece size must be a power of two from 16..4096 KiB')
  assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 3, 'repeat must be 1..3')
  assert(Number.isInteger(peers) && peers >= 1 && peers <= 12, 'peers must be 1..12')
  return { mode, sizeMiB, pieceKiB, peers, repeat, profile: args.includes('--profile'), syntheticOnly: args.includes('--synthetic-only'), output: path.resolve(get('--out', '.scratch/active-profile')) }
}

async function main () {
  const config = parseArgs()
  fs.mkdirSync(config.output, { recursive: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  const children = new Set()
  const results = []
  const syntheticResults = []
  let seeded
  try {
    if (!config.syntheticOnly) {
      console.log(`Preparing ${config.sizeMiB} MiB local fixture; ${config.pieceKiB} KiB pieces; 60 MiB/s cap.`)
      seeded = startChild('seed', { ...config, root }, 'ready')
      children.add(seeded.child)
      Object.assign(config, await seeded.promise)
    }
    const modes = config.mode === 'both' ? ['baseline', 'optimized'] : [config.mode]
    for (let run = 1; run <= config.repeat; run++) {
      // Alternate order to reduce bias from thermal state and disk caches.
      for (const mode of run % 2 ? modes : [...modes].reverse()) {
        if (!config.syntheticOnly) {
          const active = startChild('leecher', { ...config, mode, run, root }, 'result')
          children.add(active.child)
          const { result } = await active.promise
          results.push(result)
          await endChild(active.child)
          children.delete(active.child)
          console.log(JSON.stringify(result))
        }
      }
    }
    if (seeded) {
      await endChild(seeded.child, true)
      children.delete(seeded.child)
    }
    for (const mode of modes) {
      const active = startChild('synthetic', { ...config, mode, root }, 'result')
      children.add(active.child)
      const { result } = await active.promise
      syntheticResults.push(result)
      await endChild(active.child)
      children.delete(active.child)
      console.log(JSON.stringify(result))
    }
    const report = {
      generatedAt: new Date().toISOString(), runtime: process.version, platform: `${process.platform}/${process.arch}`,
      baseline: 'v1.0.2 sequential, sparse store, four cache slots, rarity map removed',
      limits: { payloadMiB: config.sizeMiB, rateLimitMiBps: RATE_LIMIT / MiB, timeoutPerChildSeconds: TIMEOUT_MS / 1000, discovery: 'disabled', priority: 'below normal', network: '127.0.0.1 only' },
      active: results, synthetic: syntheticResults,
      interpretation: 'Leecher main-process CPU only; excludes seeder and renderer/GPU. Synthetic tests allocate metadata only, never a 150 GiB file. CPU profiler adds overhead equally when enabled. Loopback results are mechanism evidence, not a prediction of Internet throughput or total Windows CPU.'
    }
    const output = path.join(config.output, `results-${Date.now()}.json`)
    fs.writeFileSync(output, JSON.stringify(report, null, 2))
    console.log(`Saved ${output}`)
  } finally {
    for (const child of children) await endChild(child)
    cleanup(root)
  }
}

belowNormal()
if (process.argv.includes('--electron') && process.env.ELECTRON_RUN_AS_NODE !== '1') {
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2).filter((arg) => arg !== '--electron')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true
  })
  child.on('error', (err) => { console.error(err.stack); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code || 0 })
} else if (process.argv[2] === '--child') {
  const config = JSON.parse(Buffer.from(process.argv[4], 'base64').toString())
  const timeout = setTimeout(() => { console.error('child time budget exceeded'); process.exit(1) }, TIMEOUT_MS)
  const task = { seed: seeder, leecher, synthetic }[process.argv[3]]
  assert(task, 'unknown child task')
  task(config).then(() => { clearTimeout(timeout); if (process.argv[3] !== 'seed') process.exit(0) }).catch((err) => { console.error(err.stack); process.exit(1) })
} else {
  main().catch((err) => { console.error(err.stack); process.exitCode = 1 })
}
