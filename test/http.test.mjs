import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createFleetEndpoints, FLEET_PATHS } from '../lib/http.js'
import { createSseHub, frame } from '../lib/sse.js'
import { MAX_BODY_BYTES, HttpError, readJsonBody, requireJson } from '../lib/security.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()

/** What a FleetError looks like to the transport: a reason, an HTTP status, a message, optional detail. */
class StubFleetError extends Error {
  constructor(status, reason, message, detail) {
    super(message)
    this.status = status
    this.reason = reason
    this.detail = detail
  }
}

function makeService() {
  const listeners = new Set()
  const calls = []
  let revision = 7
  const service = {
    calls,
    state: () => ({ ok: true, revision, note: 'stub state' }),
    frames: async (pane, query) => { calls.push(['frames', pane, query]); return { ok: true, paneId: pane, query } },
    screen: async (pane) => { calls.push(['screen', pane]); return { ok: true, paneId: pane } },
    act: async (request) => { calls.push(['act', request]); return { ok: true, verb: request?.verb, pane: request?.pane, revision: 9 } },
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    listenerCount: () => listeners.size,
    change: () => { revision += 1; for (const listener of [...listeners]) listener() },
  }
  return service
}

/** Boot the endpoints on a real HTTP server, the way webServer.register would route them. */
async function boot({ rejectWith, serviceOverrides = {}, heartbeatMs = 15_000 } = {}) {
  const service = Object.assign(makeService(), serviceOverrides)
  const warnings = []
  const connection = { requestRejection: () => rejectWith }
  const fleet = createFleetEndpoints({ service, connection, logger: { warn: (...args) => warnings.push(args) }, heartbeatMs })
  const byPath = new Map(fleet.endpoints.map(({ path, handler }) => [path, handler]))
  const server = http.createServer((request, response) => {
    const handler = byPath.get(new URL(request.url, 'http://x').pathname)
    if (!handler) { response.writeHead(404).end(); return }
    void handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    service,
    fleet,
    warnings,
    url: (path, query = '') => `${base}${path}${query}`,
    async close() {
      fleet.dispose()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const post = (url, body, headers = { 'content-type': 'application/json' }) => fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

/** Read SSE text from a streaming response until `condition(text)` holds. */
async function readStream(response, condition, { timeoutMs = 2000 } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (!condition(text)) {
    if (Date.now() > deadline) { reader.cancel().catch(() => {}); assert.fail(`stream did not reach the expected content; got: ${JSON.stringify(text)}`) }
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
    ])
    if (done) break
    if (value) text += decoder.decode(value, { stream: true })
  }
  return { text, reader }
}

const eventsIn = (text) => text.split('\n\n').filter((block) => block.startsWith('event:')).map((block) => {
  const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
  return { event: fields.event, id: fields.id, data: JSON.parse(fields.data) }
})

describe('guard and method handling', () => {
  let app
  afterEach(async () => { await app?.close() })

  it('refuses every route and method with 403 forbidden, and never reaches the service', async () => {
    app = await boot({ rejectWith: { status: 403 } })
    for (const path of Object.values(FLEET_PATHS)) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(app.url(path), { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{"verb":"interrupt","pane":"w1:p1"}' : undefined })
        assert.equal(response.status, 403, `${method} ${path}`)
        assert.deepEqual(await response.json(), { ok: false, reason: 'forbidden', message: 'request not allowed' })
      }
    }
    assert.deepEqual(app.service.calls, [])
    assert.equal(app.fleet.hub.size, 0, 'no stream was opened for a refused request')
  })

  it('answers a wrong method with 405 and an Allow header, in the contract error shape', async () => {
    app = await boot()
    const cases = [['POST', FLEET_PATHS.state, 'GET'], ['DELETE', FLEET_PATHS.frames, 'GET'], ['PUT', FLEET_PATHS.screen, 'GET'], ['GET', FLEET_PATHS.act, 'POST'], ['POST', FLEET_PATHS.stream, 'GET']]
    for (const [method, path, allow] of cases) {
      const response = await fetch(app.url(path), { method, body: method === 'GET' ? undefined : '{}' })
      assert.equal(response.status, 405, `${method} ${path}`)
      assert.equal(response.headers.get('allow'), allow)
      const body = await response.json()
      assert.deepEqual(validateDef(contract, 'ErrorResponse', body).errors, [])
      assert.equal(body.reason, 'method-not-allowed')
    }
  })
})

describe('GET /plugin/fleet/state', () => {
  let app
  beforeEach(async () => { app = await boot() })
  afterEach(async () => { await app.close() })

  it('returns the service state as JSON, uncached', async () => {
    const response = await fetch(app.url(FLEET_PATHS.state))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), app.service.state())
  })
})

describe('GET /plugin/fleet/frames', () => {
  let app
  beforeEach(async () => { app = await boot() })
  afterEach(async () => { await app.close() })

  it('passes pane, limit, before and after through to the service untouched (the orchestrator dropped `before`)', async () => {
    await fetch(app.url(FLEET_PATHS.frames, `?pane=${encodeURIComponent('w1:p3')}&before=${encodeURIComponent('o:1024:ab')}&limit=25`))
    await fetch(app.url(FLEET_PATHS.frames, '?pane=w1%3Ap3&after=o%3A2048%3Aab'))
    await fetch(app.url(FLEET_PATHS.frames, '?pane=w1%3Ap3'))
    assert.deepEqual(app.service.calls, [
      ['frames', 'w1:p3', { limit: 25, before: 'o:1024:ab' }],
      ['frames', 'w1:p3', { limit: 80, after: 'o:2048:ab' }],
      ['frames', 'w1:p3', { limit: 80 }],
    ])
  })

  it('refuses malformed queries with 400 invalid-request and a fixed message', async () => {
    const bads = ['', '?pane=', `?pane=${'x'.repeat(65)}`, '?pane=a&limit=0', '?pane=a&limit=201', '?pane=a&limit=abc', '?pane=a&limit=-5', '?pane=a&limit=1.5',
      '?pane=a&before=c1&after=c2', '?pane=a&before=', `?pane=a&after=${'x'.repeat(513)}`]
    for (const query of bads) {
      const response = await fetch(app.url(FLEET_PATHS.frames, query))
      assert.equal(response.status, 400, query)
      const body = await response.json()
      assert.deepEqual(validateDef(contract, 'ErrorResponse', body).errors, [], query)
      assert.equal(body.reason, 'invalid-request')
    }
    assert.deepEqual(app.service.calls, [], 'nothing malformed reached the service')
  })

  it('maps a service error to its own status and the contract error shape (detail kept)', async () => {
    await app.close()
    app = await boot({ serviceOverrides: { frames: async () => { throw new StubFleetError(404, 'unknown-pane', 'no such pane', { pane: 'w9:p9' }) } } })
    const response = await fetch(app.url(FLEET_PATHS.frames, '?pane=w9%3Ap9'))
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { ok: false, reason: 'unknown-pane', message: 'no such pane', detail: { pane: 'w9:p9' } })
  })
})

describe('GET /plugin/fleet/screen', () => {
  let app
  beforeEach(async () => { app = await boot() })
  afterEach(async () => { await app.close() })

  it('requires a pane and passes it through', async () => {
    assert.equal((await fetch(app.url(FLEET_PATHS.screen))).status, 400)
    const response = await fetch(app.url(FLEET_PATHS.screen, '?pane=w1%3Ap1'))
    assert.deepEqual(await response.json(), { ok: true, paneId: 'w1:p1' })
  })
})

describe('POST /plugin/fleet/act', () => {
  let app
  beforeEach(async () => { app = await boot() })
  afterEach(async () => { await app.close() })

  it('accepts JSON (with a charset), hands the parsed body to the service, and returns its answer', async () => {
    const request = { verb: 'interrupt', pane: 'w1:p3' }
    const response = await post(app.url(FLEET_PATHS.act), request, { 'content-type': 'Application/JSON; charset=utf-8' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, verb: 'interrupt', pane: 'w1:p3', revision: 9 })
    assert.deepEqual(app.service.calls, [['act', request]])
  })

  it('refuses anything that is not declared JSON with 415, before reading the body', async () => {
    for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'multipart/form-data; boundary=x' }, { 'content-type': 'application/jsonx' }]) {
      const response = await post(app.url(FLEET_PATHS.act), '{"verb":"interrupt","pane":"w1:p3"}', headers)
      assert.equal(response.status, 415, JSON.stringify(headers))
      assert.equal((await response.json()).reason, 'unsupported-media-type')
    }
    assert.deepEqual(app.service.calls, [])
  })

  it('refuses a body over 256 KB with 413, whether the size is declared or only streamed', async () => {
    const big = JSON.stringify({ verb: 'prompt', pane: 'w1:p3', text: 'x'.repeat(MAX_BODY_BYTES + 10) })
    const declared = await post(app.url(FLEET_PATHS.act), big)
    assert.equal(declared.status, 413)
    assert.equal((await declared.json()).reason, 'payload-too-large')

    // No content-length: chunked. The cap must hold on the bytes actually received.
    const chunked = await new Promise((resolve, reject) => {
      const request = http.request(app.url(FLEET_PATHS.act), { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve({ status: response.statusCode, text, connection: response.headers.connection }))
      })
      request.on('error', (error) => (error.code === 'ECONNRESET' || error.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(error)))
      request.write(big.slice(0, 200_000))
      request.write(big.slice(200_000))
      request.end()
    })
    assert.ok(chunked.status === 413 || chunked.status === 'reset', `got ${chunked.status}`)
    assert.deepEqual(app.service.calls, [], 'an oversized body is never parsed or acted on')
  })

  it('refuses an empty or malformed body with 400, and never echoes the body (not even the parser message)', async () => {
    // V8's own parse error quotes a ~10 character snippet around the failure, so the secret must START the body and the
    // check must be on a prefix: a full-string check would miss a partial leak of the first words of a prompt.
    const secret = 'SECRET-PROMPT-TEXT'
    for (const body of ['', `${secret} is not json`, `{${secret}}`, `[${secret}`, `{"verb": "prompt", "text": "${secret}`]) {
      const response = await post(app.url(FLEET_PATHS.act), body)
      assert.equal(response.status, 400, JSON.stringify(body))
      const text = await response.text()
      assert.equal(JSON.parse(text).reason, 'invalid-request')
      assert.ok(!text.includes('SECRET'), `the response must not echo request content: ${text}`)
    }
    assert.deepEqual(app.service.calls, [])
    assert.ok(!JSON.stringify(app.warnings).includes('SECRET'), 'nor the log')
  })

  it('maps a service refusal to its status and the contract error shape', async () => {
    await app.close()
    app = await boot({ serviceOverrides: { act: async () => { throw new StubFleetError(409, 'screen-changed', 'the screen changed', { revision: 413 }) } } })
    const response = await post(app.url(FLEET_PATHS.act), { verb: 'keys', pane: 'w1:p1', keys: ['enter'], expectRevision: 412 })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.deepEqual(body, { ok: false, reason: 'screen-changed', message: 'the screen changed', detail: { revision: 413 } })
    assert.deepEqual(validateDef(contract, 'ErrorResponse', body).errors, [])
    assert.deepEqual(app.warnings, [], 'an expected refusal is not a warning')
  })

  it('turns an unexpected exception into a bare 500 internal: no message, no stack, nothing about the request in the log', async () => {
    await app.close()
    const leak = 'SECRET-PROMPT-TEXT'
    app = await boot({ serviceOverrides: { act: async () => { throw new TypeError(`boom while handling ${leak}`) } } })
    const response = await post(app.url(FLEET_PATHS.act), { verb: 'prompt', pane: 'w1:p1', text: leak })
    assert.equal(response.status, 500)
    const text = await response.text()
    assert.deepEqual(JSON.parse(text), { ok: false, reason: 'internal', message: 'internal error' })
    assert.ok(!text.includes(leak) && !text.includes('boom'))
    assert.equal(app.warnings.length, 1)
    const logged = JSON.stringify(app.warnings)
    assert.ok(!logged.includes(leak) && !logged.includes('boom'), 'the error message never reaches the log')
    assert.match(logged, /TypeError/)
  })
})

describe('GET /plugin/fleet/stream (SSE)', () => {
  let app
  afterEach(async () => { await app?.close() })

  it('opens an event stream and immediately sends the full current state, id = revision', async () => {
    app = await boot()
    const response = await fetch(app.url(FLEET_PATHS.stream))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/event-stream/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { text, reader } = await readStream(response, (t) => t.includes('\n\n'))
    assert.deepEqual(eventsIn(text), [{ event: 'state', id: '7', data: app.service.state() }])
    await reader.cancel()
  })

  it('every change is broadcast to every client as a full state, built once per change', async () => {
    let builds = 0
    app = await boot({ serviceOverrides: { state: () => { builds += 1; return { ok: true, revision: builds, built: builds } } } })
    const open = async () => {
      const response = await fetch(app.url(FLEET_PATHS.stream))
      return readStream(response, (t) => t.includes('\n\n'))
    }
    const a = await open()
    const b = await open()
    assert.equal(app.fleet.hub.size, 2)
    const before = builds
    app.service.change()
    assert.equal(builds - before, 1, 'the state is built once for all clients, not once per client')
    const [afterA, afterB] = await Promise.all([a, b].map(async (client) => readStream({ body: { getReader: () => client.reader } }, (t) => eventsIn(t).length >= 1)))
    for (const { text } of [afterA, afterB]) {
      const [event] = eventsIn(text)
      assert.equal(event.event, 'state')
      assert.equal(event.data.built, builds)
    }
    await a.reader.cancel()
    await b.reader.cancel()
  })

  it('ignores Last-Event-ID: a reconnecting client just gets the newest full state', async () => {
    app = await boot()
    const response = await fetch(app.url(FLEET_PATHS.stream), { headers: { 'last-event-id': '3' } })
    const { text, reader } = await readStream(response, (t) => t.includes('\n\n'))
    assert.equal(eventsIn(text).length, 1)
    assert.equal(eventsIn(text)[0].id, '7')
    await reader.cancel()
  })

  it('sends a heartbeat comment while idle', async () => {
    app = await boot({ heartbeatMs: 30 })
    const response = await fetch(app.url(FLEET_PATHS.stream))
    const { text, reader } = await readStream(response, (t) => t.includes(': ping'))
    assert.match(text, /: ping\n\n/)
    await reader.cancel()
  })

  it('a client that disconnects is removed (no leak), and the others keep receiving', async () => {
    app = await boot()
    const first = await fetch(app.url(FLEET_PATHS.stream))
    const second = await fetch(app.url(FLEET_PATHS.stream))
    const a = await readStream(first, (t) => t.includes('\n\n'))
    const b = await readStream(second, (t) => t.includes('\n\n'))
    assert.equal(app.fleet.hub.size, 2)
    await a.reader.cancel()
    for (let index = 0; index < 100 && app.fleet.hub.size > 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(app.fleet.hub.size, 1)
    app.service.change()
    const next = await readStream({ body: { getReader: () => b.reader } }, (t) => eventsIn(t).length >= 1)
    assert.equal(eventsIn(next.text)[0].id, '8')
    await b.reader.cancel()
  })

  it('dispose() ends open streams and unsubscribes from the service', async () => {
    app = await boot()
    const response = await fetch(app.url(FLEET_PATHS.stream))
    const { reader } = await readStream(response, (t) => t.includes('\n\n'))
    assert.equal(app.service.listenerCount(), 1)
    app.fleet.dispose()
    assert.equal(app.service.listenerCount(), 0)
    assert.equal(app.fleet.hub.size, 0)
    const { done } = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: 'timeout' }), 1000))])
    assert.equal(done, true, 'the stream was closed')
  })
})

/** A minimal ServerResponse stand-in for hub unit tests. */
function fakeResponse({ blocked = false } = {}) {
  const response = new EventEmitter()
  Object.assign(response, {
    written: [],
    ended: false,
    head: null,
    blocked,
    writeHead(status, headers) { response.head = { status, headers } },
    write(chunk) {
      if (response.throwOnWrite) throw new Error('socket is gone')
      response.written.push(chunk)
      return !response.blocked
    },
    end() { response.ended = true },
  })
  return response
}

describe('SSE hub (regression: the orchestrator iterated a Map as an array, so every event threw and closed the subscription)', () => {
  it('frame() writes a single-line data field, with event and id', () => {
    assert.equal(frame({ event: 'state', id: 5, data: { a: 'line1\nline2' } }), 'event: state\nid: 5\ndata: {"a":"line1\\nline2"}\n\n')
    assert.equal(frame({ data: 1 }), 'data: 1\n\n')
  })

  it('broadcasts to every client even when one of them throws or has closed', () => {
    const errors = []
    const hub = createSseHub({ onError: (error) => errors.push(error), heartbeatMs: 60_000 })
    const good = [fakeResponse(), fakeResponse()]
    const broken = fakeResponse()
    hub.add(good[0], { event: 'state', id: 1, data: { n: 1 } })
    hub.add(broken, { event: 'state', id: 1, data: { n: 1 } })
    hub.add(good[1], { event: 'state', id: 1, data: { n: 1 } })
    assert.equal(hub.size, 3)
    broken.throwOnWrite = true
    assert.doesNotThrow(() => hub.broadcast({ event: 'state', id: 2, data: { n: 2 } }))
    assert.equal(hub.size, 2, 'the failing client was dropped')
    assert.equal(broken.ended, true)
    assert.equal(errors.length, 1)
    for (const response of good) assert.ok(response.written.at(-1).includes('"n":2'), 'the healthy clients still got the event')
    hub.close()
  })

  it('removes a client when its response closes, and stops the heartbeat when none are left', () => {
    const hub = createSseHub({ heartbeatMs: 10 })
    const response = fakeResponse()
    hub.add(response, { event: 'state', id: 1, data: {} })
    assert.equal(hub.size, 1)
    response.emit('close')
    assert.equal(hub.size, 0)
    assert.doesNotThrow(() => hub.broadcast({ event: 'state', id: 2, data: {} }))
  })

  it('a slow reader keeps only the newest full state and gets it when it drains', () => {
    const hub = createSseHub({ heartbeatMs: 60_000 })
    const response = fakeResponse({ blocked: true })
    hub.add(response, { event: 'state', id: 1, data: { n: 1 } }) // the first write reports "full": the client is now behind
    const writesBefore = response.written.length
    for (const n of [2, 3, 4]) hub.broadcast({ event: 'state', id: n, data: { n } })
    assert.equal(response.written.length, writesBefore, 'nothing more is written while the reader is behind')
    response.blocked = false
    response.emit('drain')
    assert.equal(response.written.length, writesBefore + 1, 'one catch-up message')
    assert.ok(response.written.at(-1).includes('"n":4'), 'the newest state, not the intermediate ones')
    hub.close()
  })

  it('drops a client that has not drained for stallMs', () => {
    let now = 1000
    const hub = createSseHub({ heartbeatMs: 5, stallMs: 50, now: () => now })
    const response = fakeResponse({ blocked: true })
    hub.add(response, { event: 'state', id: 1, data: {} })
    now += 100
    return new Promise((resolve) => setTimeout(() => {
      assert.equal(hub.size, 0)
      assert.equal(response.ended, true)
      hub.close()
      resolve()
    }, 40))
  })

  it('sets the SSE headers and closes cleanly', () => {
    const hub = createSseHub({ heartbeatMs: 60_000 })
    const response = fakeResponse()
    hub.add(response, { event: 'state', id: 1, data: {} })
    assert.equal(response.head.status, 200)
    assert.equal(response.head.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.equal(response.head.headers['cache-control'], 'no-store')
    hub.close()
    assert.equal(response.ended, true)
    assert.equal(hub.size, 0)
  })
})

describe('security helpers', () => {
  const requestOf = (headers, chunks) => Object.assign((async function* () { for (const chunk of chunks) yield Buffer.from(chunk) })(), { headers })

  it('requireJson accepts application/json with parameters and nothing else', () => {
    assert.doesNotThrow(() => requireJson({ headers: { 'content-type': 'application/json' } }))
    assert.doesNotThrow(() => requireJson({ headers: { 'content-type': 'APPLICATION/JSON ; charset=UTF-8' } }))
    for (const type of [undefined, '', 'text/plain', 'application/json-seq', 'application/vnd.api+json']) {
      assert.throws(() => requireJson({ headers: { 'content-type': type } }), (error) => error instanceof HttpError && error.status === 415)
    }
  })

  it('readJsonBody parses, caps by received bytes, and uses fixed messages', async () => {
    assert.deepEqual(await readJsonBody(requestOf({}, ['{"a":', '1}'])), { a: 1 })
    await assert.rejects(readJsonBody(requestOf({}, ['x'.repeat(100), 'y'.repeat(100)]), { limitBytes: 150 }), (error) => error.status === 413)
    await assert.rejects(readJsonBody(requestOf({ 'content-length': '999999' }, ['{}']), { limitBytes: 150 }), (error) => error.status === 413)
    await assert.rejects(readJsonBody(requestOf({}, [])), (error) => error.status === 400 && error.reason === 'invalid-request')
    await assert.rejects(readJsonBody(requestOf({}, ['hunter2 is not json'])), (error) => error.status === 400 && !error.message.includes('hunter'))
  })
})
