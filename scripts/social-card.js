'use strict'

// Renders docs/social-preview.png (1280x640, GitHub's recommended social preview size)
// from scripts/social.html. Needs docs/screenshot-dark.png first. Run: npm run screenshots

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tern-card-')))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 640, useContentSize: true, show: true, frame: false })
  await win.loadFile(path.join(__dirname, 'social.html'))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'social-preview.png'), image.toPNG())
  console.log('wrote social-preview.png', image.getSize())
  app.quit()
}).catch((err) => { console.error(err); app.exit(1) })
