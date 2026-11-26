/**
 * A tiny, dependency-free validator for the strict JSON Schema subset that lib/fleet/contract.schema.json uses.
 * The repo has no dependencies on purpose, and the same validator is meant to run in the host (request validation),
 * in tests (fixtures vs contract) and in dev tooling.
 *
 * Supported keywords: $ref (local "#/…" pointers only), type (string | array), enum, const, properties, required,
 * additionalProperties (boolean | schema), items (schema), minItems, maxItems, minLength, maxLength, minimum, maximum,
 * pattern, oneOf, anyOf. Annotation keywords ($schema, $id, $defs, title, description, $comment) are ignored.
 * ANY OTHER keyword throws: a contract cannot silently rely on something this validator does not enforce.
 */
import { readFileSync } from 'node:fs'

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description', '$comment'])
const ENFORCED = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'oneOf', 'anyOf',
])

/** Every keyword this validator understands (enforced or annotation-only); anything else makes validate() throw. */
export const SUPPORTED_KEYWORDS = new Set([...ANNOTATIONS, ...ENFORCED])

const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

function isType(value, type) {
  switch (type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    default: throw new Error(`schema: unsupported type "${type}"`)
  }
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  return keysA.length === keysB.length && keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`schema: only local "#/…" $ref is supported, got ${JSON.stringify(ref)}`)
  let node = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) throw new Error(`schema: unresolvable $ref ${ref}`)
    node = node[key]
  }
  return node
}

/** @returns {boolean} false only when the node failed its own `type` check (a wrong *shape*, not a wrong detail). */
function check(root, schema, value, path, errors) {
  if (schema === true) return true
  if (schema === false) { errors.push(`${path}: no value is allowed here`); return false }
  if (schema === null || typeof schema !== 'object') throw new Error(`schema: invalid schema at ${path}`)
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !ENFORCED.has(key)) throw new Error(`schema: unsupported keyword "${key}" at ${path}`)
  }

  let shapeOk = true
  if (schema.$ref !== undefined) shapeOk = check(root, resolveRef(root, schema.$ref), value, path, errors)

  if (schema.type !== undefined) {
    const types = [].concat(schema.type)
    if (!types.some((type) => isType(value, type))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeName(value)}`)
      return false // deeper keywords would only add noise
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}, got ${JSON.stringify(value)}`)
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
  }

  if (typeof value === 'string') {
    const length = [...value].length // code points, as JSON Schema counts them (CJK/emoji safe)
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.items !== undefined) value.forEach((item, index) => check(root, schema.items, item, `${path}[${index}]`, errors))
  }
  if (isType(value, 'object')) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property "${key}"`)
    }
    const properties = schema.properties ?? {}
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) check(root, sub, value[key], `${path}.${key}`, errors)
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key)) continue
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`)
        else check(root, schema.additionalProperties, value[key], `${path}.${key}`, errors)
      }
    }
  }

  if (schema.oneOf !== undefined) {
    const branches = schema.oneOf.map((sub) => {
      const own = []
      const shape = check(root, sub, value, path, own)
      return { own, shape }
    })
    const matched = branches.filter((branch) => branch.own.length === 0).length
    if (matched === 0) {
      // An alternative of the right shape is closer than one of the wrong shape ("expected null, got object" helps nobody
      // when the object was merely missing a field); among those, the one with the fewest complaints.
      const sameShape = branches.filter((branch) => branch.shape)
      const pool = sameShape.length > 0 ? sameShape : branches
      const closest = pool.reduce((best, branch) => (branch.own.length < best.own.length ? branch : best))
      errors.push(`${path}: matches none of ${branches.length} alternatives; closest: ${closest.own.join('; ')}`)
    } else if (matched > 1) {
      errors.push(`${path}: matches ${matched} alternatives, exactly one is allowed`)
    }
  }
  if (schema.anyOf !== undefined) {
    const anyMatch = schema.anyOf.some((sub) => {
      const own = []
      check(root, sub, value, path, own)
      return own.length === 0
    })
    if (!anyMatch) errors.push(`${path}: matches none of ${schema.anyOf.length} alternatives`)
  }
  return shapeOk
}

/**
 * @param {object} root the whole contract document (where "#/…" refs resolve)
 * @param {object | boolean} schema the schema to apply (often `{ $ref: '#/$defs/Name' }`)
 * @param {unknown} value
 * @returns {{ ok: boolean, errors: string[] }} errors carry a `$.path.to[3].field` prefix
 */
export function validate(root, schema, value) {
  const errors = []
  check(root, schema, value, '$', errors)
  return { ok: errors.length === 0, errors }
}

/** Validate against a named definition of the contract. */
export function validateDef(root, name, value) {
  return validate(root, { $ref: `#/$defs/${name}` }, value)
}

/** The fleet contract document (lib/fleet/contract.schema.json). */
export function loadContract() {
  return JSON.parse(readFileSync(new URL('./contract.schema.json', import.meta.url), 'utf8'))
}
