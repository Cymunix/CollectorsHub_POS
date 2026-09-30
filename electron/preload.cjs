const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nordvikDesktop', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  exitApp: () => ipcRenderer.invoke('app:exit'),
  refocusWindow: () => ipcRenderer.invoke('app:refocus'),
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
  openScannerSession: () => ipcRenderer.invoke('scanner:open-session'),
  closeScannerSession: () => ipcRenderer.invoke('scanner:close-session'),
  getScannerStatus: () => ipcRenderer.invoke('scanner:get-status'),
  onScannerStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('scanner:status', listener)
    return () => ipcRenderer.removeListener('scanner:status', listener)
  },
  recropScan: (image, rect) => ipcRenderer.invoke('scanner:recrop', { image, rect }),
  analyzeCardScan: (image, options) => ipcRenderer.invoke('scanner:analyze-card', image, options),
  readScanImage: (image) => ipcRenderer.invoke('scanner:read-image', image),
  getAiStatus: () => ipcRenderer.invoke('ai:status'),
  installAiModel: () => ipcRenderer.invoke('ai:install-model'),
  cancelAiModelInstall: () => ipcRenderer.invoke('ai:cancel-install'),
  onAiInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('ai:install-progress', listener)
    return () => ipcRenderer.removeListener('ai:install-progress', listener)
  },
  recognizeCard: (request) => ipcRenderer.invoke('ai:recognize-card', request),
  cancelCardRecognition: (jobId) => ipcRenderer.invoke('ai:cancel-recognition', jobId),
})
