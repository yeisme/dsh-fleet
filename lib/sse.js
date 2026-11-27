/**
 * Server-sent events for the fleet page (docs/design/FLEET-API.md §3).
 *
 * One event type, `state`, and every event is the FULL state, so there are no deltas to lose: a client that missed
 * events (slow reader, reconnect, `Last-Event-ID`) simply gets the newest one. That is also what makes backpressure
 * cheap: a client that cannot keep up keeps only the latest message and gets it when it drains.
 *
 * Replaces the orchestrator's broadcast loop, which iterated a Map as if it were an array: every event threw and
 * closed the subscription. Here clients live in a Set, every send is isolated (one dead client never affects the
 * others), and the loop iterates a copy because a failed send removes its client.
 */

const HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
})

/** One SSE frame. JSON.stringify never emits a raw newline, so `data:` stays on a single line. */
export function frame({ event, id, data }) {
  return `${event ? `event: ${event}\n` : ''}${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`
}

/**
 * @param {{ heartbeatMs?: number, stallMs?: number, now?: () => number, onError?: (error: unknown) => void }} [options]
 *   heartbeatMs: how often a `: ping` comment keeps idle connections (and proxies) alive.
 *   stallMs: a client that has not drained for this long is dropped.
 */
export function createSseHub({ heartbeatMs = 15_000, stallMs = 30_000, now = Date.now, onError = () => {} } = {}) {
  const clients = new Set()
  let timer = null

  function stopTimerIfIdle() {
    if (clients.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function startTimer() {
    if (timer !== null) return
    timer = setInterval(() => {
      for (const client of [...clients]) {
        if (client.blockedSince !== null) {
          if (now() - client.blockedSince > stallMs) client.drop()
          continue
        }
        client.write(': ping\n\n')
      }
    }, heartbeatMs)
    timer.unref?.()
  }

  function makeClient(response) {
    const client = {
      closed: false,
      blockedSince: null,
      latest: null,
      drop() {
        if (client.closed) return
        client.closed = true
        clients.delete(client)
        stopTimerIfIdle()
        try { response.end() } catch { /* already gone */ }
      },
      write(chunk) {
        if (client.closed) return
        try {
          if (!response.write(chunk) && client.blockedSince === null) {
            client.blockedSince = now()
            response.once('drain', () => {
              client.blockedSince = null
              const pending = client.latest
              client.latest = null
              if (pending !== null) client.send(pending)
            })
          }
        } catch (error) {
          onError(error)
          client.drop()
        }
      },
      /** Send a message, or remember only the newest one while the reader is behind. */
      send(message) {
        if (client.closed) return
        if (client.blockedSince !== null) {
          client.latest = message
          return
        }
        client.write(frame(message))
      },
    }
    return client
  }

  return {
    get size() { return clients.size },

    /** Open the stream on `response` and send `first` immediately. */
    add(response, first) {
      response.writeHead(200, HEADERS)
      const client = makeClient(response)
      clients.add(client)
      response.once('close', client.drop)
      response.once('error', client.drop)
      startTimer()
      client.send(first)
      return client
    },

    /** Send to every client. Safe if a send removes its client mid-loop. */
    broadcast(message) {
      for (const client of [...clients]) client.send(message)
    },

    /** Close every stream (plugin unload). */
    close() {
      for (const client of [...clients]) client.drop()
      stopTimerIfIdle()
    },
  }
}
