import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SUPPORTED_KEYWORDS, loadContract, validate } from '../lib/fleet/schema.js'

const ok = (schema, value, root = schema) => validate(root, schema, value)
const errorsOf = (schema, value, root = schema) => ok(schema, value, root).errors

describe('schema validator', () => {
  it('checks types, including unions, integer vs number, and null', () => {
    assert.equal(ok({ type: 'string' }, 'x').ok, true)
    assert.match(errorsOf({ type: 'string' }, 1)[0], /^\$: expected string, got number/)
    assert.equal(ok({ type: ['string', 'null'] }, null).ok, true)
    assert.equal(ok({ type: 'integer' }, 3).ok, true)
    assert.equal(ok({ type: 'integer' }, 3.5).ok, false)
    assert.equal(ok({ type: 'number' }, 3.5).ok, true)
    assert.equal(ok({ type: 'number' }, Number.NaN).ok, false)
    assert.equal(ok({ type: 'object' }, []).ok, false, 'arrays are not objects')
    assert.equal(ok({ type: 'array' }, []).ok, true)
  })

  it('checks enum (including null) and const', () => {
    assert.equal(ok({ enum: ['a', null] }, null).ok, true)
    assert.equal(ok({ enum: ['a', null] }, 'b').ok, false)
    assert.equal(ok({ const: true }, true).ok, true)
    assert.equal(ok({ const: true }, 'true').ok, false, 'strict: the string "true" is not the boolean')
    assert.equal(ok({ const: { a: [1] } }, { a: [1] }).ok, true, 'structural equality')
  })

  it('checks required properties, closed objects and schema-valued additionalProperties', () => {
    const closed = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } }
    assert.equal(ok(closed, { a: 'x' }).ok, true)
    assert.deepEqual(errorsOf(closed, {}), ['$: missing required property "a"'])
    assert.deepEqual(errorsOf(closed, { a: 'x', b: 1 }), ['$.b: unexpected property'])
    const map = { type: 'object', additionalProperties: { type: 'integer' } }
    assert.equal(ok(map, { x: 1, y: 2 }).ok, true)
    assert.deepEqual(errorsOf(map, { x: 1, y: 'no' }), ['$.y: expected integer, got string'])
  })

  it('checks arrays: items, minItems, maxItems, with indexed paths', () => {
    const schema = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } }
    assert.equal(ok(schema, [1]).ok, true)
    assert.deepEqual(errorsOf(schema, []), ['$: fewer than 1 items'])
    assert.deepEqual(errorsOf(schema, [1, 2, 3]), ['$: more than 2 items'])
    assert.deepEqual(errorsOf(schema, [1, 'x']), ['$[1]: expected integer, got string'])
  })

  it('checks strings: lengths count code points; pattern applies to strings only', () => {
    assert.equal(ok({ type: 'string', maxLength: 3 }, '三个字').ok, true)
    assert.equal(ok({ type: 'string', maxLength: 3 }, '😀😀😀').ok, true, 'one emoji is one character')
    assert.equal(ok({ type: 'string', maxLength: 3 }, '四个汉字').ok, false)
    assert.equal(ok({ type: 'string', minLength: 1 }, '').ok, false)
    const name = { type: ['string', 'null'], pattern: '^[a-z][a-z0-9_-]{0,31}$' }
    assert.equal(ok(name, 'dsh-8a0d4f').ok, true)
    assert.equal(ok(name, null).ok, true, 'pattern ignores null')
    assert.equal(ok(name, 'Bad Name').ok, false)
  })

  it('checks numeric bounds', () => {
    assert.equal(ok({ type: 'integer', minimum: 0 }, 0).ok, true)
    assert.deepEqual(errorsOf({ type: 'integer', minimum: 0 }, -1), ['$: below minimum 0'])
    assert.deepEqual(errorsOf({ type: 'integer', maximum: 5 }, 6), ['$: above maximum 5'])
  })

  it('resolves local $ref and rejects unresolvable or remote refs', () => {
    const root = { $defs: { N: { type: 'integer' } } }
    assert.equal(validate(root, { $ref: '#/$defs/N' }, 1).ok, true)
    assert.equal(validate(root, { $ref: '#/$defs/N' }, 'x').ok, false)
    assert.throws(() => validate(root, { $ref: '#/$defs/Missing' }, 1), /unresolvable/)
    assert.throws(() => validate(root, { $ref: 'http://example.com/x.json' }, 1), /only local/)
  })

  it('oneOf requires exactly one match and reports the closest alternative', () => {
    const schema = {
      oneOf: [
        { type: 'object', required: ['kind'], properties: { kind: { const: 'a' }, x: { type: 'integer' } } },
        { type: 'object', required: ['kind'], properties: { kind: { const: 'b' } } },
      ],
    }
    assert.equal(ok(schema, { kind: 'a', x: 1 }).ok, true)
    assert.equal(ok(schema, { kind: 'b' }).ok, true)
    const [none] = errorsOf(schema, { kind: 'a', x: 'bad' })
    assert.match(none, /matches none of 2 alternatives; closest: \$\.x: expected integer, got string/)
    assert.match(errorsOf({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1)[0], /matches 2 alternatives/)
  })

  it('oneOf reports the alternative of the right shape, not "expected null, got object"', () => {
    const root = { $defs: { Inner: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } }
    const nullable = { oneOf: [{ type: 'null' }, { $ref: '#/$defs/Inner' }] }
    const [message] = validate(root, nullable, {}).errors
    assert.match(message, /closest: \$: missing required property "id"/)
    assert.doesNotMatch(message, /expected null/)
    assert.match(validate(root, nullable, 'nope').errors[0], /matches none of 2 alternatives/, 'wrong shape for every branch still reports')
    assert.equal(validate(root, nullable, null).ok, true)
    assert.equal(validate(root, nullable, { id: 1 }).ok, true)
  })

  it('anyOf needs at least one match', () => {
    assert.equal(ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 1).ok, true)
    assert.equal(ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, null).ok, false)
  })

  it('refuses keywords it cannot enforce, instead of silently ignoring them', () => {
    assert.throws(() => validate({}, { allOf: [] }, 1), /unsupported keyword "allOf"/)
    assert.throws(() => validate({}, { format: 'date-time' }, 'x'), /unsupported keyword "format"/)
    assert.equal(validate({}, { title: 'ok', description: 'annotations are fine' }, 1).ok, true)
  })

  it('treats the empty schema and true as "anything"', () => {
    assert.equal(ok({}, { whatever: [1, 2] }).ok, true)
    assert.equal(ok(true, 1).ok, true)
    assert.equal(ok(false, 1).ok, false)
  })
})

describe('the fleet contract document', () => {
  const contract = loadContract()

  it('loads, and every $ref in it resolves', () => {
    const refs = []
    JSON.stringify(contract, (key, value) => { if (key === '$ref') refs.push(value); return value })
    assert.ok(refs.length > 20)
    for (const ref of refs) {
      const name = ref.replace('#/$defs/', '')
      assert.ok(Object.hasOwn(contract.$defs, name), `${ref} is defined`)
    }
  })

  it('uses only keywords the validator supports, at every depth (so every constraint in it is real)', () => {
    const bad = []
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object') return // true / false schemas
      for (const key of Object.keys(node)) if (!SUPPORTED_KEYWORDS.has(key)) bad.push(`${path}.${key}`)
      for (const [name, sub] of Object.entries(node.$defs ?? {})) walk(sub, `${path}.$defs.${name}`)
      for (const [name, sub] of Object.entries(node.properties ?? {})) walk(sub, `${path}.properties.${name}`)
      if (node.items !== undefined) walk(node.items, `${path}.items`)
      if (typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${path}.additionalProperties`)
      for (const group of ['oneOf', 'anyOf']) (node[group] ?? []).forEach((sub, index) => walk(sub, `${path}.${group}[${index}]`))
    }
    walk(contract, '#')
    assert.deepEqual(bad, [])
  })

  it('the key whitelist uses plus-separated chords only (hard rule 3)', () => {
    const keys = contract.$defs.Key.enum
    assert.ok(keys.includes('ctrl+c'))
    assert.deepEqual(keys.filter((key) => /^(ctrl|control|alt|shift|meta|cmd)-/.test(key)), [])
  })
})
