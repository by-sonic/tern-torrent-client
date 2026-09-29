# Security policy

## Supported versions

Only the latest release receives security fixes. Tern updates itself, so most people are on it already.

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/by-sonic/tern-torrent-client/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it and the Tern version. You should get a reply within a few days.

## Scope and design notes

- Torrent files, magnet links, file names and peers are treated as untrusted input.
- The interface runs sandboxed with context isolation and a strict Content Security Policy; the main process validates every request it receives from it.
- Downloads can only be written to folders the person picked in the native folder dialog, and "delete files" only moves the torrent's own files to the Recycle Bin.
- Web seeds and uTP are disabled on purpose to shrink the attack surface.
- Updates come only from this repository's GitHub Releases and are checked against the SHA-512 in `latest.yml`. The installer is not code-signed yet, so the release notes also list its SHA-256.
