import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { surrealdbAdapter } from '@rubixstudios/payload-surrealdb'

const url = 'surrealdb+ws://127.0.0.1:8000/test/application'

test('adapter supports existing connection forms and validates an absent URL', () => {
  for (const pool of [url, { connectionString: url, max: 6 }]) {
    const adapter = surrealdbAdapter({ pool }).init({ payload: {} })

    assert.equal(adapter.packageName, '@rubixstudios/payload-surrealdb')
    assert.equal(adapter.poolOptions.connectionString, url)
    assert.equal(adapter.push, true)
  }

  for (const pool of [undefined, '', '   ', {}]) {
    assert.throws(() => surrealdbAdapter({ pool }), /requires a database URL/)
  }
})

test('manifest exports resolve to built JavaScript and declarations', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    await readFile(new URL(entry.types, root))

    const module = subpath === '.' ? manifest.name : manifest.name + subpath.slice(1)

    await import(module)
  }
})
