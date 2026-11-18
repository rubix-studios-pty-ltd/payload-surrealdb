import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConfig, getPayload, handleEndpoints } from 'payload'
import { surrealdbAdapter } from '@rubixstudios/payload-surrealdb'

import { migrateInitial, setupDatabase } from './database.mjs'

const hookFailure = new Error('intentional afterChange failure')

test('Payload operations on SurrealDB', { timeout: 90_000 }, async (t) => {
  const { connectionString, migrationDir, namespace, query } = await setupDatabase(t)

  const config = buildConfig({
    db: surrealdbAdapter({
      pool: connectionString,
      migrationDir,
      push: false,
    }),
    secret: 'local-validation-only',
    telemetry: false,
    localization: {
      defaultLocale: 'en',
      locales: ['en', 'fr'],
    },
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [],
      },
      {
        slug: 'authors',
        fields: [
          {
            name: 'name',
            type: 'text',
            required: true,
          },
          {
            name: 'posts',
            type: 'join',
            collection: 'posts',
            on: 'author',
          },
        ],
      },
      {
        slug: 'topics',
        fields: [
          {
            name: 'label',
            type: 'text',
            required: true,
          },
        ],
      },
      {
        slug: 'posts',
        hooks: {
          afterChange: [
            async ({ context, doc, req }) => {
              if (!context.rollbackProbe) {
                return
              }

              await req.payload.create({
                collection: 'authors',
                data: {
                  name: doc.title,
                },
                overrideAccess: true,
                req,
              })

              const versions = await req.payload.findVersions({
                collection: 'posts',
                overrideAccess: true,
                req,
                where: {
                  parent: {
                    equals: doc.id,
                  },
                  'version.title': {
                    equals: doc.title,
                  },
                },
              })

              assert.equal(versions.totalDocs, 1)

              throw hookFailure
            },
          ],
        },
        versions: { drafts: true },
        fields: [
          {
            name: 'title',
            type: 'text',
            required: true,
          },
          {
            name: 'summary',
            type: 'text',
            localized: true,
          },
          {
            name: 'author',
            type: 'relationship',
            relationTo: 'authors',
          },
          {
            name: 'related',
            type: 'relationship',
            relationTo: ['authors', 'topics'],
            hasMany: true,
          },
        ],
      },
    ],
    globals: [
      {
        slug: 'settings',
        versions: {
          drafts: true,
        },
        fields: [
          {
            name: 'title',
            type: 'text',
          },
        ],
      },
    ],
  })

  const payload = await getPayload({ config, key: namespace })

  t.after(() => payload.destroy())

  await migrateInitial(payload)

  function request(path, options = {}) {
    const { method = 'GET', data, token } = options

    return handleEndpoints({
      config,
      payloadInstanceCacheKey: namespace,
      request: new Request(`http://localhost/api/${path}`, {
        method,
        ...(data && { body: JSON.stringify(data) }),
        headers: {
          ...(data && { 'content-type': 'application/json' }),
          ...(token && { authorization: `JWT ${token}` }),
        },
      }),
    })
  }

  const credentials = {
    email: 'editor@example.invalid',
    password: 'local-test-password',
  }

  const editor = await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: credentials,
  })

  const otherEditor = await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: {
      ...credentials,
      email: 'other@example.invalid',
    },
  })

  await t.test(
    'authenticated REST writes are visible through REST and native SurrealQL',
    async () => {
      const rejected = await request('posts', {
        method: 'POST',
        data: {
          title: 'Unauthorised',
        },
      })

      assert.equal(rejected.status, 403)

      const login = await request('users/login', {
        method: 'POST',
        data: credentials,
      })

      const { token, user } = await login.json()

      assert.equal(login.status, 200)
      assert.equal(user.id, editor.id)
      assert.ok(token)

      const create = await request('posts', {
        method: 'POST',
        token,
        data: {
          title: 'REST post',
        },
      })

      const body = await create.json()

      assert.equal(create.status, 201, JSON.stringify(body))

      const { id } = body.doc

      const read = await request(`posts/${id}?depth=0`, { token })

      assert.equal(read.status, 200)
      assert.equal((await read.json()).title, 'REST post')

      const rows = await query(
        `USE NS ${namespace} DB cms; SELECT title FROM posts WHERE title = 'REST post';`
      )

      assert.deepEqual(rows, [{ title: 'REST post' }])
    }
  )

  await t.test('list and detail lock status use the right collection and owner', async () => {
    const collection = 'posts'
    const slug = 'payload-locked-documents'

    const owner = {
      ...editor,
      collection: 'users',
    }

    const locked = await payload.create({
      overrideAccess: true,
      collection,
      data: {
        title: 'Locked post',
      },
    })

    const unlocked = await payload.create({
      overrideAccess: true,
      collection,
      data: {
        title: 'Unlocked post',
      },
    })

    const otherLock = await payload.create({
      overrideAccess: true,
      collection: slug,
      data: {
        globalSlug: 'settings',
        user: {
          relationTo: 'users',
          value: otherEditor.id,
        },
      },
    })

    await payload.create({
      overrideAccess: true,
      collection: slug,
      data: {
        document: {
          relationTo: collection,
          value: locked.id,
        },
        user: {
          relationTo: 'users',
          value: owner.id,
        },
      },
    })

    const { docs } = await payload.find({
      overrideAccess: true,
      collection,
      includeLockStatus: true,
      user: otherEditor,
      depth: 0,
      sort: 'id',
      where: {
        id: {
          in: [locked.id, unlocked.id],
        },
      },
    })

    assert.deepEqual(
      docs.map(({ id, _isLocked }) => [id, _isLocked]),
      [
        [locked.id, true],
        [unlocked.id, false],
      ]
    )

    const detail = await payload.findByID({
      overrideAccess: true,
      collection,
      id: locked.id,
      includeLockStatus: true,
      user: otherEditor,
    })

    assert.equal(detail._isLocked, true)
    assert.equal(detail._userEditing.id, owner.id)

    const edit = {
      collection,
      id: locked.id,
      data: {
        title: 'Edited post',
      },
      overrideLock: false,
    }

    await assert.rejects(
      payload.update({
        overrideAccess: true,
        ...edit,
        user: otherEditor,
      }),
      /currently locked/
    )

    const updated = await payload.update({
      overrideAccess: true,
      ...edit,
      user: owner,
    })

    assert.equal(updated.title, 'Edited post')

    const remaining = await payload.find({
      overrideAccess: true,
      collection: slug,
      depth: 0,
    })

    assert.deepEqual(
      remaining.docs.map(({ id }) => id),
      [otherLock.id]
    )
  })

  await t.test('document lock reads see locks committed after a transaction snapshot', async () => {
    const collection = 'payload-locked-documents'

    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Snapshot lock probe',
      },
      overrideAccess: true,
    })
    const where = {
      and: [
        {
          'document.relationTo': {
            equals: 'posts',
          },
        },
        {
          'document.value': {
            equals: post.id,
          },
        },
      ],
    }
    const transactionID = await payload.db.beginTransaction()

    assert.ok(transactionID)

    const req = { transactionID: Promise.resolve(transactionID) }

    const args = {
      collection,
      req,
      where,
      pagination: false,
      limit: 1,
    }

    let lock

    try {
      assert.equal((await payload.db.find(args)).docs.length, 0)

      lock = await payload.create({
        collection,
        data: {
          document: {
            relationTo: 'posts',
            value: post.id,
          },
          user: {
            relationTo: 'users',
            value: editor.id,
          },
        },
        overrideAccess: true,
      })

      assert.equal((await payload.db.find(args)).docs.length, 0)

      const result = await payload.db.findDocumentLocks(args)

      assert.deepEqual(
        result.docs.map(({ id }) => id),
        [lock.id]
      )

      assert.deepEqual(result.docs[0].user, {
        relationTo: 'users',
        value: editor.id,
      })

      assert.equal(await req.transactionID, transactionID)

      assert.ok(payload.db.sessions[transactionID])
    } finally {
      await payload.db.rollbackTransaction(transactionID)
      if (lock) {
        await payload.delete({ collection, id: lock.id, overrideAccess: true })
      }
    }
  })

  await t.test('Payload transactions isolate writes and support rollback and commit', async () => {
    const collection = 'authors'

    for (const commit of [false, true]) {
      const transactionID = await payload.db.beginTransaction()

      assert.ok(transactionID)

      try {
        const req = { transactionID }

        const author = await payload.create({
          overrideAccess: true,
          collection,
          data: {
            name: commit ? 'Committed author' : 'Rolled back author',
          },
          req,
        })

        const where = {
          id: {
            equals: author.id,
          },
        }

        assert.equal(
          (
            await payload.count({
              overrideAccess: true,
              collection,
              where,
              req,
            })
          ).totalDocs,
          1
        )
        assert.equal(
          (
            await payload.count({
              overrideAccess: true,
              collection,
              where,
            })
          ).totalDocs,
          0
        )

        if (commit) {
          await payload.db.commitTransaction(transactionID)
        } else {
          await payload.db.rollbackTransaction(transactionID)
        }

        assert.equal(
          (
            await payload.count({
              overrideAccess: true,
              collection,
              where,
            })
          ).totalDocs,
          Number(commit)
        )
      } finally {
        await payload.db.rollbackTransaction(transactionID)
      }
    }
  })

  await t.test('Payload reports a failed commit and rolls back the write', async (t) => {
    const transactionID = await payload.db.beginTransaction()

    assert.ok(transactionID)

    try {
      const collection = 'authors'

      const author = await payload.create({
        overrideAccess: true,
        collection,
        data: {
          name: 'Uncommitted author',
        },
        req: {
          transactionID,
        },
      })

      const { db } = payload.db.sessions[transactionID]

      const execute = db.execute.bind(db)

      const failure = new Error('intentional commit failure')

      t.mock.method(db, 'execute', (query) => {
        if (db.dialect.sqlToQuery(query).sql === 'commit') {
          throw failure
        }

        return execute(query)
      })

      await assert.rejects(
        payload.db.commitTransaction(transactionID),
        (error) => error === failure
      )

      assert.equal(payload.db.sessions[transactionID], undefined)

      const result = await payload.count({
        overrideAccess: true,
        collection,
        where: {
          id: {
            equals: author.id,
          },
        },
      })

      assert.equal(result.totalDocs, 0)
    } finally {
      await payload.db.rollbackTransaction(transactionID)
    }
  })

  await t.test('a failed hook rolls back the document, related write and version', async () => {
    const local = {
      collection: 'posts',
      overrideAccess: true,
    }

    const post = await payload.create({
      ...local,
      data: {
        title: 'Original title',
      },
    })

    const where = {
      parent: {
        equals: post.id,
      },
    }

    const before = await payload.findVersions({
      ...local,
      where,
    })

    assert.equal(before.totalDocs, 1)

    for (const draft of [false, true]) {
      const title = draft ? 'Aborted draft' : 'Aborted publication'

      await assert.rejects(
        payload.update({
          ...local,
          id: post.id,
          context: {
            rollbackProbe: true,
          },
          data: {
            title,
          },
          draft,
        }),
        (error) => error === hookFailure
      )

      const current = await payload.findByID({
        ...local,
        id: post.id,
        draft,
      })

      assert.equal(current.title, post.title)

      const related = await payload.count({
        collection: 'authors',
        overrideAccess: true,
        where: {
          name: {
            equals: title,
          },
        },
      })

      assert.equal(related.totalDocs, 0)

      const history = await payload.findVersions({
        ...local,
        where,
      })

      assert.deepEqual(
        history.docs.map(({ id }) => id),
        before.docs.map(({ id }) => id)
      )

      assert.equal(Object.keys(payload.db.sessions).length, 0)
    }
  })

  await t.test(
    'populates polymorphic relationships and resolves reverse join pagination',
    async () => {
      const author = await payload.create({
        overrideAccess: true,
        collection: 'authors',
        data: {
          name: 'Writer',
        },
      })

      const topic = await payload.create({
        overrideAccess: true,
        collection: 'topics',
        data: {
          label: 'News',
        },
      })

      const related = [
        {
          relationTo: 'topics',
          value: topic.id,
        },
        {
          relationTo: 'authors',
          value: author.id,
        },
      ]

      const post = await payload.create({
        overrideAccess: true,
        collection: 'posts',
        data: {
          title: 'Alpha post',
          author: author.id,
          related,
        },
      })

      const second = await payload.create({
        overrideAccess: true,
        collection: 'posts',
        data: {
          title: 'Beta post',
          author: author.id,
        },
      })

      const found = await payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 1,
        where: {
          related: {
            equals: {
              relationTo: 'authors',
              value: author.id,
            },
          },
        },
      })

      assert.equal(found.totalDocs, 1)
      assert.equal(found.docs[0].id, post.id)

      assert.deepEqual(
        found.docs[0].related.map(({ relationTo, value }) => ({ relationTo, value: value.id })),
        related
      )

      for (const [page, id] of [
        [1, post.id],
        [2, second.id],
      ]) {
        const joined = await payload.findByID({
          overrideAccess: true,
          collection: 'authors',
          id: author.id,
          depth: 0,
          joins: {
            posts: {
              count: true,
              limit: 1,
              page,
              sort: 'title',
            },
          },
        })

        assert.deepEqual(joined.posts.docs, [id])

        assert.equal(joined.posts.totalDocs, 2)
        assert.equal(joined.posts.hasNextPage, page === 1)
      }
    }
  )

  await t.test(
    'localized drafts and global versions keep published and draft values separate',
    async () => {
      const collection = 'posts'
      const slug = 'settings'

      const post = await payload.create({
        overrideAccess: true,
        collection,
        locale: 'en',
        data: {
          title: 'Versioned post',
          summary: 'Published',
        },
      })

      await payload.update({
        overrideAccess: true,
        collection,
        id: post.id,
        locale: 'fr',
        data: {
          summary: 'Publié',
        },
      })

      for (const summary of ['Premier brouillon', 'Dernier brouillon']) {
        await payload.update({
          overrideAccess: true,
          collection,
          id: post.id,
          locale: 'fr',
          data: {
            summary,
          },
          draft: true,
        })
      }

      assert.equal(
        (
          await payload.findByID({
            overrideAccess: true,
            collection,
            id: post.id,
            locale: 'fr',
          })
        ).summary,
        'Publié'
      )

      const drafts = await payload.find({
        overrideAccess: true,
        collection,
        locale: 'fr',
        draft: true,
        where: {
          summary: {
            equals: 'Dernier brouillon',
          },
        },
      })

      assert.deepEqual(
        drafts.docs.map(({ id }) => id),
        [post.id]
      )

      const versions = await payload.findVersions({
        overrideAccess: true,
        collection,
        locale: 'fr',
        where: {
          parent: {
            equals: post.id,
          },
        },
      })

      assert.equal(versions.totalDocs, 4)
      assert.equal(versions.docs[0].version.summary, 'Dernier brouillon')

      await payload.updateGlobal({
        overrideAccess: true,
        slug,
        data: {
          title: 'Published settings',
        },
      })

      await payload.updateGlobal({
        overrideAccess: true,
        slug,
        data: {
          title: 'Draft settings',
        },
        draft: true,
      })

      assert.equal(
        (
          await payload.findGlobal({
            overrideAccess: true,
            slug,
          })
        ).title,
        'Published settings'
      )
      assert.equal(
        (
          await payload.findGlobal({
            overrideAccess: true,
            slug,
            draft: true,
          })
        ).title,
        'Draft settings'
      )

      const history = await payload.findGlobalVersions({
        overrideAccess: true,
        slug,
      })

      assert.equal(history.totalDocs, 2)
      assert.equal(history.docs[0].version.title, 'Draft settings')
    }
  )
})
