import { type Migration } from 'payload'
import { type PostgresAdapter } from '@payloadcms/db-postgres'
import { Pool, type PoolConfig } from '@surrealdb/pg'
import { drizzle } from 'drizzle-orm/node-postgres'

import { bindDatabase, startupMigrate } from './migrations.js'
import { bindRelations } from './relations.js'
import { migrationPool } from './rpc.js'

export function bindConnection(adapter: PostgresAdapter, poolOptions: PoolConfig): void {
  const destroyAdapter = adapter.destroy?.bind(adapter)

  let pool: Pool | undefined
  let connecting: Promise<void> | undefined
  let destroying: Promise<void> | undefined
  let failure: Error | undefined

  adapter.connect = ({ hotReload } = { hotReload: false }) => {
    if (destroying) {
      return Promise.reject(new Error('Cannot connect while destroying the adapter'))
    }

    if (failure) {
      return Promise.reject(failure)
    }

    connecting ??= connect(hotReload).finally(() => {
      connecting = undefined
    })

    return connecting
  }

  adapter.destroy = () => {
    destroying ??= (async () => {
      await connecting?.catch(() => undefined)

      const activePool = pool
      pool = undefined

      try {
        await activePool?.end()
      } finally {
        Reflect.deleteProperty(adapter, 'pool')
        Reflect.deleteProperty(adapter, 'drizzle')
        await destroyAdapter?.()
      }
    })().finally(() => {
      destroying = undefined
      failure = undefined
    })

    return destroying
  }

  async function connect(hotReload: boolean): Promise<void> {
    let activePool: Pool | undefined
    let initialized = false

    try {
      activePool = pool ?? new Pool(migrationPool(poolOptions))

      if (!pool) {
        const client = await activePool.connect()

        try {
          await client.query('SELECT 1 AS payload_surrealdb')
        } finally {
          client.release()
        }

        pool = activePool
      }

      const client = activePool as unknown as PostgresAdapter['pool']
      const database = drizzle({
        client,
        logger: adapter.logger ?? false,
        schema: adapter.schema,
      })

      bindRelations(database, adapter.schema)

      adapter.pool = client
      adapter.drizzle = database

      bindDatabase(adapter)

      adapter.resolveInitializing()
      initialized = true

      if (!hotReload && process.env.PAYLOAD_MIGRATING !== 'true') {
        if (process.env.NODE_ENV === 'production') {
          if (adapter.prodMigrations) {
            await adapter.migrate({ migrations: adapter.prodMigrations as unknown as Migration[] })
          }
        } else if (adapter.push !== false) {
          await startupMigrate(adapter)
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))

      pool = undefined

      Reflect.deleteProperty(adapter, 'pool')
      Reflect.deleteProperty(adapter, 'drizzle')

      if (!initialized) {
        void adapter.initializing.catch(() => undefined)
        adapter.rejectInitializing()
      }

      await activePool?.end().catch(() => undefined)

      throw failure
    }
  }
}
