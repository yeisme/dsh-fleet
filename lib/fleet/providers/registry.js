/**
 * ProviderRegistry: aggregates multiple pane/bot providers into a single Fleet roster without mutating herdr panes
 * or allowing external providers to collide with herdr pane ids (e.g. `w1:p7`).
 *
 * Pure merge helpers (`namespacePaneId`, `mergeProviderPanes`) are exported separately for unit testing and for
 * callers that only need deterministic pane aggregation.
 */
import { createHash } from 'node:crypto'
import { FleetError } from '../errors.js'

const ID_MAX = 64
const DEFAULT_BOT_PREFIX = 'bot:'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Namespace an external pane/bot id so it cannot collide with herdr pane ids (`w1:p7`) and always fits within
 * the contract's `Id` limit (<= 64 code points). If truncation is needed, a short SHA-256 suffix keeps distinct
 * long ids from colliding.
 *
 * @param {string} rawId
 * @param {string} [prefix='bot:']
 * @returns {string}
 */
export function namespacePaneId(rawId, prefix = DEFAULT_BOT_PREFIX) {
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    throw new TypeError('namespacePaneId: rawId must be a non-empty string')
  }
  const cleanPrefix = typeof prefix === 'string' && prefix !== '' ? prefix : DEFAULT_BOT_PREFIX
  const candidate = rawId.startsWith(cleanPrefix) ? rawId : `${cleanPrefix}${rawId}`
  const points = [...candidate]
  if (points.length <= ID_MAX) return candidate
  const digest = createHash('sha256').update(candidate).digest('hex').slice(0, 8)
  const headLimit = Math.max(1, ID_MAX - digest.length - 1)
  return `${points.slice(0, headLimit).join('')}-${digest}`
}

function prefixForProvider(provider) {
  if (provider?.kind === 'herdr') return ''
  if (typeof provider?.idPrefix === 'string' && provider.idPrefix !== '') return provider.idPrefix
  if (provider?.kind === 'external-bots') return DEFAULT_BOT_PREFIX
  const safeKind = String(provider?.kind ?? 'ext').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ext'
  return `${safeKind}:`
}

/**
 * Pure merge of panes across providers.
 * - `herdr` panes are kept verbatim (never mutated, never renamed).
 * - External provider panes are shallow-copied with a safely namespaced `id` (<= 64 chars) so they cannot collide
 *   with herdr panes or mutate the provider's internal objects.
 * - Duplicate public ids are deduplicated in registration order (herdr first if registered first).
 *
 * @param {Array<{ provider: { id: string, kind: string, idPrefix?: string }, panes: object[] }>} entries
 * @returns {{ panes: object[], routing: Map<string, { provider: object, rawId: string }> }}
 */
export function mergeProviderPanes(entries) {
  const panes = []
  const routing = new Map()
  // Process herdr providers before external providers so herdr always owns its native ids on any collision.
  const ordered = [...entries].sort((a, b) => {
    const aHerdr = a?.provider?.kind === 'herdr' ? 0 : 1
    const bHerdr = b?.provider?.kind === 'herdr' ? 0 : 1
    return aHerdr - bHerdr
  })

  for (const entry of ordered) {
    const provider = entry?.provider
    const list = Array.isArray(entry?.panes) ? entry.panes : []
    const isHerdr = provider?.kind === 'herdr'
    const prefix = prefixForProvider(provider)

    for (const pane of list) {
      if (!isPlainObject(pane) || typeof pane.id !== 'string' || pane.id === '') continue
      const rawId = pane.id
      const publicId = isHerdr ? rawId : namespacePaneId(rawId, prefix)
      if (routing.has(publicId)) continue
      routing.set(publicId, { provider, rawId })
      // Never mutate herdr panes; keep them verbatim. External panes only get a new object if the id changed.
      panes.push(isHerdr || publicId === rawId ? pane : { ...pane, id: publicId })
    }
  }

  return { panes, routing }
}

/**
 * Aggregates pane/bot providers into one unified control-plane surface (`listPanes`, `onChange`, `act`, `frames`, `screen`).
 */
export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, { provider: object, unsubscribe: (() => void) | null }>} */
    this._providers = new Map()
    /** @type {Set<() => void>} */
    this._listeners = new Set()
    /** @type {Map<string, { provider: object, rawId: string }>} */
    this._routing = new Map()
  }

  _notify() {
    for (const listener of [...this._listeners]) {
      try {
        listener()
      } catch { /* a broken listener must not break other subscribers */ }
    }
  }

  /**
   * Register a provider. Each provider must expose `{ id, kind, listPanes() }` and may expose
   * `onChange(cb)`, `act(req)`, `frames(id, q)`, `screen(id)`, `start()`, `stop()`.
   */
  register(provider) {
    if (!isPlainObject(provider)) throw new TypeError('ProviderRegistry.register: provider must be an object')
    if (typeof provider.id !== 'string' || provider.id.trim() === '') throw new TypeError('ProviderRegistry.register: provider.id must be a non-empty string')
    if (typeof provider.kind !== 'string' || provider.kind.trim() === '') throw new TypeError('ProviderRegistry.register: provider.kind must be a non-empty string')
    if (typeof provider.listPanes !== 'function') throw new TypeError('ProviderRegistry.register: provider.listPanes must be a function')
    if (this._providers.has(provider.id)) throw new Error(`ProviderRegistry.register: duplicate provider id "${provider.id}"`)

    let unsubscribe = null
    if (typeof provider.onChange === 'function') {
      const unsub = provider.onChange(() => this._notify())
      unsubscribe = typeof unsub === 'function' ? unsub : null
    }
    this._providers.set(provider.id, { provider, unsubscribe })
    this._notify()
    return this
  }

  /** Unregister a provider by id and detach its change listener. */
  unregister(providerId) {
    const record = this._providers.get(providerId)
    if (!record) return false
    try {
      record.unsubscribe?.()
    } catch { /* ignore cleanup error */ }
    this._providers.delete(providerId)
    this._notify()
    return true
  }

  get(providerId) {
    return this._providers.get(providerId)?.provider ?? null
  }

  providers() {
    return [...this._providers.values()].map((record) => record.provider)
  }

  /** Subscribe to changes from any registered provider (or provider registration changes). */
  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('ProviderRegistry.onChange: listener must be a function')
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  /** Aggregate panes across all registered providers using pure merge logic. */
  listPanes(options) {
    const entries = []
    for (const { provider } of this._providers.values()) {
      entries.push({ provider, panes: provider.listPanes(options) })
    }
    const { panes, routing } = mergeProviderPanes(entries)
    this._routing = routing
    return panes
  }

  /** Resolve a public pane id to its owning provider and provider-local raw id. */
  resolve(paneId) {
    if (typeof paneId !== 'string' || paneId === '') return null
    const cached = this._routing.get(paneId)
    if (cached && this._providers.has(cached.provider.id)) return cached
    this.listPanes()
    return this._routing.get(paneId) ?? null
  }

  async start() {
    for (const { provider } of this._providers.values()) {
      await provider.start?.()
    }
  }

  async stop() {
    for (const { provider } of this._providers.values()) {
      await provider.stop?.()
    }
  }

  async act(request) {
    const paneId = isPlainObject(request) ? request.pane : null
    const target = this.resolve(paneId)
    if (!target) throw new FleetError('unknown-pane', 'There is no pane with this id (it may have been closed).')
    if (typeof target.provider.act !== 'function') {
      throw new FleetError('policy-denied', 'This provider does not support write actions.', { policy: 'read-only' })
    }
    const forwarded = target.rawId === paneId ? request : { ...request, pane: target.rawId }
    const result = await target.provider.act(forwarded)
    return isPlainObject(result) ? { ...result, pane: paneId } : result
  }

  async frames(paneId, query = {}) {
    const target = this.resolve(paneId)
    if (!target) throw new FleetError('unknown-pane', 'There is no pane with this id (it may have been closed).')
    if (typeof target.provider.frames !== 'function') {
      return {
        ok: true,
        paneId,
        source: 'none',
        reason: 'unsupported-agent',
        agentKind: null,
        sessionId: null,
        frames: [],
        hasEarlier: false,
        partial: false,
        reset: false,
        unknownFrames: 0,
        cursor: { start: null, end: null },
      }
    }
    const result = await target.provider.frames(target.rawId, query)
    return isPlainObject(result) ? { ...result, paneId } : result
  }

  async screen(paneId) {
    const target = this.resolve(paneId)
    if (!target) throw new FleetError('unknown-pane', 'There is no pane with this id (it may have been closed).')
    if (typeof target.provider.screen !== 'function') {
      throw new FleetError('herdr-offline', 'Live screen is not available for this provider.')
    }
    const result = await target.provider.screen(target.rawId)
    return isPlainObject(result) ? { ...result, paneId } : result
  }
}
