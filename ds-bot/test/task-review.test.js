import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { candidateIdOf, reviewIdOf, STATUS, taskReview } from '../src/host/task-review.js'
import { formatEntry, looksSecret, parseMemory } from '../src/host/memory.js'

// A memory root whose scopes are plain text files, so the review can be driven without a
// Session, a model, or a DSH_HOME. `calls` records every write the review attempted.
function harness(t, {
  files = {},
  check = async () => ({ ok: true, project: 'project:a' }),
  extract,
  fail = undefined,
  entryProblem = () => undefined,
  secretEntry = () => false,
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
    entryProblem,
    secretEntry,
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

// A replay of an unreadable candidate must quarantine it and never rebuild over it:
// only a missing file counts as absent, and the evidence bytes survive the move (#63).
test('a replay of an unreadable candidate quarantines it and never rebuilds over it', async t => {
  const h = harness(t)
  const id = candidateIdOf('s1', 'c1')
  const dir = join(h.root, 'task-plans')
  mkdirSync(dir, { recursive: true })
  const original = '{ not json at all'
  const file = join(dir, `${id}.json`)
  writeFileSync(file, original)
  const replay = await h.review.enqueue({ ...candidate })
  assert.equal(replay.status, STATUS.corrupt)
  assert.equal(replay.quarantined, true)
  assert.equal(existsSync(file), false, 'nothing was written over the unreadable file')
  const moved = readdirSync(join(dir, 'corrupt'))
  assert.equal(moved.length, 1)
  const movedPath = join(dir, 'corrupt', moved[0])
  assert.equal(createHash('sha256').update(readFileSync(movedPath)).digest('hex'), createHash('sha256').update(original).digest('hex'), 'the evidence bytes survive the move')
  assert.equal(existsSync(join(dir, `${id}.corrupt`)), true, 'the quarantine marker is saved')
  assert.equal(h.calls.extract, 0)
})

// The marker outlives the move and the process: a quarantined candidate is not rebuilt
// by a replay, and a fresh instance over the same root (a restart) refuses it too (#63).
test('a quarantined candidate is never rebuilt, including by a fresh instance', async t => {
  const h = harness(t)
  const id = candidateIdOf('s1', 'c1')
  const dir = join(h.root, 'task-plans')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), '###')
  const results = await h.review.recover()
  assert.equal(results.filter(result => result.status === STATUS.corrupt).length, 1)
  assert.equal(readdirSync(join(dir, 'corrupt')).length, 1)
  const fresh = taskReview({
    root: h.root,
    check: async () => ({ ok: true, project: 'project:a' }),
    extract: async () => ({ items: [] }),
    applyItem: async () => ({ changed: false, file: 'MEMORY.md' }),
    linkTopic: async () => {},
    readScope: () => [],
    parse: parseMemory,
    format: formatEntry,
    now: () => '2026-10-23T00:00:00.000Z',
  })
  for (const [name, review] of [['same process', h.review], ['fresh instance', fresh]]) {
    const replay = await review.enqueue({ ...candidate })
    assert.equal(replay.status, STATUS.corrupt, name)
    assert.equal(existsSync(join(dir, `${id}.json`)), false, `${name}: no candidate was rebuilt`)
    assert.equal(readdirSync(join(dir, 'corrupt')).length, 1, `${name}: the moved evidence was not touched again`)
  }
  assert.equal(h.calls.extract, 0)
})

// A file that exists but is not this candidate's record is corruption, not absence:
// `{}`, `null` and a record under another id are all quarantined, bytes intact (#63).
test('a candidate file that is not a valid record is quarantined, not treated as absent', async t => {
  const shapes = ['{}', 'null', JSON.stringify({ candidateId: 'another-id-entirely', status: 'PENDING' })]
  for (const [index, text] of shapes.entries()) {
    const h = harness(t)
    const id = candidateIdOf('s1', `bad-${index}`)
    const dir = join(h.root, 'task-plans')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.json`)
    writeFileSync(file, text)
    const replay = await h.review.enqueue({ ...candidate, callId: `bad-${index}` })
    assert.equal(replay.status, STATUS.corrupt, `shape ${index}`)
    assert.equal(existsSync(file), false, `shape ${index}: nothing was written over it`)
    const moved = readdirSync(join(dir, 'corrupt'))
    assert.equal(moved.length, 1)
    assert.equal(readFileSync(join(dir, 'corrupt', moved[0]), 'utf8'), text, `shape ${index}: bytes preserved`)
    assert.equal(existsSync(join(dir, `${id}.corrupt`)), true, `shape ${index}: marker saved`)
  }
})

// When the move aside itself fails the unreadable file stays where it is, still marked,
// and no replay overwrites it; once the obstruction is gone the evidence moves intact (#63).
test('when the file cannot be moved aside it stays in place, marked, and is never overwritten', async t => {
  const h = harness(t)
  const dir = join(h.root, 'task-plans')
  const id = candidateIdOf('s1', 'c1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'corrupt'), 'not a directory')
  const original = '{ broken'
  const file = join(dir, `${id}.json`)
  writeFileSync(file, original)
  const first = await h.review.enqueue({ ...candidate })
  assert.equal(first.status, STATUS.corrupt)
  assert.equal(first.unreadable, true)
  assert.equal(readFileSync(file, 'utf8'), original, 'the unreadable file was not overwritten')
  assert.equal(existsSync(join(dir, `${id}.corrupt`)), true, 'the marker was still saved')
  rmSync(join(dir, 'corrupt'))
  const replay = await h.review.enqueue({ ...candidate })
  assert.equal(replay.status, STATUS.corrupt)
  assert.equal(existsSync(file), false, 'no candidate was rebuilt over it')
  const moved = readdirSync(join(dir, 'corrupt'))
  assert.equal(moved.length, 1)
  assert.equal(readFileSync(join(dir, 'corrupt', moved[0]), 'utf8'), original, 'the bytes move intact once they can')
  assert.equal(h.calls.extract, 0)
})

// A candidate can go bad twice; both copies are evidence, neither replaces the other (#63).
test('a candidate that goes bad twice keeps both copies in corrupt', async t => {
  const h = harness(t)
  const dir = join(h.root, 'task-plans')
  const id = candidateIdOf('s1', 'c1')
  mkdirSync(dir, { recursive: true })
  const first = '{ first bad'
  writeFileSync(join(dir, `${id}.json`), first)
  await h.review.recover()
  const second = '{ second bad'
  writeFileSync(join(dir, `${id}.json`), second)
  await h.review.recover()
  const moved = readdirSync(join(dir, 'corrupt')).filter(name => name.startsWith(id))
  assert.equal(moved.length, 2)
  assert.deepEqual(moved.map(name => readFileSync(join(dir, 'corrupt', name), 'utf8')).sort(), [first, second].sort())
})

// The marker is the durable fact that blocks a rebuild, so it is written before the
// original path can become empty. Each crash point of that order leaves no window:
// after the marker but before the move the unreadable file is still in place, and a
// replay quarantines it then; after the move the marker alone refuses the rebuild (#63).
test('a crash between the marker and the move aside leaves no rebuild window', async t => {
  const id = candidateIdOf('s1', 'c1')
  const evidence = '{ the unreadable bytes'
  // Crash point one: the marker is saved, the file has not moved yet.
  {
    const h = harness(t)
    const dir = join(h.root, 'task-plans')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), evidence)
    writeFileSync(join(dir, `${id}.corrupt`), '{"candidateId":"marked"}\n')
    const replay = await h.review.enqueue({ ...candidate })
    assert.equal(replay.status, STATUS.corrupt)
    assert.equal(replay.quarantined, true)
    assert.equal(existsSync(join(dir, `${id}.json`)), false, 'no candidate was rebuilt over the evidence')
    const moved = readdirSync(join(dir, 'corrupt'))
    assert.equal(moved.length, 1)
    assert.equal(readFileSync(join(dir, 'corrupt', moved[0]), 'utf8'), evidence)
    assert.equal(h.calls.extract, 0)
  }
  // Crash point two: the file has moved, only the marker is left to answer the replay.
  {
    const h = harness(t)
    const dir = join(h.root, 'task-plans')
    mkdirSync(join(dir, 'corrupt'), { recursive: true })
    writeFileSync(join(dir, 'corrupt', `${id}.2026-10-23T00-00-00-000Z.json`), evidence)
    writeFileSync(join(dir, `${id}.corrupt`), '{"candidateId":"marked"}\n')
    const replay = await h.review.enqueue({ ...candidate })
    assert.equal(replay.status, STATUS.corrupt)
    assert.equal(replay.quarantined, true)
    assert.equal(existsSync(join(dir, `${id}.json`)), false, 'no candidate was rebuilt')
    assert.equal(readdirSync(join(dir, 'corrupt')).length, 1, 'the moved evidence was not touched again')
    assert.equal(h.calls.extract, 0)
  }
})

// When the marker itself cannot be persisted the move does not happen: the unreadable
// file stays in place, untouched, and the failure is reported — never swallowed as a
// successful quarantine that a later replay could rebuild over (#63).
test('a quarantine whose marker cannot be saved fails loudly and keeps the file in place', async t => {
  const h = harness(t)
  const dir = join(h.root, 'task-plans')
  const id = candidateIdOf('s1', 'c1')
  const original = '{ unreadable but present'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), original)
  mkdirSync(join(dir, `${id}.corrupt`)) // a directory where the marker would go: the write fails
  const first = await h.review.enqueue({ ...candidate })
  assert.equal(first.status, STATUS.corrupt)
  assert.equal(first.markerFailed, true)
  assert.equal(first.quarantined, undefined)
  assert.equal(existsSync(join(dir, 'corrupt')), false, 'nothing was moved aside')
  assert.equal(readFileSync(join(dir, `${id}.json`), 'utf8'), original, 'the unreadable file was left untouched')
  // The replay answers the same way, and still nothing is rebuilt over the evidence.
  const replay = await h.review.enqueue({ ...candidate })
  assert.equal(replay.status, STATUS.corrupt)
  assert.equal(replay.markerFailed, true)
  assert.equal(readFileSync(join(dir, `${id}.json`), 'utf8'), original)
  assert.equal(h.calls.extract, 0)
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

test('an item past the limits is refused at freeze, so no plan is written and nothing applies', async t => {
  // The memory module's own limit says "too long"; the freeze step must run it again
  // because the plan file is plain JSON a person can edit between extract and apply.
  const h = harness(t, {
    entryProblem: text => (text.length > 20 ? 'An entry holds at most 20 characters' : undefined),
    extract: () => ({ items: [{ scope: 'project:a', text: '这一条教训明显超过了二十个字符的长度上限而且还要更长一些', outcome: 'verified', source: 'part 1 #2' }] }),
  })
  const { candidateId } = await h.review.enqueue(candidate)
  const record = await h.review.process(candidateId)
  assert.equal(record.status, STATUS.held, 'nothing survived the freeze-time check')
  assert.equal(record.plan, null, 'no empty plan is stored')
  assert.equal(h.calls.apply.length, 0, 'nothing was applied')
  assert.equal(record.unverified.at(-1).reason, 'invalid-at-freeze')
  assert.match(record.unverified.at(-1).problem, /at most 20 characters/)
})

test('a lesson that looks like a secret is refused at freeze', async t => {
  const h = harness(t, {
    secretEntry: text => /sk-[A-Za-z0-9]{8}/.test(text),
    extract: () => ({ items: [{ scope: 'project:a', text: 'token sk-abcdefgh', outcome: 'verified', source: 'part 1 #2' }] }),
  })
  const { candidateId } = await h.review.enqueue(candidate)
  const record = await h.review.process(candidateId)
  assert.equal(record.status, STATUS.held)
  assert.equal(record.plan, null)
  assert.equal(h.calls.apply.length, 0)
  assert.equal(record.unverified.at(-1).reason, 'invalid-at-freeze')
})

test('an all-digit review id is not read as a secret, and the entry is written', async t => {
  // `review_id` is 16 lower-case hex characters; about one in a thousand of them is all
  // digits, and the memory module reads 15 digits in a row as an ID number. This
  // candidateId was searched for so that reviewIdOf gives exactly such an id: checking it
  // like content refused the whole lesson with "the entry looks like a secret".
  const allDigits = { ...candidate, callId: 'reverify-141' }
  const id = candidateIdOf(allDigits.sessionId, allDigits.callId)
  const reviewId = reviewIdOf(id, 0)
  assert.match(reviewId, /^\d{16}$/, 'the fixture still produces an all-digit id')
  assert.equal(looksSecret(`review_id: ${reviewId}`), true, 'the raw shape is what the memory rule reads')
  const h = harness(t, { secretEntry: looksSecret })
  const { candidateId } = await h.review.enqueue(allDigits)
  const record = await h.review.process(candidateId)
  assert.equal(record.status, STATUS.done)
  assert.equal(record.plan.items.length, 1, 'the entry survives the freeze')
  assert.match(record.plan.items[0].line, new RegExp(`review_id: ${reviewId}`))
})

test('the secret check still reads the other metadata values and the text', async t => {
  // The `review_id` exclusion must not weaken the check: a digit run in a real value is
  // still refused, whether it sits in the metadata or in the entry text itself.
  const source = harness(t, {
    secretEntry: looksSecret,
    extract: () => ({ items: [{ scope: 'project:a', text: '用脚本发布', outcome: 'verified', meta: { kind: 'howto', source: '1234567890123456' } }] }),
  })
  const first = await source.review.process((await source.review.enqueue(candidate)).candidateId)
  assert.equal(first.status, STATUS.held)
  assert.equal(first.unverified.at(-1).reason, 'invalid-at-freeze')
  const body = harness(t, {
    secretEntry: looksSecret,
    extract: () => ({ items: [{ scope: 'project:a', text: '账号 1234567890123456', outcome: 'verified', source: 'part 1 #2' }] }),
  })
  const second = await body.review.process((await body.review.enqueue({ ...candidate, callId: 'c2' })).candidateId)
  assert.equal(second.status, STATUS.held)
  assert.equal(second.unverified.at(-1).reason, 'invalid-at-freeze')
})