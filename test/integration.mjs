import { execFile, spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const { SURREAL_TEST_ENDPOINT: configuredEndpoint, SURREAL_TEST_PASSWORD: configuredPassword } =
  process.env

if (Boolean(configuredEndpoint) !== Boolean(configuredPassword)) {
  throw new Error('Set SURREAL_TEST_ENDPOINT and SURREAL_TEST_PASSWORD together')
}

const password = configuredPassword || 'local-test-password'
const controller = new AbortController()
const { signal } = controller
const interrupt = () => controller.abort()

process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

let container
let endpoint = configuredEndpoint

try {
  if (!endpoint) {
    const { stdout } = await exec(
      'docker',
      [
        'create',
        '--publish',
        '127.0.0.1::8000',
        '--env',
        'SURREAL_USER=root',
        '--env',
        'SURREAL_PASS',
        'surrealdb/surrealdb:v4.0.1',
        'start',
        '--bind',
        '0.0.0.0:8000',
        'memory',
      ],
      {
        env: {
          ...process.env,
          SURREAL_PASS: password,
        },
      }
    )

    container = stdout.trim()

    await exec('docker', ['start', container])

    const { stdout: publishedAddress } = await exec('docker', ['port', container, '8000/tcp'])

    endpoint = `http://${publishedAddress.trim()}`
  }

  await waitForDatabase(endpoint, container)

  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        '--test-force-exit',
        'test/*.integration.mjs',
      ],
      {
        env: {
          ...process.env,
          SURREAL_TEST_ENDPOINT: endpoint,
          SURREAL_TEST_PASSWORD: password,
        },
        signal,
        stdio: 'inherit',
      }
    )

    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })

  if (process.exitCode && container) {
    await showLogs(container)
  }
} catch (error) {
  if (container && !signal.aborted) {
    await showLogs(container)
  }

  throw error
} finally {
  try {
    if (container) {
      await exec('docker', ['rm', '--force', '--volumes', container])
    }
  } catch (error) {
    console.error('Could not remove the SurrealDB test container', error.message)
    process.exitCode ||= 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

async function waitForDatabase(endpoint, container) {
  const url = new URL('/ready', endpoint)
  const deadline = Date.now() + 30_000
  let lastFailure

  while (Date.now() < deadline) {
    signal.throwIfAborted()

    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      })

      await response.body?.cancel()

      if (response.ok) {
        return
      }

      lastFailure = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastFailure = error
    }

    signal.throwIfAborted()

    if (container) {
      const { stdout } = await exec('docker', [
        'inspect',
        '--format',
        '{{.State.Status}} (exit code {{.State.ExitCode}})',
        container,
      ])
      const status = stdout.trim()

      if (!status.startsWith('running ')) {
        throw new Error(`SurrealDB container stopped before becoming ready: ${status}`)
      }
    }

    await setTimeout(250, undefined, { signal })
  }

  throw new Error(`SurrealDB did not become ready at ${url}`, { cause: lastFailure })
}

async function showLogs(container) {
  try {
    const { stdout, stderr } = await exec('docker', ['logs', '--tail', '100', container])

    if (stdout) {
      console.error(stdout.trimEnd())
    }

    if (stderr) {
      console.error(stderr.trimEnd())
    }
  } catch (error) {
    console.error('Could not read the SurrealDB test container logs', error.message)
  }
}
