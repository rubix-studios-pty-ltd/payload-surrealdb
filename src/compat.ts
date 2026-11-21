import { columnRe, deleteRe, escapeRe } from './sql/compat.js'
import { keywordEnds } from './statements.js'

type Change = { start: number; end: number; replacement: string }

function applyChanges(source: string, changes: Change[]): string {
  if (!changes.length) {
    return source
  }

  const parts: string[] = []

  let offset = 0

  for (const { start, end, replacement } of changes) {
    parts.push(source.slice(offset, start), replacement)
    offset = end
  }

  parts.push(source.slice(offset))

  return parts.join('')
}

export function rewriteLikeEscape(source: string): string {
  const changes: Change[] = []

  for (const index of keywordEnds(source, 'LIKE')) {
    const match = escapeRe.exec(source.slice(index))

    if (match?.[1]) {
      changes.push({
        start: index + match[1].length,
        end: index + match[0].length,
        replacement: '',
      })
    }
  }

  return applyChanges(source, changes)
}

function likePrefix(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.endsWith('%')) {
    return undefined
  }

  let prefix = ''

  for (let i = 0; i < value.length - 1; i++) {
    const char = value[i]

    if (char === '\\') {
      const next = value[++i]

      if (i === value.length - 1 || (next !== '\\' && next !== '_' && next !== '%')) {
        return undefined
      }

      prefix += next
    } else if (char === '_' || char === '%') {
      return undefined
    } else {
      prefix += char
    }
  }

  return prefix
}

export function rewriteDeleteLike(
  source: string,
  values: unknown[]
): { text: string; values: unknown[] } {
  if (!/^\s*DELETE\s+FROM\b/i.test(source)) {
    return { text: rewriteLikeEscape(source), values }
  }

  const changes: Change[] = []
  const used = new Set<number>()
  let nextValues: unknown[] | undefined

  for (const index of keywordEnds(source, 'LIKE')) {
    const before = source.slice(0, index - 4)
    const column = columnRe.exec(before)
    const match = deleteRe.exec(source.slice(index))

    if (!column?.[1] || !match?.[1]) {
      continue
    }

    const param = Number(match[1])

    if (param < 1 || param > values.length) {
      continue
    }

    const prefix = likePrefix(values[param - 1])

    if (prefix === undefined) {
      continue
    }

    const count = source.match(new RegExp(`\\$${param}(?!\\d)`, 'g'))?.length ?? 0

    if (count !== 1 || used.has(param)) {
      throw new Error(`Cannot safely rewrite shared LIKE parameter $${param}`)
    }

    used.add(param)
    nextValues ??= [...values]
    nextValues[param - 1] = prefix

    changes.push({
      start: before.length - column[0].length,
      end: index + match[0].length,
      replacement: `SUBSTRING(${column[1]} FROM 1 FOR LENGTH($${param})) = $${param}`,
    })
  }

  return {
    text: applyChanges(source, changes),
    values: nextValues ?? values,
  }
}

function rewriteQuery(query: unknown, args: unknown[]): { query: unknown; args: unknown[] } {
  const config = query !== null && typeof query === 'object' && 'text' in query ? query : undefined
  const source = typeof query === 'string' ? query : config?.text

  if (typeof source !== 'string') {
    return { query, args }
  }

  const hasArgs = Array.isArray(args[0])
  const values = hasArgs ? args[0] : config && 'values' in config ? config.values : undefined

  if (!Array.isArray(values)) {
    const text = rewriteLikeEscape(source)

    return {
      query: text === source ? query : typeof query === 'string' ? text : { ...config, text },
      args,
    }
  }

  const result = rewriteDeleteLike(source, values)

  if (result.text === source && result.values === values) {
    return { query, args }
  }

  return {
    query:
      typeof query === 'string'
        ? result.text
        : {
            ...config,
            text: result.text,
            ...(!hasArgs ? { values: result.values } : {}),
          },
    args: hasArgs ? [result.values, ...args.slice(1)] : args,
  }
}

export function bindQueries<T extends { query: (...args: never[]) => unknown }>(target: T): void {
  const execute = target.query

  target.query = ((query: unknown, ...args: unknown[]) => {
    const result = rewriteQuery(query, args)

    return Reflect.apply(execute, target, [result.query, ...result.args])
  }) as T['query']
}
