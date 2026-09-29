'use strict'

/** One piece pass shared by the list, Files tab and saved resume state. */
function measureTorrentProgress (torrent, maxBuckets) {
  const count = torrent.pieces.length
  const buckets = Math.min(maxBuckets, count)
  const prefix = new Float64Array(count + 1)
  let pieces = ''
  let bucket = 0
  let bucketStart = 0
  let bucketEnd = buckets ? Math.floor(count / buckets) : 0
  let verifiedInBucket = 0
  const downloaded = (i) => {
    const length = i === count - 1 ? torrent.lastPieceLength : torrent.pieceLength
    if (torrent.bitfield.get(i)) return length
    const piece = torrent.pieces[i]
    return piece ? Math.max(0, length - piece.missing) : 0
  }
  for (let i = 0; i < count; i++) {
    const verified = torrent.bitfield.get(i)
    const length = i === count - 1 ? torrent.lastPieceLength : torrent.pieceLength
    const piece = torrent.pieces[i]
    prefix[i + 1] = prefix[i] + (verified ? length : piece ? Math.max(0, length - piece.missing) : 0)
    if (verified) verifiedInBucket++
    if (i + 1 === bucketEnd) {
      pieces += String(Math.round(verifiedInBucket / (bucketEnd - bucketStart) * 9))
      bucket++
      bucketStart = bucketEnd
      bucketEnd = Math.floor((bucket + 1) * count / buckets)
      verifiedInBucket = 0
    }
  }
  const files = torrent.files.map((file) => {
    if (!file.length || !count) return 0
    const start = Math.floor(file.offset / torrent.pieceLength)
    const end = Math.floor((file.offset + file.length - 1) / torrent.pieceLength)
    const head = file.offset - start * torrent.pieceLength
    const tail = Math.min(torrent.length, (end + 1) * torrent.pieceLength) - (file.offset + file.length)
    const bytes = prefix[end + 1] - prefix[start] - Math.min(head, downloaded(start)) - Math.min(tail, downloaded(end))
    return Math.min(file.length, Math.max(0, bytes))
  })
  return { files, pieces }
}

module.exports = { measureTorrentProgress }
