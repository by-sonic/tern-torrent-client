'use strict'

const { createHash, webcrypto } = require('node:crypto')
const { performance } = require('node:perf_hooks')

// Keep upstream concurrency, with a yield between refills. Native synchronous
// SHA-1 avoids WebCrypto's additional input copy; the measured async candidate
// used more CPU without improving these bounded engine-delay measurements.
const VERIFY_CONCURRENCY = 2
const VERIFY_BUDGET_WINDOW_MS = 16

/** One FIFO hash budget shared by every torrent in the engine. Zero is unlimited. */
function createVerificationBudget (bytesPerSecond = 0) {
  const queue = []
  let rate = 0
  let nextAt = performance.now()
  let timer = null
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null }
  const pump = () => {
    clear()
    while (queue.length) {
      const now = performance.now()
      const wait = rate ? Math.max(0, nextAt - now - VERIFY_BUDGET_WINDOW_MS) : 0
      if (wait > 0) {
        // Recheck at least once per second even for a very low rate. setRate
        // also re-arms immediately, and cancelling the last read clears it.
        timer = setTimeout(pump, Math.min(1000, Math.ceil(wait)))
        return
      }
      const job = queue.shift()
      job.queued = false
      if (rate) {
        const stride = job.bytes * 1000 / rate
        // A short byte-budget window absorbs Windows timer rounding. Pacing
        // each 16 KiB piece with a rounded timer would make the same configured
        // rate dramatically slower than for 4 MiB pieces. Credit and work
        // ahead remain bounded by this window plus the current piece.
        nextAt = Math.max(now - VERIFY_BUDGET_WINDOW_MS, nextAt) + stride
      }
      else nextAt = now
      job.run()
    }
  }
  const budget = {
    setRate (value) {
      const number = Number(value)
      rate = Number.isFinite(number) && number > 0 ? number : 0
      nextAt = performance.now()
      pump()
    },
    schedule (bytes, run) {
      const number = Number(bytes)
      const job = { bytes: Number.isFinite(number) && number > 0 ? number : 0, run, queued: true }
      queue.push(job)
      pump()
      return () => {
        if (!job.queued) return
        job.queued = false
        const index = queue.indexOf(job)
        if (index !== -1) queue.splice(index, 1)
        pump()
      }
    },
    get pending () { return queue.length }
  }
  budget.setRate(bytesPerSecond)
  return budget
}

/**
 * WebTorrent 3.0.21 calls verification after emitting metadata. Install before
 * that call. Preserve its store reads, SHA-1 comparison, bitfield mutations,
 * per-file startup probes and corruption fallback; only the digest scheduling
 * and fallback deduplication change.
 *
 * `async` is a source-only benchmark candidate, never a renderer setting.
 * Status counts completed attempts, including absent and invalid data. It is
 * verification progress, not downloaded bytes, and resets for a fallback pass.
 */
function installTorrentVerification (torrent, { hashMode = 'sync', budget = null } = {}) {
  if (!torrent || torrent._ternVerification ||
      typeof torrent._verifyPiece !== 'function' ||
      typeof torrent._verifyPiecesUsingHash !== 'function' ||
      typeof torrent._verifyPiecesUsingBitfield !== 'function' ||
      typeof torrent._markVerified !== 'function' ||
      typeof torrent._markUnverified !== 'function' ||
      typeof torrent.once !== 'function' || typeof torrent.removeListener !== 'function') return false
  if (hashMode !== 'async' && hashMode !== 'sync') throw new Error('invalid-verification-hash-mode')
  if (budget && typeof budget.schedule !== 'function') throw new Error('invalid-verification-budget')

  torrent._ternVerification = { active: false, checked: 0, total: 0, bytes: 0, totalBytes: 0, phase: 'idle' }

  torrent._verifyPiece = function (index, cb) {
    let called = false
    let cancelRead = null
    const onClose = () => finish(new Error('torrent is destroyed'))
    const finish = (err, valid) => {
      if (called) return
      called = true
      this.removeListener('close', onClose)
      if (cancelRead) cancelRead()
      cb(err, valid)
    }
    if (this.destroyed) return finish(new Error('torrent is destroyed'))
    this.once('close', onClose)
    const opts = {}
    if (index === this.pieces.length - 1) opts.length = this.lastPieceLength
    const read = () => {
      if (called) return
      if (this.destroyed) return finish(new Error('torrent is destroyed'))
      try { this.store.get(index, opts, (err, buffer) => {
        if (called) return
        if (this.destroyed) return finish(new Error('torrent is destroyed'))
        if (err) return queueMicrotask(() => finish(null, false))
        const verify = () => {
          if (called) return
          if (this.destroyed) return finish(new Error('torrent is destroyed'))
          if (hashMode === 'sync') {
            let hex
            try { hex = createHash('sha1').update(buffer).digest('hex') } catch (error) { return finish(error) }
            // The original hash helper is async even for its synchronous native
            // digest. Keep the callback after the current stack in baseline mode.
            return queueMicrotask(() => this.destroyed
              ? finish(new Error('torrent is destroyed'))
              : finish(null, hex === this._hashes[index]))
          }
          // WebCrypto copies its input without detaching it. Store/cache buffers
          // remain usable by subsequent reads and upload requests.
          try {
            webcrypto.subtle.digest('SHA-1', buffer).then((digest) => {
              if (this.destroyed) return finish(new Error('torrent is destroyed'))
              finish(null, Buffer.from(digest).toString('hex') === this._hashes[index])
            }, finish)
          } catch (error) { finish(error) }
        }
        try {
          // Do not charge absent data as if it had been read: scanning a new
          // 150 GiB torrent in an empty folder must remain fast. Successful
          // reads wait before hashing; the two-piece pass bound also applies
          // backpressure to further reads while these buffers are waiting.
          if (budget) cancelRead = budget.schedule(buffer.byteLength, verify)
          else verify()
        } catch (error) { finish(error) }
      }) } catch (err) { finish(err) }
    }
    try {
      read()
    } catch (err) { finish(err) }
  }

  const runHashPass = (live, pieces, cb, phase) => {
    // This mirrors WebTorrent's conversion: its full list contains Piece/null
    // entries, while startup probes and fallback contain numerical indices.
    const targets = pieces.map((piece, index) => Number.isInteger(piece) ? piece : index)
    const length = (index) => index === live.pieces.length - 1 ? live.lastPieceLength : live.pieceLength
    const status = {
      active: true,
      checked: 0,
      total: targets.length,
      bytes: 0,
      totalBytes: targets.reduce((sum, index) => sum + length(index), 0),
      phase
    }
    live._ternVerification = status
    let next = 0
    let inflight = 0
    let scheduled = null
    let ended = false

    const finish = (err) => {
      if (ended) return
      ended = true
      if (scheduled !== null) clearImmediate(scheduled)
      scheduled = null
      live.removeListener('close', onClose)
      status.active = false
      cb(err || null)
    }
    const onClose = () => finish(new Error('torrent is destroyed'))
    const schedule = () => {
      if (ended || scheduled !== null) return
      // Also yield for absent/read-error pieces. Cached or missing data can
      // complete synchronously, otherwise a large scan chains microtasks and
      // prevents pause, snapshot and shutdown requests from being handled.
      scheduled = setImmediate(pump)
    }
    const pump = () => {
      scheduled = null
      if (ended) return
      if (live.destroyed) return finish(new Error('torrent is destroyed'))
      if (status.checked === targets.length) return finish(null)
      while (!ended && inflight < VERIFY_CONCURRENCY && next < targets.length) {
        const index = targets[next++]
        inflight++
        live._verifyPiece(index, (err, valid) => {
          inflight--
          if (ended) return
          if (err) return finish(err)
          if (live.destroyed) return finish(new Error('torrent is destroyed'))
          try {
            if (valid) live._markVerified(index)
            else live._markUnverified(index)
          } catch (error) { return finish(error) }
          status.checked++
          status.bytes += length(index)
          schedule()
        })
      }
    }
    live.once('close', onClose)
    schedule()
  }

  torrent._verifyPiecesUsingHash = function (pieces, cb) {
    runHashPass(this, pieces, cb, 'full')
  }

  torrent._verifyPiecesUsingBitfield = function (cb) {
    const piecesToCheck = new Set()
    const piecesToFilesMap = new Map()
    // Keep the exact upstream probe selection: the SECOND verified piece of
    // each file, or its first if it has only one verified piece. Boundaries may
    // belong to more than one file.
    for (const file of this.files) {
      let checkFile = 2
      let pieceToCheckForThisFile = null
      for (let i = file._startPiece; i <= file._endPiece; ++i) {
        if (this.bitfield.get(i)) {
          if (checkFile) {
            pieceToCheckForThisFile = i
            checkFile--
          }
          if (!piecesToFilesMap.has(i)) piecesToFilesMap.set(i, [])
          piecesToFilesMap.get(i).push(file)
        }
      }
      if (pieceToCheckForThisFile !== null) piecesToCheck.add(pieceToCheckForThisFile)
    }
    runHashPass(this, [...piecesToCheck], (err) => {
      if (err) return cb(err)
      const filesToCheck = new Set()
      for (const piece of piecesToCheck) {
        if (!this.bitfield.get(piece)) {
          for (const file of piecesToFilesMap.get(piece)) filesToCheck.add(file)
        }
      }
      if (filesToCheck.size) {
        const piecesToRecheck = new Set()
        for (const file of filesToCheck) {
          for (let i = file._startPiece; i <= file._endPiece; ++i) piecesToRecheck.add(i)
        }
        return runHashPass(this, [...piecesToRecheck], cb, 'fallback')
      }
      cb(null)
    }, 'probe')
  }
  return true
}

module.exports = { installTorrentVerification, createVerificationBudget, VERIFY_CONCURRENCY, VERIFY_BUDGET_WINDOW_MS }
