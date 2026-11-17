import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildConfig, getPayload, handleEndpoints } from 'payload'
import { surrealdbAdapter } from '@rubixstudios/payload-surrealdb'

import { migrateInitial, setupDatabase } from './database.mjs'

test('Payload uploads and jobs on SurrealDB', { timeout: 90_000 }, async (t) => {
  const { connectionString, migrationDir, namespace } = await setupDatabase(t)

  const staticDir = join(migrationDir, 'uploads')
  const executions = new Map()

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
        slug: 'media',
        upload: {
          mimeTypes: ['text/plain'],
          staticDir,
        },
        fields: [
          {
            name: 'label',
            type: 'text',
            required: true,
          },
        ],
      },
      {
        slug: 'articles',
        fields: [
          {
            name: 'attachment',
            type: 'upload',
            relationTo: 'media',
          },
        ],
      },
    ],
    jobs: {
      deleteJobOnComplete: false,
      tasks: [
        {
          slug: 'record-work',
          inputSchema: [
            {
              name: 'name',
              type: 'text',
              required: true,
            },
          ],
          outputSchema: [
            {
              name: 'name',
              type: 'text',
              required: true,
            },
          ],
          handler: ({ input }) => {
            executions.set(input.name, (executions.get(input.name) ?? 0) + 1)

            return { output: { name: input.name } }
          },
        },
      ],
    },
  })

  const payload = await getPayload({ config, key: namespace })

  t.after(() => payload.destroy())

  await migrateInitial(payload)

  await t.test('stores, serves, populates and deletes a multipart upload', async () => {
    const credentials = {
      email: 'uploader@example.invalid',
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

    function request(path, options = {}) {
      return handleEndpoints({
        config,
        payloadInstanceCacheKey: namespace,
        request: new Request(new URL(path, 'http://localhost'), {
          method: options.method,
          body: options.body,
          headers: {
            authorization: `JWT ${token}`,
            ...options.headers,
          },
        }),
      })
    }

    const filename = 'test-attachment.txt'
    const contents = 'SurrealDB upload integration test\n'

    const form = new FormData()

    form.set(
      '_payload',
      JSON.stringify({
        label: 'Test attachment',
      })
    )

    form.set(
      'file',
      new Blob([contents], {
        type: 'text/plain',
      }),
      filename
    )

    const create = await request('/api/media', {
      method: 'POST',
      body: form,
    })

    const response = await create.json()

    assert.equal(create.status, 201, JSON.stringify(response))

    const { id } = response.doc

    const file = await payload.findByID({
      collection: 'media',
      id,
      overrideAccess: true,
    })

    assert.equal(file.filename, filename)
    assert.equal(file.mimeType, 'text/plain')
    assert.equal(file.filesize, Buffer.byteLength(contents))
    assert.equal(await readFile(join(staticDir, filename), 'utf8'), contents)

    const download = await request(file.url)

    assert.equal(download.status, 200)
    assert.equal(await download.text(), contents)

    const range = await request(file.url, {
      headers: {
        range: 'bytes=0-8',
      },
    })

    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'SurrealDB')

    const article = await payload.create({
      collection: 'articles',
      data: {
        attachment: id,
      },
      depth: 1,
      overrideAccess: true,
    })

    assert.equal(article.attachment.id, id)
    assert.equal(article.attachment.filename, filename)

    await payload.delete({
      collection: 'articles',
      id: article.id,
      overrideAccess: true,
    })

    await payload.delete({
      collection: 'media',
      id,
      overrideAccess: true,
    })

    await assert.rejects(readFile(join(staticDir, filename)), {
      code: 'ENOENT',
    })
    await assert.rejects(
      payload.findByID({
        collection: 'media',
        id,
        overrideAccess: true,
      }),
      {
        status: 404,
      }
    )
  })

  await t.test('workers claim a queued job once and leave scheduled jobs pending', async (t) => {
    const worker = await getPayload({ config, key: `${namespace}_worker` })

    t.after(() => worker.destroy())

    const queue = 'concurrent'
    const task = 'record-work'

    const ready = await payload.jobs.queue({
      task,
      queue,
      input: {
        name: 'ready',
      },
      overrideAccess: true,
    })

    const scheduled = await payload.jobs.queue({
      task,
      queue,
      input: {
        name: 'scheduled',
      },
      overrideAccess: true,
      waitUntil: new Date(Date.now() + 3_600_000),
    })

    const options = { limit: 1, overrideAccess: true, queue, silent: true }
    const workers = [payload, worker]
    const results = await Promise.allSettled(workers.map((worker) => worker.jobs.run(options)))

    assert.ok(results.some(({ status }) => status === 'fulfilled'))

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const error = result.reason.cause ?? result.reason
        assert.equal(error.code, '40001', result.reason.stack)
        await workers[index].jobs.run(options)
      }
    }

    for (const worker of workers) {
      assert.deepEqual(Object.keys(worker.db.sessions), [])
    }

    assert.deepEqual([...executions], [['ready', 1]])

    const collection = 'payload-jobs'

    const completed = await payload.findByID({
      collection,
      id: ready.id,
      overrideAccess: true,
    })

    assert.ok(completed.completedAt)
    assert.equal(completed.totalTried, 1)
    assert.deepEqual(completed.log[0].output, { name: 'ready' })

    const pending = await payload.findByID({
      collection,
      id: scheduled.id,
      overrideAccess: true,
    })

    assert.equal(pending.completedAt ?? null, null)
    assert.equal(pending.totalTried, 0)
  })
})
