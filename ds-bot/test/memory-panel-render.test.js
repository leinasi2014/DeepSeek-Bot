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
const { ProjectPicker, Entries } = module.exports

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

// #96: the ask prompt numbers the entries own, then team, then project, and the model
// answers "edit 3" with that number. A person could not see any number, so "3" meant the
// third row on screen — a different entry whenever own or team held any. The panel now
// shows the same number the model was given, whichever section the row is drawn in.
const numbered = (entries, sizes) => ({
  entries,
  sizes,
  limits: { main: 4000, entry: 300, topic: 16000 },
  project: sizes.project === undefined ? null : { hash: 'h1', root: 'C:\\work\\alpha' },
})
const rowNumbers = tree => walk(tree)
  .filter(node => node.props?.className === 'bt-mem-entry-number')
  .map(node => text(node))

test('every entry row shows the number the ask prompt gave it', () => {
  const entries = [
    { scope: 'own', topic: null, text: 'Own first' },
    { scope: 'own', topic: null, text: 'Own second' },
    { scope: 'team', topic: null, text: 'Team one' },
    { scope: 'project', topic: null, text: 'Project one' },
  ]
  const tree = Entries({
    bot: { name: 'Writer' },
    view: numbered(entries, { own: 100, team: 50, project: 20 }),
    remove: async () => true,
  })
  assert.deepEqual(rowNumbers(tree), ['[1]', '[2]', '[3]', '[4]'])
})

test('the numbers follow the list the model reads, not the order of the sections', () => {
  // No own entries, one team entry, one project entry: the model reads [1] team, [2]
  // project. The panel draws the team section above the project one, so a person
  // counting rows would still have said "1" for the project entry.
  const entries = [
    { scope: 'team', topic: null, text: 'Team one' },
    { scope: 'project', topic: null, text: 'Project one' },
  ]
  const tree = Entries({
    bot: { name: 'Writer' },
    view: numbered(entries, { own: 0, team: 50, project: 20 }),
    remove: async () => true,
  })
  const rows = walk(tree).filter(node => node.props?.className === 'bt-mem-entry')
  const textOf = row => walk(row).filter(item => typeof item === 'string').join(' ')
  const projectRow = rows.find(row => textOf(row).includes('Project one'))
  assert.deepEqual(rowNumbers(projectRow), ['[2]'])
})

test('a topic entry keeps its place in the numbered list', () => {
  const entries = [
    { scope: 'own', topic: null, text: 'In MEMORY.md' },
    { scope: 'own', topic: 'travel', text: 'In a topic' },
  ]
  const tree = Entries({
    bot: { name: 'Writer' },
    view: numbered(entries, { own: 100, team: 0 }),
    remove: async () => true,
  })
  assert.deepEqual(rowNumbers(tree), ['[1]', '[2]'])
})
