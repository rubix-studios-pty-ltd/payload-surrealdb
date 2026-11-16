import { type PostgresAdapterArgs } from '@payloadcms/db-postgres'
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
