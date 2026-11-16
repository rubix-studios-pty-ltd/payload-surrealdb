import { execFile, spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const endpoint = 'http://127.0.0.1:18000'
const password = 'local-test-password'
const controller = new AbortController()
const { signal } = controller
const interrupt = () => controller.abort()

process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

async function waitForDatabase() {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    signal.throwIfAborted()

    const response = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
    }).catch(() => undefined)

    if (response?.ok) return

    await setTimeout(250, undefined, { signal })
  }

  throw new Error(`SurrealDB did not become ready at ${endpoint}`)
}

const { stdout } = await exec('docker', [
  'run', '--rm', '-d',
  '-p', '127.0.0.1:18000:8000',
  'surrealdb/surrealdb:v4.0.1',
  'start', '--bind', '0.0.0.0:8000',
  '--user', 'root', '--pass', password, 'memory',
])
const container = stdout.trim()

try {
  await waitForDatabase()

  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', '--test-force-exit', 'test/payload.integration.mjs'],
      {
        env: {
          ...process.env,
          SURREAL_TEST_ENDPOINT: endpoint,
          SURREAL_TEST_PASSWORD: password,
        },
        signal,
        stdio: 'inherit',
      },
    )

    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  try {
    await exec('docker', ['stop', container])
  } catch (error) {
    if (!error.stderr?.includes('No such container')) {
      console.error('Could not stop the SurrealDB test container', error.message)
      process.exitCode ||= 1
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}
