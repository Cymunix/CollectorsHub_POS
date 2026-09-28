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
ipcMain.handle('app:exit', () => app.quit())
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
