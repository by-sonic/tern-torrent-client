# Changelog

All notable changes to Tern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
