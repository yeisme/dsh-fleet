/**
 * Transport-level safety for the /plugin/fleet/* routes (docs/design/FLEET-API.md §1, §6 step 1).
 *
 * The routes can type into terminals, so they are guarded exactly like the existing /plugin/threads/* ones
 * (`connection.requestRejection`), and a POST must prove it came from our own page: it has to be JSON, and a
 * cross-site <form> cannot send `application/json` without a preflight that the host does not answer.
 *
 * Error messages here are fixed strings. They never echo request content (not even the JSON parser's own message,
 * which quotes the offending input): prompts and keystrokes must not leak into responses or logs.
 */

/** Bodies above this are refused without being read to the end. */
export const MAX_BODY_BYTES = 256 * 1024

/** A transport-level refusal; carries the contract's `reason` and the HTTP status for it. */
export class HttpError extends Error {
  constructor(status, reason, message, detail) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.reason = reason
    this.detail = detail
  }
}

/** @param {{ requestRejection: (request: object) => unknown }} connection */
export function guardRequest(connection, request) {
  if (connection.requestRejection(request) !== undefined) throw new HttpError(403, 'forbidden', 'request not allowed')
}

/** POST bodies must be declared JSON. */
export function requireJson(request) {
  const type = String(request.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'unsupported-media-type', 'content-type must be application/json')
}

/**
 * Read and parse a JSON body with a hard size cap. The cap is enforced on the bytes actually received, not only on
 * the declared length, so a lying or chunked client cannot get past it.
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(request, { limitBytes = MAX_BODY_BYTES } = {}) {
  const declared = Number(request.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limitBytes) throw new HttpError(413, 'payload-too-large', 'request body is too large')

  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) throw new HttpError(400, 'invalid-request', 'request body is empty')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid-request', 'request body is not valid JSON')
  }
}
