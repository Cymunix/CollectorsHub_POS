import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const requestedPort = Number(process.env.PORT || 5280)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(scriptDir, '..')
const binDir = path.join(appRoot, 'node_modules', '.bin')
const viteCommand = path.join(binDir, process.platform === 'win32' ? 'vite.cmd' : 'vite')
const electronCommand = path.join(binDir, process.platform === 'win32' ? 'electron.cmd' : 'electron')
const children = new Set()

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })

  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function stopAll(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(exitCode)
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function findPort(startingPort) {
  for (let port = startingPort; port < startingPort + 20; port += 1) {
    if (await isPortAvailable(port)) return port
  }

  throw new Error(`No available port found from ${startingPort} to ${startingPort + 19}`)
}

async function waitFor(url, timeoutMs = 30000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Renderer is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${url}`)
}

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))

const port = await findPort(requestedPort)
const rendererUrl = `http://127.0.0.1:${port}`
const vite = run(viteCommand, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'])

try {
  await waitFor(rendererUrl)
} catch (error) {
  console.error(error.message)
  stopAll(1)
}

const electron = run(electronCommand, ['.'], {
  env: {
    ...process.env,
    NORDVIK_DESKTOP_RENDERER_URL: rendererUrl,
  },
})

electron.on('exit', (code) => {
  if (!vite.killed) vite.kill()
  process.exit(code ?? 0)
})
