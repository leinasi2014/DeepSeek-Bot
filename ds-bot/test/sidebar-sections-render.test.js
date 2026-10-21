import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The sidebar renders as a plain element tree here: hooks are stubs, effects never run, and a
// section is judged by the shape it renders.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/sidebar.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: {
        // Components render by being called: the tree this produces is what a screen reader
        // walks too, elements and their props, with no effects run.
        createElement: (type, props, ...children) => {
          const withChildren = { ...(props ?? {}), children: children.flat(Infinity) }
          return typeof type === 'function' ? type(withChildren) : { type, props: withChildren }
        },
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useLayoutEffect: () => {}, useMemo: make => make(),
        useRef: initial => ({ current: initial }), useId: () => 'id', Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { TeamSidebar } = module.exports

const plain = value => JSON.parse(JSON.stringify(value))
const walk = (node, found = []) => {
  if (node === null || typeof node !== 'object') return found
  found.push(node)
  // Children live in props: the stub hands them to a component the way React does.
  for (const child of node.props?.children ?? node.children ?? []) walk(child, found)
  return found
}
const nodesWithClass = (tree, className) => walk(tree).filter(node => node.props?.className === className)

const team = {
  ready: true,
  mainBotId: 'm1',
  byId: {
    m1: { id: 'm1', name: 'Chief' },
    b1: { id: 'b1', name: 'Writer' },
    b2: { id: 'b2', name: 'Coder' },
  },
  bots: [{ id: 'm1', name: 'Chief', createdAt: 1 }, { id: 'b1', name: 'Writer', createdAt: 1 }, { id: 'b2', name: 'Coder', createdAt: 1 }],
  rooms: [{ id: 'r1', name: 'Launch', members: [], createdAt: 1 }],
  roomsById: { r1: { id: 'r1', name: 'Launch', members: [] } },
  questions: {},
  exchangeTurns: {},
  agents: [{ id: 'a1', name: 'DSH Agent', sessions: [], createdAt: 1 }],
}
// Every selector store answers with the state it is given, so a component reads what the
// test put there.
const store = value => selector => selector(value)
const props = wide => ({
  wide,
  useRoster: store(team),
  useUi: store({ unread: {} }),
  useSessions: store({ ids: [], byId: {} }),
  useRegistry: store({}),
  useUpdate: store({}),
  useSessionStatus: store(new Map()),
  useSessionRetainInfo: (id, selector) => selector(undefined),
  useActivity: store({}),
  useWork: store({}),
  actions: {},
})

test('the wide sidebar shows the Main Bot, then a group-chat section and a Bots section', () => {
  const tree = TeamSidebar(props(true))
  const headers = nodesWithClass(tree, 'bt-side-section')
  assert.equal(headers.length, 2)
  assert.deepEqual(plain(headers.map(header => [header.props['aria-label'].split(',')[0], header.props['aria-expanded']])), [
    ['Group chats', 'true'],
    ['Bots', 'true'],
  ])
  const counts = nodesWithClass(tree, 'bt-side-section-count').map(node => node.props.children.join(''))
  // One group chat, and in Bots: two Bots plus the Agent, with the Main Bot left out.
  assert.deepEqual(counts, ['1', '3'])
  // The Main Bot sits above both sections, not inside one.
  const list = nodesWithClass(tree, 'bt-list')[0]
  const listed = list.props.children.filter(child => child !== null)
  // The Main Bot is the wide sidebar's tile, drawn above the sections.
  assert.equal(listed[0].props.className, 'bt-tile-wrap')
  const mainTile = listed[0].props.children.find(child => child?.props?.['aria-label'])
  assert.equal(mainTile.props['aria-label'].startsWith('Chief'), true)
  // Each section holds its own rows: one group chat, and the two Bots plus the Agent.
  const rowsIn = name => {
    const section = nodesWithClass(tree, 'bt-side-rows').find(rows => rows.props['aria-label'] === name)
    return walk(section).filter(node => node.props?.className === 'bt-row').map(node => node.props['aria-label'].split(',')[0])
  }
  assert.deepEqual(plain(rowsIn('Group chats')), ['Launch'])
  assert.deepEqual(plain(rowsIn('Bots')), ['Writer', 'Coder', 'DSH Agent'])
})

test('the narrow rail shows every row and no headers at all', () => {
  const tree = TeamSidebar(props(false))
  assert.equal(nodesWithClass(tree, 'bt-side-section').length, 0)
  // Every row is there: the Main Bot, one group chat, two Bots and the Agent.
  assert.equal(nodesWithClass(tree, 'bt-row').length, 5)
})
