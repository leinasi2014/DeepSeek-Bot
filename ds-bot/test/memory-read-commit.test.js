import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as actual from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, mock } from 'node:test'
import { fakeContext } from './fake-ctx.js'

let fault
const { default: defaultExport, ...namedExports } = actual
mock.module('node:fs/promises', { defaultExport: { ...defaultExport }, namedExports: {
  ...namedExports,
  async open(path, flags) {
    const file = await actual.open(path, flags)
    return {
      stat: () => file.stat(), truncate: n => file.truncate(n), close: () => file.close(),
      async write(bytes, ...args) {
        const held = fault
        if (held !== undefined && path === held.path && JSON.parse(bytes.toString()).op === held.op) {
          held.began()
          await held.wait
          if (held.fail) throw Object.assign(new Error('ENOSPC journal record'), { code: 'ENOSPC' })
        }
        return file.write(bytes, ...args)
      },
    }
  },
} })
after(() => mock.reset())
const { install } = await import('../src/host/memory.js')

function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-committed-'))
  const ctx = fakeContext()
  const bots = { b2: { id: 'b2', name: 'Writer' }, m1: { id: 'm1', name: 'Chief' } }
  const rt = {
    ctx, home, config: { memoryReview: false }, state: { rooms: {} },
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    botOf: id => bots[id], selfOf: id => id, isMain: id => id === 'm1',
    groupOwners: new Map(), partsOf: id => [{ sessionId: id }], clock: () => '12:00',
    async* eventsBackwards() { /* no saved history in this fixture */ },
  }
  install(rt)
  t.after(async () => { fault = undefined; await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  return {
    home,
    tool: (name, args, id = 'b2') => ctx.registeredTools.get(name).execute(args, { agent: { id } }),
    section: id => ctx.sections.get('bot-memory').text({ agent: { id } }),
    view: () => rt.memoryEndpoint('memory-view', { botId: 'b2' }),
    read: (...path) => readFileSync(join(home, 'memory', ...path), 'utf8'),
  }
}

test('another Bot freezes committed team memory while its replacement is pending and then rolled back', async t => {
  const s = start(t)
  await s.tool('remember', { scope: 'team', text: 'Deliver on Friday' }, 'm1')
  const chief = s.section('m1')
  let began, resume
  const started = new Promise(resolve => { began = resolve })
  const wait = new Promise(resolve => { resume = resolve })
  fault = { path: join(s.home, 'memory/journal.jsonl'), op: 'replace', fail: true, began, wait }
  const changing = s.tool('remember', { scope: 'team', text: 'Deliver on Thursday', replace: 'Deliver on Friday' }, 'm1')
  await started
  let frozen
  try {
    frozen = s.section('b2')
    assert.match(frozen, /Deliver on Friday/)
    assert.doesNotMatch(frozen, /Deliver on Thursday/)
    assert.deepEqual((await s.view()).entries.map(entry => [entry.text, entry.scope]), [['Deliver on Friday', 'team']])
    assert.match(await s.tool('recall', { scope: 'team', query: 'Friday' }), /Deliver on Friday/)
  } finally {
    resume()
  }
  assert.match(await changing, /ENOSPC/)
  fault = undefined
  assert.equal(s.section('b2'), frozen)
  assert.equal(s.read('snapshots', 'b2.md'), frozen)
  assert.match(s.read('team', 'MEMORY.md'), /Deliver on Friday/)
  assert.doesNotMatch(s.read('team', 'MEMORY.md'), /Thursday/)
  assert.equal(s.section('m1'), chief)
})

for (const operation of ['replace', 'add-topic', 'remove-topic']) {
  for (const fail of [false, true]) {
    test(`a first memory snapshot and synchronous readers see only committed ${operation} data when journal ${fail ? 'fails' : 'succeeds'}`, async t => {
      const s = start(t)
      await s.tool('remember', { text: 'Deliver on Friday', ...(operation === 'remove-topic' ? { topic: 'ops' } : {}) })
      const chief = s.section('m1')
      const chiefSnapshot = s.read('snapshots', 'm1.md')
      assert.equal(existsSync(join(s.home, 'memory/snapshots/b2.md')), false)
      let began, resume
      const started = new Promise(resolve => { began = resolve })
      const wait = new Promise(resolve => { resume = resolve })
      fault = { path: join(s.home, 'memory/journal.jsonl'), op: operation === 'replace' ? 'replace' : operation === 'add-topic' ? 'add' : 'remove', fail, began, wait }
      const changing = operation === 'replace'
        ? s.tool('remember', { text: 'Deliver on Thursday', replace: 'Deliver on Friday' })
        : operation === 'add-topic'
          ? s.tool('remember', { text: 'Deliver on Thursday', topic: 'ops' })
          : s.tool('forget', { entry: 'Deliver on Friday', topic: 'ops' })
      await started
      let frozen
      try {
        frozen = s.section('b2')
        assert.doesNotMatch(frozen, /Deliver on Thursday/)
        if (operation === 'remove-topic') assert.match(frozen, /Topics: \[\[ops\]\]/)
        else {
          assert.match(frozen, /Deliver on Friday/)
          assert.doesNotMatch(frozen, /\[\[ops\]\]/)
        }
        assert.deepEqual((await s.view()).entries.map(entry => [entry.text, entry.topic]), [['Deliver on Friday', operation === 'remove-topic' ? 'ops' : null]])
        assert.match(await s.tool('recall', { query: 'Friday' }), /Deliver on Friday/)
        assert.doesNotMatch(await s.tool('recall', { query: 'Thursday' }), /Deliver on Thursday/)
        const topic = await s.tool('recall', { topic: 'ops' })
        assert.match(topic, operation === 'remove-topic' ? /Deliver on Friday/ : /No topic/)
      } finally {
        resume()
      }
      const answer = await changing
      fault = undefined
      if (fail) assert.match(answer, /ENOSPC/)
      else assert.match(answer, /^(Saved|Updated|Removed)/)
      const expected = fail ? ['Deliver on Friday'] : operation === 'replace' ? ['Deliver on Thursday'] : operation === 'add-topic' ? ['Deliver on Friday', 'Deliver on Thursday'] : []
      assert.deepEqual((await s.view()).entries.map(entry => entry.text), expected)
      assert.equal(s.section('b2'), frozen, 'first render freezes the committed pre-change view even after a successful change')
      assert.equal(s.read('snapshots', 'b2.md'), frozen)
      assert.equal(s.section('m1'), chief, 'existing snapshots stay byte-stable')
      assert.equal(s.read('snapshots', 'm1.md'), chiefSnapshot)
    })
  }
}
