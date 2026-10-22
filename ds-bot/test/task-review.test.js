import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { candidateIdOf, reviewIdOf, STATUS, taskReview } from '../src/host/task-review.js'
import { formatEntry, parseMemory } from '../src/host/memory.js'

// A memory root whose scopes are plain text files, so the review can be driven without a
// Session, a model, or a DSH_HOME. `calls` records every write the review attempted.
function harness(t, {
  files = {},
  check = async () => ({ ok: true, project: 'project:a' }),
  extract,
  fail = undefined,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-task-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = { files }
  const calls = { apply: [], link: [], extract: 0 }
  const blank = topic => `# ${topic ?? 'Memory'}\n\n## Index\n`
  const scopeFiles = scope => (state.files[scope] ??= { 'MEMORY.md': blank() })
  const readScope = scope => Object.entries(scopeFiles(scope)).map(([file, content]) => ({
    file,
    topic: file === 'MEMORY.md' ? '' : file.slice(0, -3),
    content,
  }))
  const review = taskReview({
    root,
    check,
    extract: async (record) => {
      calls.extract += 1
      return extract === undefined ? { items: [{ scope: 'project:a', text: '用脚本发布', outcome: 'verified', source: 'part 1 #2' }] } : extract(record, calls)
    },
    applyItem: async (item) => {
      calls.apply.push(item)
      if (fail !== undefined) throw fail
      const files_ = scopeFiles(item.scope)
      const name = item.topic === '' ? 'MEMORY.md' : `${item.topic}.md`
      const content = files_[name] ?? blank(item.topic)
      // The memory module deduplicates across the whole scope, not just the target file.
      if (Object.values(files_).some(other => parseMemory(other).entries.some(entry => entry.text === item.text))) {
        return { changed: false, file: 'MEMORY.md' }
      }
      if (content.includes(item.line)) return { changed: false, file: name }
      files_[name] = content.replace('\n## Index', `\n${item.line}\n\n## Index`)
      return { changed: true, file: name }
    },
    linkTopic: async (scope, topic) => {
      calls.link.push(`${scope}/${topic}`)
      const files_ = scopeFiles(scope)
      if (!files_['MEMORY.md'].includes(`[[${topic}]]`)) files_['MEMORY.md'] = files_['MEMORY.md'].replace('\n## Index', `\n## Index\n\n- [[${topic}]]`)
    },
    readScope,
    parse: parseMemory,
    format: formatEntry,
    now: () => '2026-10-22T00:00:00.000Z',
  })
  return { root, review, calls, files: state.files, scopeFiles }
}

const candidate = { botId: 'b1', sessionId: 's1', roomId: null, project: 'project:a', callId: 'c1', result: 'done', claims: [], notes: '' }
const entriesOf = content => parseMemory(content).entries
const only = (text, meta) => formatEntry(text, meta)

test('a candidate is identified by its session and tool call, and a plan item by its review id', () => {
  assert.equal(candidateIdOf('s1', 'c1'), candidateIdOf('s1', 'c1'))
  assert.notEqual(candidateIdOf('s1', 'c1'), candidateIdOf('s1', 'c2'))
  assert.match(candidateIdOf('s1', 'c1'), /^[0-9a-f]{32}$/)
  assert.match(reviewIdOf('a'.repeat(32), 0), /^[0-9a-f]{16}$/)
  assert.notEqual(reviewIdOf('a'.repeat(32), 0), reviewIdOf('a'.repeat(32), 1))
})

test('enqueue writes the candidate before it returns, and a replay finds the same file', async t => {
  const h = harness(t)
  const record = await h.review.enqueue(candidate)
  const file = join(h.root, 'task-plans', `${record.candidateId}.json`)
  assert.equal(existsSync(file), true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, STATUS.pending)
  const replay = await h.review.enqueue({ ...candidate, result: 'different' })
  assert.equal(replay.candidateId, record.candidateId)
  assert.equal(replay.result, 'done', 'a replay does not overwrite the accepted candidate')
})

test('the plan is frozen once, with the review id in the exact line', async t => {
  const h = harness(t)
  const { candidateId } = await h.review.enqueue(candidate)
  const first = await h.review.process(candidateId)
  assert.equal(first.status, STATUS.done)
  assert.equal(h.calls.extract, 1)
  const item = first.plan.items[0]
  assert.equal(item.reviewId, reviewIdOf(candidateId, 0))
  assert.equal(item.line, only(item.text, { ...item.meta, review_id: item.reviewId }))
  assert.match(item.line, /review_id: [0-9a-f]{16}/)
  // A second pass reuses the frozen plan: no second extraction, no drift.
  await h.review.process(candidateId)
  assert.equal(h.calls.extract, 1)
  assert.deepEqual(readFileSync(join(h.root, 'task-plans', `${candidateId}.json`), 'utf8').match(/review_id: [0-9a-f]{16}/)[0], `review_id: ${item.reviewId}`)
})

test('a crash after the entry landed but before done was recorded is repaired without writing again', async t => {
  const h = harness(t)
  const { candidateId } = await h.review.enqueue(candidate)
  const first = await h.review.process(candidateId)
  const item = first.plan.items[0]
  // Simulate the kill: the line is in the Markdown, done was not written, the status is
  // still APPLYING, and the retry counter moved once.
  const broken = { ...first, status: STATUS.applying, retry: 1, progress: { done: [], conflicts: [] } }
  await h.review.save(broken)
  h.calls.apply.length = 0
  const resumed = await h.review.process(candidateId)
  assert.equal(resumed.status, STATUS.done)
  assert.deepEqual(resumed.progress.done.map(done => done.reviewId), [item.reviewId])
  assert.equal(h.calls.apply.length, 0, 'the entry was found by its review id, so nothing was rewritten')
})

test('an entry the user deleted after it was done is not written again', async t => {
  const h = harness(t)
  const { candidateId } = await h.review.enqueue(candidate)
  await h.review.process(candidateId)
  h.scopeFiles('project:a')['MEMORY.md'] = '# Memory\n\n## Index\n'
  h.calls.apply.length = 0
  const resumed = await h.review.process(candidateId)
  assert.equal(resumed.status, STATUS.done)
  assert.equal(h.calls.apply.length, 0, 'done is the authority: a deletion stays deleted')
  assert.equal(entriesOf(h.scopeFiles('project:a')['MEMORY.md']).length, 0)
})

test('an edit that keeps the review id but changes the line is a conflict, not an overwrite', async t => {
  const h = harness(t)
  const { candidateId } = await h.review.enqueue(candidate)
  const record = await h.review.process(candidateId)
  const item = record.plan.items[0]
  // The entry was written, then the user reworded it before `done` was recorded: the
  // metadata (and so the review id) stayed, the line did not. A finished candidate is
  // never re-examined, so this state is the one recovery has to judge.
  h.scopeFiles('project:a')['MEMORY.md'] = `# Memory\n\n${only('用户改过的说法', item.meta)}\n\n## Index\n`
  await h.review.save({ ...record, status: STATUS.applying, progress: { done: [], conflicts: [] } })
  h.calls.apply.length = 0
  const resumed = await h.review.process(candidateId)
  assert.equal(resumed.status, STATUS.conflict)
  assert.equal(h.calls.apply.length, 0)
  assert.match(h.scopeFiles('project:a')['MEMORY.md'], /用户改过的说法/)
  assert.equal(resumed.progress.conflicts.at(-1).reviewId, item.reviewId)
})

test('an entry another topic already holds ends the item and records the real file', async t => {
  const h = harness(t)
  const { candidateId } = await h.review.enqueue(candidate)
  const planned = await h.review.freeze(await h.review.read(candidateId), [{ scope: 'project:a', topic: 'ops', text: '用脚本发布' }])
  // The same text already lives in MEMORY.md, written earlier by someone else: the write
  // reports changed:false and points at that file, not at the planned topic.
  h.scopeFiles('project:a')['MEMORY.md'] = `# Memory\n\n${only('用脚本发布', {})}\n\n## Index\n`
  const record = await h.review.read(candidateId)
  record.plan = planned
  record.status = STATUS.planned
  await h.review.save(record)
  h.calls.apply.length = 0
  const resumed = await h.review.process(candidateId)
  assert.equal(resumed.status, STATUS.done)
  assert.deepEqual(resumed.progress.done.map(done => done.file), ['MEMORY.md'])
  assert.equal(h.calls.apply.length, 1)
  assert.doesNotMatch(h.scopeFiles('project:a')['MEMORY.md'], /review_id/, 'the existing entry keeps its own metadata')
})

test('a full file is CAPACITY: no retry is spent and a later pass does not try again', async t => {
  const full = Object.assign(new Error('no room'), { code: 'memory/full' })
  const h = harness(t, { fail: full })
  const { candidateId } = await h.review.enqueue(candidate)
  const record = await h.review.process(candidateId)
  assert.equal(record.status, STATUS.capacity)
  assert.equal(record.retry, 0, 'a full file is not a transient failure')
  const again = await h.review.process(candidateId)
  assert.equal(again.status, STATUS.capacity)
  assert.equal(h.calls.apply.length, 1, 'a capacity stop is not retried by itself')
})

test('three unusable extractions end the candidate without another model call', async t => {
  const h = harness(t, { extract: () => ({ invalid: 'the model answered with prose' }) })
  const { candidateId } = await h.review.enqueue(candidate)
  for (let pass = 0; pass < 3; pass += 1) await h.review.process(candidateId)
  const record = await h.review.read(candidateId)
  assert.equal(record.status, STATUS.skipped)
  assert.equal(record.invalid, 3)
  assert.equal(h.calls.extract, 3)
  await h.review.process(candidateId)
  assert.equal(h.calls.extract, 3, 'a skipped candidate is never extracted again')
})

test('an unreadable candidate file is quarantined and the others still run', async t => {
  const h = harness(t)
  const good = await h.review.enqueue(candidate)
  await h.review.enqueue({ ...candidate, callId: 'c2' })
  writeFileSync(join(h.root, 'task-plans', `${candidateIdOf('s1', 'c2')}.json`), '{ not json')
  const results = await h.review.recover()
  const quarantined = results.filter(result => result.status === STATUS.corrupt)
  assert.equal(quarantined.length, 1)
  assert.equal(existsSync(join(h.root, 'task-plans', 'corrupt')), true)
  assert.equal(readdirSync(join(h.root, 'task-plans', 'corrupt')).length, 1)
  assert.equal((await h.review.read(good.candidateId)).status, STATUS.done)
})

test('a candidate whose conditions are not met waits without asking the model', async t => {
  const h = harness(t, { check: async () => ({ ok: false, waiting: true }) })
  const { candidateId } = await h.review.enqueue(candidate)
  const record = await h.review.process(candidateId)
  assert.equal(record.status, STATUS.waiting)
  assert.equal(h.calls.extract, 0)
  assert.equal(h.calls.apply.length, 0)
})

test('a candidate whose project changed is dropped, never written to the new scope', async t => {
  const h = harness(t, { check: async () => ({ ok: true, project: 'project:b' }) })
  const { candidateId } = await h.review.enqueue(candidate)
  const record = await h.review.process(candidateId)
  assert.equal(record.status, STATUS.dropped)
  assert.equal(record.droppedReason, 'project-changed')
  assert.equal(h.calls.apply.length, 0)
})

test('a task whose lessons are all refused waits for an explicit retry', async t => {
  let refusals = 1
  const h = harness(t, {
    extract: () => (refusals > 0
      ? (refusals -= 1, { items: [], dropped: [{ reason: 'evidence-unsupported' }] })
      : { items: [{ scope: 'project:a', text: '第二次的教训', outcome: 'verified' }] }),
  })
  const { candidateId } = await h.review.enqueue(candidate)
  const held = await h.review.process(candidateId)
  assert.equal(held.status, STATUS.held)
  assert.equal(held.plan, null, 'no plan is frozen for a task with nothing to write')
  assert.equal(h.calls.extract, 1)
  // Nothing looks at it again by itself.
  await h.review.process(candidateId)
  assert.equal(h.calls.extract, 1)
  const retried = await h.review.retry(candidateId)
  assert.equal(retried.status, STATUS.pending)
  const after = await h.review.process(candidateId)
  assert.equal(h.calls.extract, 2, 'the explicit retry looks once more')
  assert.equal(after.status, STATUS.done)
})

test('a candidate with a frozen plan ignores the explicit retry', async t => {
  const h = harness(t)
  const { candidateId } = await h.review.enqueue(candidate)
  const done = await h.review.process(candidateId)
  assert.equal(done.status, STATUS.done)
  const retried = await h.review.retry(candidateId)
  assert.equal(retried.status, STATUS.done)
  assert.equal(h.calls.extract, 1, 'a frozen plan is never extracted again')
})