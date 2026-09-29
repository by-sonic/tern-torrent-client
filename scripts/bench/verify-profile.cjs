'use strict'

// Offline verification benchmark. The optional live subset is read-only and
// discovers paused records internally; no download path or torrent identity is
// accepted on the command line or included in the published report.
// node scripts/bench/verify-profile.cjs --electron --live-subset --repeat 3
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { monitorEventLoopDelay, PerformanceObserver, performance } = require('node:perf_hooks')

const MiB = 1024 * 1024
const PIECE_LENGTH = 4 * MiB
const TIMEOUT_MS = 45_000
const TEMP_PREFIX = 'tern-verify-profile-'
const MODES = ['baseline', 'fast-store', 'async-hash', 'optimized']
const round = (value) => Math.round(value * 1000) / 1000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function contained (root, candidate) {
  const base = path.resolve(root)
  const target = path.resolve(candidate)
  assert(target.startsWith(base + path.sep), 'benchmark path outside its root')
  return target
}

function belowNormal () {
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
}

function parseArgs () {
  const args = process.argv.slice(2)
  const get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  const sizeMiB = Number(get('--size-mib', '256'))
  const pieceKiB = Number(get('--piece-kib', '4096'))
  const repeat = Number(get('--repeat', '3'))
  const modes = get('--modes', MODES.join(',')).split(',')
  assert(Number.isInteger(sizeMiB) && sizeMiB >= 32 && sizeMiB <= 512, 'size must be 32..512 MiB')
  assert(Number.isInteger(pieceKiB) && pieceKiB >= 16 && pieceKiB <= 4096 && (pieceKiB & (pieceKiB - 1)) === 0, 'piece size must be a power of two from 16..4096 KiB')
  assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 3, 'repeat must be 1..3')
  assert(modes.length && modes.every((mode) => [...MODES, 'upstream', 'balanced'].includes(mode)), 'unknown benchmark mode')
  assert.equal(new Set(modes).size, modes.length, 'duplicate benchmark mode')
  return { sizeMiB, pieceKiB, repeat, modes, live: args.includes('--live-subset'), output: path.resolve(get('--out', '.scratch/verify-profile')) }
}

function fixture (root, sizeMiB, pieceLength = PIECE_LENGTH) {
  const length = sizeMiB * MiB - 17
  const lengths = [Math.min(17 * MiB + 3, Math.floor(length / 3)), Math.floor(length / 2) + 29]
  lengths.push(length - lengths[0] - lengths[1])
  assert(lengths.every((size) => size > 0), 'invalid fixture file size')
  const files = lengths.map((size, i) => ({ path: contained(root, path.join(root, `part-${i}.bin`)), length: size, offset: lengths.slice(0, i).reduce((sum, n) => sum + n, 0) }))
  const handles = files.map((file) => fs.openSync(file.path, 'wx'))
  const hashes = []
  try {
    for (let index = 0, offset = 0; offset < length; index++, offset += pieceLength) {
      const buffer = Buffer.alloc(Math.min(pieceLength, length - offset), (index * 37 + 19) & 255)
      hashes.push(crypto.createHash('sha1').update(buffer).digest('hex'))
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const from = Math.max(offset, file.offset)
        const to = Math.min(offset + buffer.length, file.offset + file.length)
        if (to > from) fs.writeSync(handles[i], buffer, from - offset, to - from, from - file.offset)
      }
    }
  } finally { for (const fd of handles) fs.closeSync(fd) }
  return { kind: 'fixture', files, length, pieceLength, lastPieceLength: length % pieceLength || pieceLength, hashes, indexes: hashes.map((_, i) => i) }
}

async function liveSubset (sizeMiB) {
  assert(process.env.APPDATA, 'live subset requires Windows APPDATA')
  const userData = path.join(process.env.APPDATA, 'Tern')
  const stateFile = path.join(userData, 'state.json')
  const stateBytes = fs.readFileSync(stateFile)
  const state = JSON.parse(stateBytes)
  const entry = state.torrents.find((record) => record.paused && record.bitfield && record.files?.length && record.pieceLength > 0)
  assert(entry, 'no paused record with verified pieces')
  assert(/^[a-f0-9]{40}$/.test(entry.id), 'invalid saved torrent identifier')
  const { default: parseTorrent } = await import('parse-torrent')
  const parsed = await parseTorrent(fs.readFileSync(path.join(userData, 'torrents', `${entry.id}.torrent`)))
  assert.equal(parsed.infoHash, entry.id)
  assert.equal(parsed.pieceLength, entry.pieceLength)
  const root = fs.realpathSync(entry.path)
  const lastPieceLength = parsed.length % parsed.pieceLength || parsed.pieceLength
  const bits = Buffer.from(entry.bitfield, 'base64')
  const indexes = []
  let bytes = 0
  for (let index = 0; index < parsed.pieces.length; index++) {
    if (!(bits[index >> 3] & (0x80 >> (index & 7)))) continue
    const size = index === parsed.pieces.length - 1 ? lastPieceLength : parsed.pieceLength
    if (bytes + size > sizeMiB * MiB) break
    indexes.push(index)
    bytes += size
  }
  assert(indexes.length > 0 && bytes <= 512 * MiB, 'invalid live subset bound')
  // Unselected files may intentionally not exist. Open only files intersecting
  // the chosen verified subset, never every path advertised by the torrent.
  const files = parsed.files.filter((file) => indexes.some((index) => {
    const start = index * parsed.pieceLength
    const end = Math.min(parsed.length, start + parsed.pieceLength)
    return file.offset < end && file.offset + file.length > start
  })).map((file) => {
    const target = fs.realpathSync(contained(root, path.resolve(root, file.path)))
    contained(root, target)
    return { path: target, length: file.length, offset: file.offset }
  })
  assert(files.length, 'no files for live subset')
  const stamps = files.map((file) => { const stat = fs.statSync(file.path); return { size: stat.size, mtimeMs: stat.mtimeMs } })
  return {
    source: { kind: 'paused-live-subset', files, length: parsed.length, pieceLength: parsed.pieceLength, lastPieceLength, hashes: parsed.pieces, indexes },
    unchanged: () => {
      assert(fs.readFileSync(stateFile).equals(stateBytes), 'saved application state changed during benchmark')
      files.forEach((file, i) => {
        const stat = fs.statSync(file.path)
        assert.equal(stat.size, stamps[i].size, 'live file size changed')
        assert.equal(stat.mtimeMs, stamps[i].mtimeMs, 'live file mtime changed')
      })
      return true
    }
  }
}

// Both modes use exactly the same fs.open('r') handles and read implementation.
// This deliberately never constructs FsChunkStore for live data: its opener
// may create directories, mark a file sparse or open it for writing.
async function readonlyStore (source, fast) {
  const handles = new Map()
  const counters = { readBytes: 0, readCalls: 0, copiedBytes: 0, allocatedBytes: 0 }
  const { concat } = await import('uint8-util')
  try {
    for (const file of source.files) handles.set(file.path, fs.openSync(file.path, 'r'))
  } catch (err) {
    for (const fd of handles.values()) fs.closeSync(fd)
    throw err
  }
  const read = (file, offset, length, cb) => {
    const buffer = Buffer.allocUnsafe(length)
    counters.allocatedBytes += length
    let done = 0
    const next = () => {
      counters.readCalls++
      fs.read(handles.get(file.path), buffer, done, length - done, offset + done, (err, bytes) => {
        if (err) return cb(err)
        if (!bytes) return cb(new Error('partial benchmark read'))
        done += bytes
        counters.readBytes += bytes
        if (done === length) cb(null, buffer)
        else next()
      })
    }
    next()
  }
  return {
    counters,
    get (index, opts, cb) {
      const start = index * source.pieceLength + ((opts && opts.offset) || 0)
      const size = (opts && opts.length) || Math.min(source.pieceLength, source.length - index * source.pieceLength)
      const end = start + size
      const targets = source.files.filter((file) => file.offset < end && file.offset + file.length > start)
      const buffers = new Array(targets.length)
      let pending = targets.length
      let ended = false
      if (!pending) return queueMicrotask(() => cb(new Error('no benchmark file range')))
      targets.forEach((file, i) => {
        const from = Math.max(start, file.offset)
        const to = Math.min(end, file.offset + file.length)
        read(file, from - file.offset, to - from, (err, buffer) => {
          if (ended) return
          if (err) { ended = true; cb(err); return }
          buffers[i] = buffer
          if (--pending) return
          if (fast && buffers.length === 1) cb(null, buffer)
          else {
            counters.copiedBytes += size
            counters.allocatedBytes += size
            cb(null, concat(buffers))
          }
        })
      })
    },
    close () { for (const fd of handles.values()) fs.closeSync(fd) }
  }
}

async function fixtureStore (source, fast) {
  const { default: FsChunkStore } = await import('fs-chunk-store')
  const { loadSparseStore } = require('../../src/main/sparse-store')
  const Store = await loadSparseStore()
  const store = new Store(source.pieceLength, {
    path: path.dirname(source.files[0].path), length: source.length,
    files: source.files.map((file) => ({ path: path.basename(file.path), length: file.length, offset: file.offset }))
  })
  const counters = { readBytes: 0, readCalls: 0, copiedBytes: 0, allocatedBytes: 0 }
  const wrapped = new WeakSet()
  for (const file of store.files) {
    const open = file.open
    file.open = (cb) => open((err, raf) => {
      if (err) return cb(err)
      if (!wrapped.has(raf)) {
        wrapped.add(raf)
        const read = raf.read.bind(raf)
        raf.read = (offset, length, done) => {
          counters.readCalls++
          counters.allocatedBytes += length
          read(offset, length, (error, buffer) => {
            if (!error) counters.readBytes += buffer.length
            done(error, buffer)
          })
        }
      }
      cb(null, raf)
    })
  }
  return {
    counters,
    get (index, opts, cb) {
      const size = index === store.lastChunkIndex ? store.lastChunkLength : store.chunkLength
      if (!fast || store.chunkMap[index].length !== 1) { counters.copiedBytes += size; counters.allocatedBytes += size }
      const get = fast ? Store.prototype.get : FsChunkStore.prototype.get
      get.call(store, index, opts, cb)
    },
    close () { return new Promise((resolve, reject) => store.close((err) => err ? reject(err) : resolve())) }
  }
}

async function measure (config) {
  const { source, mode, run } = config
  const { default: Torrent } = await import('webtorrent/lib/torrent.js')
  const { default: BitField } = await import('bitfield')
  const { installTorrentVerification, createVerificationBudget, VERIFY_BUDGET_WINDOW_MS } = require('../../src/main/verification')
  const fast = ['fast-store', 'optimized', 'balanced'].includes(mode)
  const store = await (source.kind === 'fixture' ? fixtureStore(source, fast) : readonlyStore(source, fast))
  const torrent = Object.assign(new EventEmitter(), {
    destroyed: false, pieces: new Array(source.hashes.length).fill({}), _reservations: [],
    bitfield: new BitField(source.hashes.length), pieceLength: source.pieceLength,
    lastPieceLength: source.lastPieceLength, _hashes: source.hashes, store,
    _startAsDeselected: true, files: [], _debug: () => {},
    _verifyPiece: Torrent.prototype._verifyPiece,
    _verifyPiecesUsingHash: Torrent.prototype._verifyPiecesUsingHash,
    _verifyPiecesUsingBitfield: Torrent.prototype._verifyPiecesUsingBitfield,
    _markVerified: Torrent.prototype._markVerified,
    _markUnverified: Torrent.prototype._markUnverified
  })
  if (mode === 'baseline' || mode === 'fast-store') assert(installTorrentVerification(torrent, { hashMode: 'sync' }))
  if (mode === 'async-hash' || mode === 'optimized') assert(installTorrentVerification(torrent, { hashMode: 'async' }))
  if (mode === 'balanced') assert(installTorrentVerification(torrent, { hashMode: 'sync', budget: createVerificationBudget(256 * MiB) }))
  if (global.gc) global.gc()
  const gc = { events: 0, totalMs: 0, maxMs: 0 }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) { gc.events++; gc.totalMs += entry.duration; gc.maxMs = Math.max(gc.maxMs, entry.duration) }
  })
  observer.observe({ entryTypes: ['gc'] })
  const loop = monitorEventLoopDelay({ resolution: 1 })
  loop.enable()
  await delay(20)
  loop.reset()
  let pulseAt = performance.now()
  let maxPulseDelayMs = 0
  let rss = process.memoryUsage().rss
  const pulse = setInterval(() => {
    const now = performance.now()
    maxPulseDelayMs = Math.max(maxPulseDelayMs, now - pulseAt - 10)
    pulseAt = now
    rss = Math.max(rss, process.memoryUsage().rss)
  }, 10)
  const startCpu = process.cpuUsage()
  const start = performance.now()
  try {
    await new Promise((resolve, reject) => torrent._verifyPiecesUsingHash(source.indexes, (err) => err ? reject(err) : resolve()))
    const elapsedMs = performance.now() - start
    const cpu = process.cpuUsage(startCpu)
    await delay(10)
    clearInterval(pulse)
    loop.disable()
    await new Promise((resolve) => setImmediate(resolve))
    observer.disconnect()
    assert(source.indexes.every((index) => torrent.bitfield.get(index)), 'a verified source piece failed SHA-1')
    const bytes = source.indexes.reduce((sum, index) => sum + (index === source.hashes.length - 1 ? source.lastPieceLength : source.pieceLength), 0)
    assert.equal(store.counters.readBytes, bytes, 'unexpected byte read count')
    assert(bytes <= 512 * MiB, 'measurement exceeded data limit')
    if (mode === 'balanced') {
      // Idle credit and work ahead each have a bounded window; completion can
      // precede the nominal full duration by those windows and the final piece.
      // A percentage-only tolerance would reject valid small-piece fixtures.
      const minimumMs = bytes / (256 * MiB) * 1000 - 2 * VERIFY_BUDGET_WINDOW_MS - source.pieceLength / (256 * MiB) * 1000
      assert(elapsedMs + 1 >= Math.max(0, minimumMs), 'balanced verification did not respect its rate budget')
    }
    return {
      scenario: source.kind, mode, run, bytes, pieceLength: source.pieceLength, pieces: source.indexes.length,
      elapsedMs: round(elapsedMs), throughputMiBps: round(bytes / MiB / (elapsedMs / 1000)),
      cpuSeconds: round((cpu.user + cpu.system) / 1e6), cpuUserSeconds: round(cpu.user / 1e6), cpuSystemSeconds: round(cpu.system / 1e6),
      logicalCpuPercent: round((cpu.user + cpu.system) / 1000 / elapsedMs / os.cpus().length * 100), rateLimitMiBps: mode === 'balanced' ? 256 : 0,
      loopP99Ms: round(loop.percentile(99) / 1e6), loopMaxMs: round(loop.max / 1e6), maxPulseDelayMs: round(maxPulseDelayMs),
      peakRssMiB: round(rss / MiB), gc: { events: gc.events, totalMs: round(gc.totalMs), maxMs: round(gc.maxMs) },
      storage: store.counters, correctness: { sha1AllMatched: true, liveReadOnlyHandles: source.kind === 'paused-live-subset', fixtureOwnedByHarness: source.kind === 'fixture' }
    }
  } finally { clearInterval(pulse); loop.disable(); observer.disconnect(); await store.close() }
}

function childMeasure (config) {
  const child = spawn(process.execPath, ['--expose-gc', __filename, '--child'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: process.env
  })
  return new Promise((resolve, reject) => {
    let result
    let failure
    const timer = setTimeout(() => { child.kill(); reject(new Error('verification child exceeded time budget')) }, TIMEOUT_MS)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('message', (message) => {
      if (message.kind === 'ready') child.send(config)
      if (message.kind === 'result') result = message.result
      if (message.kind === 'failure') failure = new Error(message.error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code || !result) reject(new Error(`verification child exited ${code} without a result`))
      else resolve(result)
    })
  })
}

async function main () {
  const config = parseArgs()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  const results = []
  let live
  try {
    const sources = [fixture(root, config.sizeMiB, config.pieceKiB * 1024)]
    if (config.live) { live = await liveSubset(config.sizeMiB); sources.push(live.source) }
    for (const source of sources) {
      for (let run = 1; run <= config.repeat; run++) {
        for (const mode of run % 2 ? config.modes : [...config.modes].reverse()) {
          if (live) live.unchanged()
          const result = await childMeasure({ source, mode, run })
          results.push(result)
          console.log(JSON.stringify(result))
        }
      }
    }
    const report = {
      generatedAt: new Date().toISOString(), runtime: process.version, platform: `${process.platform}/${process.arch}`, logicalCpuCount: os.cpus().length,
      baseline: 'Synchronous SHA-1, two reads in flight, yielded scheduler, concat even for one-file pieces',
      variants: { 'fast-store': 'single-file buffer reuse only', 'async-hash': 'WebCrypto SHA-1 only, original concatenation', optimized: 'buffer reuse and WebCrypto SHA-1', upstream: 'unmodified WebTorrent 3.0.21 verifier, available as a separate optional control', balanced: 'synchronous SHA-1, yielded scheduler, buffer reuse, shared 256 MiB/s rate budget' },
      limits: { maxSubsetMiB: config.sizeMiB, fixturePieceKiB: config.pieceKiB, maxTotalSourceMiB: 512, repeat: config.repeat, timePerChildSeconds: TIMEOUT_MS / 1000, priority: 'below normal', network: 'none', rateWindowMs: require('../../src/main/verification').VERIFY_BUDGET_WINDOW_MS },
      fixture: { sharedFileBoundaries: true, shortLastPiece: true },
      live: config.live ? { paused: true, metadataAndFileStampsUnchanged: live.unchanged(), handles: 'fs.open r only' } : null,
      results,
      interpretation: 'Process CPU includes async crypto threads; excludes UI/GPU. Each variant rereads the same bounded subset. Windows file cache is warm and variants alternate order; these are verification measurements, not a full 151 GiB scan. Fixture uses the actual sparse and upstream store get methods. The live readonly adapter models their buffer-copy difference and never creates a live FsChunkStore.'
    }
    fs.mkdirSync(config.output, { recursive: true })
    fs.writeFileSync(path.join(config.output, 'results.json'), JSON.stringify(report, null, 2))
    console.log('Saved sanitized verification results.json')
  } finally {
    const target = fs.realpathSync(root)
    contained(fs.realpathSync(os.tmpdir()), target)
    assert(path.basename(target).startsWith(TEMP_PREFIX), 'unexpected fixture cleanup path')
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

belowNormal()
if (process.argv.includes('--electron') && process.env.ELECTRON_RUN_AS_NODE !== '1') {
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2).filter((arg) => arg !== '--electron')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true
  })
  child.once('error', () => { console.error('Electron benchmark launch failed'); process.exitCode = 1 })
  child.once('exit', (code) => { process.exitCode = code || 0 })
} else if (process.argv.includes('--child')) {
  const timer = setTimeout(() => process.exit(1), TIMEOUT_MS)
  process.once('message', (config) => measure(config).then((result) => {
    process.send({ kind: 'result', result }, () => { clearTimeout(timer); process.exit(0) })
  }).catch((err) => {
    process.send({ kind: 'failure', error: `${err.name}: ${err.code || 'benchmark failed'}` }, () => { clearTimeout(timer); process.exit(1) })
  }))
  process.send({ kind: 'ready' })
} else {
  main().catch((err) => { console.error(`${err.name}: ${err.code || err.message}`); process.exitCode = 1 })
}
