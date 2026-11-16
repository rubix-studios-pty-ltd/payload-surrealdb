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
const reference = new RegExp(`^\\s+${tableName}\\s*\\(`, 'i')

type Definition = {
  name: string
  index: number
  statement: string
  constraints: string[]
}

export function inlineKeys(statement: string): string {
  const statements = split(statement)
  const definitions = new Map<string, Definition>()
  const positions = new Map<number, Definition>()
  const indexed = new Set<string>()

  for (const [index, entry] of statements.entries()) {
    const table = identifierName(createTable.exec(entry)?.[1])

    if (table !== undefined) {
      if (definitions.has(table)) {
        return statement
      }

      const definition = { name: table, index, statement: entry, constraints: [] }

      definitions.set(table, definition)
      positions.set(index, definition)
      continue
    }

    const owner = identifierName(createIndex.exec(entry)?.[1])

    if (owner !== undefined) {
      indexed.add(owner)
    }
  }

  const inlined = new Set<number>()

  for (const [index, entry] of statements.entries()) {
    const [, tableName, constraint] = addForeignKey.exec(entry) ?? []
    const owner = identifierName(tableName)
    const definition = owner === undefined ? undefined : definitions.get(owner)

    if (definition && indexed.has(definition.name) && definition.index < index && constraint) {
      definition.constraints.push(constraint)
      inlined.add(index)
    }
  }

  if (!inlined.size) {
    return statement
  }

  for (const group of tableGroups(statements, positions, definitions)) {
    if (!group.some(({ constraints }) => constraints.length)) {
      continue
    }

    for (const [position, { constraints, statement }] of orderTables(
      group,
      definitions
    ).entries()) {
      const index = group[position]?.index

      if (index === undefined) {
        continue
      }

      statements[index] = constraints.length
        ? `${statement.slice(0, -1).trimEnd()},\n  ${constraints.map(endLineComment).join(',\n  ')}\n)`
        : statement
    }
  }

  return statements
    .filter((_, index) => !inlined.has(index))
    .map((entry) => `${endLineComment(entry)};`)
    .join('\n')
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
