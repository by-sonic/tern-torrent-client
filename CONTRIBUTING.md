# Contributing to Tern

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Report a bug or suggest a feature

Open an [issue](https://github.com/by-sonic/tern-torrent-client/issues/new/choose). For a bug, include the Tern version (Settings → Updates), your Windows version and the steps to reproduce it. Please do not attach copyrighted material or links to it.

## Set up

```bash
git clone https://github.com/by-sonic/tern-torrent-client.git
cd tern-torrent-client
npm ci --ignore-scripts
npm rebuild node-datachannel electron
npm test
npm run test:electron
npm start
```

Node.js 22 or newer. The app is Electron (main process in `src/main`, sandboxed preload in `src/preload`, plain-JS interface in `src/renderer`) on top of the WebTorrent engine. `EngineService` runs the torrent engine in an Electron utility process so peer scheduling, hash checks and file I/O cannot block the window's event loop.

WebTorrent is pinned to 3.0.21 because `torrent-tuning.js` and `verification.js` wrap private scheduler/completion and verification methods. The sparse store also uses fs-chunk-store's chunk map for single-file reads. Before upgrading these dependencies, review the upstream methods and rerun the integration tests, Electron smokes, `npm run bench:active` and `npm run bench:verify`. See [performance measurements](docs/performance.md) for the bounded benchmarks and their limitations.

Running the app while developing: set `TERN_USER_DATA` and `TERN_DOWNLOADS` to throw-away folders so you never touch your real profile or downloads. These hooks only work in an unpackaged build.

The startup installer adapter targets this project's per-user, standalone NSIS build and is tested against electron-updater 6.8.9. It waits for the operating system to confirm the installer process before quitting. Review its downloaded-helper contract and rerun startup smokes before upgrading electron-updater or changing the installer target.

## Pull requests

- Keep a change focused, and add or update tests. `npm test` must pass; it includes a real two-client swarm over loopback.
- The renderer is untrusted by design: validate every argument in `src/main/main.js` and never expose generic `ipcRenderer` or file system access from the preload.
- Do not add telemetry, remote content or new network endpoints.
- UI text goes through `src/renderer/strings.js` where it can, and keeps a plain, direct tone.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The **Release** workflow builds the Windows installer and publishes it with `latest.yml`, which is what installed copies of Tern use to update. It fails if the tag and `package.json` version differ.
