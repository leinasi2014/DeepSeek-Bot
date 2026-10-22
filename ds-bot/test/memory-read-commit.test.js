import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as actual from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, mock } from 'node:test'
import { fakeContext } from './fake-ctx.js'

let fault
const { default: defaultExport, ...namedExports } = actual
mock.module('node:fs/promises', { defaultExport: { ...defaultExport }, namedExports: {
  ...namedExports,
  async rename(from, to) {
    if (fault?.rollbackFail && String(from).endsWith('.bak')) throw new Error('EPERM restoring backup')
    return actual.rename(from, to)
  },
  async open(path, flags) {
    if (fault?.openFail && path === fault.path) throw new Error('EPERM opening journal')
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
    archive: () => rt.archiveBotMemory('b2'),
    read: (...path) => readFileSync(join(home, 'memory', ...path), 'utf8'),
  }
}

test('a failed rollback blocks a duplicate-target move and other writes before they alter recovery files', async t => {
  const s = start(t)
  await s.tool('remember', { text: 'Deliver on Friday' })
  const before = s.read('bots', 'b2', 'MEMORY.md')
  const entry = before.split('\n').find(line => line.startsWith('- Deliver'))
  const dir = join(s.home, 'memory/bots/b2')
  writeFileSync(join(dir, 'ops.md'), `# ops\n\n${entry}\n`)
  const journal = s.read('journal.jsonl')
  fault = { path: join(s.home, 'memory/journal.jsonl'), openFail: true, rollbackFail: true }
  assert.match(await s.tool('remember', { replace: 'Deliver on Friday', text: 'Deliver on Thursday' }), /could not be fully rolled back/)
  fault = undefined
  const held = () => Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')]))
  const recovery = held()
  assert.match(recovery['MEMORY.md'], /Deliver on Thursday/)
  const backup = Object.keys(recovery).find(name => name.endsWith('.bak'))
  assert.equal(recovery[backup], before)
  assert.match(await s.tool('remember', { text: 'Another fact' }), /could not be fully rolled back/)
  assert.match(await s.tool('move', { entry: 'Deliver on Friday', topic: 'ops' }), /could not be fully rolled back/)
  assert.match(await s.tool('forget', { entry: 'Deliver on Friday' }), /could not be fully rolled back/)
  assert.throws(() => s.archive(), /could not be fully rolled back/)
  assert.deepEqual(held(), recovery, 'the body, duplicate topic, and recovery backup remain byte-for-byte unchanged')
  assert.equal(s.read('journal.jsonl'), journal)
  assert.doesNotMatch(JSON.stringify((await s.view()).entries), /Deliver on Thursday/)
})

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
    // recall collects inside the write queue now, so it waits for this pending commit
    // rather than reading past it; the committed view is asserted through the readers
    // above, and recall is checked once the write has settled.
  } finally {
    resume()
  }
  assert.match(await changing, /ENOSPC/)
  fault = undefined
  assert.match(await s.tool('recall', { scope: 'team', query: 'Friday' }), /Deliver on Friday/)
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
        // recall now collects inside the write queue (memory index), so it waits for this
        // commit instead of reading past it; the synchronous readers above are what see
        // the committed view while the write is pending. recall is checked after resume.
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
      // The queued recall settles with the same set the panel shows.
      const recalled = await s.tool('recall', { query: 'Deliver' })
      for (const text of expected) assert.match(recalled, new RegExp(text))
      if (expected.length === 0) assert.match(recalled, /Nothing/)
      assert.equal(s.section('b2'), frozen, 'first render freezes the committed pre-change view even after a successful change')
      assert.equal(s.read('snapshots', 'b2.md'), frozen)
      assert.equal(s.section('m1'), chief, 'existing snapshots stay byte-stable')
      assert.equal(s.read('snapshots', 'm1.md'), chiefSnapshot)
    })
  }
}
