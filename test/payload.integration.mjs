import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildConfig, getPayload } from 'payload'
import { sql, surrealdbAdapter } from '@rubixstudios/payload-surrealdb'
import { relations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { bigint, pgTable } from 'drizzle-orm/pg-core'

import { bindRelations } from '../dist/relations.js'
import { setupDatabase } from './database.mjs'

class MigrationTestSocket extends WebSocket {
  send(data) {
    if (typeof data === 'string') {
      const request = JSON.parse(data)

      if (
        request.method === 'query' &&
        request.txn &&
        request.params[0].includes('rollback_probe_idx')
      ) {
        request.params[0] += " THROW 'forced SurrealQL failure';"
        return super.send(JSON.stringify(request))
      }
    }

    return super.send(data)
  }
}

test('Payload connects, migrates, reads, writes and removes a collection on SurrealDB', {
  timeout: 120_000,
}, async (t) => {
  const { connectionString, migrationDir, namespace, query } = await setupDatabase(t)

  let base
  let payload

  t.after(async () => {
    await payload?.destroy()
    await base?.destroy()
  })

  let post

  await t.test('startup applies a pending migration only when push is enabled', async () => {
    const options = { connectionString, migrationDir, withTags: false }

    const generator = await getPayload({
      config: await makeConfig({ ...options, push: false }),
      key: `${namespace}_generator`,
    })

    try {
      await generator.db.createMigration({
        payload: generator,
        migrationName: 'initial',
      })
    } finally {
      await generator.destroy()
    }

    const initialFile = (await readdir(migrationDir)).find((file) => file.endsWith('_initial.ts'))

    assert.ok(initialFile, 'Expected a generated initial migration')

    const disabled = await getPayload({
      config: await makeConfig({ ...options, push: false }),
      key: `${namespace}_push_disabled`,
    })

    try {
      const { tables } = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)

      assert.equal(Object.hasOwn(tables, 'posts'), false)
      assert.equal(Object.hasOwn(tables, 'payload_migrations'), false)
    } finally {
      await disabled.destroy()
    }

    base = await getPayload({
      config: await makeConfig({ ...options, push: true }),
      key: namespace,
    })

    const { tables } = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)

    assert.ok(Object.hasOwn(tables, 'posts'), 'Startup must apply the pending migration')
    assert.equal(await count(base, 'payload-migrations'), 1)

    await base.db.connect()

    const { docs } = await base.find({
      collection: 'payload-migrations',
      overrideAccess: true,
    })

    assert.deepEqual(
      docs.map(({ name }) => name),
      [initialFile.replace(/\.ts$/, '')]
    )
  })

  await t.test('concurrent connection calls share the existing pool', async () => {
    const pool = base.db.pool
    const connecting = base.db.connect({ hotReload: true })

    assert.equal(base.db.connect({ hotReload: true }), connecting)

    await connecting

    assert.equal(base.db.pool, pool)
  })

  await t.test(
    'migrate:refresh rolls down and reapplies the generated initial migration',
    async () => {
      await base.create({
        collection: 'posts',
        data: {
          title: 'Post before refresh',
        },
        overrideAccess: true,
      })

      assert.equal(await count(base, 'posts'), 1)

      await base.db.migrateRefresh()

      assert.equal(await count(base, 'payload-migrations'), 1)
      assert.equal(await count(base, 'posts'), 0)
    }
  )

  await t.test('a generated forward migration adds tags and records history once', async () => {
    payload = await getPayload({
      config: await makeConfig({
        connectionString,
        migrationDir,
        withTags: true,
        WebSocket: MigrationTestSocket,
      }),
      key: `${namespace}_with_tags`,
    })

    await payload.db.createMigration({
      payload,
      migrationName: 'with_tags',
    })

    await payload.db.migrate()
    await payload.db.migrate()

    assert.equal(await count(payload, 'payload-migrations'), 2)
    assert.equal(await count(payload, 'tags'), 0)
  })

  await t.test('CRUD, ordered relationship population, pagination and global reads', async () => {
    const author = await payload.create({
      collection: 'authors',
      data: {
        name: 'Example Author',
      },
      overrideAccess: true,
    })

    const tag = await payload.create({
      collection: 'tags',
      data: {
        label: 'News',
        color: 'blue',
      },
      overrideAccess: true,
    })

    post = await payload.create({
      collection: 'posts',
      data: {
        title: 'First post',
        author: author.id,
        reviewers: [author.id],
        tags: [tag.id],
        sections: [
          {
            heading: 'First',
          },
          {
            heading: 'Second',
          },
        ],
      },
      overrideAccess: true,
    })

    const edited = await payload.update({
      collection: 'posts',
      id: post.id,
      data: {
        title: 'Revised post',
      },
      overrideAccess: true,
    })

    assert.equal(edited.title, 'Revised post')

    const result = await payload.find({
      collection: 'posts',
      where: {
        title: {
          equals: 'Revised post',
        },
      },
      select: {
        title: true,
        author: true,
        tags: true,
        sections: true,
      },
      depth: 1,
      limit: 1,
      page: 1,
      overrideAccess: true,
    })

    assert.equal(result.totalDocs, 1)
    assert.equal(result.docs[0].author.id, author.id)
    assert.equal(result.docs[0].author.name, 'Example Author')

    assert.deepEqual(
      result.docs[0].tags.map(({ id }) => id),
      [tag.id]
    )

    assert.deepEqual(
      result.docs[0].sections.map(({ heading }) => heading),
      ['First', 'Second']
    )

    await payload.updateGlobal({
      slug: 'settings',
      data: { title: 'Site' },
      overrideAccess: true,
    })

    assert.equal(
      (
        await payload.findGlobal({
          slug: 'settings',
          overrideAccess: true,
        })
      ).title,
      'Site'
    )

    const draft = await payload.create({
      collection: 'posts',
      data: {
        title: 'Draft',
      },
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

    await payload.delete({
      collection: 'posts',
      id: draft.id,
      overrideAccess: true,
    })
  })

  await t.test('login creates a session and a failed SQL transaction rolls back', async () => {
    const data = {
      email: 'local@example.invalid',
      password: 'local-test-password',
    }

    await payload.create({
      collection: 'users',
      data,
      overrideAccess: true,
    })

    const { token } = await payload.login({
      collection: 'users',
      data,
    })

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
        id: bigint('id', {
          mode: 'bigint',
        }).primaryKey(),
      })

      const children = pgTable('bigint_children', {
        id: bigint('id', {
          mode: 'bigint',
        }).primaryKey(),
        parentID: bigint('parent_id', {
          mode: 'bigint',
        }),
      })

      const schema = {
        parents,
        children,
        parentsRelations: relations(parents, ({ many }) => ({ children: many(children) })),
        childrenRelations: relations(children, ({ one }) => ({
          parent: one(parents, {
            fields: [children.parentID],
            references: [parents.id],
          }),
        })),
      }

      const db = drizzle({ client: payload.db.pool, schema })

      bindRelations(db, schema)

      const rows = await db.query.parents.findMany({
        orderBy: [parents.id],
        with: {
          children: {
            columns: {
              id: true,
            },
          },
        },
      })

      assert.deepEqual(rows, [
        {
          id: 9007199254740993n,
          children: [
            {
              id: 1n,
            },
          ],
        },
        {
          id: 9007199254740994n,
          children: [
            {
              id: 2n,
            },
          ],
        },
      ])

      assert.deepEqual(
        await db.query.parents.findMany({
          orderBy: [parents.id],
          with: {
            children: {
              limit: 1,
              columns: {
                id: true,
              },
            },
          },
        }),
        rows
      )

      const child = await db.query.children.findFirst({
        orderBy: [children.id],
        with: {
          parent: true,
        },
      })

      assert.deepEqual(child.parent, { id: 9007199254740993n })
    }
  )

  await t.test('a failed forward migration stops after the failing statement', async (t) => {
    exposeMigrationError(t, payload)

    await assert.rejects(
      payload.db.migrate({
        migrations: [
          {
            name: 'failed_forward_migration',
            down: async () => {},
            up: async ({ db }) => {
              await db.execute(sql`
                CREATE TABLE "forward_probe" ("id" integer PRIMARY KEY);
                CREATE TABLE;
                CREATE TABLE "unreached_probe" ("id" integer PRIMARY KEY);
              `)
            },
          },
        ],
      }),
      (error) => {
        assert.equal(error.query, 'CREATE TABLE')
        assert.match(error.cause?.message ?? '', /PostgreSQL parse error/)
        return true
      }
    )

    const { tables } = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)

    assert.equal(Object.hasOwn(tables, 'forward_probe'), true)
    assert.equal(Object.hasOwn(tables, 'unreached_probe'), false)
    assert.equal(await count(payload, 'payload-migrations'), 2)
  })

  await t.test('generated down migration removes tags and preserves posts', async () => {
    await payload.db.migrateDown()

    assert.equal(await count(base, 'payload-migrations'), 1)
    assert.equal(
      (
        await base.findByID({
          collection: 'posts',
          id: post.id,
          overrideAccess: true,
        })
      ).title,
      'Revised post'
    )

    const database = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)

    assert.equal(Object.hasOwn(database.tables, 'tags'), false)
    assert.equal(Object.hasOwn(database.tables, '_tags_v'), false)
    assert.equal(Object.hasOwn(database.types, 'enum_tags_color'), false)

    const table = await query(`USE NS ${namespace} DB cms; INFO FOR TABLE posts_rels;`)

    assert.equal(Object.hasOwn(table.fields, 'authors_id'), true)
    assert.equal(Object.hasOwn(table.fields, 'tags_id'), false)
    assert.equal(Object.hasOwn(table.indexes, 'posts_rels_tags_id_idx'), false)
  })

  await t.test('migrate reapplies the tags migration after migrate:down', async (t) => {
    exposeMigrationError(t, payload)

    await payload.db.migrate()

    assert.equal(await count(payload, 'payload-migrations'), 2)
    assert.equal(await count(payload, 'posts'), 1)
    assert.equal(await count(payload, 'tags'), 0)
  })

  await t.test('migrate:fresh validates its input and reapplies both migrations', async () => {
    const before = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)

    assert.equal(Object.hasOwn(before.types, 'enum_posts_status'), true)

    const historyCount = await count(base, 'payload-migrations')

    const emptyDir = await mkdtemp(fileURLToPath(new URL('./.migrations-empty-', import.meta.url)))

    payload.db.migrationDir = emptyDir

    try {
      await assert.rejects(
        payload.db.migrateFresh({
          forceAcceptWarning: true,
        }),
        /requires valid migration files/
      )

      assert.equal(await count(base, 'posts'), 1)
      assert.equal(await count(base, 'payload-migrations'), historyCount)
    } finally {
      payload.db.migrationDir = migrationDir
      await rm(emptyDir, { recursive: true, force: true })
    }

    await payload.db.migrateFresh({
      forceAcceptWarning: true,
    })

    assert.equal(await count(payload, 'payload-migrations'), 2)
    assert.equal(await count(payload, 'posts'), 0)
    assert.equal(await count(payload, 'tags'), 0)

    const database = await query(`USE NS ${namespace} DB cms; INFO FOR DB;`)

    assert.equal(Object.hasOwn(database.types, 'enum_posts_status'), true)
    assert.equal(Object.hasOwn(database.types, 'enum_tags_color'), true)
  })

  await t.test(
    'migrate:down rolls back removal even if the migration catches the error',
    async (t) => {
      await writeFile(
        join(migrationDir, 'rollback_probe.ts'),
        `
      import assert from 'node:assert/strict'
      import { sql } from '@rubixstudios/payload-surrealdb'

      export async function up({ db }) {
        await db.execute(sql\`
          CREATE TABLE "rollback_target" ("id" integer PRIMARY KEY);
          CREATE TABLE "rollback_related" ("id" integer PRIMARY KEY, "name" varchar);
          CREATE INDEX "rollback_probe_idx" ON "rollback_related" ("name");
          INSERT INTO "rollback_target" ("id") VALUES (1);
        \`)
      }

      export async function down({ db }) {
        await assert.rejects(
          db.execute(sql\`
            ALTER TABLE "rollback_target" DISABLE ROW LEVEL SECURITY;
            DROP TABLE "rollback_target" CASCADE;
            DROP INDEX "rollback_probe_idx";
            ALTER TABLE "rollback_related" DROP COLUMN "name";
          \`),
          /forced SurrealQL failure/
        )

        const { rows } = await db.execute(sql\`
          SELECT table_name FROM information_schema.tables
          WHERE table_name = 'rollback_target'
        \`)
        assert.deepEqual(rows, [])
      }
    `
      )
      await payload.db.migrate()

      assert.equal(await count(payload, 'payload-migrations'), 3)

      exposeMigrationError(t, payload)

      await assert.rejects(payload.db.migrateDown(), /forced SurrealQL failure/)

      assert.deepEqual(
        (await payload.db.drizzle.execute(sql`SELECT id FROM "rollback_target"`)).rows,
        [{ id: 1 }]
      )

      const table = await query(`USE NS ${namespace} DB cms; INFO FOR TABLE rollback_related;`)

      assert.equal(Object.hasOwn(table.indexes, 'rollback_probe_idx'), true)
      assert.equal(Object.hasOwn(table.fields, 'name'), true)
      assert.equal(await count(payload, 'payload-migrations'), 3)
    }
  )
})

function makeConfig({ connectionString, migrationDir, push, withTags, WebSocket }) {
  return buildConfig({
    telemetry: false,
    secret: 'local-validation-only',
    db: surrealdbAdapter({
      pool: WebSocket
        ? {
            connectionString,
            timeout: 0,
            WebSocket,
          }
        : connectionString,
      migrationDir,
      push,
    }),
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
        ],
      },
      ...(withTags
        ? [
            {
              slug: 'tags',
              versions: true,
              fields: [
                {
                  name: 'label',
                  type: 'text',
                },
                {
                  name: 'color',
                  type: 'select',
                  options: ['blue', 'green'],
                },
              ],
            },
          ]
        : []),
      {
        slug: 'posts',
        versions: { drafts: true },
        fields: [
          {
            name: 'title',
            type: 'text',
            required: true,
          },
          {
            name: 'author',
            type: 'relationship',
            relationTo: 'authors',
          },
          {
            name: 'reviewers',
            type: 'relationship',
            relationTo: 'authors',
            hasMany: true,
          },
          ...(withTags
            ? [
                {
                  name: 'tags',
                  type: 'relationship',
                  relationTo: 'tags',
                  hasMany: true,
                },
              ]
            : []),
          {
            name: 'sections',
            type: 'array',
            fields: [
              {
                name: 'heading',
                type: 'text',
              },
            ],
          },
        ],
      },
    ],
    globals: [
      {
        slug: 'settings',
        fields: [
          {
            name: 'title',
            type: 'text',
          },
        ],
      },
    ],
  })
}

function exposeMigrationError(t, payload) {
  let migrationError

  t.mock.method(payload.logger, 'error', ({ err }) => {
    migrationError = err
  })

  t.mock.method(process, 'exit', (code) => {
    assert.equal(code, 1)
    assert.ok(migrationError instanceof Error)

    throw migrationError
  })
}

async function count(payload, collection) {
  const result = await payload.count({ collection, overrideAccess: true })

  return result.totalDocs
}
