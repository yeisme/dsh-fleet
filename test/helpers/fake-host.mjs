/**
 * A fake DSH client host: just enough to run a plugin bundle's `apply(ctx)` in Node and record
 * everything the plugin registers — the "registration manifest" (slots, tabs, resources, commands,
 * shortcuts, listeners, injected CSS, storage writes).
 *
 * It is NOT a renderer: components are never mounted. Its job is to prove two bundles register the
 * same things in the same order when fed the same deterministic fake services, so a refactor of the
 * legacy client (or the build wrapper) cannot silently change what the host sees.
 *
 * Every service on the fake ctx is a deep recording Proxy: any property is another proxy, every call
 * is logged with a normalized argument summary. Callbacks the real host would invoke (`ctx.inject`,
 * `ctx.effect`, `slots.inject`) are invoked synchronously, with iterators drained.
 */
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { permissiveReact } from './loader-sim.mjs'

const PATH = Symbol('fake-host.path')
const NONE = Symbol('none')
const sha10 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10)
const tag = (value) => Object.prototype.toString.call(value).slice(8, -1)

/** Deterministic, JSON-safe, order-stable summary of an argument tree (functions become names). */
export function summarize(value, depth = 0, seen = new Set()) {
  if (value === null) return null
  switch (typeof value) {
    case 'undefined': return '[undefined]'
    case 'boolean': return value
    case 'number': return Number.isFinite(value) ? value : String(value)
    case 'bigint': return `${value}n`
    case 'string': return value.length > 160 ? { str: value.length, sha: sha10(value) } : value
    case 'symbol': return String(value)
    case 'function': return value[PATH] ? `<${value[PATH]}>` : { fn: value.name || 'anonymous' }
    default:
  }
  if (seen.has(value)) return '[circular]'
  if (depth > 6) return '[deep]'
  seen.add(value)
  try {
    if (value.__fakeElement) return { el: value.tagName }
    if (Array.isArray(value)) return value.map((v) => summarize(v, depth + 1, seen))
    const kind = tag(value)
    if (kind === 'Map') return { Map: [...value].map(([k, v]) => [summarize(k, depth + 1, seen), summarize(v, depth + 1, seen)]) }
    if (kind === 'Set') return { Set: [...value].map((v) => summarize(v, depth + 1, seen)) }
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = summarize(value[key], depth + 1, seen)
    return out
  } finally {
    seen.delete(value)
  }
}

/** Run a callback result to completion if it is an iterator (generator-style effects/injections). */
function drain(result) {
  if (result && typeof result === 'object' && typeof result.next === 'function' && typeof result[Symbol.iterator] === 'function') {
    for (const _step of result) { /* disposers are irrelevant here */ }
  }
}

function makeElement(tagName) {
  const el = {
    __fakeElement: true,
    tagName: String(tagName).toUpperCase(),
    __attrs: {},
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    isConnected: true,
    setAttribute(name, value) { this.__attrs[name] = String(value) },
    getAttribute(name) { return name in this.__attrs ? this.__attrs[name] : null },
    hasAttribute(name) { return name in this.__attrs },
    removeAttribute(name) { delete this.__attrs[name] },
    appendChild(child) { this.children.push(child); return child },
    append(...nodes) { this.children.push(...nodes) },
    prepend(...nodes) { this.children.unshift(...nodes) },
    insertBefore(node) { this.children.push(node); return node },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    contains() { return false },
    closest() { return null },
    matches() { return false },
    focus() {},
    blur() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    getClientRects() { return [] },
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
  }
  return el
}

function createSandbox(log) {
  const storage = new Map()
  const head = makeElement('head')
  const body = makeElement('body')
  // CSS and other DOM side effects are part of the manifest: a style tag appended to <head> is recorded.
  head.appendChild = (child) => {
    log.push({ dom: 'head.appendChild', el: child.tagName, attrs: summarize(child.__attrs), text: summarize(child.textContent || child.innerHTML) })
    head.children.push(child)
    return child
  }
  const listeners = (owner) => (type) => log.push({ listener: `${owner}.addEventListener`, type })
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { log.push({ storage: 'setItem', key: k, value: summarize(String(v)) }); storage.set(k, String(v)) },
    removeItem: (k) => { log.push({ storage: 'removeItem', key: k }); storage.delete(k) },
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size },
  }
  const document = {
    head,
    body,
    documentElement: makeElement('html'),
    activeElement: null,
    visibilityState: 'visible',
    hidden: false,
    createElement: makeElement,
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    hasFocus: () => true,
    addEventListener: listeners('document'),
    removeEventListener() {},
  }
  const sandbox = {
    document,
    localStorage,
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => log.push({ console: 'error', args: summarize(a) }) },
    navigator: { platform: 'MacIntel', userAgent: 'fake-host', clipboard: { writeText: async () => {} }, language: 'zh-CN' },
    location: { href: 'http://127.0.0.1:3081/', origin: 'http://127.0.0.1:3081', pathname: '/', search: '', hash: '' },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    queueMicrotask,
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    EventSource: class { constructor(url) { log.push({ network: 'EventSource', url }) } addEventListener() {} close() {} },
    fetch: (...args) => { log.push({ network: 'fetch', args: summarize(args) }); return new Promise(() => {}) },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    structuredClone,
    atob,
    btoa,
    addEventListener: listeners('window'),
    removeEventListener() {},
    dispatchEvent() { return true },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    Event: class { constructor(type) { this.type = type } },
    __handoff: undefined,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.__ModuleLoader__ = { load: (handoff) => { sandbox.__handoff = handoff } }
  return sandbox
}

/**
 * Deterministic behaviors for the few service members whose results the plugin branches on at apply
 * time; everything else is a generic recording proxy.
 */
function behaviors(getRoot) {
  const endsWith = (path, suffix) => path === suffix || path.endsWith(`.${suffix}`)
  return {
    value(path) {
      if (endsWith(path, 'shortcuts.platform')) return 'darwin'
      if (endsWith(path, 'shortcuts.runtime')) return 'web'
      return NONE
    },
    call(path, args) {
      if (endsWith(path, 'inject')) {
        if (Array.isArray(args[0]) && typeof args[1] === 'function') { drain(args[1](getRoot())); return { value: undefined } }
        if (typeof args[1] === 'function') { drain(args[1]()); return { value: () => {} } }
      }
      if (endsWith(path, 'effect') && typeof args[0] === 'function') { drain(args[0]()); return { value: () => {} } }
      if (endsWith(path, 'on') || endsWith(path, 'once') || endsWith(path, 'subscribe') || endsWith(path, 'register')) return { value: () => {} }
      if (endsWith(path, 'resolveText')) return { value: args[0]?.zh ?? args[0]?.en ?? '' }
      if (endsWith(path, 'describeBinding')) return { value: { issue: null, conflicts: [] } }
      if (endsWith(path, 'getSnapshot')) {
        if (endsWith(path, 'openTabs.getSnapshot')) return { value: [] }
        if (endsWith(path, 'mounted.getSnapshot')) return { value: undefined }
        if (endsWith(path, 'list.getSnapshot')) return { value: { phase: 'ready', byId: {}, ids: [] } }
        if (endsWith(path, 'sessionStatus.getSnapshot')) return { value: new Map() }
      }
      return NONE
    },
  }
}

function makeFakeCtx(log) {
  let root
  const rules = behaviors(() => root)
  const make = (path) => new Proxy(function fakeService() {}, {
    get(_target, prop) {
      if (prop === PATH) return path
      if (prop === Symbol.toPrimitive) return () => `<${path}>`
      if (prop === Symbol.iterator) return function* () {}
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then' || prop === 'toJSON') return undefined
      if (prop === 'length') return 0
      if (prop === 'name') return path
      const special = rules.value(`${path}.${prop}`)
      return special === NONE ? make(`${path}.${prop}`) : special
    },
    apply(_target, _this, args) {
      log.push({ call: path, args: args.map((a) => summarize(a)) })
      const handled = rules.call(path, args)
      return handled === NONE ? make(`${path}()`) : handled.value
    },
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
    has: () => false,
  })
  root = make('ctx')
  return root
}

/**
 * Evaluate a bundle (as a classic script, exactly like the host's <script> loader), run its factory with
 * a seed-only `require`, call `apply(ctx)` against the fake host and return the registration manifest.
 *
 * @param {string} code bundle text (either the original client.js or a build output)
 * @param {{ fileName?: string }} [options]
 */
export async function recordManifest(code, { fileName = 'bundle.js' } = {}) {
  const log = []
  const sandbox = createSandbox(log)
  const context = vm.createContext(sandbox)
  // Freeze the nondeterminism the plugin could observe at load/apply time.
  vm.runInContext('Date.now = () => 1700000000000; Math.random = () => 0.5', context)
  new vm.Script(code, { filename: fileName }).runInContext(context)
  const handoff = sandbox.__handoff
  if (handoff === undefined) throw new Error('bundle never called window.__ModuleLoader__.load')

  const asked = new Set()
  const seeds = {
    react: permissiveReact(),
    'react/jsx-runtime': { jsx: (...a) => ({ via: 'jsx', a }), jsxs: (...a) => ({ via: 'jsxs', a }), Fragment: Symbol('Fragment') },
    'react-dom': { createPortal: (...a) => ({ $$: 'portal', a }) },
  }
  const hostRequire = (spec) => {
    asked.add(spec)
    if (spec in seeds) return seeds[spec]
    throw new Error(`client-modules: require("${spec}") missed the module table (not a seed word in this fake host)`)
  }
  const plugin = handoff.factory(hostRequire)
  if (typeof plugin?.apply !== 'function') throw new Error('factory did not return an object with apply()')
  const ctx = makeFakeCtx(log)
  await plugin.apply(ctx, undefined)
  await new Promise((resolve) => setImmediate(resolve)) // let promise continuations queued during apply run

  return {
    id: handoff.id,
    requires: [...asked].sort(),
    exports: Object.keys(plugin).sort(),
    inject: [...plugin.inject],
    calls: log,
  }
}
