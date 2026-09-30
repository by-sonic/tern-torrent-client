'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { isLocalAbsolutePath, MAX_TORRENT_FILE_BYTES } = require('./input')

const HASH_RE = /^[a-f0-9]{64}$/
const pathKey = (target) => process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)
const contained = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// Native Recycle Bin operations must never receive a device path or an NTFS stream.
function safeLocalPath (target) {
  if (!isLocalAbsolutePath(target) || target.includes('\0')) return false
  if (process.platform !== 'win32') return true
  return !target.slice(2).includes(':') && !target.slice(3).split(/[\\/]/).some((part) => /[. ]$/.test(part))
}

function cleanSourceTorrent (source) {
  if (!source || !safeLocalPath(source.path) || typeof source.sha256 !== 'string' || !HASH_RE.test(source.sha256)) return null
  const identity = source.identity
  const validIdentity = identity && typeof identity.dev === 'string' && typeof identity.ino === 'string' && /^\d+$/.test(identity.dev) && /^\d+$/.test(identity.ino) &&
    Number.isFinite(identity.size) && Number.isFinite(identity.mtimeMs) && Number.isFinite(identity.ctimeMs)
  return { path: path.resolve(source.path), sha256: source.sha256, ...(validIdentity ? { identity: {
    dev: identity.dev, ino: identity.ino, size: identity.size, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs
  } } : {}) }
}

const identityOf = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs) })
const sameIdentity = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key] === b[key])

/** Resolve read-only ownership aliases, refusing remote link destinations before following them. */
async function resolveLocalPath (target) {
  if (!safeLocalPath(target)) return { status: 'unsafe' }
  let absolute = path.resolve(target)
  let leafLink = false
  for (let hops = 0; hops <= 32; hops++) {
    const parsed = path.parse(absolute)
    const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
    let current = parsed.root
    let redirected = false
    let finalStat
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = path.join(current, parts[i])
      let destination
      // Read the reparse target before lstat: a broken remote Windows junction can make lstat follow its target.
      try { destination = await fs.promises.readlink(current) } catch (err) {
        if (err.code !== 'EINVAL') return { status: err.code === 'ENOENT' ? 'missing' : 'failed' }
      }
      if (destination === undefined) {
        let stat
        try { stat = await fs.promises.lstat(current, { bigint: true }) } catch (err) { return { status: err.code === 'ENOENT' ? 'missing' : 'failed' } }
        if (stat.isSymbolicLink()) return { status: 'unsafe' } // Changed since the readlink check.
        if (i < parts.length - 1 && !stat.isDirectory()) return { status: 'unsafe' }
        if (i === parts.length - 1) finalStat = stat
        continue
      }
      if (hops === 32) return { status: 'unsafe' }
      // Node exposes Windows local junction targets with the extended prefix. Only this local form is accepted.
      if (process.platform === 'win32' && /^\\\\\?\\[a-z]:[\\/]/i.test(destination)) destination = destination.slice(4)
      if (/^[\\/]{2}/.test(destination) || (process.platform === 'win32' && /:/.test(destination) && !isLocalAbsolutePath(destination))) return { status: 'unsafe' }
      destination = path.isAbsolute(destination) ? destination : path.resolve(path.dirname(current), destination)
      if (!safeLocalPath(destination)) return { status: 'unsafe' }
      leafLink ||= i === parts.length - 1
      absolute = path.resolve(destination, ...parts.slice(i + 1))
      if (!safeLocalPath(absolute)) return { status: 'unsafe' }
      redirected = true
      break
    }
    if (!redirected) {
      // Windows junction readlink can return an 8.3 alias. Canonicalize only after verifying the local chain.
      let canonical
      try { canonical = await fs.promises.realpath(absolute) } catch (err) { return { status: err.code === 'ENOENT' ? 'missing' : 'failed' } }
      if (!safeLocalPath(canonical)) return { status: 'unsafe' }
      const checked = await inspectPath(canonical, finalStat.isDirectory())
      if (checked.status !== 'ready') return checked
      if (checked.identity.dev !== String(finalStat.dev) || checked.identity.ino !== String(finalStat.ino)) return { status: 'unsafe' }
      return { status: 'ready', path: canonical, leafLink }
    }
  }
  return { status: 'unsafe' }
}

/** Check every component, including the root and final file. Windows junctions are symbolic links here. */
async function inspectPath (target, directory = false) {
  if (!safeLocalPath(target)) return { status: 'unsafe' }
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  let stat
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i])
    try { stat = await fs.promises.lstat(current, { bigint: true }) } catch (err) {
      return { status: err.code === 'ENOENT' ? 'missing' : 'failed' }
    }
    if (stat.isSymbolicLink()) return { status: 'unsafe' }
    const last = i === parts.length - 1
    if (!last && !stat.isDirectory()) return { status: 'unsafe' }
    if (last && !(directory ? stat.isDirectory() : stat.isFile())) return { status: 'unsafe' }
  }
  return { status: 'ready', identity: identityOf(stat) }
}

/** Bounded reads also remain bounded if an external process grows a file after stat(). */
async function readTorrentFile (target) {
  const inspected = await inspectPath(target)
  if (inspected.status !== 'ready') return inspected
  if (inspected.identity.size > MAX_TORRENT_FILE_BYTES) return { status: 'unsafe' }
  let handle
  try {
    handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const before = identityOf(await handle.stat({ bigint: true }))
    if (!sameIdentity(before, inspected.identity)) return { status: 'unsafe' }
    const bytes = Buffer.alloc(Math.min(MAX_TORRENT_FILE_BYTES + 1, before.size + 1))
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = identityOf(await handle.stat({ bigint: true }))
    if (length !== before.size || !sameIdentity(before, after)) return { status: 'unsafe' }
    const buffer = bytes.subarray(0, length)
    return { status: 'ready', buffer, identity: after, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }
  } catch (err) { return { status: err.code === 'ENOENT' ? 'missing' : 'failed' } }
  finally { if (handle) await handle.close().catch(() => {}) }
}

/** Import may read a local junction alias; native removal remembers only its resolved regular file. */
async function readImportedTorrent (target) {
  const resolved = await resolveLocalPath(target)
  if (resolved.status !== 'ready') return resolved
  const read = await readTorrentFile(resolved.path)
  return { ...read, path: resolved.path, trackSource: !resolved.leafLink }
}

/** Repeated in the main process immediately before granting native trash authority. */
async function validateTrashTarget (target) {
  if (target.kind === 'content') {
    if (!safeLocalPath(target.root) || !contained(target.root, target.path)) return { status: 'unsafe' }
    const inspected = await inspectPath(target.path)
    if (inspected.status === 'ready' && target.identity && !sameIdentity(target.identity, inspected.identity)) return { status: 'unsafe' }
    return inspected
  }
  if (target.kind !== 'source' || !cleanSourceTorrent(target)) return { status: 'unsafe' }
  const read = await readTorrentFile(target.path)
  if (read.status !== 'ready') return read
  if (read.sha256 !== target.sha256 || (target.identity && !sameIdentity(target.identity, read.identity))) return { status: 'unsafe' }
  return read
}

async function pruneEmptyDirectories (root, files, progress = () => {}) {
  const directories = new Set()
  for (const file of files) {
    if (!contained(root, file)) continue
    for (let directory = path.dirname(file); contained(root, directory); directory = path.dirname(directory)) directories.add(directory)
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    progress()
    if ((await inspectPath(directory, true)).status !== 'ready') continue
    try { await fs.promises.rmdir(directory) } catch { /* Non-empty or already gone: leave it. */ }
  }
}

module.exports = { pathKey, contained, safeLocalPath, cleanSourceTorrent, inspectPath, resolveLocalPath, readTorrentFile, readImportedTorrent, validateTrashTarget, pruneEmptyDirectories }
