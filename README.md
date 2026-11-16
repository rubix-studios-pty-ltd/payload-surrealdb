# PayloadCMS + SurrealDB

A Payload CMS database adapter that integrates SurrealDB as a database backend. The adapter uses SurrealDB's PostgreSQL-compatible SQL interface with Payload's existing database functionality, including collections, relationships, transactions and migrations.

[![npm version](https://img.shields.io/npm/v/@rubixstudios/payload-surrealdb.svg)](https://www.npmjs.com/package/@rubixstudios/payload-surrealdb)
[![Release](https://github.com/rubix-studios-pty-ltd/payload-surrealdb/actions/workflows/release.yml/badge.svg)](https://github.com/rubix-studios-pty-ltd/payload-surrealdb/actions/workflows/release.yml)

<img width="1919" height="1078" alt="image" src="https://github.com/user-attachments/assets/8f65606c-0c09-49b4-af32-c421aa53e402" />

SurrealDB is an open-source, multi-model database designed to support structured and relational data through a unified database engine.

Learn more at [SurrealDB](https://surrealdb.com).

## Compatibility

The adapter supports Payload CMS v3 and v4, with SurrealDB v4 required for SQL compatibility.

| Component   | Supported versions             |
| ----------- | ------------------------------ |
| Payload CMS | `^3.93.0` or `^4.0.0-beta.9`   |
| SurrealDB   | v4, validated with `4.0.1`     |
| Drizzle ORM | `0.45.2`                       |
| Node.js     | `>=24.22.3 <25` or `>=26.13.1` |

## Installation

```sh
pnpm add @rubixstudios/payload-surrealdb @payloadcms/db-postgres drizzle-orm@0.45.2
```

Configure your SurrealDB connection using an environment variable.

```dotenv
DATABASE_URL=surrealdb+wss://user:password@surreal.example.com/app/payload
```

Use `surrealdb+ws://` for local development without TLS. The namespace and database must already exist in SurrealDB.

```typescript
// payload.config.ts
import { buildConfig } from 'payload'
import { surrealdbAdapter } from '@rubixstudios/payload-surrealdb'

export default buildConfig({
  db: surrealdbAdapter({
    pool: process.env.DATABASE_URL,
  }),
})
```

Additional options, including `push`, `migrationDir`, `prodMigrations`, `beforeSchemaInit` and `afterSchemaInit`, can be configured within `surrealdbAdapter`.

## Schema and migrations

Generate versioned migrations using the standard Payload command.

```sh
pnpm exec payload migrate:create
```

Review generated migrations before applying them, particularly when modifying existing database structures.

### Run migrations at startup

Outside production, the adapter applies pending migration files from `migrationDir` when Payload starts. Payload records applied migrations and skips them on subsequent starts. The `push` option defaults to `true`. Set it to `false` to disable this behaviour.

```typescript
db: surrealdbAdapter({
  pool: process.env.DATABASE_URL,
  push: false,
  migrationDir: './src/migrations',
}),
```

In production, configure `prodMigrations` with the generated migration list to apply pending migrations on startup.

Automatic startup migrations apply existing files. Changes to collections and globals still require `payload migrate:create`. To apply migrations manually, run `pnpm exec payload migrate`.

### Destructive migrations

Generated collection removals use the same WebSocket transaction as the rest of the migration and its history entry. When two new tables reference each other and need indexes on their foreign-key fields, put the foreign keys and indexes in separate migrations. Changes that add a foreign key and an index to an existing table may also need separate migrations.

`payload migrate:fresh` clears the schema after loading the migration files, then applies the migrations in order. Each replayed migration uses its own transaction.

## Notes

- SurrealDB 4 is required. Not all PostgreSQL SQL statements and schema operations are supported.
- Existing PostgreSQL databases require a separate data migration when moving to SurrealDB.
- Certain schema modifications may require adjustments to generated migrations, including foreign key constraints, indexes and column renaming.
- SurrealDB 4.0.1 may report success for `ALTER TABLE ... RENAME COLUMN` without applying the rename. Verify these changes before deployment.
- Test migration rollbacks and destructive schema changes against a disposable database before using them in production.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Support

For support or inquiries

- LinkedIn - [rubixvi](https://www.linkedin.com/in/rubixvi/)
- Website - [Rubix Studios](https://rubixstudios.com.au)

## Author

Rubix Studios  
https://rubixstudios.com.au
