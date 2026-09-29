# Contributing to Tern

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Report a bug or suggest a feature

Open an [issue](https://github.com/by-sonic/tern-torrent-client/issues/new/choose). For a bug, include the Tern version (Settings → Updates), your Windows version and the steps to reproduce it. Please do not attach copyrighted material or links to it.

## Set up

```bash
git clone https://github.com/by-sonic/tern-torrent-client.git
cd tern-torrent-client
npm ci --ignore-scripts
npm test
npm start
```

Node.js 22 or newer. The app is Electron (main process in `src/main`, sandboxed preload in `src/preload`, plain-JS interface in `src/renderer`) on top of the WebTorrent engine.

Running the app while developing: set `TERN_USER_DATA` and `TERN_DOWNLOADS` to throw-away folders so you never touch your real profile or downloads. These hooks only work in an unpackaged build.

## Pull requests

- Keep a change focused, and add or update tests. `npm test` must pass; it includes a real two-client swarm over loopback.
- The renderer is untrusted by design: validate every argument in `src/main/main.js` and never expose generic `ipcRenderer` or file system access from the preload.
- Do not add telemetry, remote content or new network endpoints.
- UI text goes through `src/renderer/strings.js` where it can, and keeps a plain, direct tone.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The **Release** workflow builds the Windows installer and publishes it with `latest.yml`, which is what installed copies of Tern use to update. It fails if the tag and `package.json` version differ.
