'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('tern', {
  getState: () => call('state:get'),
  onState: listen('state'),
  onToast: listen('toast'),
  onUpdate: listen('update'),

  addText: (text) => call('add:text', text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  addPaths: (paths) => call('add:paths', paths),
  pickTorrent: () => call('add:pick'),
  pickFolder: (current) => call('folder:pick', current),

  confirm: (id, options) => call('torrent:confirm', id, options),
  pause: (id) => call('torrent:pause', id),
  resume: (id) => call('torrent:resume', id),
  pauseAll: () => call('torrent:pause-all'),
  resumeAll: () => call('torrent:resume-all'),
  move: (id, where) => call('torrent:move', id, where),
  remove: (id, trash) => call('torrent:remove', id, trash),
  files: (id) => call('torrent:files', id),
  select: (id, selected) => call('torrent:select', id, selected),
  info: (id) => call('torrent:info', id),
  reveal: (id) => call('torrent:reveal', id),

  setSettings: (patch) => call('settings:set', patch),
  registerHandler: () => call('handler:register'),
  appInfo: () => call('app:info'),
  checkForUpdates: () => call('update:check'),
  installUpdate: () => call('update:install')
})
