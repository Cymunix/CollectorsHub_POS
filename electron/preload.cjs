const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nordvikDesktop', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  exitApp: () => ipcRenderer.invoke('app:exit'),
  selectScanImages: () => ipcRenderer.invoke('scanner:select-images'),
  scanImage: () => ipcRenderer.invoke('scanner:scan-image'),
})
