// Child process: downloads the stress torrent with one configuration and prints a JSON result.
// argv: <old|new> <ports comma separated> <output dir>   (the torrent file is read from the temp folder)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { monitorEventLoopDelay } = require('node:perf_hooks')
try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}

const [mode, portsArg, outDir] = process.argv.slice(2)
const ports = portsArg.split(',').map(Number)
const OFF = { dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
const TIMEOUT_MS = 150_000

;(async () => {
  const { default: WebTorrent } = await import('webtorrent')
  const { loadSparseStore } = require('../../src/main/sparse-store')
  const { torrentOptions, dropRarityMap } = require('../../src/main/torrent-tuning')
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const client = new WebTorrent(OFF)
  const lag = monitorEventLoopDelay({ resolution: 5 })
  lag.enable()
  const cpu0 = process.cpuUsage()
  const started = Date.now()
  let peakRss = 0
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 250)

  const torrentFile = fs.readFileSync(path.join(os.tmpdir(), 'tern-stress', 'stress.torrent'))
  const opts = mode === 'old'
    ? { path: outDir, strategy: 'rarest' } // what 1.0.0 shipped: rarest-first, default store and cache
    : torrentOptions({ path: outDir, store: await loadSparseStore() })
  if (mode === 'old') opts.deselect = false
  const torrent = client.add(torrentFile, opts)
  torrent.on('metadata', () => {
    if (mode === 'new') dropRarityMap(torrent)
    for (const port of ports) torrent.addPeer(`127.0.0.1:${port}`)
  })
  if (mode === 'new') torrent.on('ready', () => torrent.files.forEach((f) => f.select()))

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ done: false, progress: torrent.progress }), TIMEOUT_MS)
    torrent.on('done', () => { clearTimeout(timer); resolve({ done: true, progress: 1 }) })
  })
  clearInterval(sampler)
  lag.disable()
  const cpu = process.cpuUsage(cpu0)
  console.log('RESULT ' + JSON.stringify({
    mode, pieces: torrent.pieces.length, done: result.done, progress: Math.round(result.progress * 1000) / 10,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    cpuSeconds: Math.round((cpu.user + cpu.system) / 1e5) / 10,
    lagMs: { p50: Math.round(lag.percentile(50) / 1e5) / 10, p99: Math.round(lag.percentile(99) / 1e5) / 10, max: Math.round(lag.max / 1e5) / 10 },
    peakRssMB: Math.round(peakRss / 1048576)
  }))
  await new Promise((resolve) => client.destroy(resolve))
  process.exit(0)
})().catch((e) => { console.error('ERR', e); process.exit(1) })
