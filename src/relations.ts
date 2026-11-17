import {
  and,
  type Column,
  createTableRelationsHelpers,
  type DBQueryConfig,
  eq,
  extractTablesRelationalConfig,
  getOperators,
  getOrderByOperators,
  getTableUniqueName,
  inArray,
  is,
  normalizeRelation,
  One,
  or,
  type SQL,
  sql,
  type TableRelationalConfig,
} from 'drizzle-orm'
import { type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { type PgColumn, type PgTable } from 'drizzle-orm/pg-core'

type Columns = TableRelationalConfig['columns']
type Database = NodePgDatabase<Record<string, unknown>>
type Query = DBQueryConfig<'many', true>
type Row = Record<string, unknown>

type QueryBuilder = {
  findFirst: (query?: Query) => unknown
  findMany: (query?: Query) => unknown
}

type Join = {
  name: string
  target: TableRelationalConfig
  isOne: boolean
  query: Query
  sourceKeys: string[]
  targetKeys: string[]
}

const batchSize = 250

export function bindRelations(database: Database, schema: Record<string, unknown>): void {
  const { tableNamesMap, tables } = extractTablesRelationalConfig(
    schema,
    createTableRelationsHelpers
  )

  bind(database)

  function bind(database: Database): void {
    const queries = database.query as unknown as Record<string, QueryBuilder>

    for (const [name, table] of Object.entries(tables)) {
      const builder = queries[name]

      if (!builder) {
        throw new Error(`Missing Drizzle query builder for table "${name}"`)
      }

      const findFirst = builder.findFirst.bind(builder)
      const findMany = builder.findMany.bind(builder)

      builder.findFirst = (query) => {
        if (!hasRelations(query)) {
          return findFirst(query)
        }

        return selectRows(database, table, { ...query, limit: 1 }).then(([row]) => row)
      }

      builder.findMany = (query) => {
        if (!hasRelations(query)) {
          return findMany(query)
        }

        return selectRows(database, table, query)
      }
    }

    const transaction = database.transaction.bind(database)

    database.transaction = (callback, options) =>
      transaction((transaction) => {
        bind(transaction as unknown as Database)

        return callback(transaction)
      }, options)
  }

  async function selectRows(
    database: Database,
    table: TableRelationalConfig,
    query: Query,
    requiredKeys: string[] = []
  ): Promise<Row[]> {
    const joins = planJoins(table, query)
    const selectedKeys = selectKeys(table.columns, query.columns)

    const necessaryKeys = new Set([
      ...selectedKeys,
      ...requiredKeys,
      ...joins.flatMap(({ sourceKeys }) => sourceKeys),
    ])

    const fields = Object.fromEntries(
      [...necessaryKeys].map((key) => [key, table.columns[key] as PgColumn])
    )

    const extras =
      typeof query.extras === 'function' ? query.extras(table.columns, { sql }) : query.extras

    const projection = {
      ...fields,
      ...extras,
    }

    const where = getWhere(query.where, table.columns)

    const order =
      typeof query.orderBy === 'function'
        ? query.orderBy(table.columns, getOrderByOperators())
        : query.orderBy

    let statement = database
      .select(Object.keys(projection).length ? projection : { dummy: sql`1` })
      .from(schema[table.tsName] as PgTable)
      .where(where)
      .$dynamic()

    if (order) {
      const orderBy = (Array.isArray(order) ? order : [order]) as (PgColumn | SQL)[]

      statement = statement.orderBy(...orderBy)
    }

    if (query.limit !== undefined) {
      statement = statement.limit(query.limit)
    }

    if (query.offset !== undefined) {
      statement = statement.offset(query.offset)
    }

    const rows: Row[] = await statement

    for (const join of joins) {
      await loadJoin(database, rows, join)
    }

    const outputKeys = new Set([
      ...selectedKeys,
      ...requiredKeys,
      ...Object.keys(extras ?? {}),
      ...joins.map(({ name }) => name),
    ])

    return rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => outputKeys.has(key)))
    )
  }

  function planJoins(table: TableRelationalConfig, query: Query): Join[] {
    const relations = Object.entries(query.with ?? {}).filter(([, relation]) => Boolean(relation))

    return relations.map(([name, options]) => {
      const relation = table.relations[name]

      if (!relation) {
        throw new Error(`Unknown Drizzle relation ${table.tsName}.${name}`)
      }

      const tableKey = getTableUniqueName(relation.referencedTable)
      const targetName = tableNamesMap[tableKey]

      if (targetName === undefined) {
        throw new Error(`Missing Drizzle table mapping for "${tableKey}"`)
      }

      const target = tables[targetName]

      if (target === undefined) {
        throw new Error(`Missing Drizzle table config for "${targetName}"`)
      }

      const { fields, references } = normalizeRelation(tables, tableNamesMap, relation)

      return {
        name,
        target,
        isOne: is(relation, One),
        query: options === true ? {} : (options as Query),
        sourceKeys: fields.map((column) => columnKey(column, table.columns)),
        targetKeys: references.map((column) => columnKey(column, target.columns)),
      }
    })
  }

  async function loadJoin(database: Database, rows: Row[], join: Join): Promise<void> {
    const { name, target, isOne, query, sourceKeys, targetKeys } = join

    const parentKeys = new Map<string, unknown[]>()

    for (const row of rows) {
      const values = sourceKeys.map((key) => row[key])

      if (values.every((value) => value != null)) {
        parentKeys.set(joinKey(values), values)
      }
    }

    const where = getWhere(query.where, target.columns)

    const columns = targetKeys.map((key) => {
      const column = target.columns[key]

      if (!column) {
        throw new Error(`Missing Drizzle column "${target.tsName}.${key}"`)
      }

      return column
    })

    const [firstColumn] = columns

    if (!firstColumn) {
      throw new Error(`No target columns for Drizzle relation "${name}"`)
    }

    const matchesByParent = new Map<string, Row[]>()

    for (const batch of batches([...parentKeys.entries()])) {
      if (query.limit !== undefined || query.offset !== undefined) {
        for (const [key, values] of batch) {
          const related = await selectRows(database, target, {
            ...query,
            where: and(where, matchKeys(columns, values)),
          })

          matchesByParent.set(key, related)
        }

        continue
      }

      const keys = batch.map(([, values]) => values)

      const constraint =
        columns.length === 1
          ? inArray(
              firstColumn,
              keys.map(([value]) => joinParam(value))
            )
          : or(...keys.map((values) => matchKeys(columns, values)))

      const related = await selectRows(
        database,
        target,
        { ...query, where: and(where, constraint) },
        targetKeys
      )

      const selectedKeys = new Set(selectKeys(target.columns, query.columns))

      for (const row of related) {
        const key = joinKey(targetKeys.map((field) => row[field]))

        for (const field of targetKeys) {
          if (!selectedKeys.has(field)) {
            delete row[field]
          }
        }

        const group = matchesByParent.get(key) ?? []

        group.push(row)
        matchesByParent.set(key, group)
      }
    }

    for (const row of rows) {
      const key = joinKey(sourceKeys.map((field) => row[field]))
      const related = matchesByParent.get(key) ?? []

      row[name] = isOne ? (related[0] ?? null) : related
    }
  }
}

function hasRelations(query?: Query): query is Query {
  return Object.values(query?.with ?? {}).some(Boolean)
}

function columnKey(column: Column, fields: Columns): string {
  const key = Object.keys(fields).find((name) => fields[name] === column)

  if (!key) {
    throw new Error(`Cannot map Drizzle relation column ${column.name}`)
  }

  return key
}

function selectKeys(columns: Columns, selection?: Query['columns']): string[] {
  const keys = Object.keys(columns)

  if (!selection) {
    return keys
  }

  const specified = keys.filter((key) => selection[key] !== undefined)

  if (specified.some((key) => selection[key])) {
    return specified.filter((key) => selection[key])
  }

  return specified.length ? keys.filter((key) => selection[key] !== false) : []
}

function getWhere(where: Query['where'], columns: Columns): SQL | undefined {
  return typeof where === 'function' ? where(columns, getOperators()) : where
}

function matchKeys(columns: Column[], values: unknown[]): SQL | undefined {
  return and(...columns.map((column, index) => eq(column, joinParam(values[index]))))
}

function joinParam(value: unknown): unknown {
  return typeof value === 'bigint' ? sql`CAST(${value.toString()} AS bigint)` : value
}

function joinKey(values: unknown[]): string {
  return JSON.stringify(
    values.map((value) => {
      const integer =
        typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))

      return integer ? ['integer', String(value)] : ['value', value]
    })
  )
}

function* batches<T>(items: T[]): Generator<T[]> {
  for (let index = 0; index < items.length; index += batchSize) {
    yield items.slice(index, index + batchSize)
  }
}
