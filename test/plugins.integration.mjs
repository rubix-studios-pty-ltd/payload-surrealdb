import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConfig, getPayload } from 'payload'
import { nestedDocsPlugin } from '@payloadcms/plugin-nested-docs'
import { redirectsPlugin } from '@payloadcms/plugin-redirects'
import { searchPlugin } from '@payloadcms/plugin-search'
import { surrealdbAdapter } from '@rubixstudios/payload-surrealdb'

import { migrateInitial, setupDatabase } from './database.mjs'

test('official Payload plugins on SurrealDB', { timeout: 90_000 }, async (t) => {
  const { connectionString, migrationDir, namespace } = await setupDatabase(t)

  const config = buildConfig({
    db: surrealdbAdapter({ pool: connectionString, migrationDir, push: false }),
    secret: 'local-validation-only',
    telemetry: false,
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [],
      },
      {
        slug: 'pages',
        fields: [
          {
            name: 'title',
            type: 'text',
            required: true,
          },
          {
            name: 'slug',
            type: 'text',
            required: true,
          },
        ],
      },
      {
        slug: 'articles',
        fields: [
          {
            name: 'title',
            type: 'text',
            required: true,
          },
        ],
      },
    ],
    plugins: [
      nestedDocsPlugin({
        collections: ['pages'],
        generateLabel: (_, doc) => doc.title,
        generateURL: (docs) => `/${docs.map(({ slug }) => slug).join('/')}`,
      }),
      redirectsPlugin({
        collections: ['pages', 'articles'],
        redirectTypes: ['301', '302'],
      }),
      searchPlugin({
        collections: ['articles'],
      }),
    ],
  })

  const payload = await getPayload({ config, key: namespace })

  t.after(() => payload.destroy())

  await migrateInitial(payload)

  const user = await payload.create({
    collection: 'users',
    data: {
      email: 'plugins@example.invalid',
      password: 'local-test-password',
    },
    overrideAccess: true,
  })

  const local = {
    overrideAccess: true,
    user,
  }

  const pages = {
    ...local,
    collection: 'pages',
  }

  const articles = {
    ...local,
    collection: 'articles',
  }

  await t.test(
    'Nested Docs persists breadcrumbs and updates descendants when a parent moves',
    async () => {
      const section = await payload.create({
        ...pages,
        data: {
          title: 'Support',
          slug: 'support',
        },
      })

      const child = await payload.create({
        ...pages,
        data: {
          title: 'Setup',
          slug: 'setup',
          parent: section.id,
        },
      })

      const destination = await payload.create({
        ...pages,
        data: {
          title: 'Services',
          slug: 'services',
        },
      })

      const path = (doc) => doc.breadcrumbs.map(({ label, url }) => ({ label, url }))

      assert.deepEqual(path(child), [
        { label: 'Support', url: '/support' },
        { label: 'Setup', url: '/support/setup' },
      ])

      await payload.update({
        ...pages,
        id: section.id,
        data: {
          parent: destination.id,
        },
      })

      const moved = await payload.findByID({
        ...pages,
        id: child.id,
        depth: 0,
      })

      assert.equal(moved.parent, section.id)
      assert.deepEqual(path(moved), [
        { label: 'Services', url: '/services' },
        { label: 'Support', url: '/services/support' },
        { label: 'Setup', url: '/services/support/setup' },
      ])
    }
  )

  await t.test(
    'Redirects persists internal and custom destinations and enforces unique source paths',
    async () => {
      const redirects = {
        ...local,
        collection: 'redirects',
      }

      const page = await payload.create({
        ...pages,
        data: {
          title: 'Landing',
          slug: 'landing',
        },
      })

      const data = {
        from: '/old-landing',
        type: '301',
        to: {
          type: 'reference',
          reference: {
            relationTo: 'pages',
            value: page.id,
          },
        },
      }

      const internal = await payload.create({
        ...redirects,
        data,
      })

      const custom = await payload.create({
        ...redirects,
        data: {
          from: '/old-contact',
          type: '302',
          to: {
            type: 'custom',
            url: '/contact',
          },
        },
      })

      const loaded = await payload.findByID({
        ...redirects,
        id: internal.id,
        depth: 1,
      })

      assert.equal(loaded.type, '301')
      assert.equal(loaded.to.reference.relationTo, 'pages')
      assert.equal(loaded.to.reference.value.id, page.id)

      const { docs } = await payload.find({
        ...redirects,
        where: {
          from: {
            equals: custom.from,
          },
        },
      })

      assert.equal(docs.length, 1)
      assert.equal(docs[0].type, '302')
      assert.equal(docs[0].to.url, '/contact')

      await assert.rejects(
        payload.create({
          ...redirects,
          data,
        }),
        { status: 400 }
      )
    }
  )

  await t.test(
    'Search synchronizes a related index record through create, update, and delete',
    async () => {
      const article = await payload.create({
        ...articles,
        data: {
          title: 'Initial search title',
        },
      })

      const search = {
        ...local,
        collection: 'search',
        depth: 0,
        where: {
          doc: {
            equals: {
              relationTo: 'articles',
              value: article.id,
            },
          },
        },
      }

      const created = await payload.find(search)

      assert.equal(created.totalDocs, 1)
      assert.equal(created.docs[0].title, article.title)
      assert.equal(created.docs[0].doc.relationTo, 'articles')
      assert.equal(created.docs[0].doc.value, article.id)

      const title = 'Updated search title'

      await payload.update({
        ...articles,
        id: article.id,
        data: {
          title,
        },
      })

      const updated = await payload.find(search)

      assert.equal(updated.totalDocs, 1)
      assert.equal(updated.docs[0].id, created.docs[0].id)
      assert.equal(updated.docs[0].title, title)

      await payload.delete({
        ...articles,
        id: article.id,
      })

      const removed = await payload.count({
        collection: 'search',
        overrideAccess: true,
        user,
        where: {
          id: {
            equals: created.docs[0].id,
          },
        },
      })

      assert.equal(removed.totalDocs, 0)
    }
  )
})
