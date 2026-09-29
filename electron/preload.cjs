const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nordvikDesktop', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  exitApp: () => ipcRenderer.invoke('app:exit'),
  getPendingUpdate: () => ipcRenderer.invoke('app:get-pending-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateReady: (callback) => {
    const listener = (_event, update) => callback(update)
    ipcRenderer.on('app:update-ready', listener)
    return () => ipcRenderer.removeListener('app:update-ready', listener)
  },
  getEbayApiConfig: () => ipcRenderer.invoke('ebay:get-config'),
  saveEbayApiConfig: (config) => ipcRenderer.invoke('ebay:save-config', config),
  testEbayApiConfig: () => ipcRenderer.invoke('ebay:test-config'),
  searchEbayMarket: (input) => ipcRenderer.invoke('ebay:search-market', input),
  listEbayItem: (item) => ipcRenderer.invoke('ebay:list-item', item),
  selectScanImages: () => ipcRenderer.invoke('scanner:select-images'),
  scanImage: (options) => ipcRenderer.invoke('scanner:scan-image', options),
  analyzeCardScan: (image, options) => ipcRenderer.invoke('scanner:analyze-card', image, options),
})
