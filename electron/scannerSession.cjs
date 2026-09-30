// Persistent scanner session: one PowerShell host process (scanner-host.ps1)
// holds the WIA device open while the scanning page is open, so each scan
// reuses the same connection and never shows the vendor transfer window.

const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { readFile, writeFile, mkdir, rm } = require('node:fs/promises')
const path = require('node:path')

const PREFERRED_SCANNER = 'TS3700|TS3725'
const OPEN_TIMEOUT_MS = 60 * 1000
const SCAN_TIMEOUT_MS = 5 * 60 * 1000
const IDLE_CLOSE_MS = 10 * 60 * 1000
// A full FastFoto stack (~36 cards at ~8 s each) plus processing.
const FEED_TIMEOUT_MS = 30 * 60 * 1000

class ScannerSessionError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

class ScannerSession extends EventEmitter {
  constructor({ workDir, cropSource, feedSource = '' }) {
    super()
    this.workDir = workDir
    this.cropSource = cropSource
    this.feedSource = feedSource
    this.feederName = ''
    this.feeding = false
    this.process = null
    this.pending = new Map()
    this.queue = Promise.resolve()
    this.nextId = 1
    this.buffer = ''
    this.state = 'closed'
    this.scannerName = ''
    this.idleTimer = null
  }

  setState(state, message = '') {
    this.state = state
    this.emit('status', { state, scannerName: this.scannerName, feederName: this.feederName, feeding: this.feeding, message })
  }

  getStatus() {
    return { state: this.state, scannerName: this.scannerName, feederName: this.feederName, feeding: this.feeding }
  }

  async startProcess() {
    if (this.process) return
    await mkdir(this.workDir, { recursive: true })
    // The host script and crop helper ship inside the app bundle (asar), which
    // PowerShell cannot read, so they are copied to the data folder first.
    const hostPath = path.join(this.workDir, 'scanner-host.ps1')
    const cropPath = path.join(this.workDir, 'scan-crop.cs')
    await writeFile(hostPath, await readFile(path.join(__dirname, 'scanner-host.ps1'), 'utf8'), 'utf8')
    await writeFile(cropPath, this.cropSource, 'utf8')
    const args = ['-NoProfile', '-NoLogo', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', hostPath, '-CropSourcePath', cropPath]
    if (this.feedSource) {
      const feedPath = path.join(this.workDir, 'wia-feed.cs')
      await writeFile(feedPath, this.feedSource, 'utf8')
      args.push('-FeedSourcePath', feedPath)
    }

    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child
    this.buffer = ''
    let stderr = ''
    const started = new Promise((resolve, reject) => {
      this.startWaiter = { resolve, reject }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.on('exit', (code) => {
      const wasRunning = this.process === child
      if (wasRunning) this.process = null
      const error = new ScannerSessionError('SESSION_ENDED', stderr.trim() ? `Scanner session stopped: ${stderr.trim().split('\n').pop()}` : 'Scanner session stopped.')
      this.startWaiter?.reject(error)
      this.startWaiter = null
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      if (wasRunning && this.state !== 'closed') this.setState('unavailable', error.message)
      void code
    })
    const timeout = setTimeout(() => this.startWaiter?.reject(new ScannerSessionError('SESSION_START_FAILED', 'The scanner session did not start.')), OPEN_TIMEOUT_MS)
    try {
      await started
    } finally {
      clearTimeout(timeout)
    }
  }

  onData(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.event === 'started') {
        this.startWaiter?.resolve()
        this.startWaiter = null
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      if (message.event === 'processing') {
        this.setState('processing')
        continue
      }
      if (message.event === 'page') {
        try { pending.onEvent?.(message) } catch {}
        continue
      }
      this.pending.delete(message.id)
      pending.resolve(message)
    }
  }

  // Requests are serialised: a scanner can only do one thing at a time.
  request(payload, timeoutMs, onEvent = null) {
    const run = async () => {
      await this.startProcess()
      const id = String(this.nextId++)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          // A hung driver call cannot be interrupted; restart the session.
          this.kill()
          reject(new ScannerSessionError('TIMEOUT', 'The scanner did not respond in time.'))
        }, timeoutMs)
        this.pending.set(id, {
          onEvent,
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        })
        this.process.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, 'utf8')
      })
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  touch() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
  }

  // Initialises the scanner once for the scanning page.
  async open() {
    this.closeWhenIdle = false
    this.touch()
    if (this.state === 'ready' || this.state === 'scanning' || this.state === 'processing') return this.getStatus()
    this.setState('connecting')
    try {
      const reply = await this.request({ op: 'open', prefer: PREFERRED_SCANNER }, OPEN_TIMEOUT_MS)
      this.feederName = reply.feederName || ''
      if (!reply.ok) {
        this.setState('unavailable', reply.message)
        return { ...this.getStatus(), ...reply }
      }
      this.scannerName = reply.scannerName || ''
      if (reply.bedWidthIn && reply.bedHeightIn) this.bed = { width: reply.bedWidthIn, height: reply.bedHeightIn }
      this.emit('opened', reply)
      this.setState('ready')
      return this.getStatus()
    } catch (error) {
      this.setState('unavailable', error.message)
      return { ...this.getStatus(), ok: false, code: error.code || 'SESSION_START_FAILED', message: error.message }
    }
  }

  // mode: 'card' (fixed standard-card region) | 'full' (whole bed).
  async scan({ mode = 'card', dpi, intent, region = null, transferPath, rawPath = '', outputPath, displayPath = '', quality = 92 }) {
    this.touch()
    this.setState('scanning')
    try {
      const reply = await this.request({
        op: 'scan',
        prefer: PREFERRED_SCANNER,
        mode,
        dpi,
        intent,
        region: mode === 'card' ? region : null,
        transferPath,
        rawPath,
        outputPath,
        displayPath,
        quality,
      }, SCAN_TIMEOUT_MS)
      if (reply.scannerName) this.scannerName = reply.scannerName
      if (!reply.ok) {
        this.setState(['NO_DEVICE', 'NEEDS_SELECTION'].includes(reply.code) ? 'unavailable' : 'ready', reply.message)
        return reply
      }
      this.setState('ready')
      return reply
    } catch (error) {
      if (this.state !== 'unavailable') this.setState('unavailable', error.message)
      throw error
    } finally {
      this.touch()
    }
  }

  // Re-checks whether the sheet feeder is connected (it can be plugged in
  // after the page opened).
  async refreshFeeder() {
    try {
      const reply = await this.request({ op: 'feeder' }, OPEN_TIMEOUT_MS)
      this.feederName = reply.feederName || ''
    } catch {}
    this.emit('status', this.getStatus())
    return this.getStatus()
  }

  // Feeds the whole FastFoto stack. onPage is called for every finished,
  // cropped page while the stack is still feeding.
  async feed({ dpi, widthIn, heightIn, outDir, onPage }) {
    this.touch()
    const cancelPath = path.join(this.workDir, 'feed.cancel')
    await rm(cancelPath, { force: true })
    this.cancelPath = cancelPath
    this.feeding = true
    this.setState('scanning')
    try {
      const reply = await this.request({ op: 'feed', dpi, widthIn, heightIn, outDir, cancelPath }, FEED_TIMEOUT_MS, onPage)
      if (reply.feederName) this.feederName = reply.feederName
      return reply
    } finally {
      this.feeding = false
      if (this.closeWhenIdle) {
        this.closeWhenIdle = false
        this.close()
      } else {
        if (this.process) this.setState('ready')
        this.touch()
      }
    }
  }

  // Stops the stack after the page currently feeding.
  async cancelFeed() {
    if (this.feeding && this.cancelPath) await writeFile(this.cancelPath, 'cancel', 'utf8')
  }

  kill() {
    const child = this.process
    this.process = null
    if (child) {
      try { child.kill() } catch {}
    }
  }

  // Releases the scanner for other programs (leaving the page / idle / quit).
  close() {
    // Leaving the scanning page mid-stack: finish the stack first.
    if (this.feeding) {
      this.closeWhenIdle = true
      return
    }
    clearTimeout(this.idleTimer)
    const child = this.process
    this.setState('closed')
    if (!child) return
    try { child.stdin.write(`${JSON.stringify({ op: 'close' })}\n`) } catch {}
    setTimeout(() => { if (this.process === child) this.kill() }, 3000)
  }
}

module.exports = { ScannerSession, ScannerSessionError }
