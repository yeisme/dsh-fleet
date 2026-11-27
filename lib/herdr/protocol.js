/**
 * herdr transport: newline-delimited JSON over a local socket.
 *
 * Copied from herdr-orchestrator/lib/protocol.js (code reuse only: this plugin has no runtime dependency on it)
 * and hardened: a frame-size cap, and a classifier that tells "herdr is not reachable" from "herdr said no".
 *
 * Observed server behavior (herdr 0.9.5, protocol 22) shapes this module: a plain request is answered once and the
 * server then closes that connection, so request/response runs on a short-lived socket; `events.subscribe` is the
 * only long-lived connection, acknowledged with `subscription_started` and then streamed. herdr reports
 * `events_lost` when a reader falls behind, so a closed subscription is surfaced to the owner, which reconciles
 * with a fresh `session.snapshot` instead of trusting the deltas it missed.
 */
import net from 'node:net'

const DEFAULT_TIMEOUT_MS = 8000

/** A busy session's snapshot is large, but a runaway peer must not be able to grow our buffer without bound. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export class HerdrError extends Error {
  constructor(message, { method, code } = {}) {
    super(message)
    this.name = 'HerdrError'
    this.method = method
    this.code = code
  }
}

/** Codes that mean "the socket could not be used", as opposed to "herdr answered with an error frame". */
const OFFLINE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTSOCK', 'connection_closed', 'write_failed', 'socket_error'])

export function isOfflineError(error) {
  return error instanceof HerdrError && OFFLINE_CODES.has(error.code)
}

/** Windows exposes the same protocol over a named pipe derived from the socket name. */
export function endpointFor(socketPath) {
  if (process.platform !== 'win32' || !socketPath) return socketPath
  if (socketPath.startsWith('\\\\')) return socketPath
  return `\\\\.\\pipe\\${socketPath}`
}

export class HerdrClient {
  #socketPath
  #endpoint
  #timeoutMs
  #maxFrameBytes
  #subscription = null
  #seq = 0
  #closed = false
  #lastOkAt = 0
  #lastError = null

  constructor({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    this.#socketPath = socketPath
    this.#endpoint = endpointFor(socketPath)
    this.#timeoutMs = timeoutMs
    this.#maxFrameBytes = maxFrameBytes
  }

  get socketPath() { return this.#socketPath }
  get lastOkAt() { return this.#lastOkAt }
  get lastError() { return this.#lastError }
  /** Live means "the server answered recently", not "a socket is parked open". */
  get connected() { return this.#lastOkAt > 0 && Date.now() - this.#lastOkAt < 30000 }

  nextRequestId() {
    this.#seq += 1
    return `dsh_${this.#seq}_${Date.now().toString(36)}`
  }

  /**
   * Send one request and await its single response.
   *
   * Each request owns its connection because the server closes it after the response. `signal` cancels only the
   * local wait; the server may still apply the request, so an aborted or timed-out write is of UNKNOWN outcome.
   */
  request(method, params = {}, { timeoutMs = this.#timeoutMs, signal } = {}) {
    if (this.#closed) return Promise.reject(new HerdrError('herdr client is closed', { method, code: 'client_closed' }))
    const id = this.nextRequestId()
    const payload = `${JSON.stringify({ id, method, params })}\n`

    return new Promise((resolve, reject) => {
      let settled = false
      let buffer = ''
      const socket = net.createConnection(this.#endpoint)
      socket.setNoDelay?.(true)

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        socket.destroy()
        fn(value)
      }

      const timer = setTimeout(() => {
        finish(reject, new HerdrError(`herdr ${method} timed out after ${timeoutMs}ms`, { method, code: 'timeout' }))
      }, timeoutMs)
      timer.unref?.()

      const onAbort = () => finish(reject, new HerdrError(`herdr ${method} was cancelled`, { method, code: 'aborted' }))
      signal?.addEventListener?.('abort', onAbort, { once: true })

      socket.setEncoding?.('utf8')
      socket.on('error', (error) => {
        this.#lastError = String(error?.message ?? error)
        finish(reject, new HerdrError(`herdr ${method} failed: ${error?.message ?? error}`, { method, code: error?.code ?? 'socket_error' }))
      })
      socket.on('connect', () => {
        socket.write(payload, (error) => {
          if (!error) return
          finish(reject, new HerdrError(`herdr ${method} write failed: ${error.message}`, { method, code: 'write_failed' }))
        })
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index === -1) {
          if (buffer.length > this.#maxFrameBytes) finish(reject, new HerdrError(`herdr ${method} sent a frame over ${this.#maxFrameBytes} bytes`, { method, code: 'frame_too_large' }))
          return
        }
        const line = buffer.slice(0, index).trim()
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          finish(reject, new HerdrError(`herdr ${method} returned malformed JSON`, { method, code: 'malformed' }))
          return
        }
        if (frame?.error) {
          const code = frame.error.code
          this.#lastError = typeof frame.error.message === 'string' ? frame.error.message : String(code)
          // An error frame still proves the server is alive and talking.
          this.#lastOkAt = Date.now()
          finish(reject, new HerdrError(this.#lastError, { method, code }))
          return
        }
        this.#lastOkAt = Date.now()
        this.#lastError = null
        finish(resolve, frame?.result)
      })
      socket.on('close', () => {
        if (!settled) finish(reject, new HerdrError(`herdr closed the connection before answering ${method}`, { method, code: 'connection_closed' }))
      })
    })
  }

  /**
   * Open the single long-lived connection and stream pushed event frames.
   *
   * @returns {{ ready: Promise<void>, close: () => void }}
   */
  subscribe(subscriptions, { onEvent, onAck, onLost } = {}) {
    const id = this.nextRequestId()
    let closed = false
    let buffer = ''
    let acked = false
    const socket = net.createConnection(this.#endpoint)
    socket.setNoDelay?.(true)
    socket.setEncoding?.('utf8')

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!acked) {
          socket.destroy()
          reject(new HerdrError('herdr subscription was not acknowledged in time', { method: 'events.subscribe', code: 'timeout' }))
        }
      }, this.#timeoutMs)
      timer.unref?.()

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } })}\n`)
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        if (buffer.length > this.#maxFrameBytes) {
          socket.destroy() // surfaces as "lost" (or a failed ack) below, and the owner reconciles from a snapshot
          return
        }
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
          if (line.length === 0) continue
          let frame
          try {
            frame = JSON.parse(line)
          } catch {
            continue
          }
          if (!acked && frame?.id === id) {
            acked = true
            clearTimeout(timer)
            if (frame.error) {
              reject(new HerdrError(String(frame.error.message ?? 'subscription rejected'), { method: 'events.subscribe', code: frame.error.code }))
              socket.destroy()
              return
            }
            this.#lastOkAt = Date.now()
            onAck?.()
            resolve()
            continue
          }
          if (frame?.event) onEvent?.(frame)
        }
      })
      socket.on('error', (error) => {
        if (!acked) {
          clearTimeout(timer)
          reject(new HerdrError(`herdr subscription failed: ${error?.message ?? error}`, { method: 'events.subscribe', code: error?.code ?? 'socket_error' }))
        }
      })
      socket.on('close', () => {
        if (closed) return
        closed = true
        if (!acked) {
          clearTimeout(timer)
          reject(new HerdrError('herdr closed the subscription before acknowledging it', { method: 'events.subscribe', code: 'connection_closed' }))
          return
        }
        onLost?.()
      })
    })

    ready.catch(() => {})
    return {
      ready,
      close: () => {
        closed = true
        socket.destroy()
      },
    }
  }

  setSubscription(handle) {
    this.#subscription?.close?.()
    this.#subscription = handle ?? null
  }

  get subscribed() {
    return this.#subscription !== null
  }

  close() {
    this.#closed = true
    this.#subscription?.close?.()
    this.#subscription = null
  }
}

/** Resolve once the server answers `ping`, proving endpoint and protocol liveness. */
export async function probe(client) {
  const result = await client.request('ping', {})
  return {
    version: result?.version ?? null,
    protocol: result?.protocol ?? null,
    capabilities: result?.capabilities ?? {},
  }
}
