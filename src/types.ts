import { type PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { type PoolConfig } from '@surrealdb/pg'

type Migration = NonNullable<PostgresAdapterArgs['prodMigrations']>[number]

export type MigrateDownArgs = Parameters<Migration['down']>[0]
export type MigrateUpArgs = Parameters<Migration['up']>[0]

export type SurrealDBAdapterArgs = Omit<
  PostgresAdapterArgs,
  | 'disableCreateDatabase'
  | 'extensions'
  | 'pg'
  | 'pool'
  | 'query'
  | 'readReplicas'
  | 'readReplicasAfterWriteInterval'
  | 'schemaName'
  | 'transactionOptions'
> & {
  pool: string | undefined | (PoolConfig & { connectionString: string })
}

export interface GeneratedDatabaseSchema {
  schemaUntyped: Record<string, unknown>
}

type SurrealDBGeneratedSchema = GeneratedDatabaseSchema

declare module '@payloadcms/db-postgres' {
  interface GeneratedDatabaseSchema extends SurrealDBGeneratedSchema {}
}
