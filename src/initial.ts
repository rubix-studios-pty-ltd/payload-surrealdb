import { keywordEnds, split } from './statements.js'

const identifier = '(?:"(?:[^"]|"")*"|[a-z_][\\w$]*)'
const tableName = `(?:(?:"public"|public)\\s*\\.\\s*)?(${identifier})`
const createTable = new RegExp(`^CREATE\\s+TABLE\\s+${tableName}\\s*\\([\\s\\S]*\\)$`, 'i')
const addForeignKey = new RegExp(
  `^ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+(CONSTRAINT\\s+${identifier}\\s+FOREIGN\\s+KEY\\b[\\s\\S]*)$`,
  'i'
)
const createIndex = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s+ON\\s+${tableName}\\s*(?:\\(|USING\\b)`,
  'i'
)
const addColumn = new RegExp(`^ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+COLUMN\\b`, 'i')
const addedColumnName = new RegExp(
  `${addColumn.source}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
  'i'
)
const foreignKeyColumns = new RegExp(
  `^CONSTRAINT\\s+${identifier}\\s+FOREIGN\\s+KEY\\s*\\(\\s*(${identifier}(?:\\s*,\\s*${identifier})*)\\s*\\)`,
  'i'
)
const columnIdentifiers = new RegExp(identifier, 'gi')
const addKeyColumn = new RegExp(
  `${addColumn.source}\\s+(${identifier})\\s+(?:smallint|integer|bigint|uuid|text|varchar)$`,
  'i'
)
const keyColumn = new RegExp(
  `^CONSTRAINT\\s+${identifier}\\s+FOREIGN\\s+KEY\\s*\\(\\s*(${identifier})\\s*\\)\\s+` +
    `(REFERENCES\\s+${tableName}\\s*\\(\\s*(?:"id"|id)\\s*\\)` +
    `(?:\\s+ON\\s+(?:DELETE\\s+(?:CASCADE|NO\\s+ACTION|RESTRICT|SET\\s+NULL)|UPDATE\\s+NO\\s+ACTION))*)$`,
  'i'
)
const reference = new RegExp(`^\\s+${tableName}\\s*\\(`, 'i')

type Definition = {
  name: string
  index: number
  statement: string
  constraints: string[]
}

type AddedColumn = { index: number; statement: string }

export function inlineKeys(source: string): string {
  const statements = split(source)
  const definitions = new Map<string, Definition>()
  const positions = new Map<number, Definition>()
  const indexed = new Set<string>()

  for (const [index, statement] of statements.entries()) {
    const table = identifierName(createTable.exec(statement)?.[1])

    if (table !== undefined) {
      if (definitions.has(table)) {
        return source
      }

      const definition: Definition = { name: table, index, statement, constraints: [] }

      definitions.set(table, definition)
      positions.set(index, definition)

      continue
    }

    const owner = identifierName(createIndex.exec(statement)?.[1])

    if (owner !== undefined) {
      indexed.add(owner)
    }
  }

  const inlined = new Set<number>()
  const addedColumns = new Map<string, Set<string>>()

  for (const [index, statement] of statements.entries()) {
    const [, alteredTable, columnName] = addedColumnName.exec(statement) ?? []
    const altered = identifierName(alteredTable)
    const column = identifierName(columnName)

    if (altered !== undefined && column !== undefined) {
      const definition = definitions.get(altered)

      if (definition && definition.index < index) {
        const columns = addedColumns.get(altered) ?? new Set<string>()

        columns.add(column)
        addedColumns.set(altered, columns)
      }

      continue
    }

    const [, table, constraint] = addForeignKey.exec(statement) ?? []
    const owner = identifierName(table)
    const definition = owner === undefined ? undefined : definitions.get(owner)

    if (!definition || !indexed.has(definition.name) || definition.index >= index || !constraint) {
      continue
    }

    const sourceColumns = foreignKeyColumns.exec(constraint)?.[1]
    const laterColumns = addedColumns.get(definition.name)

    if (
      !sourceColumns ||
      [...sourceColumns.matchAll(columnIdentifiers)].some(([name]) => {
        const column = identifierName(name)
        return column !== undefined && laterColumns?.has(column)
      })
    ) {
      continue
    }

    definition.constraints.push(constraint)
    inlined.add(index)
  }

  if (!inlined.size) {
    return source
  }

  for (const group of tableGroups(statements, positions, definitions)) {
    if (!group.some(({ constraints }) => constraints.length)) {
      continue
    }

    const ordered = orderTables(group, definitions)

    for (const [position, { index }] of group.entries()) {
      const definition = ordered[position]

      if (!definition) {
        continue
      }

      const { constraints, statement } = definition

      statements[index] = constraints.length
        ? `${statement.slice(0, -1).trimEnd()},\n  ${constraints.map(endLineComment).join(',\n  ')}\n)`
        : statement
    }
  }

  return statements
    .filter((_, index) => !inlined.has(index))
    .map((statement) => `${endLineComment(statement)};`)
    .join('\n')
}

export function inlineAddedKeys(statements: string[]): string[] {
  const rewritten: (string | undefined)[] = [...statements]
  const pending = new Map<string, Map<string, AddedColumn>>()

  for (const [index, statement] of statements.entries()) {
    const addition = addKeyColumn.exec(statement)
    const owner = identifierName(addition?.[1])
    const column = identifierName(addition?.[2])

    if (owner !== undefined && column !== undefined) {
      const columns = pending.get(owner) ?? new Map<string, AddedColumn>()

      columns.set(column, { index, statement })
      pending.set(owner, columns)

      continue
    }

    const foreignKey = addForeignKey.exec(statement)
    const constraint = foreignKey?.[2] ? keyColumn.exec(foreignKey[2]) : null
    const keyOwner = identifierName(foreignKey?.[1])
    const keyColumnName = identifierName(constraint?.[1])
    const references = constraint?.[2]

    if (keyOwner !== undefined && keyColumnName !== undefined && references !== undefined) {
      const columns = pending.get(keyOwner)
      const added = columns?.get(keyColumnName)

      if (added) {
        rewritten[added.index] = `${added.statement} ${references}`
        rewritten[index] = undefined
        columns?.delete(keyColumnName)
      }

      continue
    }

    const indexedTable = identifierName(createIndex.exec(statement)?.[1])

    if (indexedTable === undefined) {
      pending.clear()
    } else {
      pending.delete(indexedTable)
    }
  }

  return rewritten.filter((statement) => statement !== undefined)
}

function* tableGroups(
  statements: string[],
  positions: Map<number, Definition>,
  definitions: Map<string, Definition>
): Generator<Definition[]> {
  let group: Definition[] = []

  for (const [index, statement] of statements.entries()) {
    const definition = positions.get(index)

    if (definition) {
      group.push(definition)
    } else if (group.length) {
      const altered = identifierName(addColumn.exec(statement)?.[1])

      if (
        altered === undefined ||
        definitions.has(altered) ||
        [...referencedTables(statement)].some((target) => definitions.has(target))
      ) {
        yield group
        group = []
      }
    }
  }

  if (group.length) {
    yield group
  }
}

function orderTables(group: Definition[], definitions: Map<string, Definition>): Definition[] {
  const start = group[0]?.index ?? 0
  const end = group.at(-1)?.index ?? 0
  const path: string[] = []
  const visiting = new Set<string>()
  const ordered = new Set<Definition>()

  function visit(definition: Definition): void {
    if (ordered.has(definition)) {
      return
    }

    const { name, statement, constraints } = definition

    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name].join(' -> ')

      throw new Error(
        `Cannot inline cyclic foreign keys (${cycle}). Split the migration into separate transactions.`
      )
    }

    path.push(name)
    visiting.add(name)

    for (const sql of [statement, ...constraints]) {
      for (const target of referencedTables(sql)) {
        const parent = definitions.get(target)

        if (!parent || parent === definition || parent.index < start) {
          continue
        }

        if (parent.index > end) {
          throw new Error(
            `Cannot inline a foreign key from "${name}" to "${parent.name}" across other SQL. Place the referenced table before "${name}" or split the migration.`
          )
        }

        visit(parent)
      }
    }

    path.pop()
    visiting.delete(name)
    ordered.add(definition)
  }

  for (const definition of group) {
    visit(definition)
  }

  return [...ordered]
}

function* referencedTables(statement: string): Generator<string> {
  for (const offset of keywordEnds(statement, 'REFERENCES')) {
    const table = identifierName(reference.exec(statement.slice(offset))?.[1])

    if (table !== undefined) {
      yield table
    }
  }
}

function identifierName(value: string | undefined): string | undefined {
  return value?.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value?.toLowerCase()
}

function endLineComment(statement: string): string {
  return /--[^\r\n]*$/.test(statement) ? `${statement}\n` : statement
}
