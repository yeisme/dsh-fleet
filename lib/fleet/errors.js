/**
 * The Fleet API's failures (docs/design/FLEET-API.md §7): a contract `reason`, the HTTP status that goes with it, a
 * one-line human message and an optional `detail` object.
 *
 * Rules every producer of a FleetError follows (the write path types into other people's terminals, so what it says
 * about a request must not become a second copy of that request):
 *  - `message` and `detail` never contain user input: not a prompt, not an answer, not keys, not even a field value.
 *    Fixed strings, enum values and herdr's short error codes only.
 *  - `detail` keys follow the §7 table (`status`, `policy`, `revision`, `code`); anything else needs a contract change.
 *  - No stack ever leaves the host: `toResponse()` is the only thing the transport has to serialize.
 */

/**
 * HTTP status per contract `ErrorReason`. test/errors.test.mjs keeps this equal to the contract's enum and to the §7
 * table in FLEET-API.md, so a reason cannot be added to one and forgotten in the other.
 */
export const STATUS_BY_REASON = Object.freeze({
  forbidden: 403,
  'method-not-allowed': 405,
  'unsupported-media-type': 415,
  'payload-too-large': 413,
  'invalid-request': 400,
  'unknown-verb': 400,
  'unknown-pane': 404,
  'not-an-agent': 409,
  'agent-blocked': 409,
  'not-blocked': 409,
  'confirm-required': 400,
  'policy-denied': 403,
  'key-not-allowed': 400,
  'screen-changed': 409,
  'herdr-offline': 503,
  'herdr-error': 502,
  timeout: 504,
  internal: 500,
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export class FleetError extends Error {
  /**
   * @param {keyof typeof STATUS_BY_REASON} reason a contract ErrorReason
   * @param {string} [message] one sentence for a person; programs only look at `reason`
   * @param {Record<string, unknown>} [detail] machine-readable extras per the §7 table; never user input
   */
  constructor(reason, message, detail) {
    // An unknown reason is a bug in the host. Failing here (and not emitting it) keeps every response inside the
    // contract; the message deliberately does not echo the offending value.
    if (typeof reason !== 'string' || !Object.hasOwn(STATUS_BY_REASON, reason)) throw new TypeError('FleetError: reason is not a contract ErrorReason')
    if (detail !== undefined && !isPlainObject(detail)) throw new TypeError('FleetError: detail must be a plain object')
    super(message ?? reason)
    this.name = 'FleetError'
    this.reason = reason
    this.status = STATUS_BY_REASON[reason]
    // Left unset (not null) when absent: the transport only adds `detail` to the body when it is defined.
    if (detail !== undefined) this.detail = Object.freeze({ ...detail })
  }

  /** The contract's ErrorResponse: `{ ok: false, reason, message, detail? }`. */
  toResponse() {
    const body = { ok: false, reason: this.reason, message: this.message }
    if (this.detail !== undefined) body.detail = { ...this.detail }
    return body
  }
}
