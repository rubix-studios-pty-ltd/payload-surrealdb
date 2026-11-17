import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as payloadAPI from 'payload'
import { configToSchema } from '@payloadcms/graphql'
import { surrealdbAdapter } from '@rubixstudios/payload-surrealdb'
import { graphql } from 'graphql'

import { migrateInitial, setupDatabase } from './database.mjs'

const { buildConfig, getPayload } = payloadAPI
const createWebRequest =
  payloadAPI.createPayloadRequestFromWebRequest ?? payloadAPI.createPayloadRequest

test('Payload GraphQL and trash on SurrealDB', { timeout: 90_000 }, async (t) => {
  const { connectionString, migrationDir, namespace } = await setupDatabase(t)

  const config = buildConfig({
    db: surrealdbAdapter({
      pool: connectionString,
      migrationDir,
      push: false,
    }),
    secret: 'local-validation-only',
    telemetry: false,
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [],
      },
      {
        slug: 'authors',
        access: {
          read: () => true,
        },
        fields: [
          {
            name: 'name',
            type: 'text',
            required: true,
          },
        ],
      },
      {
        slug: 'articles',
        access: {
          create: ({ req }) => Boolean(req.user),
          read: ({ req }) =>
            req.user
              ? true
              : {
                  public: {
                    equals: true,
                  },
                },
        },
        trash: true,
        versions: {
          drafts: true,
        },
        fields: [
          {
            name: 'title',
            type: 'text',
            required: true,
          },
          {
            name: 'public',
            type: 'checkbox',
            defaultValue: false,
          },
          {
            name: 'author',
            type: 'relationship',
            relationTo: 'authors',
          },
        ],
      },
    ],
  })

  const payload = await getPayload({ config, key: namespace })

  t.after(() => payload.destroy())

  await migrateInitial(payload)

  const { schema } = configToSchema(payload.config)

  const articles = {
    collection: 'articles',
    overrideAccess: true,
  }

  const credentials = {
    email: 'graphql@example.invalid',
    password: 'local-test-password',
  }

  await payload.create({
    collection: 'users',
    data: credentials,
    overrideAccess: true,
  })

  const { token } = await payload.login({
    collection: 'users',
    data: credentials,
  })

  assert.ok(token)

  async function execute(source, variableValues, authenticated = false) {
    const req = await createWebRequest({
      config,
      payloadInstanceCacheKey: namespace,
      request: new Request('http://localhost/api/graphql', {
        method: 'POST',
        headers: authenticated ? { authorization: `JWT ${token}` } : {},
      }),
    })

    req.payloadAPI = 'GraphQL'

    return graphql({
      contextValue: {
        req,
      },
      schema,
      source,
      variableValues,
    })
  }

  function resultData(result) {
    assert.equal(result.errors, undefined, result.errors?.map(({ message }) => message).join('\n'))

    return result.data
  }

  await t.test(
    'GraphQL uses collection access, mutations and paginated relationship reads',
    async () => {
      const author = await payload.create({
        collection: 'authors',
        data: {
          name: 'GraphQL writer',
        },
        overrideAccess: true,
      })

      const create = `
      mutation CreateArticle($title: String!, $author: Int!) {
        createArticle(data: { title: $title, public: true, author: $author }) {
          id
          title
        }
      }
    `
      const variables = {
        title: 'First article',
        author: author.id,
      }

      const denied = await execute(create, variables)

      assert.equal(denied.errors?.length, 1)
      assert.equal(denied.errors[0].originalError.status, 403)

      const { createArticle } = resultData(await execute(create, variables, true))

      assert.equal(createArticle.title, variables.title)

      await payload.create({
        ...articles,
        data: {
          title: 'Second article',
          public: true,
          author: author.id,
        },
      })

      await payload.create({
        ...articles,
        data: {
          title: 'Private article',
          author: author.id,
        },
      })

      const read = `
      query {
        Articles(where: { title: { contains: "article" } }, sort: "title", limit: 1, page: 2, select: true) {
          docs {
            title
            author { id name }
          }
          totalDocs
          totalPages
          hasNextPage
        }
      }
    `
      const { Articles: page } = resultData(await execute(read))

      assert.equal(page.totalDocs, 2)
      assert.equal(page.totalPages, 2)
      assert.equal(page.hasNextPage, false)

      assert.equal(page.docs[0].title, 'Second article')
      assert.equal(page.docs[0].author.id, author.id)
      assert.equal(page.docs[0].author.name, 'GraphQL writer')

      const update = `
      mutation UpdateArticle($id: Int!, $title: String!) {
        updateArticle(id: $id, data: { title: $title }) { id title }
      }
    `
      const title = 'Updated in GraphQL'

      const { updateArticle } = resultData(
        await execute(update, { id: createArticle.id, title }, true)
      )

      assert.equal(updateArticle.id, createArticle.id)
      assert.equal(updateArticle.title, title)
      assert.equal(
        (
          await payload.findByID({
            ...articles,
            id: createArticle.id,
          })
        ).title,
        title
      )

      const remove = `
        mutation DeleteArticle($id: Int!) {
          deleteArticle(id: $id) { id }
        }
      `

      const { deleteArticle } = resultData(
        await execute(
          remove,
          {
            id: createArticle.id,
          },
          true
        )
      )

      assert.equal(deleteArticle.id, createArticle.id)

      await assert.rejects(
        payload.findByID({
          ...articles,
          id: createArticle.id,
        }),
        { status: 404 }
      )
    }
  )

  await t.test(
    'trash excludes documents by default, restores them, and supports permanent deletion',
    async () => {
      const title = 'Trash lifecycle'

      const { id } = await payload.create({
        ...articles,
        data: {
          title,
          public: true,
        },
      })

      const where = {
        id: {
          equals: id,
        },
      }

      const deletedAt = new Date().toISOString()

      async function moveToTrash() {
        return payload.update({
          ...articles,
          id,
          data: {
            deletedAt,
          },
        })
      }

      assert.equal((await moveToTrash()).deletedAt, deletedAt)

      assert.equal(
        (
          await payload.find({
            ...articles,
            where,
          })
        ).totalDocs,
        0
      )

      assert.equal(
        (
          await payload.count({
            ...articles,
            where,
          })
        ).totalDocs,
        0
      )

      await assert.rejects(
        payload.findByID({
          ...articles,
          id,
        }),
        { status: 404 }
      )

      const trashed = {
        ...articles,
        trash: true,
      }

      const onlyTrashed = {
        and: [
          where,
          {
            deletedAt: {
              exists: true,
            },
          },
        ],
      }

      assert.equal(
        (
          await payload.find({
            ...trashed,
            where: onlyTrashed,
          })
        ).docs[0].id,
        id
      )

      assert.equal(
        (
          await payload.count({
            ...trashed,
            where: onlyTrashed,
          })
        ).totalDocs,
        1
      )

      const list = `
      query TrashedArticles($id: Int!) {
        hidden: Articles(where: { id: { equals: $id } }) { totalDocs }
        visible: Articles(trash: true, where: { id: { equals: $id } }) {
          docs { title deletedAt }
        }
      }
    `
      const { hidden, visible } = resultData(await execute(list, { id }))

      assert.equal(hidden.totalDocs, 0)
      assert.equal(visible.docs[0].title, title)

      assert.equal(new Date(visible.docs[0].deletedAt).toISOString(), deletedAt)

      const restored = await payload.update({
        ...trashed,
        id,
        data: {
          deletedAt: null,
        },
      })

      assert.equal(restored.deletedAt, null)

      assert.equal(
        (
          await payload.findByID({
            ...articles,
            id,
          })
        ).title,
        title
      )

      await moveToTrash()

      const history = {
        ...trashed,
        where: {
          parent: {
            equals: id,
          },
        },
      }

      assert.ok((await payload.findVersions(history)).totalDocs > 0)

      await payload.delete({
        ...trashed,
        id,
      })

      assert.equal(
        (
          await payload.count({
            ...trashed,
            where,
          })
        ).totalDocs,
        0
      )

      assert.equal((await payload.findVersions(history)).totalDocs, 0)
    }
  )
})
