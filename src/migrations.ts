import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMigrations, readMigrationFiles } from 'payload'
import { type PostgresAdapter } from '@payloadcms/db-postgres'
import { is, type SQLWrapper, StringChunk, sql } from 'drizzle-orm'

import { dropSchema } from './drop.js'
import { inlineKeys } from './initial.js'
import { planRemoval, remove } from './removal.js'
import { split } from './statements.js'

const postgres = `SELECT to_regclass('"payload_migrations"') AS exists;`

const surreal = `SELECT COUNT(*) AS "exists"
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'payload_migrations';`

const scope = new AsyncLocalStorage<'migrate' | 'down' | 'fresh'>()

export function bindDatabase(adapter: PostgresAdapter): void {
  const db = adapter.drizzle
  const execute = db.execute.bind(db)

  db.execute = <Row extends Record<string, unknown>>(query: string | SQLWrapper) => {
    const mode = scope.getStore()

    if (mode !== 'migrate' && mode !== 'fresh') {
      return execute<Row>(query)
    }

    const text = getText(query)

    if (!text) {
      return execute<Row>(query)
    }

    const rewritten = inlineKeys(text)
    const statements = split(rewritten)

    if (statements.length <= 1) {
      return execute<Row>(rewritten !== text ? sql.raw(rewritten) : query)
    }

    return (async () => {
      let result: Awaited<ReturnType<typeof execute<Row>>> | undefined

      for (const statement of statements) {
        result = await execute<Row>(sql.raw(statement))
      }

      return result
    })() as unknown as ReturnType<typeof execute<Row>>
  }
}

export async function startupMigrate(adapter: PostgresAdapter): Promise<void> {
  if (!existsSync(adapter.migrationDir)) {
    return
  }

  const migrations = await readMigrationFiles({ payload: adapter.payload })

  if (migrations.length) {
    const drizzle = adapter.drizzle
    const history = await adapter.execute({ drizzle, raw: postgres })

    if (history.rows[0]?.exists) {
      const dev = await adapter.execute({
        drizzle,
        raw: 'SELECT "id" FROM "payload_migrations" WHERE "batch" = -1 LIMIT 1;',
      })

      if (dev.rows.length) {
        throw new Error('Automatic migrations cannot run after a Payload development schema push')
      }
    }
  }

  await adapter.migrate({ migrations })
}

type Session = PostgresAdapter['sessions'][string]

export function bindMigrations(adapter: PostgresAdapter): void {
  const createMigration = adapter.createMigration.bind(adapter)
  const execute = adapter.execute.bind(adapter)
  const begin = adapter.beginTransaction.bind(adapter)
  const commit = adapter.commitTransaction.bind(adapter)
  const failures = new WeakMap<Session, unknown>()

  adapter.createMigration = async (options) => {
    const directory = adapter.migrationDir
    const before = migrationFiles(directory)
    const result = await createMigration(options)
    const originalImport = `import { MigrateUpArgs, MigrateDownArgs, sql } from '${adapter.packageName}'`
    const typedImport = `import { type MigrateUpArgs, type MigrateDownArgs, sql } from '${adapter.packageName}'`

    for (const [file, modified] of migrationFiles(directory)) {
      if (before.get(file) === modified) {
        continue
      }

      const source = readFileSync(file, 'utf8')

      if (source.startsWith(`${originalImport}\n`)) {
        writeFileSync(file, typedImport + source.slice(originalImport.length))
      }
    }

    return result
  }

  adapter.execute = async (query) => {
    if (query.raw !== postgres) {
      return execute(query)
    }

    const result = await execute({ ...query, raw: surreal })

    return {
      ...result,
      rows: [{ exists: Number(result.rows[0]?.exists) > 0 }],
    }
  }

  function inMigration<Args extends unknown[], Result>(
    run: (...args: Args) => Result,
    mode: 'migrate' | 'down' | 'fresh' = 'migrate'
  ): (...args: Args) => Result {
    return (...args) => scope.run(mode, () => run(...args))
  }

  adapter.migrate = inMigration(adapter.migrate.bind(adapter))
  adapter.migrateDown = inMigration(adapter.migrateDown.bind(adapter), 'down')
  adapter.migrateReset = inMigration(adapter.migrateReset.bind(adapter), 'down')
  adapter.migrateFresh = inMigration(adapter.migrateFresh.bind(adapter), 'fresh')
  adapter.migrateRefresh = () => refreshMigrations(adapter)

  adapter.beginTransaction = async (...args) => {
    const mode = scope.getStore()

    if (mode === 'migrate' || mode === 'fresh') {
      return null
    }

    const id = await begin(...args)
    const session = id === null ? undefined : adapter.sessions[id]

    if (session && mode === 'down') {
      bindMigrationSQL(session, failures)
    }

    return id
  }

  adapter.commitTransaction = async (incoming) => {
    if (!scope.getStore()) {
      return commit(incoming)
    }

    const id = await incoming
    const session = adapter.sessions[id]

    if (session && failures.has(session)) {
      await adapter.rollbackTransaction(id)
      throw failures.get(session)
    }

    return commit(id)
  }

  adapter.dropDatabase = async () => {
    if (scope.getStore() === 'fresh') {
      const migrations = await readMigrationFiles({ payload: adapter.payload })

      if (!migrations.length || migrations.some(({ up }) => typeof up !== 'function')) {
        throw new Error('migrate:fresh requires valid migration files to rebuild the schema')
      }
    }

    await dropSchema(adapter)
  }
}

async function refreshMigrations(
  adapter: PostgresAdapter
): ReturnType<PostgresAdapter['migrateRefresh']> {
  const { payload } = adapter
  const { existingMigrations } = await getMigrations({ payload })

  if (!existingMigrations.length) {
    return adapter.migrateReset()
  }

  const migrations = await readMigrationFiles({ payload })
  const files = new Map(migrations.map((migration) => [migration.name, migration]))

  for (const { name } of existingMigrations) {
    if (typeof files.get(name)?.down !== 'function') {
      throw new Error(`Cannot refresh migrations without a down function for "${name}"`)
    }
  }

  if (migrations.some(({ up }) => typeof up !== 'function')) {
    throw new Error('migrate:refresh requires valid migration files to rebuild the schema')
  }

  await adapter.migrateReset()
  const result = await adapter.migrate({ migrations })

  if (typeof result === 'object' && result !== null) {
    Object.assign(result, {
      rolledBack: existingMigrations.map(({ name }) => name).reverse(),
    })
  }

  return result
}

function migrationFiles(directory: string): Map<string, bigint> {
  const files = new Map<string, bigint>()

  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^\d{8}_\d{6}(?:_\w+)?\.ts$/.test(entry.name)) {
        const file = join(directory, entry.name)
        const stats = statSync(file, { bigint: true, throwIfNoEntry: false })

        if (stats) {
          files.set(file, stats.mtimeNs)
        }
      }
    }
  }

  return files
}

function bindMigrationSQL(session: Session, failures: WeakMap<Session, unknown>): void {
  const { db } = session
  const execute = db.execute.bind(db)

  db.execute = <Row extends Record<string, unknown>>(query: string | SQLWrapper) => {
    const text = getText(query)
    const removal = text && planRemoval(text)

    if (removal) {
      const result = remove(removal, (query) => execute<Row>(query)).catch((error: unknown) => {
        failures.set(session, error)
        throw error
      })

      return result as unknown as ReturnType<typeof execute<Row>>
    }

    const rewritten = text && inlineKeys(text)

    return execute<Row>(rewritten && rewritten !== text ? sql.raw(rewritten) : query)
  }
}

function getText(query: string | SQLWrapper): string | undefined {
  if (typeof query === 'string') {
    return query
  }

  const chunks = query.getSQL().queryChunks

  if (chunks.every((chunk) => is(chunk, StringChunk))) {
    return chunks.flatMap((chunk) => chunk.value).join('')
  }
}
