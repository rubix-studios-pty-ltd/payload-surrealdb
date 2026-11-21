import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bindQueries, rewriteDeleteLike, rewriteLikeEscape } from '../dist/compat.js'

const cleanup = `DELETE FROM "posts_rels" WHERE ("posts_rels"."parent_id" = $1 AND "posts_rels"."path" LIKE $2 ESCAPE '\\')`
const rewrittenCleanup = `DELETE FROM "posts_rels" WHERE ("posts_rels"."parent_id" = $1 AND SUBSTRING("posts_rels"."path" FROM 1 FOR LENGTH($2)) = $2)`

test('rewrites a Payload DELETE and its prefix binding', async () => {
  const calls = []
  const client = {
    query(query, values) {
      calls.push({ query, values })
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
  }

  bindQueries(client)

  const originalValues = [1, 'sections.%']

  await client.query({ text: cleanup, values: originalValues })

  assert.deepEqual(calls[0], {
    query: { text: rewrittenCleanup, values: [1, 'sections.'] },
    values: undefined,
  })

  assert.deepEqual(originalValues, [1, 'sections.%'])
})

test('preserves literal underscores, percent signs and backslashes in path prefixes', () => {
  const original = [1, 'my\\_section\\_name\\%.%']

  const rewritten = rewriteDeleteLike(cleanup, original)

  assert.equal(rewritten.text, rewrittenCleanup)

  assert.deepEqual(rewritten.values, [1, 'my_section_name%.'])
  assert.deepEqual(original, [1, 'my\\_section\\_name\\%.%'])

  assert.deepEqual(rewriteDeleteLike(cleanup, [1, 'folder\\\\name.%']).values, [1, 'folder\\name.'])
})

test('rewrites separate LIKE predicates without changing unrelated parameters', () => {
  const source = `DELETE FROM "posts_rels" WHERE "posts_rels"."parent_id" = $1 AND ("posts_rels"."path" LIKE $2 ESCAPE '\\' OR "posts_rels"."path" LIKE $3 ESCAPE '\\')`
  const rewritten = rewriteDeleteLike(source, [7, 'one.%', 'two\\_three.%'])

  assert.equal(
    rewritten.text,
    `DELETE FROM "posts_rels" WHERE "posts_rels"."parent_id" = $1 AND (SUBSTRING("posts_rels"."path" FROM 1 FOR LENGTH($2)) = $2 OR SUBSTRING("posts_rels"."path" FROM 1 FOR LENGTH($3)) = $3)`
  )

  assert.deepEqual(rewritten.values, [7, 'one.', 'two_three.'])
})

test('does not broaden general LIKE patterns into prefix comparisons', () => {
  const values = [1, 'my_section.%']

  const result = rewriteDeleteLike(cleanup, values)

  assert.equal(result.text, cleanup)

  assert.deepEqual(result.values, values)
})

test('does not rewrite SQL literals or comments', () => {
  assert.equal(
    rewriteLikeEscape("SELECT 'LIKE $2 ESCAPE ''\\'''"),
    "SELECT 'LIKE $2 ESCAPE ''\\'''"
  )

  assert.equal(
    rewriteLikeEscape("-- LIKE $2 ESCAPE '\\'\nSELECT 1"),
    "-- LIKE $2 ESCAPE '\\'\nSELECT 1"
  )

  assert.equal(rewriteLikeEscape(`SELECT x LIKE $1 ESCAPE '\\'`), 'SELECT x LIKE $1')

  assert.equal(rewriteLikeEscape("SELECT x LIKE $1 ESCAPE '!'"), "SELECT x LIKE $1 ESCAPE '!'")
})

test('preserves text/array/callback overloads and return values', async () => {
  const calls = []

  const pool = {
    query(query, values, callback) {
      calls.push([query, values, callback])

      return Promise.resolve('ok')
    },
  }

  bindQueries(pool)

  const callback = () => {}

  const values = [1, 'sections.%']
  const promise = pool.query(cleanup, values, callback)

  assert.equal(await promise, 'ok')

  assert.deepEqual(calls[0], [rewrittenCleanup, [1, 'sections.'], callback])
  assert.deepEqual(values, [1, 'sections.%'])
})

test('does not change a parameter used in another expression', () => {
  const query = `DELETE FROM "posts_rels" WHERE "posts_rels"."path" LIKE $1 ESCAPE '\\' OR "posts_rels"."path" = $1`

  assert.throws(() => rewriteDeleteLike(query, ['sections.%']), /shared LIKE parameter/)
})
