const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nordvikDesktop', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  exitApp: () => ipcRenderer.invoke('app:exit'),
  getEbayApiConfig: () => ipcRenderer.invoke('ebay:get-config'),
  saveEbayApiConfig: (config) => ipcRenderer.invoke('ebay:save-config', config),
  testEbayApiConfig: () => ipcRenderer.invoke('ebay:test-config'),
  searchEbayMarket: (input) => ipcRenderer.invoke('ebay:search-market', input),
  selectScanImages: () => ipcRenderer.invoke('scanner:select-images'),
  scanImage: () => ipcRenderer.invoke('scanner:scan-image'),
})
