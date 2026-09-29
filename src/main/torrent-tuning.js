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

module.exports = { torrentOptions, dropRarityMap, STORE_CACHE_SLOTS }
