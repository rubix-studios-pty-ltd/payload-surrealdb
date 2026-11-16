import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildConfig, getPayload } from 'payload'
import { sql, surrealdbAdapter } from '@rubixstudios/payload-surrealdb'
import { relations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { bigint, pgTable } from 'drizzle-orm/pg-core'

import { bindRelations } from '../dist/relations.js'

class MigrationTestSocket extends WebSocket {
  send(data) {
    if (typeof data === 'string') {
      const request = JSON.parse(data)

      if (
        request.method === 'query' &&
        request.txn &&
        request.params[0].includes('partial_drop_index')
      ) {
        request.params[0] += " THROW 'forced SurrealQL failure';"
        return super.send(JSON.stringify(request))
      }
    }

    return super.send(data)
  }
}

test('Payload connects, migrates, reads, writes and removes a collection on SurrealDB', {
  timeout: 60000,
}, async (t) => {
  const endpoint = process.env.SURREAL_TEST_ENDPOINT
  const password = process.env.SURREAL_TEST_PASSWORD

  assert.ok(endpoint && password, 'Set SURREAL_TEST_ENDPOINT and SURREAL_TEST_PASSWORD')

  const namespace = `payload_test_${randomUUID().replaceAll('-', '')}`
  const server = new URL(endpoint)
  const authorization = `Basic ${Buffer.from(`root:${password}`).toString('base64')}`
  const migrationDir = await mkdtemp(fileURLToPath(new URL('./.migrations-', import.meta.url)))

  t.after(() => rm(migrationDir, { recursive: true, force: true }))

  async function query(body) {
    const response = await fetch(new URL('/sql', server), {
      method: 'POST',
      headers: { accept: 'application/json', authorization },
      body,
      signal: AbortSignal.timeout(5000),
    })

    assert.ok(response.ok, `SurrealDB SQL endpoint returned HTTP ${response.status}`)

    const statements = await response.json()
    assert.ok(Array.isArray(statements) && statements.length)
    for (const statement of statements) {
      assert.equal(statement.status, 'OK', JSON.stringify(statement.result))
    }

    return statements.at(-1).result
  }

  await query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE cms;`)
  t.after(() => query(`REMOVE NAMESPACE IF EXISTS ${namespace};`))

  const connection = new URL('surrealdb+ws://localhost')
  const scheme = server.protocol === 'https:' ? 'surrealdb+wss:' : 'surrealdb+ws:'
  connection.hostname = server.hostname
  connection.port = server.port
  connection.username = 'root'
  connection.password = password
  connection.pathname = `/${namespace}/cms`
  const connectionString = connection.href.replace(/^surrealdb\+ws:/, scheme)

  const payload = await getPayload({
    config: await makeConfig({
      connectionString,
      migrationDir,
      withTags: true,
      WebSocket: MigrationTestSocket,
    }),
    key: namespace,
  })

  let updated
  t.after(async () => {
    await updated?.destroy()
    await payload.destroy()
  })

  let author
  let tag
  let post

  await t.test('concurrent connection calls share the existing pool', async () => {
    const pool = payload.db.pool
    const connecting = payload.db.connect({ hotReload: true })

    assert.equal(payload.db.connect({ hotReload: true }), connecting)

    await connecting

    assert.equal(payload.db.pool, pool)
  })

  await t.test('initial migration generates, applies and records history once', async () => {
    await payload.db.createMigration({ payload, migrationName: 'initial' })
    assert.ok((await readdir(migrationDir)).some((file) => file.endsWith('_initial.ts')))

    await payload.db.migrate()
    await payload.db.migrate()

    assert.equal(await count(payload, 'payload-migrations'), 1)
  })

  await t.test(
    'migrate:refresh rolls down and reapplies the generated initial migration',
    async () => {
      await payload.db.migrateRefresh()

      assert.equal(await count(payload, 'payload-migrations'), 1)
      assert.equal(await count(payload, 'posts'), 0)
    }
  )

  await t.test('CRUD, ordered relationship population, pagination and global reads', async () => {
    author = await payload.create({
      collection: 'authors',
      data: { name: 'Rubix' },
      overrideAccess: true,
    })
    tag = await payload.create({
      collection: 'dub-tags',
      data: { label: 'News', color: 'blue' },
      overrideAccess: true,
    })
    post = await payload.create({
      collection: 'posts',
      data: {
        title: 'First post',
        author: author.id,
        tags: [tag.id],
        sections: [{ heading: 'First' }, { heading: 'Second' }],
      },
      overrideAccess: true,
    })

    const edited = await payload.update({
      collection: 'posts',
      id: post.id,
      data: { title: 'Revised post' },
      overrideAccess: true,
    })
    assert.equal(edited.title, 'Revised post')

    const result = await payload.find({
      collection: 'posts',
      where: { title: { equals: 'Revised post' } },
      select: { title: true, author: true, sections: true },
      depth: 1,
      limit: 1,
      page: 1,
      overrideAccess: true,
    })
    assert.equal(result.totalDocs, 1)
    assert.equal(result.docs[0].author.id, author.id)
    assert.deepEqual(
      result.docs[0].sections.map(({ heading }) => heading),
      ['First', 'Second']
    )

    await payload.updateGlobal({ slug: 'settings', data: { title: 'Site' }, overrideAccess: true })
    assert.equal(
      (await payload.findGlobal({ slug: 'settings', overrideAccess: true })).title,
      'Site'
    )

    const draft = await payload.create({
      collection: 'posts',
      data: { title: 'Draft' },
      draft: true,
      overrideAccess: true,
    })
    const loaded = await payload.findByID({
      collection: 'posts',
      id: draft.id,
      draft: true,
      overrideAccess: true,
    })
    assert.equal(loaded._status, 'draft')
    await payload.delete({ collection: 'posts', id: draft.id, overrideAccess: true })
  })

  await t.test('login creates a session and a failed SQL transaction rolls back', async () => {
    const data = { email: 'local@example.invalid', password: 'local-test-password' }

    await payload.create({ collection: 'users', data, overrideAccess: true })
    const { token } = await payload.login({ collection: 'users', data })
    assert.ok(token)

    const before = await count(payload, 'authors')
    await assert.rejects(
      payload.db.drizzle.transaction(async (transaction) => {
        await transaction.execute(sql`INSERT INTO "authors" ("name") VALUES ('Roll back')`)
        throw new Error('intentional rollback')
      }),
      /intentional rollback/
    )
    assert.equal(await count(payload, 'authors'), before)
  })

  await t.test(
    'relationship population supports bigint keys without losing precision',
    async () => {
      await payload.db.drizzle.execute(sql`
      CREATE TABLE "bigint_parents" ("id" bigint PRIMARY KEY);
      CREATE TABLE "bigint_children" ("id" bigint PRIMARY KEY, "parent_id" bigint);
      INSERT INTO "bigint_parents" ("id") VALUES (9007199254740993), (9007199254740994);
      INSERT INTO "bigint_children" ("id", "parent_id") VALUES (1, 9007199254740993), (2, 9007199254740994);
    `)

      const parents = pgTable('bigint_parents', {
        id: bigint('id', { mode: 'bigint' }).primaryKey(),
      })
      const children = pgTable('bigint_children', {
        id: bigint('id', { mode: 'bigint' }).primaryKey(),
        parentID: bigint('parent_id', { mode: 'bigint' }),
      })
      const schema = {
        parents,
        children,
        parentsRelations: relations(parents, ({ many }) => ({ children: many(children) })),
        childrenRelations: relations(children, ({ one }) => ({
          parent: one(parents, { fields: [children.parentID], references: [parents.id] }),
        })),
      }
      const db = drizzle({ client: payload.db.pool, schema })

      bindRelations(db, schema)

      const rows = await db.query.parents.findMany({
        orderBy: [parents.id],
        with: { children: { columns: { id: true } } },
      })

      assert.deepEqual(rows, [
        { id: 9007199254740993n, children: [{ id: 1n }] },
        { id: 9007199254740994n, children: [{ id: 2n }] },
      ])

      assert.deepEqual(
        await db.query.parents.findMany({
          orderBy: [parents.id],
          with: { children: { limit: 1, columns: { id: true } } },
        }),
        rows
      )

      const child = await db.query.children.findFirst({
        orderBy: [children.id],
        with: { parent: true },
      })

      assert.deepEqual(child.parent, { id: 9007199254740993n })
    }
  )

  await t.test('a failed migration rolls back destructive SQL and its history', async (t) => {
    const failure = new Error('forced failure after schema removal')
    let removedInTransaction = false

    await payload.db.drizzle.execute(sql`
      CREATE TABLE "rollback_target" ("id" integer PRIMARY KEY, "name" varchar);
      INSERT INTO "rollback_target" ("id", "name") VALUES (1, 'keep this row');
    `)

    t.mock.method(process, 'exit', (code) => {
      assert.equal(code, 1)
      throw failure
    })

    await assert.rejects(
      payload.db.migrate({
        migrations: [
          {
            name: 'failed_removal',
            down: async () => {},
            up: async ({ db }) => {
              await db.execute(sql`
                ALTER TABLE "rollback_target" DISABLE ROW LEVEL SECURITY;
                DROP TABLE "rollback_target" CASCADE;
              `)
              const { rows } = await db.execute(sql`
                SELECT table_name FROM information_schema.tables
                WHERE table_name = 'rollback_target'
              `)

              removedInTransaction = rows.length === 0
              throw failure
            },
          },
        ],
      }),
      /forced failure after schema removal/
    )

    assert.equal(removedInTransaction, true)
    assert.deepEqual(
      (await payload.db.drizzle.execute(sql`SELECT name FROM "rollback_target"`)).rows,
      [{ name: 'keep this row' }]
    )
    assert.equal(await count(payload, 'payload-migrations'), 1)
  })

  await t.test('a caught SurrealQL error still aborts a partially executed removal', async (t) => {
    let removalError
    let removedInTransaction = false

    await payload.db.drizzle.execute(sql`
      CREATE TABLE "partial_drop" ("id" integer PRIMARY KEY);
      CREATE TABLE "partial_keep" ("id" integer PRIMARY KEY, "name" varchar);
      CREATE INDEX "partial_drop_index" ON "partial_keep" ("name");
    `)

    t.mock.method(process, 'exit', (code) => {
      assert.equal(code, 1)
      throw removalError ?? new Error('Expected a SurrealQL removal error')
    })

    await assert.rejects(
      payload.db.migrate({
        migrations: [
          {
            name: 'caught_removal_error',
            down: async () => {},
            up: async ({ db }) => {
              try {
                await db.execute(sql`
                  ALTER TABLE "partial_drop" DISABLE ROW LEVEL SECURITY;
                  DROP TABLE "partial_drop" CASCADE;
                  DROP INDEX "partial_drop_index";
                  ALTER TABLE "partial_keep" DROP COLUMN "name";
                `)
              } catch (error) {
                removalError = error

                const { rows } = await db.execute(sql`
                  SELECT table_name FROM information_schema.tables
                  WHERE table_name = 'partial_drop'
                `)

                removedInTransaction = rows.length === 0
              }
            },
          },
        ],
      }),
      /forced SurrealQL failure/
    )

    assert.equal(removedInTransaction, true)
    const table = await query(`USE NS ${namespace} DB cms; INFO FOR TABLE partial_keep;`)
    assert.equal(Object.hasOwn(table.indexes, 'partial_drop_index'), true)
    assert.equal(Object.hasOwn(table.fields, 'name'), true)
    assert.equal(await count(payload, 'payload-migrations'), 1)
  })

  await t.test(
    'generated drop migration preserves posts, removes schema and stays idempotent',
    async () => {
      updated = await getPayload({
        config: await makeConfig({ connectionString, migrationDir, withTags: false }),
        key: `${namespace}_updated`,
      })

      await updated.db.createMigration({ payload: updated, migrationName: 'remove_dub' })
      await updated.db.migrate()
      await updated.db.migrate()

      assert.equal(await count(updated, 'payload-migrations'), 2)
      assert.equal(
        (await updated.findByID({ collection: 'posts', id: post.id, overrideAccess: true })).title,
        'Revised post'
      )

      const database = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)
      assert.equal(Object.hasOwn(database.tables, 'dub_tags'), false)

      const table = await query(`USE NS ${namespace} DB cms; INFO FOR TABLE posts_rels;`)
      assert.equal(Object.hasOwn(table.fields, 'dub_tags_id'), false)
      assert.equal(Object.hasOwn(table.indexes, 'posts_rels_dub_tags_id_idx'), false)
    }
  )

  await t.test(
    'migrate:fresh removes retained enum types and reapplies both migrations',
    async () => {
      const emptyDir = await mkdtemp(
        fileURLToPath(new URL('./.migrations-empty-', import.meta.url))
      )
      updated.db.migrationDir = emptyDir

      try {
        await assert.rejects(
          updated.db.migrateFresh({ forceAcceptWarning: true }),
          /requires valid migration files/
        )
        assert.equal(await count(updated, 'posts'), 1)
        assert.equal(await count(updated, 'payload-migrations'), 2)
      } finally {
        updated.db.migrationDir = migrationDir
        await rm(emptyDir, { recursive: true, force: true })
      }

      await updated.db.migrateFresh({ forceAcceptWarning: true })

      assert.equal(await count(updated, 'payload-migrations'), 2)
      assert.equal(await count(updated, 'posts'), 0)

      const database = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)
      assert.equal(Object.hasOwn(database.tables, 'dub_tags'), false)
    }
  )
})

function makeConfig({ connectionString, migrationDir, withTags, WebSocket }) {
  return buildConfig({
    telemetry: false,
    secret: 'local-validation-only',
    db: surrealdbAdapter({
      pool: WebSocket ? { connectionString, timeout: 0, WebSocket } : connectionString,
      migrationDir,
    }),
    collections: [
      { slug: 'users', auth: true, fields: [] },
      { slug: 'authors', fields: [{ name: 'name', type: 'text', required: true }] },
      ...(withTags
        ? [
            {
              slug: 'dub-tags',
              versions: true,
              fields: [
                { name: 'label', type: 'text' },
                { name: 'color', type: 'select', options: ['blue', 'green'] },
              ],
            },
          ]
        : []),
      {
        slug: 'posts',
        versions: { drafts: true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          ...(withTags
            ? [{ name: 'tags', type: 'relationship', relationTo: 'dub-tags', hasMany: true }]
            : []),
          { name: 'sections', type: 'array', fields: [{ name: 'heading', type: 'text' }] },
        ],
      },
    ],
    globals: [{ slug: 'settings', fields: [{ name: 'title', type: 'text' }] }],
  })
}

async function count(payload, collection) {
  const result = await payload.count({ collection, overrideAccess: true })

  return result.totalDocs
}
