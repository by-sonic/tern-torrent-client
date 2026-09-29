'use strict'

// Regenerates docs/screenshot-dark.png and docs/screenshot-light.png from the real interface
// with mock data. Run: npm run screenshots (the social card is scripts/social-card.js)

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, nativeTheme } = require('electron')

const ROOT = path.join(__dirname, '..')
const DOCS = path.join(ROOT, 'docs')
const SHOT = { width: 1440, height: 900 }
const WARM_UP_MS = 30_000 // lets the speed graph collect a minute-like history
const SETTLE_MS = 1200

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tern-shots-')))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function capture (win, file, wait = SETTLE_MS) {
  await sleep(wait)
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(DOCS, file), image.toPNG())
  console.log('wrote', file, `${image.getSize().width}x${image.getSize().height}`)
}

async function run () {
  const win = new BrowserWindow({
    ...SHOT, useContentSize: true, show: true, x: 0, y: 0, frame: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, 'mock-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
  })
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'))
  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme
    await capture(win, `screenshot-${theme}.png`, theme === 'dark' ? WARM_UP_MS : SETTLE_MS)
  }

  win.destroy()
}

app.whenReady().then(async () => {
  fs.mkdirSync(DOCS, { recursive: true })
  await run()
  app.quit()
}).catch((err) => { console.error(err); app.exit(1) })
