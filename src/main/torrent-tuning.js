'use strict'

/**
 * Settings and fixes applied to every WebTorrent torrent Tern starts.
 *
 * Piece order is 'sequential', not 'rarest'. WebTorrent's rarest-first scans every piece on each
 * request and has each peer fetch a different piece, so a big torrent ends up with hundreds of
 * half-finished pieces held in memory (a 151 GB, 38 742-piece torrent grew from 300 to 750 MB in
 * five minutes while verifying five pieces) and the main thread burns CPU. Sequential finishes
 * pieces in order, keeps memory flat and writes each file front to back.
 */

// Recently used pieces kept in memory (default 20). At 4 MB pieces the default is 80 MB per torrent.
const STORE_CACHE_SLOTS = 4
// Peers already pipeline 0.5–1 second of blocks. A 5 ms refill batch avoids
// repeatedly scanning every peer on separate TCP callbacks at 60+ MB/s.
const REFILL_DELAY_MS = 5

/** @param {{ path: string, store: Function }} base */
function torrentOptions ({ path, store }) {
  return { path, store, deselect: true, strategy: 'sequential', storeCacheSlots: STORE_CACHE_SLOTS }
}

/**
 * WebTorrent builds a piece-availability map for every torrent even when rarest-first is not used,
 * and recalculates it (peers x pieces) on every peer connection and bitfield message. On a torrent
 * with tens of thousands of pieces that blocks the main thread for whole seconds. Sequential order
 * never reads it, so drop it as soon as the metadata (and with it the map) exists.
 *
 * @param {object} torrent a WebTorrent torrent
 * @returns {boolean} true when a map was removed
 */
function dropRarityMap (torrent) {
  const map = torrent && torrent._rarityMap
  if (!map || typeof map.destroy !== 'function') return false
  map.destroy()
  torrent._rarityMap = null
  return true
}

/**
 * WebTorrent 3.0.21 refills every peer after each 16 KiB block and rechecks each
 * unfinished file from its first piece on every completed piece. Batch refills
 * within a small bounded window and keep a verified frontier for each file. The
 * original completion routine still owns done events, tracker announces and
 * selection cleanup. Hash verification and storage are unchanged.
 */
function installTorrentOptimizations (torrent) {
  if (torrent._ternOptimized || typeof torrent._update !== 'function' ||
      typeof torrent._checkDone !== 'function' || typeof torrent._markUnverified !== 'function' ||
      typeof torrent._gcSelections !== 'function' || typeof torrent._updateWireInterest !== 'function') return false
  torrent._ternOptimized = true
  const update = torrent._update
  const checkDone = torrent._checkDone
  const markUnverified = torrent._markUnverified
  const frontiers = new WeakMap()
  let firstMissing = 0
  let pending = null

  torrent._update = function () {
    if (this.destroyed || pending !== null) return
    pending = setTimeout(() => {
      pending = null
      if (!this.destroyed) update.call(this)
    }, REFILL_DELAY_MS)
  }
  torrent.once('close', () => { if (pending !== null) clearTimeout(pending); pending = null })

  torrent._markUnverified = function (index) {
    // Reset before the original method: it can select pieces and update interest.
    firstMissing = Math.min(firstMissing, index)
    for (const file of this.files) {
      if (index >= file._startPiece && index <= file._endPiece) {
        frontiers.set(file, Math.min(frontiers.get(file) ?? file._startPiece, index))
      }
    }
    return markUnverified.call(this, index)
  }

  torrent._checkDone = function () {
    if (this.destroyed) return
    let allDone = true
    let newlyDone = false
    for (const file of this.files) {
      if (file.done) continue
      allDone = false
      let next = frontiers.get(file) ?? file._startPiece
      while (next <= file._endPiece && this.bitfield.get(next)) next++
      frontiers.set(file, next)
      if (next > file._endPiece) newlyDone = true
    }
    if (newlyDone || this.done !== allDone) return checkDone.call(this)
    this._gcSelections()
    return allDone
  }

  torrent._updateWireInterest = function (wire) {
    while (firstMissing < this.pieces.length && !this.pieces[firstMissing]) firstMissing++
    for (let i = firstMissing; i < this.pieces.length; i++) {
      if (this.pieces[i] && wire.peerPieces.get(i)) { wire.interested(); return }
    }
    wire.uninterested()
  }
  return true
}

module.exports = { torrentOptions, dropRarityMap, installTorrentOptimizations, STORE_CACHE_SLOTS, REFILL_DELAY_MS }
