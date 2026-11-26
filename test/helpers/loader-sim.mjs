/**
 * Simulates the host's bundle loader closely enough to catch wrapper/require mistakes:
 *  - the bundle is evaluated as a CLASSIC script (a syntax error or stray import/export fails here);
 *  - the sandbox has no global `require`/`module`/`process`, so any dependency that does not go through the
 *    factory's `require` parameter throws;
 *  - `require` is seed-only, like dsh-client-modules' makeRequire (unknown specifier => "missed the module table").
 */
import vm from 'node:vm'

/**
 * @param {string} code bundle text
 * @param {Record<string, unknown>} seeds specifier -> module object the fake host hands out
 * @param {{ fileName?: string }} [options]
 */
export function simulateLoader(code, seeds, { fileName = 'bundle.js' } = {}) {
  let handoff
  const sandbox = { window: { __ModuleLoader__: { load: (h) => { handoff = h } } } }
  vm.createContext(sandbox)
  new vm.Script(code, { filename: fileName }).runInContext(sandbox)
  if (handoff === undefined) throw new Error('bundle never called window.__ModuleLoader__.load')
  const asked = []
  const hostRequire = (spec) => {
    asked.push(spec)
    if (Object.hasOwn(seeds, spec)) return seeds[spec]
    throw new Error(`client-modules: require("${spec}") missed the module table (not a seed word)`)
  }
  const plugin = handoff.factory(hostRequire)
  return { id: handoff.id, plugin, asked }
}

const REACT_NOOPS = [
  'Children', 'Component', 'Profiler', 'PureComponent', 'StrictMode', 'Suspense', 'cloneElement', 'createRef', 'forwardRef',
  'isValidElement', 'lazy', 'memo', 'startTransition', 'use', 'useActionState', 'useCallback', 'useContext', 'useDebugValue',
  'useDeferredValue', 'useEffect', 'useId', 'useImperativeHandle', 'useInsertionEffect', 'useLayoutEffect', 'useMemo',
  'useOptimistic', 'useReducer', 'useRef', 'useState', 'useSyncExternalStore', 'useTransition',
]

/**
 * React stand-in for tests that run plugin code but never render. It is a plain object with real own properties
 * (bun compiles `import * as React` into a copy of the module's OWN property names, so a Proxy would lose them,
 * unlike the host's real React module). createElement/createContext/Fragment work; every other API is a no-op.
 */
export function permissiveReact() {
  const react = {
    createElement: (type, props, ...children) => ({ $$: 'element', type, props, children }),
    createContext: (initial) => ({ $$: 'context', Provider: { $$: 'provider' }, Consumer: { $$: 'consumer' }, initial }),
    Fragment: Symbol.for('react.fragment'),
    version: '0.0.0-fake',
  }
  for (const name of REACT_NOOPS) react[name] = () => undefined
  return react
}
