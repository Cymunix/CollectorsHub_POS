const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron')
const path = require('node:path')
const { copyFile, mkdir, readFile, unlink, writeFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { autoUpdater } = require('electron-updater')
const { recognize } = require('tesseract.js')

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

function getScanImageUrl(fileName, filePath) {
  if (isDev) return pathToFileURL(filePath).toString()
  return `collectorshub-pos://scan-images/${encodeURIComponent(fileName)}`
}

function resolveScanImagePath(image = {}) {
  const candidate = image.path || ''
  if (!candidate) throw new Error('No scan image path was provided for OCR.')
  const resolved = path.resolve(candidate)
  const scanDir = path.resolve(getScanDir())
  if (!resolved.startsWith(scanDir + path.sep)) {
    throw new Error('Scan OCR can only read images saved by CollectorsHub.')
  }
  if (!existsSync(resolved)) throw new Error('Scan image file was not found.')
  return resolved
}

function cleanOcrLine(line) {
  return String(line || '').replace(/[^\w\s.#/&-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseSportsCardOcr(text) {
  const rawLines = String(text || '').split(/\r?\n/).map(cleanOcrLine).filter(Boolean)
  const lines = rawLines.filter((line) => !/^[\d\s.#-]+$/.test(line))
  const upperLines = lines.map((line) => line.toUpperCase())
  const metadata = {}
  const confidenceNotes = []

  const numberMatch = String(text || '').match(/\b(?:NO\.?|#)\s*([A-Z0-9-]{1,8})\b/i)
  if (numberMatch) {
    metadata.cardNumber = numberMatch[1].replace(/[^A-Z0-9-]/gi, '')
    confidenceNotes.push(`card number ${metadata.cardNumber}`)
  }

  const teamWords = ['COWBOYS', 'DALLAS', 'EAGLES', 'GIANTS', 'COMMANDERS', 'PACKERS', 'BEARS', 'VIKINGS', 'LIONS', 'CHIEFS', 'RAIDERS', 'BRONCOS', 'CHARGERS', '49ERS', 'RAMS', 'SEAHAWKS', 'CARDINALS', 'BILLS', 'DOLPHINS', 'PATRIOTS', 'JETS', 'STEELERS', 'RAVENS', 'BROWNS', 'BENGALS', 'TEXANS', 'COLTS', 'JAGUARS', 'TITANS', 'BUCCANEERS', 'SAINTS', 'FALCONS', 'PANTHERS']
  const teamLine = lines.find((line, index) => {
    const textLine = `${upperLines[index - 1] || ''} ${upperLines[index] || ''}`.trim()
    return teamWords.some((word) => textLine.includes(word))
  })
  if (teamLine) {
    const previous = lines[Math.max(0, lines.indexOf(teamLine) - 1)] || ''
    const combined = `${previous} ${teamLine}`.toUpperCase()
    if (combined.includes('DALLAS') && combined.includes('COWBOYS')) metadata.team = 'Dallas Cowboys'
    else metadata.team = teamLine.replace(/\b[A-Z]{1}\b/g, '').trim()
    confidenceNotes.push(`team ${metadata.team}`)
  }

  const candidateNames = lines
    .map((line) => line.replace(/\b(NO|DALLAS|COWBOYS|NFL|NFLPA|PANINI|CONTENDERS|FOOTBALL|YEAR|TEAM|TOTALS)\b/gi, '').trim())
    .filter((line) => /^[A-Z][A-Z\s'.-]{4,}$/.test(line) && line.split(/\s+/).length >= 2)
    .sort((a, b) => b.length - a.length)
  const player = candidateNames.find((line) => !teamWords.some((word) => line.toUpperCase().includes(word)))
  if (player) {
    metadata.player = player.toUpperCase().replace(/\s+/g, ' ')
    metadata.cardName = metadata.player
    metadata.name = metadata.player
    confidenceNotes.push(`player ${metadata.player}`)
  }

  const yearMatch = String(text || '').match(/\b(19\d{2}|20\d{2})\b/)
  if (yearMatch) {
    metadata.year = yearMatch[1]
    metadata.releaseYear = yearMatch[1]
  }

  if (/PANINI/i.test(text)) metadata.brand = 'Panini'
  if (/CONTENDERS/i.test(text)) metadata.productSet = 'Contenders Football'
  if (/FOOTBALL/i.test(text)) metadata.sport = 'Football'

  return {
    metadata,
    rawText: String(text || '').trim(),
    confidence: Math.min(92, 35 + (confidenceNotes.length * 16)),
    confidenceNotes,
  }
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
    sellerAccessTokenConfigured: Boolean(config.sellerAccessToken),
    salesDataMode: config.salesDataMode || 'browse',
    merchantLocationKey: config.merchantLocationKey || '',
    categoryId: config.categoryId || '',
    paymentPolicyId: config.paymentPolicyId || '',
    fulfillmentPolicyId: config.fulfillmentPolicyId || '',
    returnPolicyId: config.returnPolicyId || '',
    currency: config.currency || 'CAD',
  }
}

async function loadEbayConfig({ includeSecret = false } = {}) {
  const fromEnv = {
    environment: process.env.EBAY_ENVIRONMENT || 'production',
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_CA',
    clientId: process.env.EBAY_CLIENT_ID || '',
    clientSecret: process.env.EBAY_CLIENT_SECRET || '',
    sellerAccessToken: process.env.EBAY_SELLER_ACCESS_TOKEN || '',
    salesDataMode: process.env.EBAY_SALES_DATA_MODE || 'browse',
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || '',
    categoryId: process.env.EBAY_CATEGORY_ID || '',
    paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID || '',
    fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID || '',
    returnPolicyId: process.env.EBAY_RETURN_POLICY_ID || '',
    currency: process.env.EBAY_CURRENCY || 'CAD',
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
    sellerAccessToken: nextConfig.sellerAccessToken ? String(nextConfig.sellerAccessToken).trim() : existing.sellerAccessToken || '',
    salesDataMode: nextConfig.salesDataMode || existing.salesDataMode || 'browse',
    merchantLocationKey: String(nextConfig.merchantLocationKey ?? existing.merchantLocationKey ?? '').trim(),
    categoryId: String(nextConfig.categoryId ?? existing.categoryId ?? '').trim(),
    paymentPolicyId: String(nextConfig.paymentPolicyId ?? existing.paymentPolicyId ?? '').trim(),
    fulfillmentPolicyId: String(nextConfig.fulfillmentPolicyId ?? existing.fulfillmentPolicyId ?? '').trim(),
    returnPolicyId: String(nextConfig.returnPolicyId ?? existing.returnPolicyId ?? '').trim(),
    currency: String(nextConfig.currency ?? existing.currency ?? 'CAD').trim() || 'CAD',
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

function getEbaySellerAccessToken(config) {
  if (!config.sellerAccessToken) {
    throw new Error('Add an eBay seller OAuth user access token with the sell.inventory scope before listing online.')
  }
  return config.sellerAccessToken
}

function ebayConditionForItem(item = {}) {
  const text = String(item.condition || item.rawCondition || '').toLowerCase()
  if (text.includes('new') || text.includes('sealed')) return 'NEW'
  if (text.includes('near mint') || text.includes('excellent')) return 'USED_EXCELLENT'
  if (text.includes('light') || text.includes('very good')) return 'USED_VERY_GOOD'
  if (text.includes('heavy') || text.includes('poor') || text.includes('acceptable')) return 'USED_ACCEPTABLE'
  return 'USED_GOOD'
}

function ebaySkuForItem(item = {}) {
  return String(item.sku || item.inventoryId || item.id || '').trim().replace(/\s+/g, '-')
}

function requireEbayListingConfig(config) {
  const missing = []
  if (!config.merchantLocationKey) missing.push('Merchant Location Key')
  if (!config.categoryId) missing.push('eBay Category ID')
  if (!config.paymentPolicyId) missing.push('Payment Policy ID')
  if (!config.fulfillmentPolicyId) missing.push('Fulfillment Policy ID')
  if (!config.returnPolicyId) missing.push('Return Policy ID')
  if (missing.length) {
    throw new Error(`Complete eBay listing settings first: ${missing.join(', ')}.`)
  }
}

async function ebayRequest(config, pathName, { method = 'GET', body = null, seller = false } = {}) {
  const token = seller ? getEbaySellerAccessToken(config) : await getEbayAccessToken(config)
  const response = await fetch(`${ebayApiBase(config)}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': config.marketplaceId === 'EBAY_CA' ? 'en-CA' : 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': config.marketplaceId || 'EBAY_CA',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await ebayJson(response)
  if (!response.ok) throw new Error(ebayErrorMessage(payload, 'eBay request failed.'))
  return payload
}

async function listEbayItem(item = {}) {
  const config = await loadEbayConfig({ includeSecret: true })
  requireEbayListingConfig(config)

  const sku = ebaySkuForItem(item)
  if (!sku) throw new Error('This item needs a SKU before it can be listed on eBay.')

  const price = Number(item.onlinePrice || item.inStorePrice || item.price || 0)
  if (price <= 0) throw new Error('Set an online price before listing on eBay.')

  const quantity = Math.max(1, Number(item.quantityAvailable ?? item.available ?? item.quantity ?? item.onHand ?? 1))
  const title = String(item.name || item.title || sku).slice(0, 80)
  const description = String(item.description || `${title}\n\nCondition: ${item.condition || 'Used'}`)
  const imageUrls = [item.imageUrl, item.image].filter((value) => /^https?:\/\//i.test(String(value || '')))

  await ebayRequest(config, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    seller: true,
    body: {
      availability: {
        shipToLocationAvailability: { quantity },
      },
      condition: ebayConditionForItem(item),
      product: {
        title,
        description,
        imageUrls,
        aspects: {
          Category: [item.category || 'Collectibles'],
          Condition: [item.condition || 'Used'],
        },
      },
    },
  })

  const offer = await ebayRequest(config, '/sell/inventory/v1/offer', {
    method: 'POST',
    seller: true,
    body: {
      sku,
      marketplaceId: config.marketplaceId || 'EBAY_CA',
      format: 'FIXED_PRICE',
      availableQuantity: quantity,
      categoryId: config.categoryId,
      merchantLocationKey: config.merchantLocationKey,
      listingDescription: description,
      pricingSummary: {
        price: {
          currency: config.currency || 'CAD',
          value: String(price.toFixed(2)),
        },
      },
      listingPolicies: {
        paymentPolicyId: config.paymentPolicyId,
        fulfillmentPolicyId: config.fulfillmentPolicyId,
        returnPolicyId: config.returnPolicyId,
      },
    },
  })

  const offerId = offer?.offerId
  if (!offerId) throw new Error('eBay created the inventory item but did not return an offer ID.')

  const published = await ebayRequest(config, `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
    method: 'POST',
    seller: true,
  })

  return {
    sku,
    offerId,
    listingId: published?.listingId || published?.listing?.listingId || '',
    marketplaceId: config.marketplaceId || 'EBAY_CA',
    raw: published,
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
ipcMain.handle('ebay:list-item', async (_event, item) => listEbayItem(item))
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
      url: getScanImageUrl(fileName, destinationPath),
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
  const fileName = `${Date.now()}-${randomUUID()}.jpg`
  const destinationPath = path.join(getScanDir(), fileName)
  const transferPath = `${destinationPath}.wia.bmp`
  const escapedPath = destinationPath.replace(/'/g, "''")
  const escapedTransferPath = transferPath.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Suppress the "Preparing modules for first use" progress record, which
    // PowerShell otherwise serialises as CLIXML noise onto the error stream.
    "$ProgressPreference = 'SilentlyContinue'",
    // Match the known-good WIA flow: enumerate devices, select a real WIA
    // scanner (Type 1), connect, then transfer from Items.Item(1). The Canon
    // TS3725/TS3700 exposes a second ESCL entry that looks attractive by name
    // but is not the working WIA scanner for this acquisition path.
    "$manager = New-Object -ComObject WIA.DeviceManager",
    "if ($manager.DeviceInfos.Count -eq 0) { throw 'No imaging device detected. Make sure the scanner is powered on, connected, and its Windows (WIA) driver is installed.' }",
    "$scannerInfos = @($manager.DeviceInfos | Where-Object { $_.Type -eq 1 })",
    "$scannerRows = @($scannerInfos | ForEach-Object { @{ name = [string]$_.Properties['Name'].Value; deviceId = [string]$_.DeviceID; type = [int]$_.Type } })",
    "if ($scannerInfos.Count -eq 0) { Write-Output (@{ needsSelection = $true; scanners = $scannerRows; message = 'No WIA scanner devices were found. Confirm the scanner is visible in Windows WIA.' } | ConvertTo-Json -Compress); exit 0 }",
    "$scanner = $scannerInfos | Where-Object { ([string]$_.Properties['Name'].Value) -match 'TS3700|TS3725' } | Select-Object -First 1",
    "if (-not $scanner -and $scannerInfos.Count -eq 1) { $scanner = $scannerInfos | Select-Object -First 1 }",
    "if (-not $scanner) { Write-Output (@{ needsSelection = $true; scanners = $scannerRows; message = 'Multiple WIA scanners are available. Select a default scanner in CollectorsHub scanner settings.' } | ConvertTo-Json -Compress); exit 0 }",
    "$scannerName = [string]$scanner.Properties['Name'].Value",
    "$device = $scanner.Connect()",
    "$item = $device.Items.Item(1)",
    "$dialog = New-Object -ComObject WIA.CommonDialog",
    "$jpeg = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'",
    "$image = $dialog.ShowTransfer($item, $jpeg, $false)",
    "if ($null -eq $image) { Write-Output (@{ canceled = $true; scannerName = $scannerName } | ConvertTo-Json -Compress); exit 0 }",
    `$image.SaveFile('${escapedTransferPath}')`,
    "Add-Type -AssemblyName System.Drawing",
    `$bitmap = [System.Drawing.Image]::FromFile('${escapedTransferPath}')`,
    // Ignore the outer scanner frame and crop around dense non-white content.
    // The TS3725 flatbed may have a black border at (0, 0), so using one
    // corner as the background makes the white bed look like the object.
    "$step = [Math]::Max(2, [Math]::Floor([Math]::Min($bitmap.Width, $bitmap.Height) / 420))",
    "$marginX = [Math]::Max(12, [Math]::Floor($bitmap.Width * 0.018))",
    "$marginY = [Math]::Max(12, [Math]::Floor($bitmap.Height * 0.018))",
    "$cols = @{}; $rows = @{}",
    "$sampleRows = 0; $sampleCols = 0",
    "for ($y = $marginY; $y -lt ($bitmap.Height - $marginY); $y += $step) { $sampleRows++ }",
    "for ($x = $marginX; $x -lt ($bitmap.Width - $marginX); $x += $step) { $sampleCols++ }",
    "for ($y = $marginY; $y -lt ($bitmap.Height - $marginY); $y += $step) {",
    "  for ($x = $marginX; $x -lt ($bitmap.Width - $marginX); $x += $step) {",
    "    $pixel = $bitmap.GetPixel($x, $y)",
    "    $brightness = [int]$pixel.R + [int]$pixel.G + [int]$pixel.B",
    "    $spread = [Math]::Max([Math]::Max([int]$pixel.R, [int]$pixel.G), [int]$pixel.B) - [Math]::Min([Math]::Min([int]$pixel.R, [int]$pixel.G), [int]$pixel.B)",
    "    if ($brightness -lt 705 -or $spread -gt 44) {",
    "      $cols[$x] = 1 + [int]$cols[$x]",
    "      $rows[$y] = 1 + [int]$rows[$y]",
    "    }",
    "  }",
    "}",
    "$colThreshold = [Math]::Max(6, [Math]::Floor($sampleRows * 0.018))",
    "$rowThreshold = [Math]::Max(6, [Math]::Floor($sampleCols * 0.018))",
    "$activeX = @($cols.Keys | Where-Object { $cols[$_] -ge $colThreshold } | Sort-Object)",
    "$activeY = @($rows.Keys | Where-Object { $rows[$_] -ge $rowThreshold } | Sort-Object)",
    "$cropApplied = $false",
    "try {",
    "  if ($activeX.Count -gt 0 -and $activeY.Count -gt 0) {",
    "    $minX = [int]$activeX[0]",
    "    $maxX = [int]$activeX[$activeX.Count - 1]",
    "    $minY = [int]$activeY[0]",
    "    $maxY = [int]$activeY[$activeY.Count - 1]",
    "  } else {",
    "    $minX = 0; $minY = 0; $maxX = $bitmap.Width - 1; $maxY = $bitmap.Height - 1",
    "  }",
    "  $contentWidth = $maxX - $minX",
    "  $contentHeight = $maxY - $minY",
    "  $contentArea = $contentWidth * $contentHeight",
    "  $imageArea = $bitmap.Width * $bitmap.Height",
    "  if ($contentWidth -gt 80 -and $contentHeight -gt 80 -and $contentArea -gt ($imageArea * 0.01) -and $contentArea -lt ($imageArea * 0.92)) {",
    "    $pad = [Math]::Max(24, [Math]::Floor([Math]::Max($contentWidth, $contentHeight) * 0.065))",
    "    $cropX = [Math]::Max(0, $minX - $pad)",
    "    $cropY = [Math]::Max(0, $minY - $pad)",
    "    $cropRight = [Math]::Min($bitmap.Width - 1, $maxX + $pad)",
    "    $cropBottom = [Math]::Min($bitmap.Height - 1, $maxY + $pad)",
    "    $crop = New-Object System.Drawing.Rectangle($cropX, $cropY, ($cropRight - $cropX + 1), ($cropBottom - $cropY + 1))",
    "    $cropped = $bitmap.Clone($crop, $bitmap.PixelFormat)",
    "    try {",
    `      $cropped.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
    "      $cropApplied = $true",
    "    } finally {",
    "      $cropped.Dispose()",
    "    }",
    "  } else {",
    `    $bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
    "  }",
    "} finally {",
    "  $bitmap.Dispose()",
    "}",
    `Remove-Item -LiteralPath '${escapedTransferPath}' -Force -ErrorAction SilentlyContinue`,
    `Write-Output (@{ canceled = $false; path = '${escapedPath}'; scannerName = $scannerName; cropped = $cropApplied } | ConvertTo-Json -Compress)`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 120000, killSignal: 'SIGKILL' })
    const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}')
    if (result.needsSelection) return result
    if (result.canceled) return { canceled: true }
    return {
      canceled: false,
      path: destinationPath,
      url: getScanImageUrl(fileName, destinationPath),
      fileName,
      scannerName: result.scannerName || '',
      cropped: Boolean(result.cropped),
    }
  } catch (error) {
    await unlink(transferPath).catch(() => {})
    const timedOut = error.killed || error.signal
    const detail = timedOut
      ? 'Scanner acquisition timed out. Cancel the scanner dialog or try the scan again.'
      : cleanPowerShellError(error.stderr || error.message) || 'Windows could not acquire an image from the scanner.'
    throw new Error(`Scanner acquisition failed: ${detail}`)
  }
})

ipcMain.handle('scanner:analyze-card', async (_event, image) => {
  const imagePath = resolveScanImagePath(image)
  await mkdir(getDataDir(), { recursive: true })
  const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))
  const result = await recognize(imagePath, 'eng', {
    langPath,
    cachePath: path.join(getDataDir(), 'ocr-cache'),
  })
  return parseSportsCardOcr(result?.data?.text || '')
})

app.whenReady().then(async () => {
  if (!isDev) {
    protocol.handle('collectorshub-pos', (request) => {
      const url = new URL(request.url)
      if (url.hostname === 'scan-images') {
        const fileName = path.basename(decodeURIComponent(url.pathname.replace(/^\/+/, '')))
        const filePath = path.join(getScanDir(), fileName)
        return net.fetch(pathToFileURL(filePath).toString())
      }

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
