import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The panel renders as a plain element tree here, the way sidebar-sections-render.test.js
// does it: hooks are stubs, effects never run, and what a screen reader would walk is what
// is asserted. The project tabs are the part of the memory panel that showed ".git".
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/memory-panel.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  window: { matchMedia: () => ({ matches: true }), addEventListener: () => {}, removeEventListener: () => {} },
  setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, console,
  require: (name) => {
    const platform = {
      react: {
        // Components render by being called: the tree this produces is what a screen
        // reader walks too, elements and their props, with no effects run.
        createElement: (type, props, ...children) => {
          const withChildren = { ...props, children: children.flat(Infinity) }
          return typeof type === 'function' ? type(withChildren) : { type, props: withChildren }
        },
        Fragment: 'fragment',
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useCallback: fn => fn,
        useEffect: () => {}, useLayoutEffect: () => {}, useMemo: make => make(),
        useRef: initial => ({ current: initial }), useId: () => 'id',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { ProjectPicker } = module.exports

const walk = (node, found = []) => {
  if (typeof node === 'string' || typeof node === 'number') { found.push(String(node)); return found }
  if (node === null || typeof node !== 'object') return found
  found.push(node)
  for (const child of node.props?.children ?? node.children ?? []) walk(child, found)
  return found
}
const text = node => walk(node).filter(item => typeof item === 'string').join('')

// Two Git repositories with the same folder name: the host names them by path tail, so
// the tabs read differently. Deriving the name from `root` again is the #61 defect, and
// it makes both of these tabs read ".git".
const view = {
  projects: [
    { hash: 'h1', root: 'C:\\work\\same\\.git', session: 's1', name: 'work/same' },
    { hash: 'h2', root: 'C:\\personal\\same\\.git', session: 's2', name: 'personal/same' },
  ],
}

test('the project tabs show the host name, so two repositories do not both read .git', () => {
  const tree = ProjectPicker({ view, session: '', onSession: () => {} })
  const tabs = walk(tree).filter(node => node.props?.role === 'tab')
  const labels = tabs.map(tab => text(tab))
  assert.equal(labels[0], 'No project')
  assert.deepEqual(labels.slice(1), ['work/same', 'personal/same'])
  assert.equal(labels.includes('.git'), false, 'a tab must never be named after the .git directory')
  // The full path stays in the tooltip, so a name can still be traced to its repository.
  assert.deepEqual(tabs.slice(1).map(tab => tab.props.title), ['C:\\work\\same\\.git', 'C:\\personal\\same\\.git'])
})

test('choosing a tab reports the session whose memory the page should show', () => {
  const chosen = []
  const tree = ProjectPicker({ view, session: 's2', onSession: session => chosen.push(session) })
  const tabs = walk(tree).filter(node => node.props?.role === 'tab')
  // The selected project is the one the dialog was opened on.
  assert.deepEqual(tabs.map(tab => tab.props['aria-selected']), [undefined, undefined, true])
  tabs[1].props.onClick()
  tabs[0].props.onClick()
  assert.deepEqual(chosen, ['s1', ''])
})

test('a project the host could not name falls back to the root rather than to a blank tab', () => {
  const tree = ProjectPicker({
    view: { projects: [{ hash: 'h3', root: 'C:\\only', session: 's3' }] },
    session: '', onSession: () => {},
  })
  const tabs = walk(tree).filter(node => node.props?.role === 'tab')
  assert.equal(text(tabs[1]), 'C:\\only')
})

test('no projects draws no picker at all', () => {
  assert.equal(ProjectPicker({ view: { projects: [] }, session: '', onSession: () => {} }), null)
})
