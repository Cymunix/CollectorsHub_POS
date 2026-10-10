const { contextBridge, ipcRenderer, webFrame } = require('electron')

// The app is laid out for a maximized 1920x1080 screen. Smaller or larger windows are
// scaled to fit (real page zoom, so full-height layouts still fit exactly):
// e.g. a 1366x768 laptop ~80%, 2560x1440 ~125%. Updates as the window resizes.
const DESIGN_WIDTH = 1920
const DESIGN_HEIGHT = 1000 // a maximized 1080p window, after the title bar and taskbar
function fitToWindow() {
  const zoom = webFrame.getZoomFactor() || 1
  // Window size in screen pixels (innerWidth is in zoomed CSS pixels).
  const width = window.innerWidth * zoom
  const height = window.innerHeight * zoom
  if (!width || !height) return
  const fit = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT)
  const next = Math.round(Math.min(1.25, Math.max(0.75, fit)) * 20) / 20
  if (Math.abs(next - zoom) >= 0.01) webFrame.setZoomFactor(next)
}
let fitTimer = 0
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitToWindow, 120) })
window.addEventListener('DOMContentLoaded', fitToWindow)

contextBridge.exposeInMainWorld('nordvikDesktop', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  logError: (entry) => ipcRenderer.invoke('app:log-error', entry),
  exitApp: () => ipcRenderer.invoke('app:exit'),
  refocusWindow: () => ipcRenderer.invoke('app:refocus'),
  getPendingUpdate: () => ipcRenderer.invoke('app:get-pending-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
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
  scanIdentityDocument: () => ipcRenderer.invoke('scanner:scan-identity'),
  openScannerSession: () => ipcRenderer.invoke('scanner:open-session'),
  closeScannerSession: () => ipcRenderer.invoke('scanner:close-session'),
  getScannerStatus: () => ipcRenderer.invoke('scanner:get-status'),
  onScannerStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('scanner:status', listener)
    return () => ipcRenderer.removeListener('scanner:status', listener)
  },
  recropScan: (image, rect) => ipcRenderer.invoke('scanner:recrop', { image, rect }),
  compactScans: (images) => ipcRenderer.invoke('scanner:compact-scans', images),
  configureCatalogueBackup: (config) => ipcRenderer.invoke('backup:configure', config),
  getCatalogueBackupStatus: () => ipcRenderer.invoke('backup:status'),
  chooseCatalogueBackupFolder: () => ipcRenderer.invoke('backup:choose-folder'),
  recordCatalogueChange: (change) => ipcRenderer.invoke('backup:record', change),
  verifyCatalogueBackup: () => ipcRenderer.invoke('backup:verify'),
  openCatalogueBackupFolder: () => ipcRenderer.invoke('backup:open-folder'),
  onCatalogueBackupStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('backup:status', listener)
    return () => ipcRenderer.removeListener('backup:status', listener)
  },
  getScanStorage: () => ipcRenderer.invoke('scanner:get-storage'),
  unusedScans: (request) => ipcRenderer.invoke('scanner:unused-scans', request),
  chooseScanStorage: () => ipcRenderer.invoke('scanner:choose-storage'),
  moveScans: () => ipcRenderer.invoke('scanner:move-scans'),
  onMoveScansProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('scanner:move-progress', listener)
    return () => ipcRenderer.removeListener('scanner:move-progress', listener)
  },
  feedStack: (options) => ipcRenderer.invoke('scanner:feed-stack', options),
  cancelFeed: () => ipcRenderer.invoke('scanner:cancel-feed'),
  refreshFeeder: () => ipcRenderer.invoke('scanner:refresh-feeder'),
  rotateScanImage: (image, degrees) => ipcRenderer.invoke('scanner:rotate-image', image, degrees),
  compareScanWithPhoto: (image, photoUrl) => ipcRenderer.invoke('scanner:compare-with-photo', image, photoUrl),
  onFeedCard: (callback) => {
    const listener = (_event, card) => callback(card)
    ipcRenderer.on('scanner:feed-card', listener)
    return () => ipcRenderer.removeListener('scanner:feed-card', listener)
  },
  onFeedProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('scanner:feed-progress', listener)
    return () => ipcRenderer.removeListener('scanner:feed-progress', listener)
  },
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
  warmUpAi: () => ipcRenderer.invoke('ai:warm-up'),
  checkCardOrientation: (request) => ipcRenderer.invoke('ai:check-orientation', request),
  cancelCardRecognition: (jobId) => ipcRenderer.invoke('ai:cancel-recognition', jobId),
})
