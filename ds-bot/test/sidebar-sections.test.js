import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SECTIONS, groupEntries, readSections, sectionCounts, writeSections } from '../src/client/sidebar-sections.js'

const memoryStorage = (initial = {}) => {
  const held = new Map(Object.entries(initial))
  return {
    getItem: key => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => held.set(key, String(value)),
    held,
  }
}

test('both sections start expanded when nothing is saved', () => {
  assert.deepEqual(readSections(memoryStorage()), DEFAULT_SECTIONS)
})

test('a saved section survives, and the unknown one falls back to expanded', () => {
  const storage = memoryStorage({ 'ds-bot:ui': JSON.stringify({ sections: { rooms: false } }) })
  assert.deepEqual(readSections(storage), { rooms: false, bots: true })
})

test('broken or oddly shaped storage means everything expanded, never a throw', () => {
  for (const raw of ['not json', '[]', 'null', '{"sections":null}', '{"sections":{"rooms":"no","bots":3}}']) {
    assert.deepEqual(readSections(memoryStorage({ 'ds-bot:ui': raw })), DEFAULT_SECTIONS, `raw: ${raw}`)
  }
  assert.deepEqual(readSections({ getItem: () => { throw new Error('denied') } }), DEFAULT_SECTIONS)
})

test('writing merges the other keys it finds, so one section cannot erase the other', () => {
  const storage = memoryStorage({ 'ds-bot:ui': JSON.stringify({ scroll: 12, sections: { rooms: true, bots: true } }) })
  writeSections({ rooms: false }, storage)
  const saved = JSON.parse(storage.held.get('ds-bot:ui'))
  assert.equal(saved.scroll, 12, 'keys this module does not own are kept')
  assert.deepEqual(saved.sections, { rooms: false, bots: true })
})

test('a storage that refuses to write does not throw', () => {
  assert.doesNotThrow(() => writeSections({ rooms: false }, { getItem: () => null, setItem: () => { throw new Error('quota') } }))
})

test('groups go to the rooms section, bots and agents to the bots section, order kept', () => {
  const order = [
    { kind: 'room', item: { id: 'r1' } },
    { kind: 'bot', item: { id: 'b2' } },
    { kind: 'agent', item: { id: 'a1' } },
    { kind: 'room', item: { id: 'r3' } },
  ]
  const { rooms, bots } = groupEntries(order)
  assert.deepEqual(rooms.map(entry => entry.item.id), ['r1', 'r3'])
  assert.deepEqual(bots.map(entry => entry.item.id), ['b2', 'a1'], 'agents count as Bots')
})

test('a section counts only its own rows, and an approval that names a room counts once', () => {
  const counts = sectionCounts({
    rooms: [{ id: 'r1' }, { id: 'r2' }],
    bots: [{ id: 'b1' }, { id: 'b2' }, { id: 'a1' }],
    unread: new Set(['r1', 'b1']),
    asks: new Set(['r2']),
    approvals: [
      { botId: 'b1', roomId: 'r2' },
      { botId: 'a1', roomId: 'r1' },
      { botId: 'b2' },
      { botId: 'gone' },
    ],
  })
  // Both room-scoped approvals sit with the group chats; the Bot group has only the one
  // approval that names no room, and the Bot that is not in the section is not counted.
  assert.deepEqual(counts.rooms, { rows: 2, unread: 1, asks: 1, approvals: 2 })
  assert.deepEqual(counts.bots, { rows: 3, unread: 1, asks: 0, approvals: 1 })
})
