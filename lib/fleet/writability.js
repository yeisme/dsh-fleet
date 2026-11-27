/**
 * Who may write to which pane. One pure function, shared by the State builder (which publishes `writable` /
 * `writableReason` per pane) and the act pipeline (which refuses before it ever touches herdr), so the two cannot
 * disagree.
 *
 * Precedence (docs/design/FLEET-API.md §2): an intrinsic reason outranks a transient one, so a shell stays
 * "not-an-agent" while the connection is down, and a policy refusal is not hidden by an outage.
 *   not-an-agent  ->  policy-*  ->  offline
 *
 * Fails closed: a policy value this code does not know is treated as read-only.
 */
export const POLICIES = Object.freeze(['all', 'dsh-only', 'read-only'])

/**
 * @param {{ id: string, isAgent: boolean }} pane
 * @param {{ policy?: string, dshPanes?: Set<string>, connected?: boolean, stale?: boolean }} [context]
 * @returns {{ writable: boolean, reason: null | 'not-an-agent' | 'policy-read-only' | 'policy-dsh-only' | 'offline' }}
 */
export function writability({ id, isAgent }, { policy = 'all', dshPanes = new Set(), connected = true, stale = false } = {}) {
  if (!isAgent) return { writable: false, reason: 'not-an-agent' }
  if (policy === 'dsh-only') {
    if (!dshPanes.has(id)) return { writable: false, reason: 'policy-dsh-only' }
  } else if (policy !== 'all') {
    return { writable: false, reason: 'policy-read-only' }
  }
  if (!connected || stale) return { writable: false, reason: 'offline' }
  return { writable: true, reason: null }
}
