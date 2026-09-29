'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SAVE_DELAY_MS = 800

/**
 * Tiny JSON file with atomic writes and a debounced save.
 * A corrupt file is moved aside instead of being silently discarded.
 */
class JsonStore {
  constructor (file, fallback) {
    this.file = file
    this.fallback = fallback
    this.timer = null
    this.pending = null
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : this.fallback()
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* nothing to keep */ }
        console.error('[store] could not read state, starting fresh:', err.message)
      }
      return this.fallback()
    }
  }

  saveSoon (getData) {
    this.pending = getData
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
  }

  flush () {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending) return
    const getData = this.pending
    this.pending = null
    try {
      const data = getData()
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] save failed:', err.message)
    }
  }
}

module.exports = { JsonStore }
