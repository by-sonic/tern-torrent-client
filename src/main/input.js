'use strict'

// Pure helpers: decide what a string / command-line argument means.

const path = require('node:path')

const MAGNET_RE = /^magnet:\?(?:[^#\s]*&)?xt=urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})(?:&[^#\s]*)?$/i
const INFOHASH_RE = /^[a-f0-9]{40}$/i
const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024
const MAX_TORRENT_FILES = 10_000

/** Absolute local path; UNC (\\host\share) is refused so Windows never opens an SMB connection. */
function isLocalAbsolutePath (p) {
  return typeof p === 'string' && path.isAbsolute(p) && !/^[\\/]{2}/.test(p)
}

/**
 * @param {unknown} raw
 * @returns {{kind: 'magnet', uri: string} | {kind: 'file', path: string} | null}
 */
function classifyInput (raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/^"(.*)"$/, '$1')
  if (!text || text.length > 8192) return null

  if (MAGNET_RE.test(text)) return { kind: 'magnet', uri: text }
  if (INFOHASH_RE.test(text)) return { kind: 'magnet', uri: `magnet:?xt=urn:btih:${text.toLowerCase()}` }
  if (/\.torrent$/i.test(text) && isLocalAbsolutePath(text)) return { kind: 'file', path: text }
  return null
}

/**
 * Everything in argv that Tern can open. Flags and the app path are skipped;
 * relative file paths are resolved against `cwd` (argv comes from the OS, not the UI).
 * @param {string[]} argv
 * @param {string} [cwd]
 */
function extractLaunchInputs (argv, cwd = process.cwd()) {
  const found = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('--')) continue
    const looksLikeFile = /\.torrent"?$/i.test(arg) && !/^[\\/]{2}/.test(arg) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)
    const input = classifyInput(looksLikeFile && !path.isAbsolute(arg) ? path.resolve(cwd, arg) : arg)
    if (input) found.push(input)
  }
  return found
}

module.exports = { classifyInput, extractLaunchInputs, isLocalAbsolutePath, MAX_TORRENT_FILE_BYTES, MAX_TORRENT_FILES }
