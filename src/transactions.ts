import { randomUUID } from 'node:crypto'
import { type PostgresAdapter } from '@payloadcms/db-postgres'

type Session = PostgresAdapter['sessions'][string]

export function bindTransactions(adapter: PostgresAdapter): void {
  adapter.beginTransaction = async (options) => {
    await adapter.initializing

    const ready = Promise.withResolvers<Session['db']>()
    const finish = Promise.withResolvers<void>()

    const rollback = new Error('Payload transaction rolled back')

    const done = adapter.drizzle.transaction(async (db) => {
      ready.resolve(db)
      await finish.promise
    }, options)

    void done.catch(ready.reject)

    const db = await ready.promise
    const id = randomUUID()

    adapter.sessions[id] = {
      db,
      async reject() {
        finish.reject(rollback)

        try {
          await done
        } catch (error) {
          if (error !== rollback) {
            throw error
          }
        }
      },
      resolve() {
        finish.resolve()
        return done
      },
    }

    return id
  }

  adapter.commitTransaction = async (identifier) => {
    const id = await identifier
    const session = adapter.sessions[id]

    delete adapter.sessions[id]

    await session?.resolve()
  }
}
