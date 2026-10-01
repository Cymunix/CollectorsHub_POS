const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell } = require('electron')
const path = require('node:path')
const { appendFile, copyFile, mkdir, readFile, unlink, writeFile } = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { autoUpdater } = require('electron-updater')
const { createWorker } = require('tesseract.js')
const { OllamaCardRecognitionProvider } = require('./cardRecognition.cjs')
const { ScannerSession } = require('./scannerSession.cjs')
const { rotateNativeImage } = require('./imageRotate.cjs')

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

function hasVowel(value) {
  return /[AEIOUY]/i.test(value)
}

const NFL_TEAMS = [
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills', 'Carolina Panthers', 'Chicago Bears',
  'Cincinnati Bengals', 'Cleveland Browns', 'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs', 'Las Vegas Raiders',
  'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins', 'Minnesota Vikings', 'New England Patriots',
  'New Orleans Saints', 'New York Giants', 'New York Jets', 'Philadelphia Eagles', 'Pittsburgh Steelers',
  'San Francisco 49ers', 'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Commanders',
]
const NFL_TEAM_NICKNAMES = NFL_TEAMS.map((team) => team.toUpperCase().split(' ').pop())
const SPORTS_CARD_BRANDS = [['UPPER DECK', 'Upper Deck'], ['PANINI', 'Panini'], ['TOPPS', 'Topps'], ['DONRUSS', 'Donruss'], ['BOWMAN', 'Bowman'], ['FLEER', 'Fleer'], ['LEAF', 'Leaf']]
const SPORTS = [['BASKETBALL', 'Basketball'], ['FOOTBALL', 'Football'], ['BASEBALL', 'Baseball'], ['HOCKEY', 'Hockey'], ['SOCCER', 'Soccer']]
const TCG_FRANCHISES = [
  // Pokémon first: WotC-era Pokémon cards also print "Wizards of the Coast".
  { pattern: /POK[EÉ]MON|GAME\s*FREAK|CREATURES/i, franchiseGame: 'Pokémon', manufacturerPublisher: 'The Pokémon Company' },
  { pattern: /YU-?GI-?OH|KONAMI/i, franchiseGame: 'Yu-Gi-Oh!', manufacturerPublisher: 'Konami' },
  { pattern: /LORCANA|RAVENSBURGER/i, franchiseGame: 'Disney Lorcana', manufacturerPublisher: 'Ravensburger' },
  { pattern: /ONE\s*PIECE/i, franchiseGame: 'One Piece Card Game', manufacturerPublisher: 'Bandai' },
  { pattern: /WIZARDS\s+OF\s+THE\s+COAST/i, franchiseGame: 'Magic: The Gathering', manufacturerPublisher: 'Wizards of the Coast' },
]
const NAME_STOP_WORDS = new Set([
  'SEASON', 'TICKET', 'NFL', 'NFLPA', 'MLB', 'NBA', 'NHL', 'CONTENDERS', 'ROOKIE', 'CARD', 'TEAM', 'TOTALS', 'YEAR', 'NO',
  ...NFL_TEAM_NICKNAMES,
  ...SPORTS_CARD_BRANDS.flatMap(([word]) => word.split(' ')),
  ...SPORTS.map(([word]) => word),
])

function scorePersonNameCandidate(value) {
  const text = String(value || '').toUpperCase().replace(/[^A-Z\s'.-]/g, ' ').replace(/\s+/g, ' ').trim()
  const stopWords = NAME_STOP_WORDS
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length < 2 || tokens.length > 4) return 0
  if (tokens.some((token) => stopWords.has(token))) return 0
  if (tokens[tokens.length - 1].length <= 2 && !hasVowel(tokens[tokens.length - 1])) return 0
  const vowelTokens = tokens.filter(hasVowel).length
  const shortTokens = tokens.filter((token) => token.length <= 2).length
  const oddTokens = tokens.filter((token) => !hasVowel(token) && token.length <= 3).length
  let score = 30 + (vowelTokens * 14) - (shortTokens * 12) - (oddTokens * 18)
  if (tokens.every((token) => token.length >= 3)) score += 15
  if (/^[A-Z]{3,}\s+[A-Z]{3,}$/.test(text)) score += 10
  return Math.max(0, score)
}

// "No. 27", "#101", "No. RT-12". The number must contain a digit so words
// such as "NOTHING" are not read as "No. THING".
const CARD_NUMBER_PATTERN = /(?:\bNO\.?|#)\s*([A-Z]{0,4}-?\d[A-Z0-9-]{0,6})\b/i

function titleCase(value) {
  return String(value || '').toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

function looksLikeSportsCard(upperText) {
  return /\b(NFL|NFLPA|MLB|MLBPA|NBA|NBPA|NHL|NHLPA|MLS)\b/.test(upperText)
    || (SPORTS_CARD_BRANDS.some(([word]) => upperText.includes(word)) && SPORTS.some(([word]) => upperText.includes(word)))
}

function parseSportsCardFields(text, metadata, confidenceNotes, rejectedNames) {
  const upperText = text.toUpperCase().replace(/\s+/g, ' ')

  const numberMatch = text.match(CARD_NUMBER_PATTERN)
  if (numberMatch) {
    metadata.cardNumber = numberMatch[1].toUpperCase()
    confidenceNotes.push(`card number ${metadata.cardNumber}`)
  }

  // Prefer a full "City Nickname" match; fall back to the nickname alone.
  const team = NFL_TEAMS.find((name) => upperText.includes(name.toUpperCase()))
    || NFL_TEAMS.find((name) => new RegExp(`\\b${name.toUpperCase().split(' ').pop()}\\b`).test(upperText))
  if (team) {
    metadata.team = team
    metadata.league = 'NFL'
    confidenceNotes.push(`team ${team}`)
  }

  // Card backs print the product line as "2024 PANINI - CONTENDERS FOOTBALL".
  // That is the set year; the copyright year is often the following year.
  const brandPattern = SPORTS_CARD_BRANDS.map(([word]) => word.replace(' ', '\\s+')).join('|')
  const productLine = text.match(new RegExp(`\\b((?:19|20)\\d{2})\\s+(${brandPattern})\\s*[-–—:]?\\s*([A-Z][A-Z0-9 &'.]{2,40})`, 'i'))
  if (productLine) {
    metadata.year = productLine[1]
    metadata.releaseYear = productLine[1]
    metadata.productSet = titleCase(productLine[3].trim())
    confidenceNotes.push(`set ${productLine[1]} ${metadata.productSet}`)
  }

  const teamNamePattern = new RegExp(`\\b(${NFL_TEAMS.map((name) => name.toUpperCase()).join('|')})\\b`, 'gi')
  const candidateNames = text.split(/\r?\n/)
    .map((rawLine) => {
      const line = cleanOcrLine(rawLine).replace(teamNamePattern, '').trim()
      let score = scorePersonNameCandidate(line)
      // Barcodes and artwork OCR as letters wrapped in | ] ( ) noise.
      if (/[|\[\](){}<>\\]/.test(rawLine)) score -= 40
      // The real player's surname is usually repeated in the bio on the back.
      const surname = line.split(/\s+/).pop()
      if (surname && surname.length >= 3) {
        const mentions = upperText.match(new RegExp(`\\b${surname.toUpperCase().replace(/[^A-Z'-]/g, '')}\\b`, 'g')) || []
        if (mentions.length > 1) score += 30
      }
      return { line, score }
    })
    .filter(({ line }) => /^[A-Z][A-Z\s'.-]{4,}$/i.test(line) && line.split(/\s+/).length >= 2 && line.split(/\s+/).length <= 4)
    .sort((a, b) => b.score - a.score)
  candidateNames.filter((candidate) => candidate.score < 55).slice(0, 3).forEach((candidate) => rejectedNames.push(candidate.line))
  const player = candidateNames.find((candidate) => candidate.score >= 55)?.line
  if (player) {
    metadata.player = player.toUpperCase().replace(/\s+/g, ' ')
    metadata.cardName = metadata.player
    metadata.name = metadata.player
    confidenceNotes.push(`player ${metadata.player}`)
  }

  const brand = SPORTS_CARD_BRANDS.find(([word]) => upperText.includes(word))
  if (brand) metadata.brand = brand[1]
  const sport = SPORTS.find(([word]) => upperText.includes(word))
  if (sport) metadata.sport = sport[1]
  if (!metadata.productSet && /CONTENDERS/i.test(text)) metadata.productSet = sport ? `Contenders ${sport[1]}` : 'Contenders'
}

function parseTradingCardFields(text, metadata, confidenceNotes) {
  // Collector numbers print as "199/165" on most TCGs.
  const numberMatch = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/) || text.match(CARD_NUMBER_PATTERN)
  if (numberMatch) {
    metadata.cardNumber = numberMatch[2] ? `${numberMatch[1]}/${numberMatch[2]}` : numberMatch[1].toUpperCase()
    confidenceNotes.push(`card number ${metadata.cardNumber}`)
  }

  const franchise = TCG_FRANCHISES.find((entry) => entry.pattern.test(text))
  if (franchise) {
    metadata.franchiseGame = franchise.franchiseGame
    metadata.manufacturerPublisher = franchise.manufacturerPublisher
    confidenceNotes.push(`game ${franchise.franchiseGame}`)
  }
}

function parseCardOcr(text, category = '') {
  const source = String(text || '')
  const upperText = source.toUpperCase().replace(/\s+/g, ' ')
  const metadata = {}
  const confidenceNotes = []
  const rejectedNames = []

  // The intake form defaults to Trading Cards, so a sports card scanned without
  // changing the category would otherwise never get player/team parsing.
  let detectedCategory = category
  const isCardCategory = category === 'Trading Cards' || category === 'Sports Cards'
  if (category === 'Trading Cards' && !TCG_FRANCHISES.some((entry) => entry.pattern.test(source)) && looksLikeSportsCard(upperText)) {
    detectedCategory = 'Sports Cards'
    confidenceNotes.push('detected sports card')
  }

  if (detectedCategory === 'Sports Cards') {
    parseSportsCardFields(source, metadata, confidenceNotes, rejectedNames)
  } else if (detectedCategory === 'Trading Cards') {
    parseTradingCardFields(source, metadata, confidenceNotes)
  }

  // A copyright line ("©2023 Pokémon", "© 1995-2024") is a better release year
  // than the first four-digit number, which is often a stat line.
  if (!metadata.year) {
    const copyrightMatch = source.match(/(?:©|\(C\)|COPYRIGHT)\s*(?:(?:19|20)\d{2}\s*[-–]\s*)?((?:19|20)\d{2})/i)
    const yearMatch = copyrightMatch || source.match(/\b(19\d{2}|20\d{2})\b/)
    if (yearMatch) {
      metadata.year = yearMatch[1]
      metadata.releaseYear = yearMatch[1]
    }
  }

  const barcodeMatch = source.replace(/(\d) (?=\d)/g, '$1').match(/\b(\d{12,13})\b/)
  if (barcodeMatch && !isCardCategory) {
    metadata.barcode = barcodeMatch[1]
    confidenceNotes.push(`barcode ${metadata.barcode}`)
  }

  return {
    metadata,
    detectedCategory,
    rawText: source.trim(),
    confidence: Math.min(92, 35 + (confidenceNotes.length * 16)),
    confidenceNotes,
    rejectedNames,
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

// Electron on Windows can leave the page unable to receive keystrokes after a
// native confirm()/alert() or another process's window (the WIA scan dialog):
// inputs show a caret but typing goes nowhere. Blurring and refocusing the
// window restores keyboard input.
function refocusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.blur()
  mainWindow.focus()
  mainWindow.webContents.focus()
}

let pendingUpdate = null

function configureAutoUpdates() {
  if (isDev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // The renderer shows a CollectorsHub-styled prompt instead of a native
  // Windows dialog. Keep the info so a window that loads later can ask for it.
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = {
      version: info?.version || '',
      releaseName: info?.releaseName || '',
      currentVersion: app.getVersion(),
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-ready', pendingUpdate)
    }
  })

  autoUpdater.on('error', (error) => {
    console.error('[Auto Update] Failed:', error)
  })

  setTimeout(() => {
    // checkForUpdates (not ...AndNotify) so Windows does not also show a toast.
    autoUpdater.checkForUpdates().catch((error) => {
      console.error('[Auto Update] Check failed:', error)
    })
  }, 5000)
}

ipcMain.handle('store:load', async () => ensureStore())
ipcMain.handle('store:save', async (_event, nextStore) => saveStore(nextStore))
ipcMain.handle('app:get-data-path', () => getStoreFile())
ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:exit', () => app.quit())
ipcMain.handle('app:refocus', () => refocusMainWindow())
ipcMain.handle('app:get-pending-update', () => pendingUpdate)
ipcMain.handle('app:install-update', () => {
  if (pendingUpdate) autoUpdater.quitAndInstall(false, true)
})
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

// Compiled into the scan PowerShell session with Add-Type. Per-pixel work in
// PowerShell took seconds and counted against the acquisition timeout.
// Card crop + deskew helper, compiled into the scanner PowerShell session.
const SCAN_CROP_SOURCE = readFileSync(path.join(__dirname, 'scanCrop.cs'), 'utf8')
// WIA 2.0 sheet-feeder transfer (Epson FastFoto), compiled alongside it.
const SCAN_FEED_SOURCE = readFileSync(path.join(__dirname, 'wiaFeed.cs'), 'utf8')
// Always scan at 600 DPI: at the driver default (150) card text is too small
// for OCR to read reliably.
const SCAN_DPI = 600

// ---------------------------------------------------------------------------
// Scanning. Normal scans go through a persistent ScannerSession (one WIA
// connection per scanning page, direct Item.Transfer, no vendor UI). The old
// one-shot WIA.CommonDialog path is kept only as the fallback when a direct
// transfer fails.
//
// Scan modes:
//   card: Standard Trading Card. Only a fixed card-sized region of the glass is
//         scanned (measured on the Canon TS3700 at 600 DPI: ~20 s vs ~55 s for
//         the full bed). 3.7 x 3.7 in covers a 2.5 x 3.5 in card in portrait or
//         landscape plus ~0.1 in margin; the extra width costs <1 s because
//         carriage travel is set by the height.
//   full: Full Bed / Large Item. Whole bed, general object detection.

const scannerSession = new ScannerSession({ workDir: path.join(getDataDirSafe(), 'scanner'), cropSource: SCAN_CROP_SOURCE, feedSource: SCAN_FEED_SOURCE })
const CARD_REGION_IN = { width: 3.7, height: 3.7 }
const DEFAULT_BED_IN = { width: 8.5, height: 11.68 }
// WIA_IPS_CUR_INTENT: image type (colour) | WIA_INTENT_MAXIMIZE_QUALITY.
const WIA_INTENT_COLOR = 1
const WIA_INTENT_MAXIMIZE_QUALITY = 0x20000

function getDataDirSafe() {
  // app.getPath is only valid after 'ready'; the session only uses workDir later.
  try { return getDataDir() } catch { return path.join(process.env.APPDATA || '.', 'collectorshub-pos', 'local-data') }
}

scannerSession.on('status', (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scanner:status', status)
})
scannerSession.on('opened', (info) => {
  logScanner({
    event: 'session-opened',
    scannerName: info.scannerName,
    bedIn: { width: info.bedWidthIn, height: info.bedHeightIn },
    // Every item property the WIA driver exposes (colour mode, bit depth,
    // brightness/contrast, any vendor enhancement controls).
    driverProperties: info.properties,
  })
})

// Development log: one JSON object per line in local-data/logs/scanner.log.
async function logScanner(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  console.log('[Scanner]', line)
  try {
    const dir = path.join(getDataDir(), 'logs')
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, 'scanner.log'), `${line}\n`, 'utf8')
  } catch {}
}

// Card region on the glass (inches). Default: the scanner's origin corner
// (top-left of the scanned image), where cards are placed by default.
function cardRegionIn(position, custom, bed) {
  const bedWidth = bed?.width || DEFAULT_BED_IN.width
  const bedHeight = bed?.height || DEFAULT_BED_IN.height
  const { width, height } = CARD_REGION_IN
  let x = 0
  let y = 0
  if (position === 'top-right' || position === 'bottom-right') x = bedWidth - width
  if (position === 'bottom-left' || position === 'bottom-right') y = bedHeight - height
  if (position === 'custom') {
    x = Number(custom?.x) || 0
    y = Number(custom?.y) || 0
  }
  const clampedX = Math.min(Math.max(0, x), Math.max(0, bedWidth - width))
  const clampedY = Math.min(Math.max(0, y), Math.max(0, bedHeight - height))
  return { region: { x: clampedX, y: clampedY, w: width, h: height }, clamped: clampedX !== x || clampedY !== y }
}

function scanImageResult(files, extra = {}) {
  return {
    canceled: false,
    path: files.outputPath,
    url: getScanImageUrl(path.basename(files.outputPath), files.outputPath),
    fileName: path.basename(files.outputPath),
    rawPath: files.rawPath && existsSync(files.rawPath) ? files.rawPath : '',
    rawUrl: files.rawPath && existsSync(files.rawPath) ? getScanImageUrl(path.basename(files.rawPath), files.rawPath) : '',
    displayPath: files.displayPath && existsSync(files.displayPath) ? files.displayPath : '',
    displayUrl: files.displayPath && existsSync(files.displayPath) ? getScanImageUrl(path.basename(files.displayPath), files.displayPath) : '',
    ...extra,
  }
}

ipcMain.handle('scanner:open-session', async () => {
  if (process.platform !== 'win32') return { state: 'unavailable', message: 'Direct scanner control is available on Windows only.' }
  return scannerSession.open()
})
ipcMain.handle('scanner:close-session', () => scannerSession.close())
ipcMain.handle('scanner:get-status', () => scannerSession.getStatus())

ipcMain.handle('scanner:scan-image', async (_event, options = {}) => {
  if (process.platform !== 'win32') {
    throw new Error('Direct scanner control is currently available on Windows through the Canon WIA driver.')
  }
  await mkdir(getScanDir(), { recursive: true })
  const mode = options.scanMode === 'full' ? 'full' : 'card'
  const base = path.join(getScanDir(), `${Date.now()}-${randomUUID()}`)
  const files = {
    // raw_scan (lossless), cropped_master (lossless), optional display copy.
    // The AI-optimised copy is made in memory by the recognition provider.
    transferPath: `${base}.wia`,
    rawPath: `${base}.raw.png`,
    outputPath: `${base}.png`,
    displayPath: options.displayCopy ? `${base}.display.jpg` : '',
  }
  // Cards are always scanned in 24-bit colour, photo quality.
  const intent = WIA_INTENT_COLOR | WIA_INTENT_MAXIMIZE_QUALITY
  const card = mode === 'card' ? cardRegionIn(options.cardPosition, options.customPosition, scannerSession.bed) : null
  const started = Date.now()

  let reply = null
  let directError = null
  try {
    reply = await scannerSession.scan({ mode, dpi: SCAN_DPI, intent, region: card?.region || null, ...files, quality: 92 })
  } catch (error) {
    directError = error
  }

  if (reply?.ok) {
    await logScanner({
      event: 'scan',
      mode,
      dpi: reply.dpi,
      requestedRegionIn: card?.region || null,
      regionClampedToBed: Boolean(card?.clamped || reply.regionClamped),
      requestedPx: reply.requestedPx,
      appliedDriverSettings: reply.appliedPx,
      returnedPx: { width: reply.returnedWidth, height: reply.returnedHeight },
      hardwareRoi: reply.hardwareRoi,
      softwareRoi: reply.softwareRoi,
      transferFormat: reply.transferFormat,
      outputFormat: 'png',
      cardStatus: reply.status,
      orientation: reply.orientation,
      detectedContent: reply.contentWidth ? { x: reply.contentX, y: reply.contentY, width: reply.contentWidth, height: reply.contentHeight } : null,
      crop: { x: reply.cropX, y: reply.cropY, width: reply.cropWidth, height: reply.cropHeight },
      cropAspect: reply.aspect,
      cropConfidence: reply.confidence,
      skewDegrees: reply.skewDegrees,
      display: reply.displayBlackPoint != null ? { blackPoint: reply.displayBlackPoint, whitePoint: reply.displayWhitePoint } : null,
      timingsMs: {
        total: Date.now() - started,
        scannerTransfer: reply.transferMs,
        saveTransfer: reply.saveTransferMs,
        rawSave: reply.rawSaveMs,
        crop: reply.cropMs,
        processing: reply.processMs,
      },
    })
    if (mode === 'card' && reply.hardwareRoi === false) {
      await logScanner({ event: 'hardware-roi-unavailable', note: 'Driver returned more than the requested region; the card region was cut in software.' })
    }
    return scanImageResult(files, {
      scannerName: reply.scannerName || scannerSession.scannerName || '',
      cropped: Boolean(reply.cropped),
      scanMode: mode,
      cardStatus: reply.status || '',
      confidence: reply.confidence ?? null,
      orientation: reply.orientation || '',
    })
  }

  if (reply?.needsSelection || reply?.code === 'NEEDS_SELECTION') return { needsSelection: true, scanners: reply.scanners || [], message: reply.message }
  if (reply && ['NO_DEVICE', 'COVER_OPEN'].includes(reply.code)) throw new Error(reply.message)

  // Direct transfer failed: fall back to the vendor transfer dialog once.
  await logScanner({ event: 'direct-scan-failed', mode, code: reply?.code || directError?.code, message: reply?.message || directError?.message, hresult: reply?.hresult })
  const fallback = await legacyScan({ ...options, files })
  await logScanner({ event: 'fallback-scan', mode, ok: !fallback.canceled, totalMs: Date.now() - started })
  return fallback
})

// Legacy one-shot scan through WIA.CommonDialog.ShowTransfer (shows the
// Windows/Canon transfer window). Only used when the direct session fails.
async function legacyScan(options = {}) {
  const { files } = options
  const escapedPath = files.outputPath.replace(/'/g, "''")
  const escapedTransferPath = `${files.transferPath}.bmp`.replace(/'/g, "''")
  const cropSourcePath = path.join(getDataDir(), 'scan-crop.cs')
  await writeFile(cropSourcePath, SCAN_CROP_SOURCE, 'utf8')
  const escapedCropSourcePath = cropSourcePath.replace(/'/g, "''")
  const intent = WIA_INTENT_COLOR
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$manager = New-Object -ComObject WIA.DeviceManager",
    "$scannerInfos = @($manager.DeviceInfos | Where-Object { $_.Type -eq 1 })",
    "if ($scannerInfos.Count -eq 0) { throw 'No imaging device detected. Make sure the scanner is powered on, connected, and its Windows (WIA) driver is installed.' }",
    "$scanner = $scannerInfos | Where-Object { ([string]$_.Properties['Name'].Value) -match 'TS3700|TS3725' } | Select-Object -First 1",
    "if (-not $scanner) { $scanner = $scannerInfos | Select-Object -First 1 }",
    "$scannerName = [string]$scanner.Properties['Name'].Value",
    "$device = $scanner.Connect()",
    "$item = $device.Items.Item(1)",
    "function Set-WiaValue($id, $value) { try { $item.Properties.Item([string]$id).Value = $value } catch {} }",
    "function Set-WiaMax($id) { try { $property = $item.Properties.Item([string]$id); $property.Value = $property.SubTypeMax } catch {} }",
    `Set-WiaValue 6146 ${intent}`,
    `Set-WiaValue 6147 ${SCAN_DPI}`,
    `Set-WiaValue 6148 ${SCAN_DPI}`,
    "Set-WiaValue 6149 0",
    "Set-WiaValue 6150 0",
    "Set-WiaMax 6151",
    "Set-WiaMax 6152",
    "$dialog = New-Object -ComObject WIA.CommonDialog",
    // BMP (the driver's native format): no lossy WIA JPEG conversion.
    "$image = $dialog.ShowTransfer($item, '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}', $false)",
    "if ($null -eq $image) { Write-Output (@{ canceled = $true; scannerName = $scannerName } | ConvertTo-Json -Compress); exit 0 }",
    `$image.SaveFile('${escapedTransferPath}')`,
    "Add-Type -AssemblyName System.Drawing",
    `Add-Type -ReferencedAssemblies System.Drawing -Path '${escapedCropSourcePath}'`,
    `$cropApplied = [CollectorsHubScanCrop]::SaveCropped('${escapedTransferPath}', '${escapedPath}', 92)`,
    `Remove-Item -LiteralPath '${escapedTransferPath}' -Force -ErrorAction SilentlyContinue`,
    "Write-Output (@{ canceled = $false; scannerName = $scannerName; cropped = $cropApplied } | ConvertTo-Json -Compress)",
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 300000, killSignal: 'SIGKILL' })
    const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}')
    if (result.canceled) return { canceled: true }
    return scanImageResult({ ...files, rawPath: '', displayPath: '' }, { scannerName: result.scannerName || '', cropped: Boolean(result.cropped), scanMode: 'full', cardStatus: '', fallback: true })
  } catch (error) {
    await unlink(`${files.transferPath}.bmp`).catch(() => {})
    const timedOut = error.killed || error.signal
    const detail = timedOut
      ? 'Scanner acquisition timed out. Cancel the scanner dialog or try the scan again.'
      : cleanPowerShellError(error.stderr || error.message) || 'Windows could not acquire an image from the scanner.'
    throw new Error(`Scanner acquisition failed: ${detail}`)
  } finally {
    // The WIA transfer window belongs to another process; take keyboard focus back.
    refocusMainWindow()
  }
}

// Manual crop correction from the preserved raw scan (Full Bed mode, or any
// scan whose automatic crop needs fixing). Writes a new lossless master.
ipcMain.handle('scanner:recrop', async (_event, { image, rect } = {}) => {
  const rawPath = resolveScanImagePath({ path: image?.rawPath })
  const raw = nativeImage.createFromPath(rawPath)
  if (raw.isEmpty()) throw new Error('The original scan could not be opened for cropping.')
  const size = raw.getSize()
  const x = Math.max(0, Math.min(size.width - 1, Math.round(Number(rect?.x) || 0)))
  const y = Math.max(0, Math.min(size.height - 1, Math.round(Number(rect?.y) || 0)))
  const width = Math.max(1, Math.min(size.width - x, Math.round(Number(rect?.width) || 0)))
  const height = Math.max(1, Math.min(size.height - y, Math.round(Number(rect?.height) || 0)))
  const outputPath = path.join(getScanDir(), `${Date.now()}-${randomUUID()}.png`)
  await writeFile(outputPath, raw.crop({ x, y, width, height }).toPNG())
  await logScanner({ event: 'manual-crop', rawPx: size, crop: { x, y, width, height }, aspect: Math.round((width / height) * 10000) / 10000 })
  return {
    ...image,
    path: outputPath,
    url: getScanImageUrl(path.basename(outputPath), outputPath),
    fileName: path.basename(outputPath),
    displayPath: '',
    displayUrl: '',
    cropped: true,
    manualCrop: { x, y, width, height },
  }
})

// ---------------------------------------------------------------------------
// Epson FastFoto stack scanning. The feeder scans both sides of every card in
// one pass; pages arrive in order (side 1, side 2 per card) already cropped
// and straightened. Here each pair is turned upright and sorted into
// front/back using how much readable text each orientation has, then handed
// to the renderer, which queues it for local AI recognition.

// Scan strip centred on the feeder: fits a standard card either way round.
const FEED_STRIP_IN = { width: 4, height: 4 }

async function rotateImageFile(filePath, degrees) {
  if (!degrees || !filePath || !existsSync(filePath)) return
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return
  const rotated = rotateNativeImage(image, degrees)
  await writeFile(filePath, /\.png$/i.test(filePath) ? rotated.toPNG() : rotated.toJPEG(92))
}

// Confident, readable words in one orientation of a card side. Upside-down
// or sideways text reads as a handful of low-confidence fragments.
async function readableWordCount(image) {
  const worker = await getOcrWorker()
  const { data } = await worker.recognize(image.toPNG(), {}, { blocks: true, text: false })
  let words = 0
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (word.confidence >= 75 && /^[A-Za-z][A-Za-z'.-]{2,}$/.test(word.text)) words += 1
        }
      }
    }
  }
  return words
}

// Scores the likely orientations of one side. Cards fed top edge first come
// out upside down, so 180 is tried first; sideways only if neither reads.
async function scoreSideOrientation(filePath) {
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return { best: null, lean: null, words: 0, scores: {} }
  const small = image.resize({ width: Math.min(1000, image.getSize().width), quality: 'best' })
  const scores = {}
  for (const turn of [180, 0]) scores[turn] = await readableWordCount(rotateNativeImage(small, turn))
  if (Math.max(scores[180], scores[0]) < 3) {
    for (const turn of [90, 270]) scores[turn] = await readableWordCount(rotateNativeImage(small, turn))
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [bestTurn, bestWords] = ranked[0]
  const second = ranked[1]?.[1] || 0
  const confident = bestWords >= 3 && bestWords >= second * 2
  // A weaker reading that still points one way (e.g. a photo-heavy front).
  const lean = bestWords > second ? Number(bestTurn) : null
  return { best: confident ? Number(bestTurn) : null, lean, words: bestWords, scores }
}

// Turns a scanned pair upright and decides which side is the front. The back
// (bio, stats) nearly always carries far more text than the front; when the
// text doesn't say, the feed order decides (cards loaded face down feed the
// back first).
async function orientFeedPair(first, second, { backFirst = true } = {}) {
  const sides = [first, second].filter(Boolean)
  const orientation = []
  for (const side of sides) orientation.push(await scoreSideOrientation(side.path))
  let checkRotation = false
  const turns = orientation.map((entry, index) => {
    if (entry.best !== null) return entry.best
    // Turning a card over mirrors it across the feed direction, so the other
    // side's rotation maps to its negative (180 <-> 180, 90 <-> 270).
    const other = orientation[1 - index]?.best
    const expected = other == null ? null : (360 - other) % 360
    // A weak reading that agrees with the other side is trusted.
    if (expected !== null && entry.lean === expected) return entry.lean
    checkRotation = true
    return expected ?? 180
  })
  for (let index = 0; index < sides.length; index += 1) {
    await rotateImageFile(sides[index].path, turns[index])
    await rotateImageFile(sides[index].rawPath, turns[index])
  }
  let backIndex = backFirst ? 0 : 1
  let frontBackBy = 'feed-order'
  if (sides.length === 2) {
    const [a, b] = orientation.map((entry) => entry.words)
    if (a >= b * 1.5 + 3) { backIndex = 0; frontBackBy = 'text' }
    else if (b >= a * 1.5 + 3) { backIndex = 1; frontBackBy = 'text' }
  } else {
    backIndex = -1
  }
  const front = sides.length === 2 ? sides[1 - backIndex] : sides[0]
  const back = sides.length === 2 ? sides[backIndex] : null
  return { front, back, checkRotation, frontBackBy, turns, orientation }
}

function feedImageResult(side, feederName, extra = {}) {
  return scanImageResult({ outputPath: side.path, rawPath: side.rawPath, displayPath: '' }, {
    scannerName: feederName,
    cropped: side.crop?.status === 'ok',
    scanMode: 'feeder',
    cardStatus: side.crop?.status || '',
    orientation: side.crop?.orientation || '',
    ...extra,
  })
}

ipcMain.handle('scanner:refresh-feeder', async () => {
  if (process.platform !== 'win32') return { feederName: '' }
  return scannerSession.refreshFeeder()
})

ipcMain.handle('scanner:cancel-feed', () => scannerSession.cancelFeed())

ipcMain.handle('scanner:feed-stack', async (event, options = {}) => {
  if (process.platform !== 'win32') throw new Error('The FastFoto feeder is available in the Windows desktop app only.')
  await mkdir(getScanDir(), { recursive: true })
  const send = (channel, payload) => { if (!event.sender.isDestroyed()) event.sender.send(channel, payload) }
  const backFirst = options.loadFaceDown !== false
  const started = Date.now()
  const pages = []
  let cards = 0
  let chain = Promise.resolve()
  let feederName = scannerSession.feederName || 'Epson FastFoto'

  const deliver = (first, second) => {
    const index = cards + 1
    cards += 1
    chain = chain.then(async () => {
      const oriented = await orientFeedPair(first, second, { backFirst })
      const card = {
        index,
        frontImage: feedImageResult(oriented.front, feederName),
        backImage: oriented.back ? feedImageResult(oriented.back, feederName) : null,
        feed: {
          checkRotation: oriented.checkRotation,
          frontBackBy: oriented.frontBackBy,
          singleSided: !oriented.back,
          // Readable words per side, so the AI can double-check close calls.
          words: oriented.back ? { front: oriented.orientation[[first, second].indexOf(oriented.front)]?.words ?? 0, back: oriented.orientation[[first, second].indexOf(oriented.back)]?.words ?? 0 } : null,
        },
      }
      await logScanner({
        event: 'feed-card',
        index,
        crop: [first, second].filter(Boolean).map((side) => side.crop),
        rotation: oriented.turns,
        orientationScores: oriented.orientation.map((entry) => entry.scores),
        frontBackBy: oriented.frontBackBy,
        checkRotation: oriented.checkRotation,
      })
      send('scanner:feed-card', card)
    }).catch((error) => {
      send('scanner:feed-progress', { pages: pages.length, cards, error: `Card ${index} could not be prepared: ${error.message}` })
    })
  }

  const reply = await scannerSession.feed({
    dpi: SCAN_DPI,
    widthIn: FEED_STRIP_IN.width,
    heightIn: FEED_STRIP_IN.height,
    outDir: getScanDir(),
    onPage: (message) => {
      pages.push({ path: message.path, rawPath: message.rawPath, crop: message.crop })
      send('scanner:feed-progress', { pages: pages.length, cards: Math.floor(pages.length / 2) })
      if (pages.length % 2 === 0) deliver(pages[pages.length - 2], pages[pages.length - 1])
    },
  }).catch((error) => ({ ok: false, code: error.code || 'FEED_FAILED', message: error.message }))
  if (reply.feederName) feederName = reply.feederName

  // An odd page means the stack stopped between a card's two sides.
  if (pages.length % 2 === 1) deliver(pages[pages.length - 1], null)
  await chain
  await logScanner({ event: 'feed', ok: reply.ok, code: reply.code, hresult: reply.hresult, pages: pages.length, cards, cancelled: reply.cancelled, region: reply.region, rejectedSettings: reply.rejected, deviceMessages: reply.deviceMessages, totalMs: Date.now() - started })
  return {
    ok: Boolean(reply.ok) || pages.length > 0,
    code: reply.ok ? '' : reply.code || 'FEED_FAILED',
    message: reply.ok ? '' : reply.message || 'The FastFoto scan failed.',
    cancelled: Boolean(reply.cancelled),
    pages: pages.length,
    cards,
    feederName,
    totalMs: Date.now() - started,
  }
})

// Rotates a scan (master and raw) into new files, so the renderer never
// shows a cached copy. Returns the updated image reference.
async function rotateScanImageObject(image, degrees) {
  const imagePath = resolveScanImagePath(image)
  const turn = ((Number(degrees) % 360) + 360) % 360
  if (![90, 180, 270].includes(turn)) return image
  // A new file name, so the renderer does not show a cached copy.
  const outputPath = path.join(getScanDir(), `${Date.now()}-${randomUUID()}${path.extname(imagePath) || '.png'}`)
  const source = nativeImage.createFromPath(imagePath)
  if (source.isEmpty()) throw new Error('The scan could not be opened for rotating.')
  const rotated = rotateNativeImage(source, turn)
  await writeFile(outputPath, /\.png$/i.test(outputPath) ? rotated.toPNG() : rotated.toJPEG(92))
  let rawPath = ''
  let rawSource = ''
  try { rawSource = image?.rawPath ? resolveScanImagePath({ path: image.rawPath }) : '' } catch { rawSource = '' }
  if (rawSource && existsSync(rawSource)) {
    rawPath = path.join(getScanDir(), `${Date.now()}-${randomUUID()}${path.extname(rawSource)}`)
    const raw = rotateNativeImage(nativeImage.createFromPath(rawSource), turn)
    await writeFile(rawPath, /\.png$/i.test(rawPath) ? raw.toPNG() : raw.toJPEG(92))
  }
  return {
    ...image,
    path: outputPath,
    url: getScanImageUrl(path.basename(outputPath), outputPath),
    fileName: path.basename(outputPath),
    rawPath,
    rawUrl: rawPath ? getScanImageUrl(path.basename(rawPath), rawPath) : '',
    displayPath: '',
    displayUrl: '',
  }
}

// Manual orientation fix from review.
ipcMain.handle('scanner:rotate-image', (_event, image, degrees) => rotateScanImageObject(image, degrees))

// Orientation of a stack-scanned pair, checked by the local AI where the
// text-based check was weak: which side is the back (sides), and which way up
// each side goes (upright). Returns the (possibly swapped/rotated) images.
async function checkCardImages({ front, back, checkSides = false, checkUpright = {} }, signal) {
  let images = { front, back }
  let flags = { front: Boolean(checkUpright.front), back: Boolean(checkUpright.back) }
  let sidesSwapped = false
  const turns = { front: 0, back: 0 }
  if (checkSides && front && back) {
    const backIndex = await cardRecognition.backSideIndex({ firstPath: resolveScanImagePath(front), secondPath: resolveScanImagePath(back) }, signal).catch(() => null)
    if (backIndex === 1) {
      sidesSwapped = true
      images = { front: back, back: front }
      flags = { front: flags.back, back: flags.front }
    }
  }
  for (const side of ['front', 'back']) {
    if (!flags[side] || !images[side]) continue
    const turn = await cardRecognition.uprightTurn(resolveScanImagePath(images[side]), signal, side).catch((error) => {
      if (error?.code === 'CANCELLED' || signal?.aborted) throw error
      return null
    })
    if (turn) {
      images[side] = await rotateScanImageObject(images[side], turn)
      turns[side] = turn
    }
  }
  return { images, sidesSwapped, turns, changed: sidesSwapped || Boolean(turns.front || turns.back) }
}

ipcMain.handle('ai:check-orientation', async (_event, request = {}) => {
  try {
    return { ok: true, ...(await checkCardImages(request)) }
  } catch (error) {
    return { ok: false, code: error.code || 'AI_ERROR', message: error.message || 'The orientation check failed.' }
  }
})

app.on('before-quit', () => scannerSession.close())

let ocrWorkerPromise = null

// One long-lived worker (tesseract queues jobs) instead of a new worker per
// image. Sparse-text mode (PSM 11) reads the scattered labels on a card; the
// default page mode only picked up paragraph text such as the bio.
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      await mkdir(getDataDir(), { recursive: true })
      const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))
      const worker = await createWorker('eng', 1, {
        langPath,
        cachePath: path.join(getDataDir(), 'ocr-cache'),
      })
      await worker.setParameters({ tessedit_pageseg_mode: '11' })
      return worker
    })()
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null })
  }
  return ocrWorkerPromise
}

// ---------------------------------------------------------------------------
// Local AI card recognition (Ollama + Qwen3-VL). The renderer only sends the
// draft's image references; paths are validated to the scan folder here.
const cardRecognition = new OllamaCardRecognitionProvider()
const recognitionJobs = new Map()
let modelInstall = null

ipcMain.handle('ai:status', async () => cardRecognition.getStatus())

ipcMain.handle('ai:install-model', async (event) => {
  if (modelInstall) return modelInstall.promise
  const controller = new AbortController()
  const send = (payload) => { if (!event.sender.isDestroyed()) event.sender.send('ai:install-progress', payload) }
  const promise = cardRecognition.installModel((progress) => send(progress), controller.signal)
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, code: error.code || 'AI_ERROR', message: error.message }))
    .finally(() => { modelInstall = null })
  modelInstall = { controller, promise }
  return promise
})

ipcMain.handle('ai:cancel-install', () => {
  modelInstall?.controller.abort(new Error('cancelled'))
})

// Returns { ok, result, model, durationMs } or { ok: false, code, message } so
// one failed card never throws across the batch loop in the renderer.
ipcMain.handle('ai:recognize-card', async (_event, { jobId, front, back, checkSides = false, checkUpright = null } = {}) => {
  const controller = new AbortController()
  if (jobId) recognitionJobs.set(jobId, controller)
  try {
    let frontPath
    let backPath
    try {
      frontPath = front ? resolveScanImagePath(front) : ''
      backPath = back ? resolveScanImagePath(back) : ''
    } catch (error) {
      return { ok: false, code: 'IMAGE_MISSING', message: error.message }
    }
    // Stack scans: where the text-based front/back or orientation call was
    // weak, the AI checks it first, so the card is identified (and later
    // saved) the right way round and the right way up.
    let orientation = null
    if (checkSides || checkUpright?.front || checkUpright?.back) {
      orientation = await checkCardImages({ front, back, checkSides, checkUpright: checkUpright || {} }, controller.signal)
      frontPath = orientation.images.front ? resolveScanImagePath(orientation.images.front) : ''
      backPath = orientation.images.back ? resolveScanImagePath(orientation.images.back) : ''
    }
    const output = await cardRecognition.recognizeCard({ frontPath, backPath }, controller.signal)
    return {
      ok: true,
      ...output,
      sidesSwapped: Boolean(orientation?.sidesSwapped),
      orientation: orientation ? { images: orientation.changed ? orientation.images : null, turns: orientation.turns } : null,
      provider: cardRecognition.id,
      providerLabel: cardRecognition.label,
    }
  } catch (error) {
    return { ok: false, code: error.code || 'AI_ERROR', message: error.message || 'Local AI analysis failed.' }
  } finally {
    if (jobId) recognitionJobs.delete(jobId)
  }
})

ipcMain.handle('ai:warm-up', () => { cardRecognition.warmUp() })

ipcMain.handle('ai:cancel-recognition', (_event, jobId) => {
  recognitionJobs.get(jobId)?.abort(new Error('cancelled'))
})

// Returns a saved scan's bytes so the renderer can upload it as a catalogue image.
ipcMain.handle('scanner:read-image', async (_event, image) => {
  const imagePath = resolveScanImagePath(image)
  const ext = path.extname(imagePath).slice(1).toLowerCase() || 'jpg'
  if (ext === 'png') {
    // Lossless scan masters stay local; the catalogue gets one high-quality
    // JPEG made directly from the lossless master (a single lossy encode).
    const master = nativeImage.createFromPath(imagePath)
    if (!master.isEmpty()) return { data: master.toJPEG(95), ext: 'jpg', mime: 'image/jpeg' }
  }
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' }[ext] || 'application/octet-stream'
  return { data: await readFile(imagePath), ext, mime }
})

ipcMain.handle('scanner:analyze-card', async (_event, image, options = {}) => {
  const imagePath = resolveScanImagePath(image)
  const worker = await getOcrWorker()
  const result = await worker.recognize(imagePath)
  return parseCardOcr(result?.data?.text || '', String(options?.category || ''))
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
