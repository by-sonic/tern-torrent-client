'use strict'

// Stand-in for the real preload, used only by scripts/screenshots.js.
// It feeds the real interface a fixed, realistic state made of openly licensed downloads.

const { contextBridge } = require('electron')

const MB = 1048576
const GB = 1024 * MB

/** Deterministic pseudo-random so screenshots do not change between runs. */
function rng (seed) {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
}

/** A piece map: mostly-filled front with a ragged, half-filled frontier, like a real swarm download. */
function pieces (progress, seed, n = 360) {
  const rand = rng(seed)
  let out = ''
  for (let i = 0; i < n; i++) {
    const x = i / n
    if (progress >= 1) out += '9'
    else if (x < progress - 0.1) out += rand() < 0.93 ? '9' : String(Math.floor(rand() * 9))
    else if (x < progress + 0.12) out += String(Math.floor(rand() * 10))
    else out += rand() < 0.05 ? String(Math.floor(rand() * 9)) : '0'
  }
  return out
}

const base = (o) => ({
  error: null, total: o.size, down: 0, up: 0, peers: 0, eta: null, uploaded: 0, dir: 'D:\\Downloads', fileCount: 1,
  paused: false, ...o
})

const torrents = [
  base({ id: '1'.repeat(40), name: 'ubuntu-26.04-desktop-amd64.iso', state: 'downloading', size: 6.2 * GB, progress: 0.62, down: 14.6 * MB, up: 310 * 1024, peers: 48, eta: 168, uploaded: 84 * MB, fileCount: 5, pieces: pieces(0.62, 11) }),
  base({ id: '2'.repeat(40), name: 'Blender Foundation — Sprite Fright (4K)', state: 'downloading', size: 2.4 * GB, progress: 0.27, down: 5.2 * MB, peers: 21, eta: 313, fileCount: 8, pieces: pieces(0.27, 23) }),
  base({ id: '3'.repeat(40), name: 'archlinux-2026.09.01-x86_64.iso', state: 'seeding', size: 1.1 * GB, progress: 1, up: 820 * 1024, peers: 9, uploaded: 3.4 * GB, pieces: pieces(1, 5) }),
  base({ id: '4'.repeat(40), name: 'debian-13.0.0-amd64-netinst.iso', state: 'done', size: 690 * MB, progress: 1, pieces: pieces(1, 7) }),
  base({ id: '5'.repeat(40), name: 'Wikipedia — enwiki latest pages-articles', state: 'paused', paused: true, size: 22 * GB, progress: 0.41, fileCount: 3, pieces: pieces(0.41, 31) }),
  base({ id: '6'.repeat(40), name: 'LibreOffice 25.8 (Windows x64).msi', state: 'queued', size: 380 * MB, progress: 0.03, pieces: pieces(0.03, 41) })
]

const files = [
  ['ubuntu-26.04-desktop-amd64.iso', 6.1 * GB, 0.62, true],
  ['SHA256SUMS', 1024, 1, true],
  ['SHA256SUMS.gpg', 833, 1, true],
  ['manifest.txt', 4096, 1, true],
  ['ubuntu-26.04-desktop-amd64.iso.zsync', 12 * MB, 0, false]
].map(([path, length, progress, selected], index) => ({ index, path: `ubuntu-26.04/${path}`, length, progress, selected }))

const state = {
  torrents,
  settings: { downloadDir: 'D:\\Downloads', downLimitKB: 0, upLimitKB: 512, maxActive: 3, seedAfterDone: true, closeToTray: true, launchAtLogin: false, autoUpdate: true },
  speed: { down: 19.8 * MB, up: 1.1 * MB }
}

try { localStorage.setItem('tern.handlerHint', '1') } catch { /* hide the "make default" hint in screenshots */ }

/** Push the state once a second with a gently moving speed, so the sparkline has history. */
function pushStates (cb) {
  let tick = 0
  const send = () => {
    const wave = 1 + 0.25 * Math.sin(tick / 3) + 0.1 * Math.sin(tick * 1.7)
    cb({ ...state, speed: { down: state.speed.down * wave, up: state.speed.up } })
    tick += 1
  }
  send()
  setInterval(send, 1000)
}

const ok = (value) => async () => value
contextBridge.exposeInMainWorld('tern', {
  getState: ok(state),
  onState: (cb) => { pushStates(cb); return () => {} },
  onToast: () => () => {},
  onUpdate: () => () => {},
  appInfo: ok({ version: '1.0.0', update: { status: 'idle', version: null, percent: 0, error: null, checkedAt: Date.now() } }),
  checkForUpdates: ok(undefined),
  installUpdate: ok(undefined),
  addText: ok(undefined),
  pathForFile: () => '',
  addPaths: ok(undefined),
  pickTorrent: ok(undefined),
  pickFolder: ok(null),
  confirm: ok(undefined),
  pause: ok(undefined),
  resume: ok(undefined),
  pauseAll: ok(undefined),
  resumeAll: ok(undefined),
  move: ok(undefined),
  remove: ok(undefined),
  files: ok(files),
  select: ok(undefined),
  info: ok({
    trackers: ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce'],
    addedAt: Date.now() - 3600 * 1000, pieceCount: 360, pieceLength: 2 * MB
  }),
  reveal: ok(undefined),
  setSettings: ok(undefined),
  registerHandler: ok(undefined)
})
