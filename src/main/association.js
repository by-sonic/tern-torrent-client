'use strict'

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { app, shell } = require('electron')

const run = promisify(execFile)
const APP_KEY = 'Tern'

/**
 * Command line Windows runs when a .torrent file or magnet link is opened.
 * `--` stops Chromium's switch parsing, so a link containing a quote cannot inject switches.
 */
function openCommand () {
  const exe = process.execPath
  return app.isPackaged ? `"${exe}" -- "%1"` : `"${exe}" "${app.getAppPath()}" -- "%1"`
}

async function regAdd (key, name, value) {
  const args = ['add', `HKCU\\${key}`, '/f']
  if (name === '') args.push('/ve')
  else args.push('/v', name)
  if (value) args.push('/d', value)
  await run('reg.exe', args, { windowsHide: true })
}

/**
 * Registers Tern as a candidate handler for .torrent and magnet: in the current
 * user's registry (no admin needed) and opens Windows' Default apps page for it.
 * Windows does not allow apps to claim the default silently, the person picks it.
 */
async function registerAsHandler () {
  if (process.platform !== 'win32') throw new Error('unsupported-platform')
  const cls = 'Software\\Classes'
  const exe = process.execPath

  await regAdd(`${cls}\\Tern.Torrent`, '', 'Torrent file')
  await regAdd(`${cls}\\Tern.Torrent\\DefaultIcon`, '', `${exe},0`)
  await regAdd(`${cls}\\Tern.Torrent\\shell\\open\\command`, '', openCommand())

  await regAdd(`${cls}\\Tern.Magnet`, '', 'URL:Magnet link')
  await regAdd(`${cls}\\Tern.Magnet`, 'URL Protocol', '')
  await regAdd(`${cls}\\Tern.Magnet\\DefaultIcon`, '', `${exe},0`)
  await regAdd(`${cls}\\Tern.Magnet\\shell\\open\\command`, '', openCommand())

  await regAdd(`${cls}\\.torrent\\OpenWithProgids`, 'Tern.Torrent', '')

  const caps = `Software\\${APP_KEY}\\Capabilities`
  await regAdd(caps, 'ApplicationName', 'Tern')
  await regAdd(caps, 'ApplicationDescription', 'Minimal torrent client')
  await regAdd(`${caps}\\FileAssociations`, '.torrent', 'Tern.Torrent')
  await regAdd(`${caps}\\UrlAssociations`, 'magnet', 'Tern.Magnet')
  await regAdd('Software\\RegisteredApplications', APP_KEY, caps)

  await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${APP_KEY}`)
}

module.exports = { registerAsHandler }
