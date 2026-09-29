'use strict'

/**
 * Collapse a piece bitfield into `buckets` characters '0'..'9'.
 * Each character is how complete that slice of the torrent is, so the UI can
 * draw the real shape of the download no matter how many pieces it has.
 *
 * @param {(index: number) => boolean} has  true when piece `index` is verified
 * @param {number} pieceCount
 * @param {number} maxBuckets
 * @returns {string}
 */
function pieceMap (has, pieceCount, maxBuckets) {
  if (!pieceCount) return ''
  const buckets = Math.min(maxBuckets, pieceCount)
  let out = ''
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * pieceCount) / buckets)
    const end = Math.max(start + 1, Math.floor(((b + 1) * pieceCount) / buckets))
    let done = 0
    for (let i = start; i < end; i++) if (has(i)) done += 1
    out += String(Math.round((done / (end - start)) * 9))
  }
  return out
}

/** Reader over a bitfield stored as base64 (BitTorrent bit order: MSB first). */
function bitfieldReader (base64) {
  if (!base64) return () => false
  const bytes = Buffer.from(base64, 'base64')
  return (i) => {
    const byte = bytes[i >> 3]
    return byte !== undefined && (byte & (0x80 >> (i & 7))) !== 0
  }
}

module.exports = { pieceMap, bitfieldReader }
