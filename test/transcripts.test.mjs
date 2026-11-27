import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadContract, validateDef } from '../lib/fleet/schema.js'
import { DEFAULT_WINDOW_BYTES, TEXT_CAP, readFrames, supportsKind } from '../lib/transcripts/index.js'
import { CWD, SESSION_ID, T0, builders, expectedTurn, iso, jsonl, layout, sessionFor } from './fixtures/transcripts/builders.mjs'

const KINDS = ['pi', 'claude', 'codex']
const contract = loadContract()
const DENIED = { status: 'missing', reason: 'no-transcript' }

/* --------------------------------------------------------------------------------------------- helpers */

const temps = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-transcripts-'))
  temps.push(dir)
  return dir
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

/** A fresh home with the kind's session file written into it (`records`: objects, or raw text/bytes). */
function setup(kind, records, { home = tempDir(), file = layout[kind](home), eol = '\n' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof records === 'string' || Buffer.isBuffer(records) ? records : jsonl(records, eol))
  return { home, file, session: sessionFor(kind, file) }
}

const append = (file, records, eol = '\n') => fs.appendFileSync(file, typeof records === 'string' ? records : jsonl(records, eol))

const read = (kind, world, extra = {}) => readFrames({ kind, session: world.session, cwd: CWD, home: world.home, ...extra })

const at = (i) => T0 + 1000 + i * 1000

/** The records of `count` turns (and the kind's header unless `header` is false), the first being turn `from`. */
function conversation(kind, count, { header = true, from = 0 } = {}) {
  const b = builders[kind]
  const records = header ? [...b.header()] : []
  for (let i = from; i < from + count; i += 1) records.push(...b.turn(i, at(i)))
  return records
}

const headFrames = (kind) => (kind === 'claude' ? [] : [{ kind: 'session', sessionId: SESSION_ID, cwd: CWD }])
const expectedFrames = (kind, count, from = 0) => [...headFrames(kind), ...Array.from({ length: count }, (_, i) => expectedTurn(kind, from + i)).flat()]

/** Frames without ids and times: what the content is, not where it sits. */
const project = (frames) => frames.map(({ id, at, ...rest }) => rest)

const isResult = {
  pi: (r) => r.type === 'message' && r.message?.role === 'toolResult',
  claude: (r) => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content[0]?.type === 'tool_result',
  codex: (r) => r.type === 'response_item' && String(r.payload?.type).endsWith('_output'),
}
const resultIndexes = (kind, records) => records.flatMap((record, index) => (isResult[kind](record) ? [index] : []))

/** Turns with bookkeeping inside a tool run and unrecognized entries around them; returns how many are unrecognized. */
function noisy(kind, count) {
  const b = builders[kind]
  const records = [...b.header()]
  let unknown = 0
  for (let i = 0; i < count; i += 1) {
    const turn = b.turn(i, at(i))
    turn.splice(resultIndexes(kind, turn)[0] + 1, 0, b.bookkeeping(at(i) + 123))
    if (i % 3 === 0) { turn.push(b.unrecognized()); unknown += 1 }
    if (i % 4 === 1) { turn.unshift(b.unrecognized()); unknown += 1 }
    records.push(...turn)
  }
  return { records, unknown }
}

/** The synchronous node:fs surface the reader may use, with the bytes it reads counted; anything else is undefined. */
const SURFACE = ['realpathSync', 'statSync', 'fstatSync', 'openSync', 'readSync', 'closeSync', 'readdirSync']
function countingFs() {
  const stats = { bytes: 0, reads: 0 }
  const wrapped = { constants: fs.constants }
  for (const name of SURFACE) wrapped[name] = fs[name]
  wrapped.readSync = (...args) => {
    const got = fs.readSync(...args)
    stats.bytes += got
    stats.reads += 1
    return got
  }
  return { fs: wrapped, stats }
}

/** Every frame is a contract Frame and the result fits FramesResponse once the service adds its fields. */
function assertContract(result, kind = 'pi') {
  assert.equal(result.status, 'ok')
  for (const frame of result.frames) {
    assert.deepEqual(validateDef(contract, 'Frame', frame).errors, [], `frame ${JSON.stringify(frame).slice(0, 200)} must match the contract`)
  }
  const { status, ...rest } = result
  const response = { ok: true, paneId: 'w1:p1', source: 'transcript', reason: null, agentKind: kind, ...rest }
  assert.deepEqual(validateDef(contract, 'FramesResponse', response).errors, [], 'the result must fit FramesResponse')
  assert.equal(new Set(result.frames.map((frame) => frame.id)).size, result.frames.length, 'frame ids are unique')
}

/** Pages back through the whole file, newest page first; returns the pages oldest first. */
async function pageBack(kind, world, extra) {
  const pages = []
  let result = await read(kind, world, extra)
  assertContract(result, kind)
  pages.unshift(result)
  for (let guard = 0; result.hasEarlier; guard += 1) {
    assert.ok(guard < 3000, 'paging must terminate')
    assert.equal(typeof result.cursor.start, 'string', 'hasEarlier means there is a cursor to page from')
    result = await read(kind, world, { ...extra, before: result.cursor.start })
    assertContract(result, kind)
    pages.unshift(result)
  }
  return pages
}

const rootOf = (kind, home) => ({
  pi: path.join(home, '.pi', 'agent', 'sessions'),
  claude: path.join(home, '.claude', 'projects'),
  codex: path.join(home, '.codex', 'sessions'),
})[kind]
const dotDirOf = (kind, home) => path.join(home, { pi: '.pi', claude: '.claude', codex: '.codex' }[kind])

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

/* ------------------------------------------------------------------------------------------- the API */

describe('supportsKind', () => {
  it('knows pi, claude and codex and nothing else', () => {
    for (const kind of KINDS) assert.equal(supportsKind(kind), true)
    for (const kind of ['grok', 'opencode', 'gemini', '', null, undefined, 42, {}]) assert.equal(supportsKind(kind), false)
  })
})

describe('readFrames arguments', () => {
  it('throws a TypeError when before and after are both given', async () => {
    await assert.rejects(readFrames({ kind: 'pi', before: 's.1.2.0.abcdef012345', after: 'e.1.-.abcdef012345' }), TypeError)
  })

  it('treats null, undefined and an empty string as "no cursor"', async () => {
    const world = setup('pi', conversation('pi', 1))
    const plain = await read('pi', world)
    for (const absent of [null, undefined, '']) {
      assert.deepEqual(await read('pi', world, { before: absent, after: absent }), plain)
    }
  })

  it('rejects with the signal reason when aborted', async () => {
    const world = setup('pi', conversation('pi', 1))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(read('pi', world, { signal: controller.signal }), { name: 'AbortError' })
  })

  it('reports an unsupported agent before it looks at anything else', async () => {
    const world = setup('pi', conversation('pi', 1))
    for (const kind of ['grok', 'opencode', undefined, null, '']) {
      assert.deepEqual(await readFrames({ kind, session: world.session, cwd: CWD, home: world.home }), { status: 'missing', reason: 'unsupported-agent' })
    }
  })

  it('falls back to the default limit for nonsense and clamps a huge one', async () => {
    const world = setup('pi', conversation('pi', 3))
    const base = await read('pi', world)
    assert.equal(base.frames.length, 1 + 18)
    for (const limit of [undefined, null, 0, -3, 2.5, Number.NaN, 'many']) {
      assert.deepEqual(await read('pi', world, { limit }), base, `limit ${String(limit)} falls back to the default`)
    }
    assert.equal((await read('pi', world, { limit: 5 })).frames.length, 5)
    assert.equal((await read('pi', world, { limit: 100000 })).frames.length, 19, 'a huge limit is clamped, not an error')
  })
})

/* ------------------------------------------------------------------------------------- frames per kind */

for (const kind of KINDS) {
  const b = builders[kind]

  describe(`${kind}: frames`, () => {
    it('maps turns to text, reasoning, work and final frames that match the contract', async () => {
      const world = setup(kind, conversation(kind, 2))
      const result = await read(kind, world)
      assertContract(result, kind)
      assert.deepEqual(project(result.frames), expectedFrames(kind, 2))
      assert.equal(result.sessionId, SESSION_ID)
      assert.equal(result.hasEarlier, false)
      assert.equal(result.partial, false)
      assert.equal(result.reset, false)
      assert.equal(result.unknownFrames, 0)
      assert.equal(typeof result.cursor.start, 'string')
      assert.equal(typeof result.cursor.end, 'string')
    })

    it('gives frames stable ids that do not change as the file grows', async () => {
      const world = setup(kind, conversation(kind, 2))
      const first = await read(kind, world)
      append(world.file, conversation(kind, 2, { header: false, from: 2 }))
      const second = await read(kind, world)
      assertContract(second, kind)
      assert.deepEqual(second.frames.slice(0, first.frames.length), first.frames, 'frames that were there keep their ids and content')
      assert.equal(second.frames.length, first.frames.length + 12)
    })

    it('pairs calls with results whatever the order, and leaves unanswered calls pending', async () => {
      const records = conversation(kind, 1)
      const [a, c] = resultIndexes(kind, records)
      ;[records[a], records[c]] = [records[c], records[a]]
      const swapped = (await read(kind, setup(kind, records))).frames.find((frame) => frame.kind === 'work')
      assert.deepEqual(swapped.rows.map((row) => [row.verb, row.outcome, row.ms]), [['Read', 'ok', 12], ['Bash', 'error', 34]])

      const pending = setup(kind, [...b.header(), ...b.pending(0, at(0))])
      const open = (await read(kind, pending)).frames.find((frame) => frame.kind === 'work')
      assert.deepEqual(open.rows.map((row) => [row.verb, row.outcome, row.ms]), [['Read', null, null], ['Bash', null, null]], 'no result yet means outcome null')
      assert.equal(open.summary, 'Read · Bash')
      assert.equal(open.tokens, 40, 'the usage of the response that made the calls is known already')
    })

    it('reads CJK and emoji intact and never cuts a surrogate pair when capping', async () => {
      const text = '你好，世界 🙂 ' + 'あ'.repeat(10) + '👩‍💻🙂'
      const world = setup(kind, [...b.header(), b.user(0, at(0), text)])
      const whole = await read(kind, world)
      assert.equal(whole.frames.find((frame) => frame.kind === 'text').text, text)
      const points = [...text]
      for (let cap = 1; cap < points.length; cap += 1) {
        const cut = (await read(kind, world, { textCap: cap })).frames.find((frame) => frame.kind === 'text').text
        assert.equal(cut, `${points.slice(0, cap).join('')}…`, `cap ${cap}`)
        assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u, `cap ${cap} leaves no lone surrogate`)
      }
    })

    it('caps one giant entry at 8000 code points with an ellipsis', async () => {
      const world = setup(kind, [...b.header(), b.user(0, at(0), '界'.repeat(20000))])
      const text = (await read(kind, world)).frames.find((frame) => frame.kind === 'text').text
      assert.equal([...text].length, 8001)
      assert.ok(text.endsWith('…'))
      assert.equal(TEXT_CAP, 8000)
    })

    it('counts unrecognized entries and malformed lines, and never turns them into frames', async () => {
      const clean = conversation(kind, 1)
      const json = (record) => JSON.stringify(record)
      const lines = [
        json(clean[0]), json(b.unrecognized()), ...clean.slice(1, 3).map(json),
        '{"type": "mess', 'not json at all', '', '42', '[1,2]',
        json(b.unrecognized()), ...clean.slice(3).map(json),
      ]
      const result = await read(kind, setup(kind, `${lines.join('\n')}\n`))
      assertContract(result, kind)
      assert.equal(result.unknownFrames, 6, 'two unrecognized, two lines that are not JSON, two JSON values that are not objects; a blank line is nothing')
      assert.deepEqual(project(result.frames), expectedFrames(kind, 1))
    })

    it('reads recognized bookkeeping without counting it as unknown', async () => {
      const clean = conversation(kind, 1)
      const result = await read(kind, setup(kind, [clean[0], b.bookkeeping(), ...clean.slice(1), b.bookkeeping()]))
      assert.equal(result.unknownFrames, 0)
      assert.deepEqual(project(result.frames), expectedFrames(kind, 1))
    })

    it('ignores a half-written last line, does not count it, and delivers it once it is complete', async () => {
      const clean = conversation(kind, 1)
      const last = JSON.stringify(clean.at(-1))
      const half = Math.floor(last.length / 2)
      const world = setup(kind, jsonl(clean.slice(0, -1)) + last.slice(0, half))
      const early = await read(kind, world)
      assertContract(early, kind)
      assert.equal(early.unknownFrames, 0, 'an unfinished line is not an unknown entry')
      assert.equal(early.frames.some((frame) => frame.kind === 'final'), false)
      // Nothing new is complete: the same cursor keeps working.
      const quiet = await read(kind, world, { after: early.cursor.end })
      assert.deepEqual(quiet.frames, [])
      assert.equal(quiet.cursor.end, early.cursor.end)
      // The line completes.
      append(world.file, `${last.slice(half)}\n`)
      const next = await read(kind, world, { after: early.cursor.end })
      assert.equal(next.reset, false)
      assert.equal(next.frames.at(-1).kind, 'final')
      assert.equal(next.unknownFrames, 0)
    })

    it('reads a file with CRLF line endings exactly like one with LF', async () => {
      const lf = await read(kind, setup(kind, conversation(kind, 2)))
      const crlf = await read(kind, setup(kind, conversation(kind, 2), { eol: '\r\n' }))
      assertContract(crlf, kind)
      assert.deepEqual(project(crlf.frames), project(lf.frames))
      assert.equal(crlf.unknownFrames, 0)
    })

    it('reports an empty file as ok with no frames and no cursors', async () => {
      const result = await read(kind, setup(kind, ''))
      assert.deepEqual(result, { status: 'ok', sessionId: SESSION_ID, frames: [], hasEarlier: false, partial: false, reset: false, unknownFrames: 0, cursor: { start: null, end: null } })
    })
  })

  /* ------------------------------------------------------------------------------- windows and paging */

  describe(`${kind}: windows and paging`, () => {
    it('reads a file larger than the window as its tail: partial, hasEarlier, a suffix of the whole', async () => {
      const world = setup(kind, conversation(kind, 40))
      const whole = await read(kind, world, { limit: 500 })
      assert.equal(whole.frames.length, expectedFrames(kind, 40).length)
      assert.equal(whole.partial, false)
      assert.equal(whole.hasEarlier, false)
      const tail = await read(kind, world, { windowBytes: 4096 })
      assertContract(tail, kind)
      assert.equal(tail.partial, true)
      assert.equal(tail.hasEarlier, true)
      assert.ok(tail.frames.length > 0 && tail.frames.length < whole.frames.length)
      assert.deepEqual(tail.frames, whole.frames.slice(-tail.frames.length))
      assert.equal(tail.cursor.end, whole.cursor.end, 'both end at the same place')
    })

    it('is not partial when the file fits the window, even if there are more frames than the limit', async () => {
      const world = setup(kind, conversation(kind, 150))
      assert.ok(fs.statSync(world.file).size > 200_000)
      const result = await read(kind, world, { limit: 5 })
      assert.equal(result.frames.length, 5)
      assert.equal(result.partial, false)
      assert.equal(result.hasEarlier, true)
    })

    it('pages backwards through the whole file: every frame once, in order, equal to one unpaged read', async () => {
      const { records, unknown } = noisy(kind, 30)
      const world = setup(kind, records)
      const whole = await read(kind, world, { limit: 500, windowBytes: 1 << 26 })
      assertContract(whole, kind)
      assert.equal(whole.hasEarlier, false)
      assert.equal(whole.unknownFrames, unknown)
      assert.deepEqual(project(whole.frames), expectedFrames(kind, 30))
      for (const windowBytes of [700, 2500]) {
        for (const limit of [1, 4, 25]) {
          const label = `window ${windowBytes}, limit ${limit}`
          const pages = await pageBack(kind, world, { windowBytes, limit })
          assert.deepEqual(pages.flatMap((page) => page.frames), whole.frames, `${label}: the pages concatenate to the whole`)
          assert.ok(pages.every((page) => page.frames.length >= 1 && page.frames.length <= limit), `${label}: no page is empty or over the limit`)
          assert.equal(pages[0].hasEarlier, false, `${label}: the oldest page reaches the start`)
          assert.ok(pages.slice(1).every((page) => page.hasEarlier), `${label}: every other page says there is more`)
          assert.ok(pages.every((page) => page.reset === false), `${label}: paging never resets`)
          assert.equal(pages.reduce((sum, page) => sum + page.unknownFrames, 0), unknown, `${label}: the unknown counts add up`)
        }
      }
    })

    it('returns the frames strictly before the cursor, exactly one limit of them', async () => {
      const world = setup(kind, conversation(kind, 12))
      const whole = await read(kind, world, { limit: 500 })
      let newer = await read(kind, world, { limit: 10 })
      assert.deepEqual(newer.frames, whole.frames.slice(-10))
      let upto = whole.frames.length - 10
      while (newer.hasEarlier) {
        const older = await read(kind, world, { limit: 10, before: newer.cursor.start })
        assert.deepEqual(older.frames, whole.frames.slice(Math.max(0, upto - 10), upto))
        upto -= older.frames.length
        newer = older
      }
      assert.equal(upto, 0)
    })

    it('keeps a tool run whole across pages however small the window', async () => {
      const records = [...b.header(), b.user(0, at(0)), ...Array.from({ length: 30 }, (_, j) => b.step(0, j, at(1) + j * 100)).flat(), b.say(0, at(9), 'finished')]
      const world = setup(kind, records)
      const whole = await read(kind, world, { limit: 500 })
      const works = whole.frames.filter((frame) => frame.kind === 'work')
      assert.equal(works.length, 1, 'thirty steps with nothing in between are one run')
      assert.equal(works[0].rows.length, 30)
      assert.ok(works[0].rows.every((row) => row.outcome === 'ok'))
      for (const windowBytes of [300, 900, 4000]) {
        for (const limit of [1, 3]) {
          const pages = await pageBack(kind, world, { windowBytes, limit })
          assert.deepEqual(pages.flatMap((page) => page.frames), whole.frames, `window ${windowBytes}, limit ${limit}`)
        }
      }
    })

    it('splits a very long run at fixed byte boundaries, the same way for every read', async () => {
      const records = [...b.header(), b.user(0, at(0)), ...Array.from({ length: 30 }, (_, j) => b.step(0, j, at(1) + j * 100)).flat(), b.say(0, at(9), 'finished')]
      const world = setup(kind, records)
      const options = { runSpan: 4096 }
      const whole = await read(kind, world, { limit: 500, ...options })
      const works = whole.frames.filter((frame) => frame.kind === 'work')
      assert.ok(works.length > 1, 'a run of this size crosses 4096-byte boundaries')
      assert.equal(works.reduce((sum, frame) => sum + frame.rows.length, 0), 30)
      const pages = await pageBack(kind, world, { windowBytes: 900, limit: 2, ...options })
      assert.deepEqual(pages.flatMap((page) => page.frames), whole.frames)
    })

    it('reads a window of a big file, not the file, and an after read costs about what was appended', async () => {
      const world = setup(kind, conversation(kind, 300))
      const size = fs.statSync(world.file).size
      assert.ok(size > 400_000, `the file is big (${size} bytes)`)
      const tail = countingFs()
      const result = await read(kind, world, { fs: tail.fs, windowBytes: 8192 })
      assert.equal(result.partial, true)
      assert.equal(result.hasEarlier, true)
      assert.ok(tail.stats.bytes > 0)
      assert.ok(tail.stats.bytes <= 8192 * 3 + 2048, `read ${tail.stats.bytes} bytes of a ${size} byte file with an 8192 byte window`)

      const turn = conversation(kind, 1, { header: false, from: 300 })
      const appended = Buffer.byteLength(jsonl(turn))
      append(world.file, turn)
      const next = countingFs()
      const news = await read(kind, world, { fs: next.fs, windowBytes: 8192, after: result.cursor.end })
      assert.equal(news.frames.length, 6)
      assert.ok(next.stats.bytes <= appended * 2 + 2048, `read ${next.stats.bytes} bytes for ${appended} appended`)
    })

    it('never parses more than the default window of a huge file, and a short page needs only a short read', async () => {
      const records = [...b.header()]
      for (let i = 0; i < 35; i += 1) {
        const turn = b.turn(i, at(i))
        turn[0] = b.user(i, at(i), `question ${i} ${'x'.repeat(100_000)}`)
        records.push(...turn)
      }
      const world = setup(kind, records)
      assert.ok(fs.statSync(world.file).size > 3 * 1024 * 1024)
      assert.equal(DEFAULT_WINDOW_BYTES, 2 * 1024 * 1024)
      const big = countingFs()
      const result = await read(kind, world, { fs: big.fs, limit: 500 })
      assertContract(result, kind)
      assert.equal(result.partial, true)
      assert.equal(result.hasEarlier, true)
      assert.ok(big.stats.bytes <= DEFAULT_WINDOW_BYTES + 64 * 1024, `read ${big.stats.bytes} bytes`)
      const small = countingFs()
      const few = await read(kind, world, { fs: small.fs, limit: 3 })
      assert.equal(few.frames.length, 3)
      assert.ok(small.stats.bytes <= 1024 * 1024, `three frames took ${small.stats.bytes} bytes`)
    })
  })

  /* --------------------------------------------------------------------------------------------- after */

  describe(`${kind}: after`, () => {
    it('returns only what was appended, an empty array when nothing', async () => {
      const world = setup(kind, conversation(kind, 1))
      const first = await read(kind, world)
      const nothing = await read(kind, world, { after: first.cursor.end })
      assert.deepEqual(nothing, { status: 'ok', sessionId: SESSION_ID, frames: [], hasEarlier: false, partial: false, reset: false, unknownFrames: 0, cursor: { start: null, end: first.cursor.end } })

      append(world.file, conversation(kind, 1, { header: false, from: 1 }))
      const news = await read(kind, world, { after: first.cursor.end })
      assertContract(news, kind)
      assert.deepEqual(project(news.frames), expectedTurn(kind, 1))
      assert.equal(news.reset, false)
      assert.notEqual(news.cursor.end, first.cursor.end)

      const again = await read(kind, world, { after: news.cursor.end })
      assert.deepEqual(again.frames, [])
    })

    it('hands a pending tool run out again under the same id once its results arrive', async () => {
      const world = setup(kind, [...b.header(), ...b.pending(0, at(0))])
      const first = await read(kind, world)
      const pending = first.frames.at(-1)
      assert.equal(pending.kind, 'work')
      assert.deepEqual(pending.rows.map((row) => row.outcome), [null, null])
      const rest = b.turn(0, at(0)).slice(b.pending(0, at(0)).length)
      append(world.file, rest)
      const next = await read(kind, world, { after: first.cursor.end })
      assertContract(next, kind)
      assert.equal(next.frames.length, 3, 'the completed run, the closing text, the end of turn')
      assert.equal(next.frames[0].id, pending.id)
      assert.deepEqual(next.frames[0].rows.map((row) => [row.outcome, row.ms]), [['ok', 12], ['error', 34]])
      assert.equal(next.frames[0].tokens, 40)
      assert.deepEqual(project(next.frames.slice(1)), expectedTurn(kind, 0).slice(4))
    })

    it('hands the run out one result at a time, and nothing else', async () => {
      const turn = b.turn(0, at(0))
      const [a, c] = resultIndexes(kind, turn)
      const world = setup(kind, [...b.header(), ...b.pending(0, at(0))])
      const first = await read(kind, world)
      append(world.file, [turn[a]])
      const one = await read(kind, world, { after: first.cursor.end })
      assert.equal(one.frames.length, 1)
      assert.deepEqual(one.frames[0].rows.map((row) => row.outcome), ['ok', null])
      append(world.file, [turn[c]])
      const two = await read(kind, world, { after: one.cursor.end })
      assert.equal(two.frames.length, 1)
      assert.equal(two.frames[0].id, one.frames[0].id)
      assert.deepEqual(two.frames[0].rows.map((row) => row.outcome), ['ok', 'error'])
    })

    it('moves its cursor over bookkeeping and unknown entries, counting only the unknown ones', async () => {
      const world = setup(kind, conversation(kind, 1))
      const first = await read(kind, world)
      append(world.file, [b.bookkeeping()])
      const quiet = await read(kind, world, { after: first.cursor.end })
      assert.deepEqual([quiet.frames, quiet.unknownFrames, quiet.reset], [[], 0, false])
      assert.notEqual(quiet.cursor.end, first.cursor.end, 'the cursor moved past what it read')
      append(world.file, [b.unrecognized(), b.unrecognized()])
      const odd = await read(kind, world, { after: quiet.cursor.end })
      assert.deepEqual([odd.frames, odd.unknownFrames], [[], 2])
    })

    it('answers more news than a page with the newest page and a reset, not a window with a hole', async () => {
      const world = setup(kind, conversation(kind, 1))
      const first = await read(kind, world, { limit: 10 })
      append(world.file, conversation(kind, 5, { header: false, from: 1 }))
      const news = await read(kind, world, { limit: 10, after: first.cursor.end })
      assertContract(news, kind)
      assert.equal(news.reset, true)
      assert.equal(news.hasEarlier, true)
      assert.deepEqual(news.frames, (await read(kind, world, { limit: 10 })).frames)
    })

    it('answers an appended part larger than the window with a reset', async () => {
      const world = setup(kind, conversation(kind, 1))
      const first = await read(kind, world, { windowBytes: 4096 })
      append(world.file, conversation(kind, 10, { header: false, from: 1 }))
      assert.ok(fs.statSync(world.file).size > 4096 * 4)
      const news = await read(kind, world, { windowBytes: 4096, after: first.cursor.end })
      assertContract(news, kind)
      assert.equal(news.reset, true)
      assert.equal(news.partial, true)
    })
  })

  /* --------------------------------------------------------------------------------------------- reset */

  describe(`${kind}: reset`, () => {
    it('resets with a fresh tail when the file shrank', async () => {
      const world = setup(kind, conversation(kind, 3))
      const first = await read(kind, world)
      fs.writeFileSync(world.file, jsonl(conversation(kind, 1)))
      const news = await read(kind, world, { after: first.cursor.end })
      assert.equal(news.reset, true)
      assert.deepEqual({ ...news, reset: false }, await read(kind, world), 'the response is the new tail')
      assert.deepEqual(project(news.frames), expectedFrames(kind, 1))
    })

    it('resets when the file was replaced by a bigger one', async () => {
      const world = setup(kind, conversation(kind, 2))
      const first = await read(kind, world)
      fs.writeFileSync(world.file, jsonl(conversation(kind, 5, { from: 10 })))
      const news = await read(kind, world, { after: first.cursor.end })
      assertContract(news, kind)
      assert.equal(news.reset, true)
      assert.deepEqual(project(news.frames), expectedFrames(kind, 5, 10))
    })

    it('resets when the file was replaced by another of exactly the same size', async () => {
      const world = setup(kind, conversation(kind, 3))
      const first = await read(kind, world)
      const size = fs.statSync(world.file).size
      fs.writeFileSync(world.file, jsonl(conversation(kind, 3, { from: 5 })))
      assert.equal(fs.statSync(world.file).size, size, 'the replacement has the same length')
      const news = await read(kind, world, { after: first.cursor.end })
      assert.equal(news.reset, true)
      assert.deepEqual(project(news.frames), expectedFrames(kind, 3, 5))
    })

    it('resets when a cursor from another file is used to page backwards', async () => {
      const one = setup(kind, conversation(kind, 8))
      const two = setup(kind, conversation(kind, 8, { from: 20 }))
      const cursor = (await read(kind, one, { limit: 5 })).cursor.start
      const news = await read(kind, two, { limit: 5, before: cursor })
      assert.equal(news.reset, true)
      assert.deepEqual(news.frames, (await read(kind, two, { limit: 5 })).frames)
    })

    it('resets for cursors it cannot understand, and for a cursor used in the wrong place', async () => {
      const world = setup(kind, conversation(kind, 4))
      const tail = await read(kind, world, { limit: 5 })
      for (const bad of ['garbage', 'e.zz', 5, {}, 'e.1.-.nothex', `${tail.cursor.end}x`, tail.cursor.start]) {
        const viaAfter = await read(kind, world, { limit: 5, after: bad })
        assert.equal(viaAfter.reset, true, `after ${JSON.stringify(bad)}`)
        assert.deepEqual(viaAfter.frames, tail.frames)
      }
      for (const bad of ['garbage', 's.1', 5, tail.cursor.end]) {
        const viaBefore = await read(kind, world, { limit: 5, before: bad })
        assert.equal(viaBefore.reset, true, `before ${JSON.stringify(bad)}`)
        assert.deepEqual(viaBefore.frames, tail.frames)
      }
    })
  })
}

/* -------------------------------------------------------------------------------- why there is nothing */

describe('missing transcripts', () => {
  for (const kind of KINDS) {
    const b = builders[kind]

    it(`${kind}: no-transcript when herdr gave nothing and nothing is found by cwd`, async () => {
      const home = tempDir()
      for (const session of [null, undefined, {}, { value: '' }, { value: 42 }, { kind: 'path', source: `herdr:${kind}`, value: null }]) {
        assert.deepEqual(await readFrames({ kind, session, cwd: CWD, home }), DENIED, JSON.stringify(session))
      }
      assert.deepEqual(await readFrames({ kind, session: null, cwd: null, home }), DENIED)
      assert.deepEqual(await readFrames({ kind, session: null, cwd: 'relative/dir', home }), DENIED)
    })

    it(`${kind}: not-yet for a path inside the root that does not exist yet`, async () => {
      const home = tempDir()
      const file = layout[kind](home)
      assert.deepEqual(await readFrames({ kind, session: sessionFor(kind, file), cwd: CWD, home }), { status: 'missing', reason: 'not-yet' }, 'not even the directory exists')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      assert.deepEqual(await readFrames({ kind, session: sessionFor(kind, file), cwd: CWD, home }), { status: 'missing', reason: 'not-yet' }, 'the directory exists')
      fs.writeFileSync(file, jsonl(conversation(kind, 1)))
      assert.equal((await readFrames({ kind, session: sessionFor(kind, file), cwd: CWD, home })).status, 'ok', 'and then it appears')
    })

    it(`${kind}: unreadable for a directory with a .jsonl name`, async () => {
      const home = tempDir()
      const file = layout[kind](home)
      fs.mkdirSync(file, { recursive: true })
      assert.deepEqual(await readFrames({ kind, session: sessionFor(kind, file), cwd: CWD, home }), { status: 'missing', reason: 'unreadable' })
    })

    it(`${kind}: unreadable for a file the user cannot read`, { skip: isRoot ? 'root can read anything' : false }, async () => {
      const world = setup(kind, conversation(kind, 1))
      fs.chmodSync(world.file, 0)
      try {
        assert.deepEqual(await read(kind, world), { status: 'missing', reason: 'unreadable' })
      } finally {
        fs.chmodSync(world.file, 0o600)
      }
    })

    it(`${kind}: unreadable for binary junk and for a text file that is not a transcript`, async () => {
      const junk = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37 + 11) % 256))
      for (const content of [junk, Buffer.concat([Buffer.from([0, 255, 254, 10, 128, 129, 10]), junk]), 'hello\nworld\nthis is a log\n', '"a string"\n12\n[1]\n']) {
        assert.deepEqual(await read(kind, setup(kind, content)), { status: 'missing', reason: 'unreadable' }, JSON.stringify(String(content).slice(0, 20)))
      }
    })

    it(`${kind}: ok but empty for a first line that is still being written`, async () => {
      const first = JSON.stringify(conversation(kind, 1)[0])
      const result = await read(kind, setup(kind, first.slice(0, 20)))
      assert.equal(result.status, 'ok')
      assert.deepEqual(result.frames, [])
      assert.equal(result.unknownFrames, 0)
    })

    it(`${kind}: a record the adapter does not know is not a reason to call the file unreadable`, async () => {
      const result = await read(kind, setup(kind, [b.unrecognized(), b.unrecognized()]))
      assert.equal(result.status, 'ok')
      assert.deepEqual([result.frames, result.unknownFrames], [[], 2])
    })
  }
})

/* ----------------------------------------------------------------------------------------------- security */

describe('session paths are untrusted', () => {
  for (const kind of KINDS) {
    const b = builders[kind]

    /** A legitimate transcript inside the root, and an equally valid one outside it that must never be read. */
    function world() {
      const inside = setup(kind, conversation(kind, 1))
      const outsideDir = path.join(inside.home, 'outside')
      fs.mkdirSync(outsideDir)
      const secret = path.join(outsideDir, 'secret.jsonl')
      fs.writeFileSync(secret, jsonl([...b.header(), b.user(0, at(0), 'SECRET')]))
      return { ...inside, root: rootOf(kind, inside.home), outsideDir, secret }
    }
    const ask = async (w, value, cwd = CWD) => readFrames({ kind, session: sessionFor(kind, value), cwd, home: w.home })

    it(`${kind}: the control case reads the legitimate transcript, and the secret is a valid transcript too`, async () => {
      const w = world()
      assert.equal((await ask(w, w.file)).status, 'ok')
      assert.equal((await ask(w, fs.realpathSync(w.file))).status, 'ok', 'the resolved form of the same path works as well')
      const direct = await readFrames({ kind, session: null, cwd: CWD, home: w.home })
      assert.equal(direct.status, 'ok', 'cwd discovery finds it')
      // If the confinement were absent the secret would be read: prove it is a readable transcript.
      assert.equal((await readFrames({ kind, session: sessionFor(kind, w.secret), cwd: CWD, home: w.outsideDir })).status, 'missing')
    })

    it(`${kind}: refuses a path that climbs out of the root with ..`, async () => {
      const w = world()
      const climb = `${w.root}${path.sep}${path.relative(w.root, w.secret)}`
      assert.ok(climb.includes('..'), climb)
      assert.deepEqual(await ask(w, climb), DENIED)
      assert.deepEqual(await ask(w, `${path.dirname(w.file)}${path.sep}..${path.sep}..${path.sep}${path.relative(w.root, w.secret)}`), DENIED)
      // Even when nothing is there, "not yet" must not become a way to probe places outside the root.
      assert.deepEqual(await ask(w, `${w.root}${path.sep}..${path.sep}nowhere.jsonl`), DENIED)
      assert.deepEqual(await ask(w, `${w.root}${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}etc${path.sep}passwd.jsonl`), DENIED)
    })

    it(`${kind}: allows a .. that stays inside the root`, async () => {
      const w = world()
      const folded = `${path.dirname(w.file)}${path.sep}..${path.sep}${path.basename(path.dirname(w.file))}${path.sep}${path.basename(w.file)}`
      assert.equal((await ask(w, folded)).status, 'ok')
    })

    it(`${kind}: refuses a symlinked file that points outside the root`, async () => {
      const w = world()
      const link = path.join(path.dirname(w.file), 'link.jsonl')
      fs.symlinkSync(w.secret, link)
      assert.deepEqual(await ask(w, link), DENIED)
    })

    it(`${kind}: refuses a path through a symlinked directory that points outside the root`, async () => {
      const w = world()
      fs.symlinkSync(w.outsideDir, path.join(w.root, 'linkdir'))
      assert.deepEqual(await ask(w, path.join(w.root, 'linkdir', 'secret.jsonl')), DENIED)
      assert.deepEqual(await ask(w, path.join(w.root, 'linkdir', 'missing.jsonl')), DENIED, 'also when the file is not there')
    })

    it(`${kind}: allows a symlink that stays inside the root`, async () => {
      const w = world()
      const alias = path.join(w.root, 'alias.jsonl')
      fs.symlinkSync(w.file, alias)
      assert.equal((await ask(w, alias)).status, 'ok')
    })

    it(`${kind}: allows a relocated root, reached through its symlink or by its real path`, async () => {
      const w = world()
      const relocated = path.join(w.home, 'relocated')
      fs.mkdirSync(relocated)
      const dot = dotDirOf(kind, w.home)
      fs.renameSync(dot, path.join(relocated, path.basename(dot)))
      fs.symlinkSync(path.join(relocated, path.basename(dot)), dot)
      assert.equal((await ask(w, w.file)).status, 'ok', 'through the symlink')
      assert.equal((await ask(w, fs.realpathSync(w.file))).status, 'ok', 'by the real path')
    })

    it(`${kind}: refuses a path in a directory whose name merely starts like the root`, async () => {
      const w = world()
      const evil = `${w.root}-evil`
      fs.mkdirSync(evil, { recursive: true })
      fs.writeFileSync(path.join(evil, 'x.jsonl'), jsonl(conversation(kind, 1)))
      assert.deepEqual(await ask(w, path.join(evil, 'x.jsonl')), DENIED)
      assert.deepEqual(await ask(w, `${w.root}x${path.sep}y.jsonl`), DENIED)
    })

    it(`${kind}: refuses a directory, the root itself, and anything that is not a .jsonl file`, async () => {
      const w = world()
      assert.deepEqual(await ask(w, w.root), DENIED, 'the root')
      assert.deepEqual(await ask(w, path.dirname(w.file)), DENIED, 'a directory in the root')
      const notes = path.join(path.dirname(w.file), 'notes.txt')
      fs.writeFileSync(notes, jsonl(conversation(kind, 1)))
      assert.deepEqual(await ask(w, notes), DENIED, 'a non-.jsonl file with valid content')
      assert.deepEqual(await ask(w, `${w.file}.txt`), DENIED)
      assert.deepEqual(await ask(w, w.file.replace(/\.jsonl$/, '.JSONL')), DENIED, 'the extension is exact')
      const plain = path.join(path.dirname(w.file), 'plain')
      fs.symlinkSync(w.file, plain)
      assert.deepEqual(await ask(w, plain), DENIED, 'a symlink without the extension')
    })

    it(`${kind}: refuses values that are not usable paths`, async () => {
      const w = world()
      assert.deepEqual(await ask(w, `${w.file}\0`), DENIED)
      assert.deepEqual(await ask(w, '\0'), DENIED)
      assert.deepEqual(await ask(w, 'x/y.jsonl', null), DENIED, 'relative with no cwd to resolve against')
      assert.deepEqual(await ask(w, path.relative(path.dirname(w.file), w.secret), path.dirname(w.file)), DENIED, 'relative, resolving outside')
      const relative = path.relative(w.root, w.file)
      assert.equal((await ask(w, relative, w.root)).status, 'ok', 'relative, resolving inside')
      assert.deepEqual(await ask(w, '/etc/hosts'), DENIED)
      assert.deepEqual(await ask(w, '/'), DENIED)
    })

    it(`${kind}: never returns the content of a refused file in any field`, async () => {
      const w = world()
      const climb = `${w.root}${path.sep}${path.relative(w.root, w.secret)}`
      const link = path.join(path.dirname(w.file), 'link.jsonl')
      fs.symlinkSync(w.secret, link)
      for (const value of [climb, link]) {
        const result = await ask(w, value)
        assert.equal(JSON.stringify(result).includes('SECRET'), false)
        assert.deepEqual(Object.keys(result), ['status', 'reason'])
      }
    })
  }

  it('refuses a rollout symlinked to outside the root when choosing by cwd, without opening it', async () => {
    const home = tempDir()
    const outside = path.join(home, 'outside')
    fs.mkdirSync(outside)
    const secret = path.join(outside, 'rollout-secret.jsonl')
    fs.writeFileSync(secret, jsonl([...builders.codex.header({ cwd: '/Users/demo/secret' }), builders.codex.user(0, at(0), 'SECRET')]))
    const link = layout.codex(home, { id: 'cccccccc-0000-4000-8000-00000000000c', day: '2026/01/05', stamp: '2026-01-05T00-00-00' })
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(secret, link)
    assert.deepEqual(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/secret', home }), DENIED)
  })
})

/* ------------------------------------------------------------------------------- finding by cwd or id */

describe('finding the transcript without a path from herdr', () => {
  const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
  const utimes = (file, seconds) => fs.utimesSync(file, T0 / 1000 + seconds, T0 / 1000 + seconds)

  /** A codex rollout with its own cwd, id and place in the date tree. */
  function rollout(home, { cwd, n, day, extra = {}, text = `question in ${cwd}` }) {
    const file = layout.codex(home, { id: id(n), day, stamp: `${day.replaceAll('/', '-')}T00-00-00` })
    setup('codex', [...builders.codex.header({ id: id(n), cwd, ...extra }), builders.codex.user(0, at(0), text)], { home, file })
    return file
  }
  const idOf = (result) => result.sessionId

  it('codex: picks the newest rollout that was started in the pane\'s cwd, not the newest of anyone', async () => {
    const home = tempDir()
    const a1 = rollout(home, { cwd: '/Users/demo/a', n: 1, day: '2026/01/01' })
    const a2 = rollout(home, { cwd: '/Users/demo/a', n: 2, day: '2026/01/02' })
    const b = rollout(home, { cwd: '/Users/demo/b', n: 3, day: '2026/01/03' })
    utimes(a1, 10)
    utimes(a2, 20)
    utimes(b, 30)
    const forA = await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/a', home })
    assert.equal(idOf(forA), id(2))
    assert.equal(forA.frames.find((frame) => frame.kind === 'text').text, 'question in /Users/demo/a')
    assert.equal(idOf(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/b', home })), id(3))
    assert.deepEqual(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/c', home }), DENIED)
    assert.deepEqual(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/a/sub', home }), DENIED, 'a parent or child directory is not the same cwd')
  })

  it('codex: "newest" means most recently modified, since a resumed rollout keeps its old name', async () => {
    const home = tempDir()
    const old = rollout(home, { cwd: '/Users/demo/a', n: 1, day: '2026/01/01' })
    const young = rollout(home, { cwd: '/Users/demo/a', n: 2, day: '2026/01/09' })
    utimes(old, 50)
    utimes(young, 10)
    assert.equal(idOf(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/a', home })), id(1))
  })

  it('codex: matches the cwd spelled with a trailing slash, and skips rollouts of spawned sub-agents', async () => {
    const home = tempDir()
    const own = rollout(home, { cwd: '/Users/demo/a', n: 1, day: '2026/01/01' })
    const sub = rollout(home, { cwd: '/Users/demo/a', n: 2, day: '2026/01/02', extra: { parent_thread_id: id(1) } })
    utimes(own, 10)
    utimes(sub, 40)
    assert.equal(idOf(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/a/', home })), id(1))
  })

  it('codex: a path from herdr wins over the cwd, and an id finds its own rollout', async () => {
    const home = tempDir()
    const a = rollout(home, { cwd: '/Users/demo/a', n: 1, day: '2026/01/01' })
    const b = rollout(home, { cwd: '/Users/demo/b', n: 2, day: '2026/01/02' })
    utimes(a, 10)
    utimes(b, 20)
    assert.equal(idOf(await readFrames({ kind: 'codex', session: sessionFor('codex', a), cwd: '/Users/demo/b', home })), id(1))
    const byId = { agent: 'codex', kind: 'id', source: 'herdr:codex', value: id(1) }
    assert.equal(idOf(await readFrames({ kind: 'codex', session: byId, cwd: '/Users/demo/b', home })), id(1))
    assert.deepEqual(await readFrames({ kind: 'codex', session: { ...byId, value: id(9) }, cwd: '/Users/demo/b', home }), DENIED, 'an unknown id is not "the newest file"')
  })

  it('codex: reads only the synchronous node:fs surface (a wrapper without anything else is enough)', async () => {
    const home = tempDir()
    rollout(home, { cwd: '/Users/demo/a', n: 1, day: '2026/01/01' })
    const { fs: counted } = countingFs()
    assert.equal(idOf(await readFrames({ kind: 'codex', session: null, cwd: '/Users/demo/a', home, fs: counted })), id(1))
  })

  for (const kind of ['pi', 'claude']) {
    it(`${kind}: picks the newest file in the cwd's own directory, by modification time`, async () => {
      const home = tempDir()
      const mine = [1, 2, 3].map((n) => setup(kind, conversation(kind, 1), { home, file: layout[kind](home, { id: id(n) }) }).file)
      const theirs = setup(kind, conversation(kind, 1), { home, file: layout[kind](home, { cwd: '/Users/demo/other', id: id(9) }) }).file
      utimes(mine[0], 10)
      utimes(mine[1], 30)
      utimes(mine[2], 20)
      utimes(theirs, 90)
      assert.equal(idOf(await readFrames({ kind, session: null, cwd: CWD, home })), id(2))
      assert.equal(idOf(await readFrames({ kind, session: null, cwd: `${CWD}/`, home })), id(2), 'a trailing slash is the same cwd')
      assert.deepEqual(await readFrames({ kind, session: null, cwd: '/Users/demo/never', home }), DENIED)
    })

    it(`${kind}: finds a session by id in the cwd's directory, and never falls back to another file`, async () => {
      const home = tempDir()
      const first = setup(kind, conversation(kind, 1), { home, file: layout[kind](home, { id: id(1) }) }).file
      const second = setup(kind, conversation(kind, 1), { home, file: layout[kind](home, { id: id(2) }) }).file
      utimes(first, 10)
      utimes(second, 20)
      const byId = (value) => ({ agent: kind, kind: 'id', source: `herdr:${kind}`, value })
      assert.equal(idOf(await readFrames({ kind, session: byId(id(1)), cwd: CWD, home })), id(1))
      assert.deepEqual(await readFrames({ kind, session: byId(id(7)), cwd: CWD, home }), DENIED)
    })

    it(`${kind}: a relative path from herdr is resolved against the pane's cwd`, async () => {
      const home = tempDir()
      const { file } = setup(kind, conversation(kind, 1), { home })
      const relative = path.join(path.basename(path.dirname(file)), path.basename(file))
      const result = await readFrames({ kind, session: sessionFor(kind, relative), cwd: path.dirname(path.dirname(file)), home })
      assert.equal(result.status, 'ok')
    })
  }

  it('claude: finds a directory whether Claude dashed every symbol or only the slashes', async () => {
    const home = tempDir()
    const cwd = '/Users/demo/my.app'
    const dashed = path.join(home, '.claude', 'projects', '-Users-demo-my-app', `${id(1)}.jsonl`)
    setup('claude', conversation('claude', 1), { home, file: dashed })
    assert.equal(idOf(await readFrames({ kind: 'claude', session: null, cwd, home })), id(1))
    const home2 = tempDir()
    const slashed = path.join(home2, '.claude', 'projects', '-Users-demo-my.app', `${id(2)}.jsonl`)
    setup('claude', conversation('claude', 1), { home: home2, file: slashed })
    assert.equal(idOf(await readFrames({ kind: 'claude', session: null, cwd, home: home2 })), id(2))
  })

  it('claude: does not read the transcripts of sub-agents that live below the session', async () => {
    const home = tempDir()
    const file = layout.claude(home, { id: id(1) })
    setup('claude', conversation('claude', 1), { home, file })
    const sub = path.join(path.dirname(file), id(1), 'subagents', 'agent-1.jsonl')
    setup('claude', conversation('claude', 2), { home, file: sub })
    utimes(file, 10)
    utimes(sub, 50)
    assert.equal(idOf(await readFrames({ kind: 'claude', session: null, cwd: CWD, home })), id(1))
  })
})

/* -------------------------------------------------------------------------------------- pi specifics */

describe('pi: what its records mean', () => {
  const b = builders.pi
  const message = (id, t, m) => ({ type: 'message', id, timestamp: iso(t), message: { ...m, timestamp: t } })
  const frames = async (records) => (await read('pi', setup('pi', records))).frames

  it('reads the time from message.timestamp (epoch ms), not from the ISO string on the entry', async () => {
    const [user] = await frames([b.user(0, at(0))])
    assert.equal(user.at, at(0))
    const [fromEntry] = await frames([{ type: 'message', id: 'u', timestamp: iso(at(2)), message: { role: 'user', content: [{ type: 'text', text: 'no message time' }] } }])
    assert.equal(fromEntry.at, at(2), 'falls back to the ISO time of the entry')
    const [none] = await frames([{ type: 'message', id: 'u', message: { role: 'user', content: 'no time at all' } }])
    assert.equal(none.at, null)
  })

  it('takes a tool duration from durationMs and leaves it null when pi did not record one', async () => {
    const records = [b.user(0, at(0)), b.assistant(0, at(0) + 10, [b.call('c1', 'Bash', { command: 'a' }), b.call('c2', 'Bash', { command: 'b' })]), b.result(0, at(0) + 20, 'c1', 'Bash', false, 7), b.result(0, at(0) + 30, 'c2', 'Bash', false)]
    const work = (await frames(records)).find((frame) => frame.kind === 'work')
    assert.deepEqual(work.rows.map((row) => row.ms), [7, null])
    assert.equal(work.tokens, 40, 'two calls of one message are one usage')
  })

  it('leaves tokens null when the message carries no usage', async () => {
    const records = [b.assistant(0, at(0), [b.call('c1', 'Bash', { command: 'a' })], { usage: undefined })]
    assert.equal((await frames(records)).find((frame) => frame.kind === 'work').tokens, null)
  })

  it('marks the end of a turn with the raw stop reason, and carries an error message', async () => {
    const stops = await frames([
      message('a', at(0), { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }),
      message('b', at(1), { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'upstream said no' }),
      message('c', at(2), { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' }),
      message('d', at(3), { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'Bash', arguments: { command: 'a' } }], stopReason: 'toolUse' }),
    ])
    assert.deepEqual(stops.filter((frame) => frame.kind === 'final').map(({ id, ...rest }) => rest), [
      { kind: 'final', text: '', reason: 'stop', ms: null },
      { kind: 'final', text: 'upstream said no', reason: 'error', ms: null },
      { kind: 'final', text: '', reason: 'aborted', ms: null },
    ])
    assert.equal(stops.filter((frame) => frame.kind === 'work').length, 1, 'toolUse is not an end')
  })

  it('shows extension messages only when pi displays them, notes a compaction, ignores the system prompt', async () => {
    const result = await frames([
      { type: 'custom_message', id: 'm1', customType: 'note', content: 'shown to the user', display: true, details: {} },
      { type: 'custom_message', id: 'm2', customType: 'note', content: 'hidden from the user', display: false, details: {} },
      { type: 'compaction', id: 'c1', summary: 'long summary that must not be copied', tokensBefore: 1234, firstKeptEntryId: 'x' },
      { type: 'compaction', id: 'c2', summary: 'another' },
      message('s', at(0), { role: 'system', content: 'You are a helpful agent' }),
    ])
    assert.deepEqual(project(result), [
      { kind: 'text', role: 'system', text: 'shown to the user' },
      { kind: 'text', role: 'system', text: 'Context compacted · 1234 tokens before' },
      { kind: 'text', role: 'system', text: 'Context compacted' },
    ])
    const world = setup('pi', [{ type: 'custom_message', id: 'm2', content: 'hidden', display: false }, message('s', at(0), { role: 'system', content: 'prompt' })])
    assert.equal((await read('pi', world)).unknownFrames, 0)
  })

  it('shows a command the user ran by hand as a finished work row', async () => {
    const result = await frames([
      message('x1', at(0), { role: 'bashExecution', command: 'ls -la', output: 'total 0', exitCode: 0, cancelled: false, truncated: false }),
      message('x2', at(1), { role: 'bashExecution', command: 'false', output: '', exitCode: 1, cancelled: false, truncated: false }),
    ])
    assert.deepEqual(project(result), [{ kind: 'work', summary: 'bash ×2', rows: [{ verb: 'bash', object: 'ls -la', outcome: 'ok', ms: null }, { verb: 'bash', object: 'false', outcome: 'error', ms: null }], tokens: null }])
  })

  it('takes only the header at the top as the session, and counts an unknown message role as unknown', async () => {
    const header = b.header()[0]
    const result = await read('pi', setup('pi', [header, b.user(0, at(0)), { ...header, id: 'forked' }, message('w', at(1), { role: 'wizard', content: [] })]))
    assert.deepEqual(result.frames.map((frame) => frame.kind), ['session', 'text'])
    assert.equal(result.frames[0].sessionId, SESSION_ID)
    assert.equal(result.unknownFrames, 1)
  })

  it('skips empty thinking and text, and ignores image blocks', async () => {
    const records = [b.assistant(0, at(0), [{ type: 'thinking', thinking: '  ' }, { type: 'text', text: '' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], { stopReason: 'length' })]
    assert.deepEqual(project(await frames(records)), [{ kind: 'final', text: '', reason: 'length', ms: null }])
  })
})

/* ---------------------------------------------------------------------------------- claude specifics */

describe('claude: what its records mean', () => {
  const b = builders.claude
  const frames = async (records) => (await read('claude', setup('claude', records))).frames

  it('writes no session frame (there is no header record) but knows the session id', async () => {
    const result = await read('claude', setup('claude', conversation('claude', 1), { file: layout.claude(tempDir(), { id: 'not-a-uuid' }) }))
    assert.equal(result.frames.some((frame) => frame.kind === 'session'), false)
    assert.equal(result.sessionId, SESSION_ID, 'from the records when the file name is no uuid')
  })

  it('counts the usage of an assistant message once however many records it was written as', async () => {
    const records = [b.user(0, at(0)), b.block(0, at(1), { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'x' } }, 'msg_1'), b.block(0, at(2), { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'y' } }, 'msg_1'), b.block(0, at(3), { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'z' } }, 'msg_2')]
    const work = (await frames(records)).find((frame) => frame.kind === 'work')
    assert.equal(work.tokens, 80, 'two messages of 40, not three records of 40')
    assert.equal(work.rows.length, 3)
  })

  it('takes the turn duration from turn_duration and ignores other system records', async () => {
    const system = (t, subtype, extra = {}) => ({ type: 'system', subtype, uuid: `s${t}`, timestamp: iso(t), sessionId: SESSION_ID, ...extra })
    const result = await frames([system(at(0), 'turn_duration', { durationMs: 4200 }), system(at(1), 'api_error', { error: {} }), system(at(2), 'away_summary', { content: 'x' }), system(at(3), 'turn_duration'), system(at(4), 'compact_boundary')])
    assert.deepEqual(project(result), [
      { kind: 'final', text: '', reason: 'turn_duration', ms: 4200 },
      { kind: 'final', text: '', reason: 'turn_duration', ms: null },
      { kind: 'text', role: 'system', text: 'Context compacted' },
    ])
    const world = setup('claude', [system(at(1), 'api_error'), system(at(2), 'something_new')])
    assert.equal((await read('claude', world)).unknownFrames, 0)
  })

  it('leaves out sub-agent conversations, injected meta messages and harness wrappers', async () => {
    const meta = { ...b.user(0, at(0), 'injected skill text'), isMeta: true }
    const result = await frames([
      meta,
      { ...b.user(1, at(1), 'subagent says hi'), isSidechain: true },
      { ...b.block(0, at(2), { type: 'text', text: 'subagent reply' }), isSidechain: true },
      b.user(2, at(3), '<command-name>/clear</command-name>'),
      b.user(3, at(4), '<local-command-stdout>output</local-command-stdout>'),
      b.user(4, at(5), '<system-reminder>be careful</system-reminder>'),
      b.user(5, at(6), 'a real question'),
      { ...b.user(6, at(7), ''), message: { role: 'user', content: [{ type: 'text', text: '<pasted_content id="1">pasted by the user</pasted_content>' }] } },
    ])
    assert.deepEqual(project(result), [
      { kind: 'text', role: 'user', text: 'a real question' },
      { kind: 'text', role: 'user', text: '<pasted_content id="1">pasted by the user</pasted_content>' },
    ])
  })

  it('shows an interruption as the system speaking, and an API error placeholder too', async () => {
    const result = await frames([
      { ...b.user(0, at(0)), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      b.block(0, at(1), { type: 'text', text: 'API Error: 529 overloaded' }, 'msg_e', { isApiErrorMessage: true }),
    ])
    assert.deepEqual(project(result), [
      { kind: 'text', role: 'system', text: '[Request interrupted by user]' },
      { kind: 'text', role: 'system', text: 'API Error: 529 overloaded' },
    ])
  })

  it('reads a tool result that arrives together with user text, and gives unanswered calls null', async () => {
    const result = await frames([
      b.block(0, at(0), { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'x' } }),
      { ...b.toolResult(0, at(0) + 40, 'a', false), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    ])
    assert.deepEqual(project(result).map((frame) => frame.kind), ['work', 'text'])
    assert.deepEqual(result[0].rows, [{ verb: 'Bash', object: 'x', outcome: 'ok', ms: 40 }])
  })

  it('describes a tool by what it was pointed at, one line, clipped', async () => {
    const records = [
      b.block(0, at(0), { type: 'tool_use', id: 'a', name: 'Bash', input: { command: `echo   hello\n\tworld ${'x'.repeat(300)}`, description: 'ignored' } }, 'm1'),
      b.block(0, at(1), { type: 'tool_use', id: 'b', name: 'Task', input: { subagent_type: 'x', prompt: 'do the thing' } }, 'm2'),
      b.block(0, at(2), { type: 'tool_use', id: 'c', name: 'Odd', input: { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 } }, 'm3'),
      b.block(0, at(3), { type: 'tool_use', id: 'd', name: 'None' }, 'm4'),
    ]
    const rows = (await frames(records)).find((frame) => frame.kind === 'work').rows
    assert.equal(rows[0].object, `echo hello world ${'x'.repeat(120 - 'echo hello world '.length)}…`)
    assert.equal(rows[1].object, 'do the thing')
    assert.equal(rows[2].object, 'alpha, beta, gamma, delta')
    assert.equal(rows[3].object, '')
    assert.equal((await frames(records)).find((frame) => frame.kind === 'work').summary, 'Bash · Task · Odd · None')
  })

  it('summarizes repeated verbs with a count and caps the list', async () => {
    const call = (n, name) => b.block(0, at(n), { type: 'tool_use', id: `t${n}`, name, input: { command: 'x' } }, `m${n}`)
    const work = (await frames([call(0, 'Read'), call(1, 'Read'), call(2, 'Read'), call(3, 'Bash'), call(4, 'Edit'), call(5, 'Grep'), call(6, 'Glob')])).find((frame) => frame.kind === 'work')
    assert.equal(work.summary, 'Read ×3 · Bash · Edit · +2')
  })
})

/* ---------------------------------------------------------------------------------- codex specifics */

describe('codex: what its records mean', () => {
  const b = builders.codex
  const frames = async (records) => (await read('codex', setup('codex', records))).frames

  it('leaves out the harness prompt and injected context, and does not repeat messages the UI events mirror', async () => {
    const mirror = (t, item) => b.event(t, { type: 'item_completed', item })
    const result = await read('codex', setup('codex', [
      b.header()[0],
      b.item(at(0), { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] }),
      b.item(at(1), { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/Users/demo</cwd>\n</environment_context>' }] }),
      b.item(at(2), { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/demo\n\nbe nice' }] }),
      b.user(0, at(3)),
      mirror(at(3), { type: 'UserMessage', id: 'x', content: [{ type: 'text', text: 'question 0' }] }),
      b.item(at(4), { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], content: null }),
      mirror(at(4), { type: 'Reasoning', id: 'r', summary_text: ['thinking'] }),
      b.item(at(5), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }),
      mirror(at(5), { type: 'AgentMessage', id: 'm', text: 'hi' }),
      b.event(at(6), { type: 'thread_settings_applied' }),
      b.event(at(6), { type: 'task_started', turn_id: 't' }),
    ]))
    assert.deepEqual(project(result.frames), [
      { kind: 'session', sessionId: SESSION_ID, cwd: CWD },
      { kind: 'text', role: 'user', text: 'question 0' },
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'text', role: 'assistant', text: 'hi' },
    ])
    assert.equal(result.unknownFrames, 0)
  })

  it('reads the outcome of a custom tool from its Script completed / Script failed header', async () => {
    const out = (id, text) => b.item(at(2), { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text }, { type: 'input_text', text: 'details' }] })
    const call = (id) => b.item(at(1), { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'run()', status: 'completed' })
    const work = (await frames([call('a'), call('b'), call('c'), out('a', 'Script completed'), out('b', 'Script failed'), out('c', 'Script running with cell ID 7')])).find((frame) => frame.kind === 'work')
    assert.deepEqual(work.rows.map((row) => row.outcome), ['ok', 'error', 'ok'])
  })

  it('reads the outcome of a function tool from its exit code, its metadata, or its flags', async () => {
    const call = (id) => b.item(at(1), { type: 'function_call', name: 'shell', call_id: id, arguments: '{"command":["ls"]}' })
    const out = (id, output, extra = {}) => b.item(at(2), { type: 'function_call_output', call_id: id, output, ...extra })
    const records = [
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(call),
      out('a', 'Exit code: 0\nWall time: 1 seconds\nOutput:\nfine'),
      out('b', 'Exit code: 2\nOutput:\nbad'),
      out('c', JSON.stringify({ output: 'x', metadata: { exit_code: 0 } })),
      out('d', JSON.stringify({ output: 'x', metadata: { exit_code: 127 } })),
      out('e', 'plain text with no status'),
      out('f', 'whatever', { is_error: true }),
      out('g', { success: false }),
    ]
    const work = (await frames(records)).find((frame) => frame.kind === 'work')
    assert.deepEqual(work.rows.map((row) => row.outcome), ['ok', 'error', 'ok', 'error', 'ok', 'error', 'error'])
    assert.equal(work.rows[0].object, 'ls', 'the command array of the arguments is the object')
  })

  it('ends a turn at task_complete or turn_aborted, with the duration the agent recorded', async () => {
    const result = await frames([
      b.event(at(0), { type: 'task_complete', last_agent_message: 'all done', duration_ms: 1500 }),
      b.event(at(1), { type: 'task_complete', last_agent_message: null, duration_ms: 'soon', error: { message: 'x' } }),
      b.event(at(2), { type: 'turn_aborted', reason: 'interrupted', duration_ms: 800 }),
      b.event(at(3), { type: 'turn_aborted', reason: 'interrupted' }),
    ])
    assert.deepEqual(project(result), [
      { kind: 'final', text: 'all done', reason: 'task_complete', ms: 1500 },
      { kind: 'final', text: '', reason: 'task_complete', ms: null },
      { kind: 'final', text: '', reason: 'turn_aborted', ms: 800 },
      { kind: 'final', text: '', reason: 'turn_aborted', ms: null },
    ])
  })

  it('counts output tokens once per model response, and ignores a token_count without info', async () => {
    const call = (id, t) => b.item(t, { type: 'function_call', name: 'shell', call_id: id, arguments: '{}' })
    const count = (t, total, output) => b.event(t, { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { output_tokens: output } } })
    const work = (await frames([call('a', at(0)), count(at(0) + 1, 100, 30), count(at(0) + 2, 100, 30), call('b', at(1)), count(at(1) + 1, 250, 25), b.event(at(2), { type: 'token_count', info: null })])).find((frame) => frame.kind === 'work')
    assert.equal(work.tokens, 55, 'the repeated report of the same response is not added again')
  })

  it('takes searches and local shell calls as work, and counts payload types it does not know as unknown', async () => {
    const world = setup('codex', [
      b.header()[0],
      b.item(at(0), { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'node test runner' } }),
      b.item(at(1), { type: 'local_shell_call', call_id: 'l1', status: 'completed', action: { type: 'exec', command: ['git', 'status'] } }),
      b.item(at(2), { type: 'function_call_output', call_id: 'l1', output: 'Exit code: 0\nOutput:\nclean' }),
      b.item(at(3), { type: 'agent_message', author: 'a', recipient: 'b', content: [] }),
      b.item(at(4), { type: 'hologram_call' }),
      { timestamp: iso(at(5)), type: 'compacted', payload: { message: 'long summary' } },
    ])
    const result = await read('codex', world)
    assert.deepEqual(project(result.frames), [
      { kind: 'session', sessionId: SESSION_ID, cwd: CWD },
      { kind: 'work', summary: 'web_search · shell', rows: [{ verb: 'web_search', object: 'node test runner', outcome: 'ok', ms: 0 }, { verb: 'shell', object: 'git status', outcome: 'ok', ms: 2000 }], tokens: null },
      { kind: 'text', role: 'system', text: 'Context compacted' },
    ])
    assert.equal(result.unknownFrames, 1)
  })

  it('takes only the head of the file as the session, whatever follows', async () => {
    const result = await frames([...b.header(), ...b.header({ id: 'inherited', cwd: '/Users/demo/parent' }), b.user(0, at(0))])
    assert.deepEqual(result.map((frame) => frame.kind), ['session', 'text'])
    assert.equal(result[0].sessionId, SESSION_ID)
  })
})
