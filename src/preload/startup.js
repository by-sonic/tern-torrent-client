'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ternStartup', {
  getState: () => ipcRenderer.invoke('startup:get'),
  retry: () => ipcRenderer.invoke('startup:retry'),
  continue: () => ipcRenderer.invoke('startup:continue'),
  quit: () => ipcRenderer.invoke('startup:quit'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('startup:state', handler)
    return () => ipcRenderer.removeListener('startup:state', handler)
  }
})
