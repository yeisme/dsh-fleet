import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FIXTURE_PATH, NOW, TIME_FIELDS, render } from '../scripts/gen-fixtures.mjs'
import { loadContract, validate, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()
const fixtureText = readFileSync(FIXTURE_PATH, 'utf8')
const fixtures = JSON.parse(fixtureText)
const scenarios = fixtures.scenarios
const docText = readFileSync(new URL('../docs/design/FLEET-API.md', import.meta.url), 'utf8')

const SEC = 1000
const DAY = 24 * 60 * 60 * SEC
const STALL_MS = 180 * SEC
const VERBS = ['prompt', 'answer', 'keys', 'interrupt', 'rename', 'restart', 'close']
const NEEDS_CONFIRM = new Set(['restart', 'close'])
const KEYS = contract.$defs.Key.enum
const requestDef = (verb) => `${verb[0].toUpperCase()}${verb.slice(1)}Request`
const errorsOf = (def, value) => validateDef(contract, def, value).errors
const agentPanes = (state) => state.panes.filter((pane) => pane.agent !== null)
const mutated = (value, mutate) => { const copy = structuredClone(value); mutate(copy); return copy }

/**
 * The order in which the host must classify a request it rejects (FLEET-API.md, "Request validation order").
 * First failing check wins, so `confirm-required` is reported even when other fields are also wrong, and a bad key
 * is named as such rather than as a generic shape error.
 */
function classify(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.verb !== 'string') return 'invalid-request'
  if (!VERBS.includes(request.verb)) return 'unknown-verb'
  if (NEEDS_CONFIRM.has(request.verb) && request.confirm !== true) return 'confirm-required'
  if (request.verb === 'keys' && Array.isArray(request.keys) && request.keys.some((key) => !KEYS.includes(key))) return 'key-not-allowed'
  return 'invalid-request'
}

describe('fixtures/fleet.json', () => {
  it('validates against the FixtureFile contract', () => {
    assert.deepEqual(errorsOf('FixtureFile', fixtures), [])
  })

  it('is exactly what scripts/gen-fixtures.mjs produces (regenerate with: node scripts/gen-fixtures.mjs)', () => {
    assert.equal(fixtureText, render(), 'fixtures/fleet.json is stale or was edited by hand')
  })

  it('generation is deterministic', () => {
    assert.equal(render(), render())
  })

  it('has the scenario set the client relies on', () => {
    assert.deepEqual(Object.keys(scenarios).sort(), ['blocked', 'busy', 'calm', 'empty', 'offline', 'stale'])
    assert.equal(fixtures.now, NOW)
    for (const [name, scenario] of Object.entries(scenarios)) assert.equal(scenario.state.now, NOW, `${name}: state.now`)
  })

  it('contains no real home directory, host or account (neutral demo data only)', () => {
    assert.doesNotMatch(fixtureText, /\/Users\/(?!demo\/)/, 'a /Users/ path other than /Users/demo/')
    assert.doesNotMatch(fixtureText, /\/home\/|C:\\\\Users/)
  })
})

describe('scenario semantics (what the schema cannot express)', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    const { state, frames, screens } = scenario

    describe(name, () => {
      it('pane ids are unique and counts/workspaces are consistent with the panes', () => {
        assert.equal(new Set(state.panes.map((pane) => pane.id)).size, state.panes.length)
        const expected = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: state.panes.length }
        for (const pane of state.panes) {
          if (pane.agent === null) expected.shells += 1
          else { expected.agents += 1; expected[pane.status] += 1 }
        }
        assert.deepEqual(state.counts, expected)

        const byWorkspace = new Map()
        for (const pane of state.panes) {
          const entry = byWorkspace.get(pane.workspaceId) ?? { tabs: new Set(), panes: 0, focused: false }
          entry.tabs.add(pane.tabId)
          entry.panes += 1
          entry.focused ||= pane.focused
          byWorkspace.set(pane.workspaceId, entry)
        }
        assert.deepEqual(
          state.workspaces.map(({ id, tabCount, paneCount, focused }) => [id, tabCount, paneCount, focused]).sort(),
          [...byWorkspace].map(([id, entry]) => [id, entry.tabs.size, entry.panes, entry.focused]).sort(),
        )
        assert.ok(state.panes.filter((pane) => pane.focused).length <= 1, 'at most one focused pane')
      })

      it('stale implies disconnected; a connected herdr has no error and a last-ok time; a disconnected one says why', () => {
        if (state.stale) assert.equal(state.health.connected, false)
        if (state.health.connected) {
          assert.equal(state.health.error, null)
          assert.notEqual(state.health.lastOkAt, null)
        } else {
          assert.notEqual(state.health.error, null)
        }
      })

      it('titles carry no leading status glyph (herdr\'s terminal_title_stripped; the UI draws its own state mark)', () => {
        for (const pane of state.panes) assert.doesNotMatch(pane.title, /^[✳✻✶◐◑◒◓●○◉]\s/u, `${pane.id}: ${pane.title}`)
      })

      it('a plain shell has no agent facts: both sequences are 0, because herdr records them only on agent entries', () => {
        for (const pane of state.panes.filter((candidate) => candidate.agent === null)) {
          assert.equal(pane.completionSeq, 0, `${pane.id} completionSeq`)
          assert.equal(pane.stateChangeSeq, 0, `${pane.id} stateChangeSeq`)
        }
      })

      it('stalled follows the documented rule: working, has output, silent for over 180 s', () => {
        for (const pane of state.panes) {
          const expected = pane.status === 'working' && pane.outputAt !== null && state.now - pane.outputAt > STALL_MS
          assert.equal(pane.stalled, expected, `${pane.id} stalled`)
        }
      })

      it('writable and writableReason agree; shells are never writable; offline fleets are read-only', () => {
        for (const pane of state.panes) {
          assert.equal(pane.writable, pane.writableReason === null, `${pane.id}: writable <=> no reason`)
          if (pane.agent === null) assert.equal(pane.writableReason, 'not-an-agent', `${pane.id} is a shell`)
          else if (state.stale || !state.health.connected) assert.equal(pane.writableReason, 'offline', `${pane.id} while offline`)
          else assert.equal(pane.writable, true, `${pane.id} is writable under policy ${state.policy.write}`)
        }
      })

      it('frames and screens describe real agent panes, at the pane\'s own revision', () => {
        const byId = new Map(state.panes.map((pane) => [pane.id, pane]))
        for (const id of Object.keys(frames)) {
          const pane = byId.get(id)
          assert.ok(pane && pane.agent, `frames[${id}] must be an agent pane of this scenario`)
          assert.equal(frames[id].paneId, id)
          assert.equal(frames[id].agentKind, pane.agent.kind, `${id}: agentKind`)
        }
        for (const id of Object.keys(screens)) {
          const pane = byId.get(id)
          assert.ok(pane && pane.agent, `screens[${id}] must be an agent pane of this scenario`)
          assert.equal(screens[id].paneId, id)
          assert.equal(screens[id].revision, pane.revision, `${id}: a screen is read at the pane revision the client will quote in expectRevision`)
        }
        if (!state.stale && state.health.connected) {
          for (const pane of agentPanes(state)) {
            assert.ok(frames[pane.id], `${pane.id}: every agent pane has a frames response while connected`)
            assert.ok(screens[pane.id], `${pane.id}: every agent pane has a screen while connected`)
          }
        }
      })

      it('a frames response is internally consistent', () => {
        for (const [id, response] of Object.entries(frames)) {
          const ids = response.frames.map((frame) => frame.id)
          assert.equal(new Set(ids).size, ids.length, `${id}: frame ids are unique`)
          if (response.source === 'transcript') {
            assert.equal(response.reason, null, `${id}: a transcript has no "missing" reason`)
            assert.ok(response.frames.length > 0, `${id}: a transcript source carries frames`)
            const session = response.frames.find((frame) => frame.kind === 'session')
            assert.equal(session?.sessionId, response.sessionId, `${id}: the session frame names the response's sessionId`)
          } else {
            assert.notEqual(response.reason, null, `${id}: without a transcript the response must say why`)
            assert.deepEqual(response.frames, [], `${id}: no frames without a transcript`)
            assert.equal(response.sessionId, null)
          }
        }
      })

      it('every blocked agent has a screen to show the user before they answer', () => {
        if (state.stale || !state.health.connected) return
        for (const pane of agentPanes(state).filter((candidate) => candidate.status === 'blocked')) {
          assert.ok(screens[pane.id]?.text.length > 0, `${pane.id} is blocked but has no screen`)
        }
      })
    })
  }
})

describe('time fields (the fixture transport shifts these by real-now minus fixtures.now)', () => {
  it('every epoch-sized number sits under a key listed in TIME_FIELDS, so no instant can be missed by the rebase', () => {
    const stray = []
    const walk = (node, path, key) => {
      if (typeof node === 'number') {
        if (node >= 1e11 && !TIME_FIELDS.includes(key)) stray.push(`${path} = ${node}`)
        return
      }
      if (node === null || typeof node !== 'object') return
      for (const [name, child] of Object.entries(node)) walk(child, `${path}.${name}`, Array.isArray(node) ? key : name)
    }
    walk(scenarios, '$', '')
    assert.deepEqual(stray, [])
  })

  it('listed time fields are real instants close to fixtures.now, never in the future', () => {
    const seen = new Set()
    const walk = (node, path, key) => {
      if (typeof node === 'number' && TIME_FIELDS.includes(key)) {
        seen.add(key)
        assert.ok(Math.abs(node - NOW) < DAY, `${path} = ${node} is not within a day of now`)
        assert.ok(node <= NOW, `${path} is in the future`)
        return
      }
      if (node === null || typeof node !== 'object') return
      for (const [name, child] of Object.entries(node)) walk(child, `${path}.${name}`, Array.isArray(node) ? key : name)
    }
    walk(scenarios, '$', '')
    assert.deepEqual([...seen].sort(), [...TIME_FIELDS].sort(), 'each listed time field occurs somewhere in the fixtures')
  })
})

describe('the busy fixture covers what the UI has to render', () => {
  const { state, frames, screens } = scenarios.busy
  const agents = agentPanes(state)
  const allFrames = Object.values(frames).flatMap((response) => response.frames)
  const texts = allFrames.filter((frame) => frame.kind === 'text' || frame.kind === 'final').map((frame) => frame.text)

  it('all five statuses, a stalled agent, an unread completion, six agent kinds, plain shells', () => {
    assert.deepEqual([...new Set(agents.map((pane) => pane.status))].sort(), ['blocked', 'done', 'idle', 'unknown', 'working'])
    assert.ok(agents.some((pane) => pane.stalled))
    assert.ok(agents.some((pane) => pane.status === 'done' && pane.completionSeq > 0), 'a done agent whose completion can be unread')
    assert.deepEqual([...new Set(agents.map((pane) => pane.agent.kind))].sort(), ['claude', 'codex', 'gemini', 'grok', 'opencode', 'pi'])
    assert.ok(state.panes.filter((pane) => pane.agent === null).length >= 2)
    assert.ok(state.panes.length >= 10)
    assert.equal(state.workspaces.length, 3)
    assert.ok(agents.some((pane) => pane.agent.name === null), 'an agent without a name (shown by its display string)')
  })

  it('every frame kind, both roles, and all three work outcomes (ok, error, still running)', () => {
    assert.deepEqual([...new Set(allFrames.map((frame) => frame.kind))].sort(), ['final', 'reasoning', 'session', 'text', 'work'])
    assert.deepEqual([...new Set(allFrames.filter((frame) => frame.kind === 'text').map((frame) => frame.role))].sort(), ['assistant', 'user'])
    const outcomes = new Set(allFrames.filter((frame) => frame.kind === 'work').flatMap((frame) => frame.rows.map((row) => row.outcome)))
    assert.deepEqual([...outcomes].map(String).sort(), ['error', 'null', 'ok'])
  })

  it('text exercises the markdown renderer: headings, lists, table, code, diff, link, quote, CJK, emoji, long unbroken path', () => {
    const all = texts.join('\n')
    assert.match(all, /^## /m, 'heading')
    assert.match(all, /^- `/m, 'bullet list')
    assert.match(all, /^1\. /m, 'ordered list')
    assert.match(all, /^\|---/m, 'table')
    assert.match(all, /```bash/, 'fenced code')
    assert.match(all, /```diff/, 'fenced diff')
    assert.match(all, /\]\(https:\/\//, 'link')
    assert.match(all, /^> /m, 'blockquote')
    assert.match(all, /[\u4e00-\u9fff]/u, 'CJK')
    assert.match(all, /\p{Extended_Pictographic}/u, 'emoji')
    assert.match(all, /[^\s]{100,}/, 'a very long unbroken token that must truncate or wrap')
  })

  it('screens carry ANSI colour and the approval dialog the blocked agent is waiting on', () => {
    const all = Object.values(screens).map((screen) => screen.text).join('\n')
    assert.match(all, /\u001b\[1;36m/, 'SGR bold cyan')
    assert.match(all, /\u001b\[0m/, 'SGR reset')
    assert.match(screens['w1:p1'].text, /Do you want to proceed\?/)
  })

  it('across scenarios, every way a transcript can be missing is represented', () => {
    const responses = Object.values(scenarios).flatMap((scenario) => Object.values(scenario.frames))
    // (default sort() compares as strings, so null sits between "no-transcript" and "not-yet": compare on strings)
    assert.deepEqual([...new Set(responses.map((response) => String(response.reason)))].sort(), ['no-transcript', 'not-yet', 'null', 'unsupported-agent'])
    assert.deepEqual([...new Set(responses.map((response) => response.source))].sort(), ['none', 'screen', 'transcript'])
    assert.equal(scenarios.stale.frames['w3:p1'].source, 'none', 'offline, a screen fallback has no screen')
  })

  it('the other scenarios show what they are for', () => {
    assert.equal(scenarios.blocked.state.counts.blocked, 2)
    assert.equal(scenarios.calm.state.counts.blocked + scenarios.calm.state.counts.done + scenarios.calm.state.counts.working, 0)
    assert.equal(scenarios.empty.state.counts.agents, 0)
    assert.equal(scenarios.empty.state.counts.shells, 1)
    assert.equal(scenarios.offline.state.panes.length, 0)
    assert.equal(scenarios.offline.state.health.connected, false)
    assert.equal(scenarios.offline.state.stale, false, 'never connected: there is no old data to call stale')
    assert.equal(scenarios.offline.state.revision, 0)
    assert.equal(scenarios.offline.state.health.lastOkAt, null)
    assert.equal(scenarios.stale.state.stale, true)
    assert.ok(scenarios.stale.state.health.lastOkAt !== null)
  })
})

describe('the contract has teeth: each of these corruptions is rejected', () => {
  const state = scenarios.busy.state
  const frames = scenarios.busy.frames['w1:p3']
  const screen = scenarios.busy.screens['w1:p3']

  it('controls: the untouched data passes', () => {
    assert.deepEqual(errorsOf('State', state), [])
    assert.deepEqual(errorsOf('FramesResponse', frames), [])
    assert.deepEqual(errorsOf('ScreenResponse', screen), [])
  })

  const cases = [
    ['State', 'an unknown field on a pane', state, (value) => { value.panes[0].extra = 1 }],
    ['State', 'an unknown top-level field', state, (value) => { value.debug = true }],
    ['State', 'a missing required pane field', state, (value) => { delete value.panes[0].revision }],
    ['State', 'a status outside herdr\'s five', state, (value) => { value.panes[0].status = 'running' }],
    ['State', 'a different protocol number', state, (value) => { value.protocol = 2 }],
    ['State', 'a summary over 240 characters', state, (value) => { value.panes[0].summary = '长'.repeat(241) }],
    ['State', 'a negative revision', state, (value) => { value.panes[0].revision = -1 }],
    ['State', 'a fractional timestamp', state, (value) => { value.panes[0].stateSince += 0.5 }],
    ['State', 'an agent name that is not lowercase kebab', state, (value) => { value.panes[0].agent.name = 'Dsh Reviewer' }],
    ['State', 'a stalled flag that is not a boolean', state, (value) => { value.panes[0].stalled = 'no' }],
    ['State', 'a writableReason from outside the vocabulary', state, (value) => { value.panes[0].writableReason = 'nope' }],
    ['State', 'a transcript path leaking through agent.session', state, (value) => { value.panes[3].agent.session.value = '/Users/demo/.pi/x.jsonl' }],
    ['State', 'a pane id longer than 64 characters', state, (value) => { value.panes[0].id = 'x'.repeat(65) }],
    ['FramesResponse', 'a frame of an unknown kind', frames, (value) => { value.frames[1].kind = 'banner' }],
    ['FramesResponse', 'a frame with an extra field', frames, (value) => { value.frames[1].extra = 1 }],
    ['FramesResponse', 'a work row outcome of "warn"', frames, (value) => { value.frames.find((frame) => frame.kind === 'work').rows[0].outcome = 'warn' }],
    ['FramesResponse', 'a source outside transcript/screen/none', frames, (value) => { value.source = 'transcripts' }],
    ['FramesResponse', 'a missing cursor', frames, (value) => { delete value.cursor }],
    ['ScreenResponse', 'a non-ansi format', screen, (value) => { value.format = 'plain' }],
    ['ScreenResponse', 'zero columns', screen, (value) => { value.cols = 0 }],
  ]
  for (const [def, label, base, mutate] of cases) {
    it(`${def}: ${label}`, () => {
      assert.notDeepEqual(errorsOf(def, mutated(base, mutate)), [], `${label} slipped through`)
    })
  }

  it('an error response must say ok:false, use a known reason, and a message', () => {
    for (const reason of contract.$defs.ErrorReason.enum) assert.deepEqual(errorsOf('ErrorResponse', { ok: false, reason, message: 'x' }), [], reason)
    assert.deepEqual(errorsOf('ErrorResponse', { ok: false, reason: 'agent-blocked', message: 'x', detail: { status: 'blocked' } }), [])
    assert.notDeepEqual(errorsOf('ErrorResponse', { ok: true, reason: 'internal', message: 'x' }), [])
    assert.notDeepEqual(errorsOf('ErrorResponse', { ok: false, reason: 'teapot', message: 'x' }), [])
    assert.notDeepEqual(errorsOf('ErrorResponse', { ok: false, reason: 'internal' }), [])
  })
})

describe('act: the write surface', () => {
  const { valid, invalid } = fixtures.act
  const busy = scenarios.busy.state

  it('every valid example matches ActRequest (exactly one alternative) and its own verb definition', () => {
    for (const request of valid) {
      assert.deepEqual(errorsOf('ActRequest', request), [], JSON.stringify(request))
      assert.deepEqual(errorsOf(requestDef(request.verb), request), [], request.verb)
    }
  })

  it('the valid examples cover all seven verbs', () => {
    assert.deepEqual([...new Set(valid.map((request) => request.verb))].sort(), [...VERBS].sort())
    assert.deepEqual(contract.$defs.ActResponse.properties.verb.enum, VERBS)
  })

  it('the valid examples are valid against the busy fixture, not just well-formed', () => {
    for (const request of valid) {
      const pane = busy.panes.find((candidate) => candidate.id === request.pane)
      assert.ok(pane, `${request.verb}: ${request.pane} exists`)
      assert.ok(pane.writable, `${request.verb}: ${request.pane} is writable`)
      if (request.verb === 'answer' || request.verb === 'keys') {
        assert.equal(pane.status, 'blocked', `${request.verb} targets a blocked pane`)
        assert.equal(request.expectRevision, pane.revision, `${request.verb}: expectRevision is the pane's current revision`)
      }
      if (request.verb === 'prompt') assert.notEqual(pane.status, 'blocked', 'a blocked pane takes answer/keys, not prompt')
    }
  })

  it('answer and keys cannot be sent without expectRevision: never type blind (FLEET-API.md, "刻意为之")', () => {
    for (const verb of ['answer', 'keys']) {
      assert.ok(contract.$defs[requestDef(verb)].required.includes('expectRevision'), `${verb}: expectRevision must stay required`)
      const example = valid.find((request) => request.verb === verb)
      const without = Object.fromEntries(Object.entries(example).filter(([key]) => key !== 'expectRevision'))
      assert.notDeepEqual(errorsOf('ActRequest', without), [], `${verb} without expectRevision slipped through`)
    }
    assert.ok(contract.$defs.ErrorReason.enum.includes('screen-changed'), 'the refusal that guards it must stay in the vocabulary')
  })

  it('restart and close always carry confirm === true; nothing else does', () => {
    for (const request of valid) {
      if (NEEDS_CONFIRM.has(request.verb)) assert.strictEqual(request.confirm, true)
      else assert.equal('confirm' in request, false, `${request.verb} has no confirm field`)
    }
  })

  it('every invalid example is rejected by ActRequest, with the reason the validation order assigns', () => {
    for (const { why, request, reason } of invalid) {
      assert.notDeepEqual(errorsOf('ActRequest', request), [], `${why}: should not validate`)
      assert.equal(classify(request), reason, why)
    }
  })

  it('the invalid examples include the strictness cases: confirm must be exactly true; hyphen chords and stray keys are refused', () => {
    const reasons = new Set(invalid.map((example) => example.reason))
    for (const reason of ['confirm-required', 'key-not-allowed', 'unknown-verb', 'invalid-request']) assert.ok(reasons.has(reason), reason)
    assert.ok(invalid.some((example) => example.request.confirm === 'yes'), 'a truthy non-boolean confirm')
    assert.ok(invalid.some((example) => example.request.confirm === false), 'confirm:false')
    assert.ok(invalid.some((example) => example.request.verb === 'keys' && example.request.keys.some((key) => /^ctrl-/.test(key))), 'a hyphen chord')
  })

  it('a valid request never classifies as an error the validator would not also raise (control for classify)', () => {
    for (const request of valid) assert.equal(validate(contract, { $ref: `#/$defs/${requestDef(request.verb)}` }, request).ok, true)
  })

  it('mutating a valid request in the ways an attacker or a bug would is rejected', () => {
    const base = Object.fromEntries(valid.map((request) => [`${request.verb}:${Object.keys(request).length}`, request]))
    const restart = valid.find((request) => request.verb === 'restart')
    const close = valid.find((request) => request.verb === 'close')
    const keys = valid.find((request) => request.verb === 'keys')
    const answer = valid.find((request) => request.verb === 'answer')
    const prompt = valid.find((request) => request.verb === 'prompt')
    assert.ok(Object.keys(base).length > 0)
    const bad = [
      ['restart with confirm "true" (string)', { ...restart, confirm: 'true' }],
      ['restart with confirm 1', { ...restart, confirm: 1 }],
      ['close without confirm', Object.fromEntries(Object.entries(close).filter(([key]) => key !== 'confirm'))],
      ['restart with an empty thenPrompt', { ...restart, thenPrompt: '' }],
      ['keys with an empty list', { ...keys, keys: [] }],
      ['keys with nine entries', { ...keys, keys: Array(9).fill('enter') }],
      ['keys with a negative expectRevision', { ...keys, expectRevision: -1 }],
      ['answer with enter as a string', { ...answer, enter: 'yes' }],
      ['answer over 2000 characters', { ...answer, text: 'x'.repeat(2001) }],
      ['prompt over 20000 characters', { ...prompt, text: 'x'.repeat(20001) }],
      ['prompt with a smuggled field', { ...prompt, keys: ['enter'] }],
      ['a verb from the P2 reserve (spawn)', { verb: 'spawn', kind: 'claude', cwd: '/Users/demo/work' }],
      ['an array instead of an object', [prompt]],
      ['null', null],
    ]
    for (const [label, request] of bad) assert.notDeepEqual(errorsOf('ActRequest', request), [], `${label} slipped through`)
  })
})

describe('FLEET-API.md stays in sync with the contract', () => {
  const quoted = (name) => docText.includes(`\`${name}\``)

  it('documents every route', () => {
    for (const route of ['/plugin/fleet/state', '/plugin/fleet/stream', '/plugin/fleet/frames', '/plugin/fleet/screen', '/plugin/fleet/act']) {
      assert.ok(docText.includes(route), route)
    }
  })

  it('names every verb, every error reason and every whitelisted key', () => {
    for (const verb of VERBS) assert.ok(quoted(verb), `verb ${verb}`)
    for (const reason of contract.$defs.ErrorReason.enum) assert.ok(quoted(reason), `error reason ${reason}`)
    for (const key of KEYS) assert.ok(quoted(key), `key ${key}`)
    for (const reason of contract.$defs.Pane.properties.writableReason.enum.filter(Boolean)) assert.ok(quoted(reason), `writableReason ${reason}`)
  })

  // A section runs from its heading to the next heading of the same or a higher level (so "##" includes its "###" children).
  const section = (heading) => {
    const start = docText.indexOf(heading)
    assert.ok(start >= 0, `FLEET-API.md lost its "${heading.trim()}" section`)
    const level = heading.match(/^#+/)[0].length
    const next = docText.slice(start + heading.length).search(new RegExp(`\\n#{1,${level}} `))
    return docText.slice(start, next < 0 ? undefined : start + heading.length + next)
  }

  it('keeps the section that says expectRevision / screen-changed are deliberate, so nobody "fixes" them', () => {
    const text = section('## 刻意为之的约束')
    for (const needle of ['不盲打', '`expectRevision`', '`screen-changed`', '`interrupt`', '不要', '自动重发']) {
      assert.ok(text.includes(needle), `the section must still say ${needle}`)
    }
  })

  it('keeps the checklist of state-dependent rejections the host fake-herdr tests must name', () => {
    const text = section('### 宿主单测必须点名的拒绝')
    for (const reason of ['unknown-pane', 'not-an-agent', 'policy-denied', 'herdr-offline', 'agent-blocked', 'not-blocked', 'screen-changed']) {
      assert.ok(text.includes(`\`${reason}\``), `the checklist must name ${reason}`)
      assert.ok(contract.$defs.ErrorReason.enum.includes(reason), `${reason} must be a real ErrorReason`)
    }
  })

  it('states the stall threshold the generator and validator use', () => {
    assert.match(docText, /180\s*(?:s\b|秒)/)
  })

  it('lists exactly the time fields the generator exports, in its rebase rule', () => {
    for (const field of TIME_FIELDS) assert.ok(quoted(field), `time field ${field}`)
  })
})
