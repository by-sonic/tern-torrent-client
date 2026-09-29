# Changelog

All notable changes to Tern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.3] - 2026-09-30

### Changed
- Torrent networking, hashing and disk work run in a dedicated process, leaving the window's event loop available for UI work.
- Peer request refills are batched within a bounded 5 ms window. Completed file prefixes are checked once as downloads advance,
  and peer interest checks skip the verified prefix instead of walking it again.
- The list, file progress and saved resume state share one piece scan. File progress also correctly handles files ending
  exactly on a piece boundary.
- The details panel refreshes file progress less often and updates DOM/canvases only when their inputs change.
- WebTorrent is pinned to the version covered by the scheduler/completion regression tests.
- A bounded six-peer test at about 60 MiB/s used 21.8% less mean engine CPU time. Maximum engine stalls fell from
  516–586 ms to 28–31 ms; throughput was maintained. See `docs/performance.md` for the measurements and their limits.

### Fixed
- Finishing with seeding disabled no longer destroys the torrent in the middle of WebTorrent's file-completion callback.
- Healthy multi-file deletion renews its watchdog as files are moved to the Recycle Bin.

### Added
- Regression checks in the real Electron runtime, including download/pause/restart and the engine inside the packaged archive.
- `npm run bench` now runs the bounded active-download benchmark; `npm run bench:active` repeats the comparison.

## [1.0.2] - 2026-09-29

### Changed
- **Much lighter in the background.** Closing the window to the tray now really closes it, so the renderer and its memory
  are released; starting with Windows (`--hidden`) never creates a window at all. The list is only built and refreshed while
  a visible window is watching; in the tray the app wakes up every 5 seconds instead of every second and updates just the
  tooltip. The interface uses software rendering, which removes the GPU process and its idle work.
- Measured with one seeding torrent (private working set, as Task Manager shows it): tray mode went from 118 MB to 61 MB and
  from 1.77% to 0.13% of one CPU core; with the window open memory went from 105 MB to 84 MB.
- The tray tooltip is only updated when its text changes.

## [1.0.1] - 2026-09-29

### Fixed
- **Big torrents could freeze Tern, the network and the whole computer.** WebTorrent's rarest-first piece picker and its
  piece-availability map cost time proportional to peers x pieces, so on a torrent with tens of thousands of pieces the
  main process stalled for up to 40 seconds at a time. Tern now downloads pieces in order and drops the availability map.
  On a local 32 768-piece test the old settings reached only 6% in 166 s while keeping a CPU core busy; the new ones finish
  in 17 s.
- **Huge files were filled with zeros on NTFS.** Pieces arriving far past the end of a new file made Windows write the
  whole gap first (tens of gigabytes on a large torrent), saturating the disk and Node's I/O thread pool. Large files are
  now created as sparse files.
- Memory: a smaller piece cache (4 pieces instead of 20).
- Node's I/O thread pool is larger (16 threads), so slow disk operations no longer stall DNS and network lookups.

### Added
- `npm run bench`: a local benchmark that reproduces big-torrent stalls without internet access.

## [1.0.0] - 2026-09-29

First public release.

### Added
- Torrent client for Windows 10/11 on the WebTorrent engine: magnet links and `.torrent` files.
- File picker before a download starts, and file selection that can be changed later.
- Live piece strip in the list and piece mosaic in the details panel.
- Speed limits, download queue with reordering, seeding after completion.
- Tray icon, close-to-tray and optional start with Windows.
- "Make default" registration for `.torrent` files and `magnet:` links.
- Automatic updates from GitHub Releases, with a banner, a manual check and an off switch.
- Light and dark themes, search and sortable columns.
