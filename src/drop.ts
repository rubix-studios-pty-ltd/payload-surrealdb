import { type PostgresAdapter } from '@payloadcms/db-postgres'
import { sql } from 'drizzle-orm'

export async function dropSchema(adapter: PostgresAdapter): Promise<void> {
  await adapter.drizzle.transaction(async (db) => {
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`)

    const { rows: types } = await db.execute<{ name: string; kind: string }>(sql`
      SELECT t.typname AS name, t.typtype AS kind
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c')
      ORDER BY t.typtype
    `)

    for (const { name, kind } of types) {
      const identifier = sql.identifier(name)

      if (kind === 'd') {
        await db.execute(sql`DROP DOMAIN IF EXISTS "public".${identifier}`)
      } else {
        await db.execute(sql`DROP TYPE IF EXISTS "public".${identifier}`)
      }
    }

    const { rows: sequences } = await db.execute<{ name: string }>(sql`
      SELECT sequencename AS name FROM pg_catalog.pg_sequences WHERE schemaname = 'public'
    `)

    for (const { name } of sequences) {
      await db.execute(sql`DROP SEQUENCE IF EXISTS "public".${sql.identifier(name)}`)
    }

    await db.execute(sql`CREATE SCHEMA public`)
  })
}
