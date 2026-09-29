'use strict'

const fs = require('node:fs/promises')
const { spawn: nativeSpawn } = require('node:child_process')
const { isLocalAbsolutePath } = require('./input')

// DownloadedUpdateHelper's file/info contract is private. Upgrade this adapter
// deliberately together with the pinned electron-updater dependency and tests.
const NSIS_UPDATER_VERSION = '6.8.9'

async function localFile (file, extension = null) {
  if (!isLocalAbsolutePath(file) || (extension && !file.toLowerCase().endsWith(extension))) throw new Error('invalid-update-installer')
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw new Error('invalid-update-installer')
}

/**
 * Startup cannot use BaseUpdater.quitAndInstall(): NSIS returns true before its
 * async spawn can fail, and BaseUpdater schedules app.quit unconditionally.
 * Launch only the verified, downloaded per-user standalone NSIS installer and
 * acknowledge the operating system's spawn event before the caller quits.
 */
function createNsisInstaller (updater, { spawn = nativeSpawn, updaterVersion = require('electron-updater/package.json').version } = {}) {
  return {
    async launch ({ signal, version } = {}) {
      if (updaterVersion !== NSIS_UPDATER_VERSION) throw new Error('unsupported-update-installer')
      const helper = updater && updater.downloadedUpdateHelper
      const installer = updater && updater.installerPath
      const info = helper && helper.downloadedFileInfo
      if (!helper || helper.file !== installer || !info ||
          typeof info.sha512 !== 'string' || info.sha512 !== helper.fileInfo?.info?.sha512 ||
          !version || version !== helper.versionInfo?.version) throw new Error('invalid-update-installer')
      // Tern's feed publishes standalone per-user NSIS installers. Spawning an
      // elevation helper is not proof that UAC accepted or started an installer.
      if (info.isAdminRightsRequired) throw new Error('update-admin-required')
      await localFile(installer, '.exe')
      const args = ['--updated', '/S', '--force-run']
      if (updater.installDirectory) {
        if (!isLocalAbsolutePath(updater.installDirectory)) throw new Error('invalid-update-install-directory')
        args.push(`/D=${updater.installDirectory}`)
      }
      if (helper.packageFile != null) {
        await localFile(helper.packageFile)
        args.push(`--package-file=${helper.packageFile}`)
      }
      if (signal?.aborted) throw new Error('update-install-cancelled')
      updater.autoInstallOnAppQuit = false
      return new Promise((resolve, reject) => {
        let child
        let settled = false
        const finish = (err) => {
          if (settled) return
          settled = true
          if (child) { child.removeListener('spawn', onSpawn); child.removeListener('error', onError) }
          if (err) return reject(err)
          // Avoid a second installation from any upstream quit listener.
          updater.quitAndInstallCalled = true
          child.once('error', () => {}) // detached process can report a later close error
          child.unref()
          resolve()
        }
        const onError = (err) => finish(err)
        const onSpawn = () => {
          if (signal?.aborted) { child.kill(); finish(new Error('update-install-cancelled')); return }
          finish(null)
        }
        try {
          child = spawn(installer, args, { detached: true, stdio: 'ignore', windowsHide: true, signal })
          child.once('error', onError)
          child.once('spawn', onSpawn)
        } catch (err) { finish(err) }
      })
    }
  }
}

module.exports = { createNsisInstaller, NSIS_UPDATER_VERSION }
