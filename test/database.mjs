import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function setupDatabase(t) {
  const endpoint = process.env.SURREAL_TEST_ENDPOINT
  const password = process.env.SURREAL_TEST_PASSWORD

  assert.ok(endpoint && password, 'Set SURREAL_TEST_ENDPOINT and SURREAL_TEST_PASSWORD')

  const namespace = `payload_test_${randomUUID().replaceAll('-', '')}`
  const server = new URL(endpoint)
  const authorization = `Basic ${Buffer.from(`root:${password}`).toString('base64')}`

  async function query(body) {
    const response = await fetch(new URL('/sql', server), {
      method: 'POST',
      headers: { accept: 'application/json', authorization },
      body,
      signal: AbortSignal.timeout(5000),
    })

    assert.ok(response.ok, `SurrealDB SQL endpoint returned HTTP ${response.status}`)

    const statements = await response.json()

    assert.ok(Array.isArray(statements) && statements.length)

    for (const statement of statements) {
      assert.equal(statement.status, 'OK', JSON.stringify(statement.result))
    }

    return statements.at(-1).result
  }

  await query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE cms;`)
  t.after(() => query(`REMOVE NAMESPACE IF EXISTS ${namespace};`))

  const connection = new URL('surrealdb+ws://localhost')
  const scheme = server.protocol === 'https:' ? 'surrealdb+wss:' : 'surrealdb+ws:'
  connection.hostname = server.hostname
  connection.port = server.port
  connection.username = 'root'
  connection.password = password
  connection.pathname = `/${namespace}/cms`
  const connectionString = connection.href.replace(/^surrealdb\+ws:/, scheme)

  const migrationDir = await mkdtemp(fileURLToPath(new URL('./.migrations-', import.meta.url)))

  t.after(() => rm(migrationDir, { recursive: true, force: true }))

  return { connectionString, migrationDir, namespace, query }
}

export async function migrateInitial(payload) {
  await payload.db.createMigration({
    migrationName: 'initial',
    payload,
    forceAcceptWarning: true,
  })
  await payload.db.migrate()
}
