import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bindLocks } from '../dist/locks.js'

const collection = 'payload-locked-documents'

function createAdapter() {
  const adapter = {
    find: (args) => args,
    deleteMany: (args) => args,
    payload: {
      collections: {
        posts: { config: {} },
        authors: { config: { lockDocuments: false } },
      },
    },
  }

  bindLocks(adapter)

  return adapter
}

test('lock filters target one relationship column for multiple document IDs', () => {
  const adapter = createAdapter()
  const updatedAt = { updatedAt: { greater_than: new Date() } }
  const where = {
    and: [
      { 'document.relationTo': { equals: 'posts' } },
      { 'document.value': { in: [0, 42, 42] } },
      updatedAt,
    ],
  }
  const args = { collection, where: { or: [where] } }
  const expected = {
    or: [
      {
        and: [
          updatedAt,
          {
            or: [
              { document: { equals: { relationTo: 'posts', value: 0 } } },
              { document: { equals: { relationTo: 'posts', value: 42 } } },
            ],
          },
        ],
      },
    ],
  }

  for (const operation of [adapter.find, adapter.deleteMany]) {
    assert.deepEqual(operation(args).where, expected)
  }

  assert.deepEqual(where.and[1], { 'document.value': { in: [0, 42, 42] } })
})

test('lock filters preserve unsupported and ambiguous predicates', () => {
  const adapter = createAdapter()
  const posts = { 'document.relationTo': { equals: 'posts' } }
  const authors = { 'document.relationTo': { equals: 'authors' } }

  for (const and of [
    [posts, { 'document.value': { in: [] } }],
    [posts, { 'document.value': { in: [null, 1] } }],
    [posts, { 'document.value': { not_in: [1] } }],
    [posts, authors, { 'document.value': { equals: 1 } }],
    [authors, { 'document.value': { equals: 1 } }],
  ]) {
    assert.deepEqual(adapter.find({ collection, where: { and } }).where, { and })
  }
})
