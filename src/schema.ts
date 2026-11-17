import { type PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { getTableColumns, is, sql } from 'drizzle-orm'
import { PgSerial, PgSmallSerial, PgText, PgVarchar } from 'drizzle-orm/pg-core'
import toSnakeCase from 'to-snake-case'

type SchemaHook = NonNullable<PostgresAdapterArgs['beforeSchemaInit']>[number]

export const setSessionKeys: SchemaHook = ({ adapter, schema }) => {
  for (const collection of adapter.payload.config.collections) {
    if (!collection.auth?.useSessions) {
      continue
    }

    const table = adapter.tableNameMap.get(toSnakeCase(collection.slug))
    const sessions = table && adapter.rawRelations[table]?.sessions?.to
    const columns = sessions ? adapter.rawTables[sessions]?.columns : undefined

    if (columns?.id?.type === 'varchar') {
      columns.id = { ...columns.id, type: 'uuid' }
    }
  }

  return schema
}

export const bindColumnTypes: SchemaHook = ({ adapter, schema }) => {
  for (const table of Object.values(schema.tables)) {
    for (const column of Object.values(getTableColumns(table))) {
      if (is(column, PgSerial) || is(column, PgSmallSerial)) {
        column.mapFromDriverValue = (value) => (typeof value === 'string' ? Number(value) : value)
      }
    }
  }

  const jobs = adapter.tableNameMap.get(toSnakeCase('payload-jobs'))
  const token = jobs ? schema.tables[jobs]?.processingToken : undefined

  if (is(token, PgVarchar) || is(token, PgText)) {
    token.mapToDriverValue = (value) => sql`CAST(${value} AS text)`
  }

  return schema
}
