import { type SQL, sql } from 'drizzle-orm'

import { executeSurrealDDL } from './rpc.js'
import {
  disabledSecurity,
  disableSecurity,
  dropColumn,
  dropConstraint,
  dropIndex,
  dropTable,
  dropType,
  removalPatterns,
} from './sql/removal.js'
import { split } from './statements.js'

type Column = {
  table: string
  name: string
}

type Removal = {
  columns: Column[]
  indexes: string[]
  tables: string[]
  types: string[]
}

export function planRemoval(sql: string): Removal | undefined {
  if (!disabledSecurity.test(sql)) {
    return
  }

  const statements = split(sql)
  const tables = matches(statements, dropTable, 1).map(([table]) => table)
  const disabledTables = matches(statements, disableSecurity, 1).map(([table]) => table)

  if (
    !tables.length ||
    !disabledTables.length ||
    disabledTables.some((table) => !tables.includes(table))
  ) {
    return
  }

  if (statements.some((statement) => !removalPatterns.some((pattern) => pattern.test(statement)))) {
    return
  }

  const columns = matches(statements, dropColumn, 2).map(([table, name]) => ({
    table,
    name,
  }))
  const constraints = matches(statements, dropConstraint, 2)

  for (const [table, constraint] of constraints) {
    if (!columns.some((column) => isColumnForeignKey(column, table, constraint))) {
      return
    }
  }

  return {
    columns,
    indexes: matches(statements, dropIndex, 1).map(([index]) => index),
    tables: tables.reverse(),
    types: matches(statements, dropType, 1).map(([type]) => type),
  }
}

export async function remove<T extends { rows: Record<string, unknown>[] }>(
  plan: Removal,
  execute: (query: SQL) => PromiseLike<T>
): Promise<T> {
  const removeIndexes: string[] = []

  for (const index of plan.indexes) {
    const { rows } = await execute(sql`
      SELECT t.relname AS table_name, i.indisprimary AS is_primary
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      WHERE idx.relname = ${index}
    `)

    const [row] = rows

    if (!row) {
      continue
    }

    if (rows.length !== 1 || row.is_primary || typeof row.table_name !== 'string') {
      throw new Error(`Cannot identify the index to remove: ${index}`)
    }

    removeIndexes.push(`REMOVE INDEX IF EXISTS ${quote(index)} ON TABLE ${quote(row.table_name)}`)
  }

  const statements = [
    ...removeIndexes,
    ...plan.columns.map(
      ({ table, name }) => `REMOVE FIELD IF EXISTS ${quote(name)} ON TABLE ${quote(table)}`
    ),
    ...plan.tables.map((table) => `REMOVE TABLE IF EXISTS ${quote(table)}`),
    ...plan.types.map((type) => `REMOVE TYPE IF EXISTS ${quote(type)}`),
  ]

  return executeSurrealDDL(`${statements.join(';\n')};`, () => execute(sql`SELECT 1`))
}

function matches(statements: string[], pattern: RegExp, count: 1): [string][]
function matches(statements: string[], pattern: RegExp, count: 2): [string, string][]
function matches(
  statements: string[],
  pattern: RegExp,
  count: 1 | 2
): ([string] | [string, string])[] {
  return statements.flatMap<[string] | [string, string]>((statement) => {
    const [, first, second] = pattern.exec(statement) ?? []

    if (first === undefined) {
      return []
    }

    const name = first.replaceAll('""', '"')

    if (count === 1) {
      return [[name]]
    }

    if (second === undefined) {
      throw new Error(`Missing second identifier in migration statement: ${statement}`)
    }

    return [[name, second.replaceAll('""', '"')]]
  })
}

function isColumnForeignKey(column: Column, table: string, constraint: string): boolean {
  if (column.table !== table) {
    return false
  }

  const generated = `${table}_${column.name}_fkey`
  const drizzle = `${table}_${column.name}_fk`
  const shortened = `${table}_${column.name.replace(/_id$/, '')}_fk`

  return constraint === generated || constraint === drizzle || constraint === shortened
}

function quote(identifier: string): string {
  return `\`${identifier.replace(/[`\\]/g, '\\$&')}\``
}
