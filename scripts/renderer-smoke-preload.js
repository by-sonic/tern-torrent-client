'use strict'

// Only used by renderer-smoke.js. It never loads the torrent engine or user data.
const { contextBridge } = require('electron')
const GB = 1024 ** 3
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const makeTorrent = (id, name, size, count) => ({
  id, name, size, total: size, state: 'downloading', paused: false,
  progress: 0.5, down: 55 * 1024 ** 2, up: 0, peers: 12, eta: 1400,
  uploaded: 0, dir: 'D:\\Smoke downloads', fileCount: count,
  error: null, pieces: '9'.repeat(180) + '0'.repeat(180)
})
const state = {
  torrents: [makeTorrent(A, 'Large Linux image bundle (150 GB)', 150 * GB, 2), makeTorrent(B, 'Small image bundle', GB, 3)],
  settings: { downloadDir: 'D:\\Smoke downloads', downLimitKB: 0, upLimitKB: 0, maxActive: 3, seedAfterDone: true, closeToTray: true, launchAtLogin: false, autoUpdate: false },
  speed: { down: 55 * 1024 ** 2, up: 0 }
}
const fileRows = {
  [A]: [0, 1].map((index) => ({ index, path: `large/image-${index}.iso`, length: 75 * GB, progress: 0.5, selected: true })),
  [B]: [0, 1, 2].map((index) => ({ index, path: `small/image-${index}.iso`, length: GB / 3, progress: 0.5, selected: true }))
}
const held = { files: new Set(), info: new Set(), select: new Set(), remove: new Set() }
const pending = { files: [], info: [], select: [], remove: [] }
const calls = { files: [], select: [], remove: [] }
const removeResults = []
let serial = 0
let listener = null
const copy = (value) => JSON.parse(JSON.stringify(value))

function push (patch = {}) {
  if (patch.id) Object.assign(state.torrents.find((torrent) => torrent.id === patch.id), patch)
  if (listener) listener(copy(state))
}

function deferred (kind, id, value, complete = (result) => result) {
  if (!held[kind].has(id)) return Promise.resolve().then(() => complete(value))
  return new Promise((resolve, reject) => pending[kind].push({ serial: ++serial, id, value, resolve, reject, complete }))
}

const ok = async () => undefined
contextBridge.exposeInMainWorld('tern', {
  getState: async () => copy(state), onState: (cb) => { listener = cb; return () => { listener = null } },
  onToast: () => () => {}, onUpdate: () => () => {},
  appInfo: async () => ({ version: '0.0.0-smoke', update: { status: 'idle', checkedAt: 0 } }),
  files: (id) => { calls.files.push(id); return deferred('files', id, copy(fileRows[id])) },
  info: (id) => deferred('info', id, { trackers: [`udp://${id[0]}.example.test:1337/announce`], addedAt: 1_700_000_000_000, pieceCount: id === A ? 75_000 : 100, pieceLength: 2 * 1024 ** 2 }),
  select: (id, selected) => {
    calls.select.push({ id, selected: [...selected] })
    return deferred('select', id, [...selected], (accepted) => {
      fileRows[id].forEach((file, index) => { file.selected = accepted[index] })
      push()
    })
  },
  pause: async (id) => push({ id, state: 'paused', paused: true }),
  resume: async (id) => push({ id, state: 'downloading', paused: false }),
  addText: ok, addPaths: ok, pickTorrent: ok, pickFolder: async () => null, confirm: ok,
  remove: (id, trash) => {
    calls.remove.push({ id, trash })
    const result = removeResults.shift() || { removed: true, failed: 0, skipped: 0, sourceUnavailable: false, trashed: 0 }
    return deferred('remove', id, result, (accepted) => {
      if (accepted.error) throw new Error('Fixture removal failed')
      if (accepted.removed) { state.torrents = state.torrents.filter((torrent) => torrent.id !== id); push() }
      return accepted
    })
  },
  pauseAll: ok, resumeAll: ok, move: ok, reveal: ok, setSettings: ok,
  registerHandler: ok, checkForUpdates: ok, installUpdate: ok, pathForFile: () => ''
})

contextBridge.exposeInMainWorld('ternSmoke', {
  ids: { A, B, C }, push,
  hold: (kind, id) => held[kind].add(id),
  release: (kind, requestSerial) => {
    const index = pending[kind].findIndex((request) => request.serial === requestSerial)
    if (index < 0) throw new Error(`Missing ${kind} request ${requestSerial}`)
    const [request] = pending[kind].splice(index, 1)
    try { request.resolve(request.complete(request.value)) } catch (err) { request.reject(err) }
  },
  unhold: (kind, id) => held[kind].delete(id),
  snapshot: () => ({ calls: copy(calls), pending: Object.fromEntries(Object.entries(pending).map(([kind, requests]) => [kind, requests.map(({ serial, id }) => ({ serial, id }))])) }),
  progress: (id, value) => { fileRows[id].forEach((file) => { file.progress = value }) },
  removeResult: (result) => removeResults.push(copy(result)),
  addTorrent: (id, name, stage = 'downloading') => {
    const torrent = makeTorrent(id, name, GB, 3)
    torrent.state = stage
    if (stage === 'choosing') torrent.files = copy(fileRows[B])
    fileRows[id] = copy(fileRows[B])
    state.torrents.push(torrent)
    push()
  }
})
