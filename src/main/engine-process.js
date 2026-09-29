'use strict'

// A separate Node event loop keeps hashing, peer scheduling, disk and snapshot work off the UI process.
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')
const { Engine } = require('./engine')
const { JsonStore } = require('./store')

const port = process.parentPort
if (!port) throw new Error('engine-process requires an Electron utility process')
const ALLOWED = new Set(['add', 'confirm', 'pause', 'resume', 'pauseAll', 'resumeAll', 'move', 'remove', 'files', 'info', 'contentPath', 'setSelection', 'setSettings', 'snapshot'])
const requestContext = new AsyncLocalStorage()
const pendingTrash = new Map()
const inflight = new Set()
let engine = null
let stopping = false
let observed = false
let trashSequence = 0

function post (message) { port.postMessage(message) }

function trash (target) {
  const requestId = requestContext.getStore()
  if (!requestId) return Promise.reject(new Error('trash-without-request'))
  const id = ++trashSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingTrash.delete(id); reject(new Error('trash-timeout')) }, 30_000)
    pendingTrash.set(id, { resolve, reject, timer })
    post({ type: 'trash', id, requestId, target })
  })
}

async function invoke (message) {
  if (!Number.isSafeInteger(message.id) || !Array.isArray(message.args)) return
  try {
    let value
    if (message.method === 'init') {
      if (engine) throw new Error('engine-already-started')
      const options = message.args[0]
      if (!options || !path.isAbsolute(options.userData) || !path.isAbsolute(options.defaultDir)) throw new Error('bad-engine-options')
      engine = new Engine({
        stateStore: new JsonStore(path.join(options.userData, 'state.json'), () => ({ torrents: [], settings: {} })),
        torrentsDir: path.join(options.userData, 'torrents'),
        defaultDir: options.defaultDir,
        clientOptions: options.clientOptions,
        trash
      })
      for (const event of ['state', 'stats', 'completed']) engine.on(event, (payload) => post({ type: 'event', event, value: payload }))
      await engine.init()
      engine.setObserved(observed)
      value = engine.snapshot()
    } else if (message.method === 'shutdown') {
      stopping = true
      // A native trash operation can take longer than the shutdown budget. Persist the current
      // queue and bitfield before waiting, then let shutdown make a final checkpoint on success.
      if (engine) engine.checkpoint()
      // Finish earlier mutations before persisting state and closing the stores.
      await Promise.allSettled([...inflight])
      if (engine) await engine.shutdown()
    } else {
      if (!engine || stopping || !ALLOWED.has(message.method)) throw new Error('engine-unavailable')
      value = await engine[message.method](...message.args)
    }
    post({ type: 'result', id: message.id, ok: true, value, settings: engine?.settings })
  } catch (err) {
    console.error('[request]', message.method, err.stack || err.message)
    post({ type: 'result', id: message.id, ok: false, error: err.message })
  }
}

port.on('message', ({ data: message }) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'observe') {
    observed = Boolean(message.value)
    if (engine && !stopping) engine.setObserved(observed)
  } else if (message.type === 'trash-result') {
    const pending = pendingTrash.get(message.id)
    if (!pending) return
    pendingTrash.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve()
    else pending.reject(new Error(message.error || 'trash-failed'))
  } else if (message.type === 'request') {
    const promise = requestContext.run(message.id, () => invoke(message))
    if (message.method !== 'shutdown') { inflight.add(promise); promise.finally(() => inflight.delete(promise)) }
  }
})

process.on('uncaughtException', (err) => { post({ type: 'fatal', error: err.message, stack: err.stack }); process.exit(1) })
process.on('unhandledRejection', (err) => { post({ type: 'fatal', error: String(err?.message || err), stack: err?.stack }); process.exit(1) })
