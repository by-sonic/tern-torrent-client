# Torrent removal

The renderer sends only a torrent ID and a boolean. `createRemovalDialog` captures the ID when opened and resets the
file-removal checkbox. Cancel and Escape send no removal request. Cancelling an unconfirmed import remains a separate
operation that preserves files.

With the checkbox unchecked, Tern stops the torrent, removes its list entry and cleans up its internal metadata cache.
With the checkbox checked, `EngineService` first obtains an internal removal plan from the utility process. Preparation
pauses the torrent and captures its resume state; prepared entries remain in saved state until removal commits. Failed
preparation and abandoned plans can be retried. Once file removal commits, partial failures do not restore stale resume
state: the torrent leaves the list and the UI reports files that could not be removed.

The plan reads bounded metadata for the matching infoHash, rather than trusting file paths saved in `state.json`.
Targets are exact files inside the download directory, plus the saved original `.torrent` source. The optional
`sourceTorrent` field stores the source path, SHA-256 and file identity without changing state schema version 1. Legacy
records load with no source; reopening the same `.torrent` attaches one without restarting the download.
Read-only imports through a local linked directory use the resolved regular file as the source. If the imported file
itself is a symbolic link, the torrent can be opened, but neither that link nor its target is attached for deletion.

Both the engine and native bridge validate targets. The bridge grants each path once for its associated removal request.
Content file identity, local containment, shared paths and hard links, symbolic links, junctions and Windows path aliases
are checked. Source bytes and identity must still match the import. Only empty directories are pruned. Native
`shell.trashItem` uses the Windows Recycle Bin; it takes a path, so validation is not an atomic file-handle guarantee
against another local process replacing a path between its final check and the operating-system operation.

Preparation and native file operations renew their watchdog while making progress; stalled requests still time out.
Fixture tests cover persistence, cancellation, changed/missing sources, shared files, unsafe paths, partial failures and
request authority. Electron checks exercise the utility bridge and renderer, including the packaged `app.asar`.
