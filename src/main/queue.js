'use strict'

/**
 * Decide which torrents should be running right now.
 *
 * - paused torrents never run
 * - unfinished torrents run in list order, at most `maxActive` of them
 * - finished torrents run (seed) only when `seed` is true and do not use a slot
 *
 * @param {{id: string, order: number, paused: boolean, done: boolean}[]} entries
 * @param {{maxActive: number, seed: boolean}} rules
 * @returns {Set<string>} ids that should be live
 */
function planQueue (entries, { maxActive, seed }) {
  const limit = Math.max(1, Math.floor(maxActive) || 1)
  const run = new Set()
  let slots = 0
  const ordered = [...entries].sort((a, b) => a.order - b.order)
  for (const entry of ordered) {
    if (entry.paused) continue
    if (entry.done) {
      if (seed) run.add(entry.id)
      continue
    }
    if (slots < limit) {
      run.add(entry.id)
      slots += 1
    }
  }
  return run
}

/**
 * Move one id inside an ordered list of ids. Returns a new array.
 * @param {string[]} ids
 * @param {string} id
 * @param {'up' | 'down' | 'top'} where
 */
function moveId (ids, id, where) {
  const from = ids.indexOf(id)
  if (from === -1) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  const to = where === 'top' ? 0 : where === 'up' ? Math.max(0, from - 1) : Math.min(next.length, from + 1)
  next.splice(to, 0, id)
  return next
}

module.exports = { planQueue, moveId }
