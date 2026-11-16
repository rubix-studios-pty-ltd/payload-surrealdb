import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { type PoolConfig } from '@surrealdb/pg'

type Capture = { socket?: WebSocket; timeout?: number }
type Statement = { status: string; result: unknown }
type Reply = { id?: string; result?: Statement[]; error?: { message?: string } }

const sockets = new AsyncLocalStorage<Capture>()
const transactionID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export function migrationPool(options: PoolConfig): PoolConfig {
  const Socket = options.WebSocket ?? globalThis.WebSocket

  if (!Socket) {
    return options
  }

  return {
    ...options,
    WebSocket: class extends Socket {
      override send(data: Parameters<WebSocket['send']>[0]): void {
        const capture = sockets.getStore()

        if (capture) {
          capture.socket = this
          capture.timeout = options.timeout
        }

        super.send(data)
      }
    },
  }
}

export async function executeSurrealDDL<T>(
  text: string,
  transactionQuery: () => PromiseLike<T>
): Promise<T> {
  const capture: Capture = {}
  const result = await sockets.run(capture, async () => await transactionQuery())
  const { socket, timeout } = capture

  if (!socket) {
    throw new Error('Collection removal requires a SurrealDB WebSocket transaction')
  }

  const [transaction] = await query(socket, 'RETURN $sql_txn;', timeout)
  const id = transaction?.result

  if (typeof id !== 'string' || !transactionID.test(id)) {
    throw new Error('Could not identify the active SurrealDB migration transaction')
  }

  await query(socket, text, timeout, id)

  return result
}

function query(
  socket: WebSocket,
  text: string,
  timeout: number | undefined,
  txn?: string
): Promise<Statement[]> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== 1) {
      reject(new Error('SurrealDB connection closed before running a migration query'))
      return
    }

    const id = randomUUID()
    const timer = timeout
      ? setTimeout(() => fail(new Error('SurrealDB migration query timed out')), timeout)
      : undefined

    function cleanup(): void {
      clearTimeout(timer)
      socket.removeEventListener('message', receive)
      socket.removeEventListener('close', disconnect)
      socket.removeEventListener('error', disconnect)
    }

    function fail(error: unknown): void {
      cleanup()
      reject(error)
    }

    function disconnect(): void {
      fail(new Error('SurrealDB connection lost during a migration query'))
    }

    function receive({ data }: MessageEvent<unknown>): void {
      let reply: Reply

      try {
        const json =
          typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
              ? new TextDecoder().decode(data)
              : undefined

        if (!json) {
          return
        }

        reply = JSON.parse(json)
      } catch {
        return
      }

      if (reply?.id !== id) {
        return
      }

      if (reply.error || !Array.isArray(reply.result) || !reply.result.length) {
        fail(new Error(reply.error?.message ?? 'Invalid SurrealDB migration query response'))
        return
      }

      for (const statement of reply.result) {
        if (statement?.status !== 'OK') {
          fail(new Error(`SurrealDB migration query failed: ${String(statement?.result)}`))
          return
        }
      }

      cleanup()
      resolve(reply.result)
    }

    socket.addEventListener('message', receive)
    socket.addEventListener('close', disconnect)
    socket.addEventListener('error', disconnect)

    try {
      socket.send(JSON.stringify({ id, method: 'query', params: [text], txn }))
    } catch (error) {
      fail(error)
    }
  })
}
