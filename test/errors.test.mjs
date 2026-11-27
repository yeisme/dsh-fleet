import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FleetError, STATUS_BY_REASON } from '../lib/fleet/errors.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()
const reasons = contract.$defs.ErrorReason.enum
const docText = readFileSync(new URL('../docs/design/FLEET-API.md', import.meta.url), 'utf8')

/** The rows of FLEET-API.md's "## 7. 错误" table: `| \`reason\` | 503 | when |`. */
function documentedStatuses() {
  const start = docText.indexOf('## 7. 错误')
  assert.ok(start >= 0, 'FLEET-API.md lost its "## 7. 错误" section')
  const end = docText.indexOf('\n## ', start + 1)
  const section = docText.slice(start, end < 0 ? undefined : end)
  const rows = {}
  for (const [, reason, status] of section.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*(\d{3})\s*\|/gm)) rows[reason] = Number(status)
  return rows
}

describe('STATUS_BY_REASON', () => {
  it('covers exactly the contract\'s ErrorReason enum: no reason without a status, no status without a reason', () => {
    assert.deepEqual(Object.keys(STATUS_BY_REASON).sort(), [...reasons].sort())
  })

  it('maps every reason to a real HTTP error status', () => {
    for (const [reason, status] of Object.entries(STATUS_BY_REASON)) {
      assert.ok(Number.isInteger(status) && status >= 400 && status <= 599, `${reason}: ${status}`)
    }
  })

  it('is the table in FLEET-API.md §7, row for row', () => {
    const documented = documentedStatuses()
    assert.equal(Object.keys(documented).length, reasons.length, 'the doc table has one row per reason')
    assert.deepEqual(STATUS_BY_REASON, documented)
  })

  it('pins the statuses the safety tests rely on (literals, so a table edit has to be deliberate)', () => {
    const pinned = {
      'unknown-pane': 404, 'not-an-agent': 409, 'policy-denied': 403, 'herdr-offline': 503, 'agent-blocked': 409,
      'not-blocked': 409, 'screen-changed': 409, 'confirm-required': 400, 'key-not-allowed': 400, timeout: 504, 'herdr-error': 502,
    }
    for (const [reason, status] of Object.entries(pinned)) assert.equal(STATUS_BY_REASON[reason], status, reason)
  })

  it('cannot be changed at run time', () => {
    assert.ok(Object.isFrozen(STATUS_BY_REASON))
    assert.throws(() => { STATUS_BY_REASON['screen-changed'] = 200 }, TypeError)
    assert.throws(() => { STATUS_BY_REASON.sneaky = 200 }, TypeError)
  })
})

describe('FleetError', () => {
  it('is an Error carrying reason, status (from the table), message and detail', () => {
    const error = new FleetError('screen-changed', 'the screen moved', { revision: 413 })
    assert.ok(error instanceof Error)
    assert.ok(error instanceof FleetError)
    assert.equal(error.name, 'FleetError')
    assert.equal(error.reason, 'screen-changed')
    assert.equal(error.status, 409)
    assert.equal(error.message, 'the screen moved')
    assert.deepEqual(error.detail, { revision: 413 })
  })

  it('derives the status from the reason for every reason; nobody picks a status by hand', () => {
    for (const reason of reasons) assert.equal(new FleetError(reason, 'x').status, STATUS_BY_REASON[reason], reason)
  })

  it('leaves `detail` undefined (not null, not {}) when there is none: the transport adds it only when defined', () => {
    const error = new FleetError('unknown-pane', 'no such pane')
    assert.equal(error.detail, undefined)
    assert.equal(Object.hasOwn(error, 'detail'), false)
    assert.deepEqual(Object.keys(error.toResponse()), ['ok', 'reason', 'message'])
  })

  it('falls back to the reason as the message when none is given, so a response is never message-less', () => {
    assert.equal(new FleetError('internal').message, 'internal')
  })

  it('copies and freezes detail: a later change to the caller\'s object cannot rewrite an error in flight', () => {
    const source = { status: 'blocked' }
    const error = new FleetError('agent-blocked', 'x', source)
    source.status = 'working'
    assert.deepEqual(error.detail, { status: 'blocked' })
    assert.ok(Object.isFrozen(error.detail))
    assert.throws(() => { error.detail.status = 'idle' }, TypeError)
  })

  it('refuses a reason outside the contract (so no response can ever leave it), without echoing the value', () => {
    for (const reason of ['teapot', '', undefined, null, 404, '__proto__', 'constructor', 'toString']) {
      assert.throws(() => new FleetError(reason, 'x'), (error) => error instanceof TypeError && !String(error.message).includes('teapot'), String(reason))
    }
  })

  it('refuses a detail that is not a plain object (the contract says `detail` is an object)', () => {
    for (const detail of [null, 'text', 7, ['a'], true]) assert.throws(() => new FleetError('internal', 'x', detail), TypeError, JSON.stringify(detail))
  })

  it('toResponse() is the contract\'s ErrorResponse for every reason, with and without detail, and carries no stack', () => {
    for (const reason of reasons) {
      for (const detail of [undefined, { code: 'x' }]) {
        const body = new FleetError(reason, 'a sentence', detail).toResponse()
        assert.deepEqual(validateDef(contract, 'ErrorResponse', body).errors, [], reason)
        assert.equal(body.ok, false)
        assert.equal(body.reason, reason)
        assert.equal('stack' in body, false)
        assert.equal(JSON.stringify(body).includes('at '), false, 'no stack frames in the body')
      }
    }
  })

  it('toResponse() returns a fresh object: editing the body cannot reach the error', () => {
    const error = new FleetError('herdr-error', 'x', { code: 'bad' })
    const body = error.toResponse()
    body.detail.code = 'changed'
    body.message = 'changed'
    assert.deepEqual(error.detail, { code: 'bad' })
    assert.equal(error.message, 'x')
  })
})
