'use strict'

const { mkdir } = require('node:fs')
const { dirname } = require('node:path')

// Only large files gain anything from being sparse; tiny ones stay ordinary.
const SPARSE_MIN_BYTES = 32 * 1024 * 1024

/**
 * WebTorrent's default file store creates each file on the first write to it and writes pieces
 * wherever they arrive. On NTFS, a write far past the end of a file that is not marked sparse
 * makes Windows fill the whole gap with zeros first. On a big torrent that is tens of gigabytes
 * of pointless writes: it saturates the disk, blocks Node's I/O thread pool (which DNS lookups
 * share, so the network stalls too) and can freeze the whole computer.
 *
 * Files are opened through random-access-file with `sparse: true`, which marks them sparse
 * before the first write. Reads contained in one file return its buffer directly: the upstream
 * store copies even a single buffer through concat(), allocating a second full piece.
 *
 * @returns {Promise<typeof import('fs-chunk-store').default>} a store class WebTorrent accepts as `store`
 */
async function loadSparseStore () {
  const { default: FsChunkStore } = await import('fs-chunk-store')
  const RandomAccessFile = require('random-access-file')

  return class SparseChunkStore extends FsChunkStore {
    constructor (chunkLength, opts) {
      super(chunkLength, opts)
      for (const file of this.files) {
        if (!(file.length >= SPARSE_MIN_BYTES)) continue
        file.open = this._sparseOpener(file)
      }
    }

    get (index, opts, cb) {
      if (typeof opts === 'function') return this.get(index, null, opts)
      const targets = this.chunkMap[index]
      // Let upstream own closed-store errors, unbounded stores and multi-file pieces.
      if (this.closed || this.length === Infinity || !targets || targets.length !== 1) return super.get(index, opts, cb)
      const chunkLength = index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength
      const rangeFrom = (opts && opts.offset) || 0
      const rangeTo = opts && opts.length ? rangeFrom + opts.length : chunkLength
      const target = targets[0]
      // Delegate empty and invalid ranges too, preserving their asynchronous/error semantics.
      if (!Number.isInteger(rangeFrom) || !Number.isInteger(rangeTo) ||
          rangeFrom < target.from || rangeTo > target.to || rangeTo <= rangeFrom) return super.get(index, opts, cb)
      target.file.open((err, file) => {
        if (err) return cb(err)
        file.read(target.offset + rangeFrom - target.from, rangeTo - rangeFrom, cb)
      })
    }

    /** Same contract as fs-chunk-store's own `file.open`: memoised, calls back with the open file. */
    _sparseOpener (file) {
      let opened = null
      return (cb) => {
        if (!opened) {
          opened = new Promise((resolve) => {
            const closed = () => resolve({ err: new Error('Storage is closed') })
            if (this.closed) return closed()
            mkdir(dirname(file.path), { recursive: true }, (err) => {
              if (err) return resolve({ err })
              if (this.closed) return closed()
              resolve({ file: new RandomAccessFile(file.path, { sparse: true }) })
            })
          })
        }
        opened.then((result) => cb(result.err || null, result.file))
      }
    }
  }
}

module.exports = { loadSparseStore, SPARSE_MIN_BYTES }
