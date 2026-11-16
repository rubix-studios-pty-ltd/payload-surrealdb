import { postgresAdapter } from '@payloadcms/db-postgres'

import { bindConnection } from './connect.js'
import { bindMigrations } from './migrations.js'
import { setSessionKeys } from './schema.js'
import { type SurrealDBAdapterArgs } from './types.js'

const packageName = '@rubixstudios/payload-surrealdb'

export function surrealdbAdapter(args: SurrealDBAdapterArgs): ReturnType<typeof postgresAdapter> {
  const { pool: input, push = true, ...options } = args

  const pool = typeof input === 'string' ? { connectionString: input } : input

  if (!pool?.connectionString?.trim()) {
    throw new Error(`${packageName} requires a database URL`)
  }

  const upstream = postgresAdapter({
    ...options,
    beforeSchemaInit: [setSessionKeys, ...(options.beforeSchemaInit ?? [])],
    disableCreateDatabase: true,
    pool: {
      connectionString: pool.connectionString,
    },
    push,
  })

  return {
    ...upstream,
    init(initArgs) {
      const adapter = upstream.init(initArgs)

      adapter.packageName = packageName
      bindConnection(adapter, pool)
      bindMigrations(adapter)

      return adapter
    },
  }
}
