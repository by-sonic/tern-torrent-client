// Bench helper. Child process: creates (once) a 512 MB / 32 768-piece torrent and seeds it from K clients on loopback.
// Prints "READY <json>" with the torrent file (base64) and the ports.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}

const K = Number(process.argv[2] || 6)
const root = path.join(os.tmpdir(), 'tern-stress')
const content = path.join(root, 'seed', 'big')
const OFF = { dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }

;(async () => {
  const { default: WebTorrent } = await import('webtorrent')
  fs.mkdirSync(content, { recursive: true })
  const file = path.join(content, 'data.bin')
  if (!fs.existsSync(file) || fs.statSync(file).size !== 512 * 1048576) {
    const fd = fs.openSync(file, 'w')
    const block = Buffer.alloc(8 * 1048576)
    for (let i = 0; i < 64; i++) { crypto.randomFillSync(block); fs.writeSync(fd, block) }
    fs.closeSync(fd)
  }
  const first = new WebTorrent(OFF)
  const torrent = await new Promise((resolve) => first.seed(content, { pieceLength: 16384, announce: [] }, resolve))
  const torrentFile = Buffer.from(torrent.torrentFile)
  const clients = [first]
  const ports = [first.torrentPort]
  for (let i = 1; i < K; i++) {
    const c = new WebTorrent(OFF)
    await new Promise((resolve) => c.add(torrentFile, { path: path.join(root, 'seed') }, () => resolve()))
    clients.push(c)
    ports.push(c.torrentPort)
  }
  fs.writeFileSync(path.join(root, 'stress.torrent'), torrentFile)
  console.log('READY ' + JSON.stringify({ ports, pieces: torrent.pieces.length }))
  setInterval(() => {}, 1 << 30)
})().catch((e) => { console.error(e); process.exit(1) })
