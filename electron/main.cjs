const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron')
const path = require('node:path')
const { copyFile, mkdir, readFile, writeFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { autoUpdater } = require('electron-updater')

const execFileAsync = promisify(execFile)

// PowerShell serialises error/progress records as CLIXML when its streams are
// redirected (as they are under execFile). Pull the human-readable text out of
// the <S S="Error">…</S> nodes so callers don't see a wall of XML.
function cleanPowerShellError(raw) {
  const text = String(raw || '')
  if (!text.includes('CLIXML')) return text.trim()
  const parts = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1])
  const message = (parts.length ? parts.join(' ') : text)
    .replace(/_x000D_/g, '')
    .replace(/_x000A_/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return message || text.trim()
}

const isDev = Boolean(process.env.NORDVIK_DESKTOP_RENDERER_URL)
const appRoot = path.resolve(__dirname, '..')
const distDir = path.join(appRoot, 'dist')
const appIconPath = path.join(appRoot, 'assets', 'icon.png')
let mainWindow = null
let ebayTokenCache = null

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'collectorshub-pos',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

function getDataDir() {
  return path.join(app.getPath('userData'), 'local-data')
}

function getStoreFile() {
  return path.join(getDataDir(), 'store.json')
}

function getScanDir() {
  return path.join(getDataDir(), 'scan-images')
}

function getEbayConfigFile() {
  return path.join(getDataDir(), 'ebay-api.json')
}

function sanitiseEbayConfig(config = {}) {
  return {
    environment: config.environment || 'production',
    marketplaceId: config.marketplaceId || 'EBAY_CA',
    clientId: config.clientId || '',
    clientSecretConfigured: Boolean(config.clientSecret),
    salesDataMode: config.salesDataMode || 'browse',
  }
}

async function loadEbayConfig({ includeSecret = false } = {}) {
  const fromEnv = {
    environment: process.env.EBAY_ENVIRONMENT || 'production',
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_CA',
    clientId: process.env.EBAY_CLIENT_ID || '',
    clientSecret: process.env.EBAY_CLIENT_SECRET || '',
    salesDataMode: process.env.EBAY_SALES_DATA_MODE || 'browse',
  }

  let stored = {}
  try {
    if (existsSync(getEbayConfigFile())) {
      stored = JSON.parse(await readFile(getEbayConfigFile(), 'utf8'))
    }
  } catch (error) {
    console.error('[eBay API] Config read failed:', error)
  }

  const config = { ...fromEnv, ...stored }
  return includeSecret ? config : sanitiseEbayConfig(config)
}

async function saveEbayConfig(nextConfig = {}) {
  const existing = await loadEbayConfig({ includeSecret: true })
  const config = {
    environment: nextConfig.environment || existing.environment || 'production',
    marketplaceId: nextConfig.marketplaceId || existing.marketplaceId || 'EBAY_CA',
    clientId: String(nextConfig.clientId || '').trim(),
    clientSecret: nextConfig.clientSecret ? String(nextConfig.clientSecret).trim() : existing.clientSecret || '',
    salesDataMode: nextConfig.salesDataMode || existing.salesDataMode || 'browse',
  }

  await mkdir(getDataDir(), { recursive: true })
  await writeFile(getEbayConfigFile(), JSON.stringify(config, null, 2))
  ebayTokenCache = null
  return sanitiseEbayConfig(config)
}

function ebayApiBase(config) {
  return config.environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
}

async function ebayJson(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function ebayErrorMessage(payload, fallback) {
  const errors = payload?.errors || payload?.error?.errors
  if (Array.isArray(errors) && errors.length) {
    return errors.map((entry) => entry.message || entry.longMessage || entry.errorId).filter(Boolean).join(' ')
  }
  return payload?.error_description || payload?.message || payload?.error || fallback
}

async function getEbayAccessToken(config) {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Add your eBay Client ID and Client Secret before connecting.')
  }

  if (
    ebayTokenCache?.token &&
    ebayTokenCache.environment === config.environment &&
    ebayTokenCache.clientId === config.clientId &&
    ebayTokenCache.expiresAt > Date.now() + 60000
  ) {
    return ebayTokenCache.token
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  })
  const response = await fetch(`${ebayApiBase(config)}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const payload = await ebayJson(response)
  if (!response.ok) throw new Error(ebayErrorMessage(payload, 'eBay OAuth failed.'))

  ebayTokenCache = {
    token: payload.access_token,
    environment: config.environment,
    clientId: config.clientId,
    expiresAt: Date.now() + Number(payload.expires_in || 7200) * 1000,
  }
  return ebayTokenCache.token
}

function normaliseEbayPrice(price) {
  return price ? { value: Number(price.value || 0), currency: price.currency || 'CAD' } : { value: 0, currency: 'CAD' }
}

function mapEbayBrowseItem(item) {
  const price = normaliseEbayPrice(item.price || item.currentBidPrice)
  const shipping = normaliseEbayPrice(item.shippingOptions?.[0]?.shippingCost)
  return {
    id: item.itemId || item.legacyItemId || randomUUID(),
    sourceSaleId: item.itemId || item.legacyItemId || null,
    sourceUrl: item.itemWebUrl || null,
    title: item.title || 'eBay listing',
    price: price.value,
    currency: price.currency,
    shippingPrice: shipping.value || null,
    dateOfSale: null,
    quantity: 1,
    rawCondition: item.condition || null,
    source: 'eBay Active',
    reviewStatus: 'REVIEW',
    include: false,
    exclusionReason: 'Active listing only; not confirmed sold.',
    raw: item,
  }
}

function mapEbaySoldItem(item) {
  const price = normaliseEbayPrice(item.price || item.soldPrice || item.currentBidPrice)
  const shipping = normaliseEbayPrice(item.shippingOptions?.[0]?.shippingCost)
  return {
    id: item.itemId || item.legacyItemId || randomUUID(),
    sourceSaleId: item.itemId || item.legacyItemId || null,
    sourceUrl: item.itemWebUrl || null,
    title: item.title || 'eBay sold item',
    price: price.value,
    currency: price.currency,
    shippingPrice: shipping.value || null,
    dateOfSale: item.itemEndDate || item.soldDate || item.lastSoldDate || null,
    quantity: Number(item.quantitySold || 1),
    rawCondition: item.condition || null,
    source: 'eBay',
    raw: item,
  }
}

async function searchEbayMarket({ query, limit = 25 } = {}) {
  const config = await loadEbayConfig({ includeSecret: true })
  const token = await getEbayAccessToken(config)
  const mode = config.salesDataMode === 'insights' ? 'insights' : 'browse'
  const base = ebayApiBase(config)
  const endpoint = mode === 'insights'
    ? `${base}/buy/marketplace_insights/v1_beta/item_sales/search`
    : `${base}/buy/browse/v1/item_summary/search`
  const url = new URL(endpoint)
  url.searchParams.set('q', query || '')
  url.searchParams.set('limit', String(Math.min(Math.max(Number(limit) || 25, 1), 50)))

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': config.marketplaceId || 'EBAY_CA',
      'Content-Type': 'application/json',
    },
  })
  const payload = await ebayJson(response)
  if (!response.ok) throw new Error(ebayErrorMessage(payload, 'eBay search failed.'))

  const items = mode === 'insights' ? payload?.itemSales || payload?.itemSummaries || [] : payload?.itemSummaries || []
  return {
    mode,
    marketplaceId: config.marketplaceId || 'EBAY_CA',
    total: Number(payload?.total || payload?.totalSoldItems || items.length || 0),
    candidates: items.map(mode === 'insights' ? mapEbaySoldItem : mapEbayBrowseItem),
    raw: payload,
  }
}

function createInitialStore() {
  const now = new Date().toISOString()

  return {
    meta: {
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    register: {
      status: 'closed',
      cashFloat: 0,
      openedAt: null,
    },
    inventory: [],
    customers: [],
    transactions: [],
  }
}

async function ensureStore() {
  const dataDir = getDataDir()
  const storeFile = getStoreFile()

  await mkdir(dataDir, { recursive: true })

  if (!existsSync(storeFile)) {
    await writeFile(storeFile, JSON.stringify(createInitialStore(), null, 2))
  }

  const raw = await readFile(storeFile, 'utf8')
  return JSON.parse(raw)
}

async function saveStore(nextStore) {
  const store = {
    ...nextStore,
    meta: {
      ...(nextStore.meta || {}),
      version: 1,
      updatedAt: new Date().toISOString(),
    },
  }

  await mkdir(getDataDir(), { recursive: true })
  await writeFile(getStoreFile(), JSON.stringify(store, null, 2))
  return store
}

function resolveDistPath(requestUrl) {
  const url = new URL(requestUrl)
  const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(distDir, normalizedPath)

  if (!filePath.startsWith(distDir)) {
    return path.join(distDir, 'index.html')
  }

  return filePath
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1060,
    minHeight: 700,
    title: 'CollectorsHub POS',
    icon: appIconPath,
    backgroundColor: '#f6f3ed',
    fullscreen: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }

    return { action: 'allow' }
  })

  if (isDev) {
    await mainWindow.loadURL(process.env.NORDVIK_DESKTOP_RENDERER_URL)
  } else {
    await mainWindow.loadURL('collectorshub-pos://app/index.html')
  }
}

function configureAutoUpdates() {
  if (isDev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    const detail = releaseName
      ? `${releaseName} has been downloaded and will install when CollectorsHub POS closes.`
      : 'An update has been downloaded and will install when CollectorsHub POS closes.'

    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: 'CollectorsHub POS update ready',
        detail,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall(false, true)
      })
    }
  })

  autoUpdater.on('error', (error) => {
    console.error('[Auto Update] Failed:', error)
  })

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.error('[Auto Update] Check failed:', error)
    })
  }, 5000)
}

ipcMain.handle('store:load', async () => ensureStore())
ipcMain.handle('store:save', async (_event, nextStore) => saveStore(nextStore))
ipcMain.handle('app:get-data-path', () => getStoreFile())
ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:exit', () => app.quit())
ipcMain.handle('ebay:get-config', async () => loadEbayConfig())
ipcMain.handle('ebay:save-config', async (_event, nextConfig) => saveEbayConfig(nextConfig))
ipcMain.handle('ebay:test-config', async () => {
  const config = await loadEbayConfig({ includeSecret: true })
  await getEbayAccessToken(config)
  return sanitiseEbayConfig(config)
})
ipcMain.handle('ebay:search-market', async (_event, input) => searchEbayMarket(input))
ipcMain.handle('scanner:select-images', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select scanned image files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'bmp'] },
    ],
  })

  if (result.canceled || !result.filePaths.length) return []

  await mkdir(getScanDir(), { recursive: true })
  const copied = []

  for (const sourcePath of result.filePaths) {
    const ext = path.extname(sourcePath) || '.jpg'
    const fileName = `${Date.now()}-${randomUUID()}${ext}`
    const destinationPath = path.join(getScanDir(), fileName)
    await copyFile(sourcePath, destinationPath)
    copied.push({
      sourcePath,
      path: destinationPath,
      url: pathToFileURL(destinationPath).toString(),
      fileName,
    })
  }

  return copied
})

ipcMain.handle('scanner:scan-image', async () => {
  if (process.platform !== 'win32') {
    throw new Error('Direct scanner control is currently available on Windows through the Canon WIA driver.')
  }

  await mkdir(getScanDir(), { recursive: true })
  const fileName = `${Date.now()}-${randomUUID()}.png`
  const destinationPath = path.join(getScanDir(), fileName)
  const escapedPath = destinationPath.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Suppress the "Preparing modules for first use" progress record, which
    // PowerShell otherwise serialises as CLIXML noise onto the error stream.
    "$ProgressPreference = 'SilentlyContinue'",
    // Give a clear message when there is simply no imaging device, instead of the
    // opaque COM "No WIA device of the selected type is available".
    "$manager = New-Object -ComObject WIA.DeviceManager",
    "if ($manager.DeviceInfos.Count -eq 0) { throw 'No imaging device detected. Make sure the scanner is powered on, connected, and its Windows (WIA) driver is installed.' }",
    "$dialog = New-Object -ComObject WIA.CommonDialog",
    // Device type 0 (Unspecified) instead of 1 (Scanner-only): many all-in-ones
    // and document scanners expose themselves to WIA without the strict Scanner
    // type, and the Scanner filter is what raised "No WIA device of the selected
    // type is available" even though a usable device was present.
    "$image = $dialog.ShowAcquireImage(0, 4, 0, '', $false, $true, $false)",
    "if ($null -eq $image) { Write-Output (@{ canceled = $true } | ConvertTo-Json -Compress); exit 0 }",
    `$image.SaveFile('${escapedPath}')`,
    `Write-Output (@{ canceled = $false; path = '${escapedPath}' } | ConvertTo-Json -Compress)`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 })
    const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}')
    if (result.canceled) return { canceled: true }
    return {
      canceled: false,
      path: destinationPath,
      url: pathToFileURL(destinationPath).toString(),
      fileName,
    }
  } catch (error) {
    const detail = cleanPowerShellError(error.stderr || error.message) || 'Windows could not acquire an image from the scanner.'
    throw new Error(`Scanner acquisition failed: ${detail}`)
  }
})

app.whenReady().then(async () => {
  if (!isDev) {
    protocol.handle('collectorshub-pos', (request) => {
      const filePath = resolveDistPath(request.url)
      return net.fetch(pathToFileURL(filePath).toString())
    })
  }

  await createWindow()
  configureAutoUpdates()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
