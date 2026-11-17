import { tokens, words } from './sql/statements.js'

export function* keywordEnds(sql: string, keyword: string): Generator<number> {
  for (const token of sql.matchAll(words)) {
    if (token[2]?.toUpperCase() === keyword) {
      yield token.index + token[0].length
    }
  }
}

export function split(sql: string): string[] {
  const statements: string[] = []

  let start = 0

  for (const token of sql.matchAll(tokens)) {
    if (token[0] !== ';') {
      continue
    }

    statements.push(sql.slice(start, token.index).trim())
    start = token.index + 1
  }

  statements.push(sql.slice(start).trim())

  return statements.filter(Boolean)
}
