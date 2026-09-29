/** Checking existing data is a separate operation from downloading it. */
export function visibleProgress (torrent) {
  const check = torrent.state === 'checking' && torrent.verification
  if (!check) return torrent.progress
  return check.total ? Math.min(1, Math.max(0, check.checked / check.total)) : 0
}

/** During checking the strip follows attempted pieces, including invalid ones. */
export function visiblePieces (torrent) {
  if (torrent.state !== 'checking' || !torrent.verification) return torrent.pieces
  const count = Math.min(360, torrent.verification.total)
  const full = Math.floor(count * visibleProgress(torrent))
  return '9'.repeat(full) + '0'.repeat(count - full)
}
