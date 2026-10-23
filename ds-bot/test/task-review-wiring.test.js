import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { apply } from '../index.js'
import { parseMemory } from '../src/host/memory.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// A user line, the plain answer, and the tool result the claims quote: `command` and
// `test` claims may only rest on a real tool result (#66), so the fixture carries one —
// its tool name, its output and its exit code — instead of the Bot saying its own tests
// passed. The Bot's own words could never prove that.
const HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh.' }] } } } },
    { event: { seq: 12, type: 'tool/call', data: { turn: 1, step: 1, callId: 'k1', name: 'bash', arguments: '{"command":"npm test"}' } } },
    { event: { seq: 13, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'k1' }, toolCallId: 'k1', content: [{ type: 'text', text: 'tests 12/12 passing' }, { type: 'text', text: '[exit code: 0]' }] } } } },
  ],
}

// The three model calls are answered by their system prompt, so the order in which the
// idle handlers happen to run does not matter.
function start({ items = [], support = [], memory = '{"changes":[]}', cwd, works, questions } = {}) {
  // Each verify call takes the next list, so a retry can be answered differently.
  const supportQueue = Array.isArray(support[0]) ? [...support] : undefined
  let folder = cwd
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-review-wiring-'))
  // Work still open when the report is made, and the question card on screen: both are
  // what WAITING must consult, and neither is derived from the Bot id.
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    ...TEAM,
    works: works ?? {},
    questions: questions ?? {},
  }))
  const ctx = fakeContext()
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream(request) {
        requests.push(request)
        const system = String(request.system ?? '')
        let reply = ''
        if (system.startsWith('You keep the long-term memory')) reply = memory
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items })
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support: supportQueue === undefined ? support : (supportQueue.shift() ?? []) })
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (HISTORY[sessionId] ?? []).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (HISTORY[address.sessionId] ?? []).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [], get: id => (folder === undefined ? undefined : { id, header: { cwd: folder } }) },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home, memoryReviewDelayMs: 0 })
  const tool = (name, args, sessionId, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId })
  const json = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const memoryFile = () => join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
  const planDir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(planDir())
    ? readdirSync(planDir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(planDir(), name), 'utf8')))
    : [])
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const setCwd = next => { folder = next }
  const memoryPathOf = record => (record.project === null
    ? join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
    : join(home, 'memory', 'projects', record.project.slice('project:'.length), 'MEMORY.md'))
  return { ctx, home, tool, json, memoryFile, memoryPathOf, planDir, plans, requests, setCwd, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check) {
  for (let tries = 0; tries < 300 && !check(); tries += 1) await settle()
  assert.ok(check(), 'the condition did not hold within 6 s')
}
const idle = ctx => ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })

const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: 'tests 12/12', ref: 'bash k1' }
const report = { result: '完成发布脚本验证', claims: [CLAIM], notes: '' }
const ONE_ITEM = [{ claim: 0, topic: '', text: '发布用 scripts/ship.sh，测试通过后再发布', outcome: 'verified' }]

// The answers are matched to the questions by position, so the number of questions has to
// be the number the caller can use. A plan holds eight entries; a ninth lesson extracted
// from the same report used to be verified and then dropped by the freeze with no trace.
// It is now recorded as unverified, and the batch stays at the eight the plan can hold.
test('a report that yields more lessons than a plan holds keeps the extras on record', async t => {
  const items = Array.from({ length: 9 }, (_, at) => ({ claim: 0, topic: '', text: `发布教训 ${at + 1}`, outcome: 'verified' }))
  const s = start({ items, support: Array.from({ length: 8 }, () => 'yes') })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-over-plan')
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'DONE', () => `status=${s.plans()[0]?.status}`)
  const record = s.plans()[0]
  assert.equal(record.plan.items.length, 8, 'a plan holds eight entries')
  assert.equal(record.unverified.filter(entry => entry.reason === 'plan-full').length, 1, 'the ninth lesson is kept on record')
  assert.equal(s.requests.filter(request => String(request.system).startsWith('You check whether')).length, 1, 'one batch, not two')
  assert.equal(parseMemory(readFileSync(s.memoryPathOf(record), 'utf8')).entries.length, 8)
})

test('a report without claims is refused and records nothing', async t => {
  const s = start()
  t.after(() => s.stop())
  assert.match(await s.tool('complete_task', { result: 'done' }, 'b2', 'c1'), /Give at least one claim/)
  const missing = await s.tool('complete_task', { result: 'done', claims: [{ statement: 'x', evidence: '  ' }] }, 'b2', 'c2')
  assert.match(missing, /needs both what it claims and the exact words/)
  assert.equal(existsSync(s.planDir()), false)
})

test('a report whose evidence is not in the conversation writes no memory', async t => {
  const s = start({ items: [{ claim: 0, topic: '', text: '伪造的教训', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  const forged = { ...CLAIM, evidence: 'the suite passed: tests 99/99' }
  assert.match(await s.tool('complete_task', { ...report, claims: [forged] }, 'b2', 'c1'), /Recorded as a candidate/)
  idle(s.ctx)
  await until(() => s.plans().length === 1)
  await until(() => s.plans()[0].status === 'HELD')
  assert.equal(existsSync(s.memoryFile()), false, 'nothing was written to memory')
  assert.equal(s.plans()[0].plan, null, 'no plan is frozen when every lesson was refused')
  // What the gate refused stays with the candidate, never in the Markdown.
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
})

test('a verified claim writes one entry with its review id, and the plan is kept', async t => {
  const s = start({ items: ONE_ITEM, support: ['yes'] })
  t.after(() => s.stop())
  assert.match(await s.tool('complete_task', report, 'b2', 'call-1'), /Recorded as a candidate/)
  // Nothing is written in the reporting turn itself.
  assert.equal(existsSync(s.memoryFile()), false)
  idle(s.ctx)
  // The entry lands first; the record is marked DONE once the whole frozen plan has been
  // applied, so both have to hold before the state is read — APPLYING in between is a
  // legitimate state a crash could leave behind.
  await until(() => existsSync(s.memoryFile()) && s.plans()[0]?.status === 'DONE')
  const text = readFileSync(s.memoryFile(), 'utf8')
  // The entry carries the metadata §5/§6 require: where it came from, when it was added
  // (frozen with the plan, never recomputed), and whether it held.
  assert.match(text, /- 发布用 scripts\/ship\.sh，测试通过后再发布 \[kind: howto; claim: 0; evidence: tests 12\/12; source: bash k1; outcome: verified; added: \d{4}-\d{2}-\d{2}; review_id: [0-9a-f]{16}\]/)
  assert.equal(parseMemory(text).entries.length, 1)
  const [record] = s.plans()
  assert.equal(record.status, 'DONE')
  assert.equal(record.plan.items[0].text, '发布用 scripts/ship.sh，测试通过后再发布')
  assert.deepEqual(record.progress.done.map(done => done.reviewId), [record.plan.items[0].reviewId])
})

test('a file claim outside the Session folder is refused even when the words match', async t => {
  const outside = join(tmpdir(), 'ds-bot-outside.txt')
  writeFileSync(outside, 'tests 12/12 passed in another project')
  t.after(() => rmSync(outside, { force: true }))
  const s = start({ items: [{ claim: 0, topic: '', text: '来自别处文件的教训', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  const claim = { kind: 'file', statement: '测试通过', evidence: 'tests 12/12', ref: outside }
  await s.tool('complete_task', { ...report, claims: [claim] }, 'b2', 'call-file')
  idle(s.ctx)
  await until(() => s.plans().length === 1)
  await until(() => s.plans()[0].status === 'HELD')
  assert.equal(existsSync(s.memoryFile()), false)
  assert.equal(s.plans()[0].plan, null)
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
})

test('a model that does not support the claim writes no memory', async t => {
  const s = start({ items: ONE_ITEM, support: ['no'] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-2')
  idle(s.ctx)
  await until(() => s.plans().length === 1)
  await until(() => s.plans()[0].status === 'HELD')
  assert.equal(existsSync(s.memoryFile()), false)
  assert.equal(s.plans()[0].unverified[0].reason, 'model-unsupported')
})

test('a done candidate never asks the model again', async t => {
  const s = start({ items: ONE_ITEM, support: ['yes'] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-3')
  idle(s.ctx)
  await until(() => existsSync(s.memoryFile()))
  await until(() => s.plans()[0]?.status === 'DONE')
  const calls = s.requests.length
  idle(s.ctx)
  await settle()
  await settle()
  assert.equal(s.requests.length, calls, 'a done candidate is not extracted again')
  assert.equal(parseMemory(readFileSync(s.memoryFile(), 'utf8')).entries.length, 1)
})

test('an explicit retry reopens a held task, and a frozen one is never extracted again', async t => {
  // The first check says no, so nothing is written and the candidate is held; the retry
  // asks once more and the second answer supports the claim.
  const s = start({ items: ONE_ITEM, support: [['no'], ['yes']] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-retry')
  idle(s.ctx)
  await until(() => s.plans().length === 1)
  await until(() => s.plans()[0].status === 'HELD')
  assert.equal(existsSync(s.memoryFile()), false, 'a held task wrote nothing')
  assert.equal(s.plans()[0].unverified[0].reason, 'model-unsupported')
  // Idle alone must not look again.
  const before = s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length
  idle(s.ctx)
  await settle()
  await settle()
  const afterIdle = s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length
  assert.equal(afterIdle, before, 'nothing retries by itself')
  const id = s.plans()[0].candidateId
  const retried = await s.json('memory-task-retry', { candidateId: id })
  assert.equal(retried.value.ok, true)
  assert.equal(retried.value.status, 'PENDING')
  idle(s.ctx)
  await until(() => s.plans().some(record => record.candidateId === id && record.status === 'DONE'))
  assert.equal(parseMemory(readFileSync(s.memoryFile(), 'utf8')).entries.length, 1)
  // A frozen plan is never extracted again, even when asked.
  const extraction = s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length
  await s.json('memory-task-retry', { candidateId: id })
  await settle()
  assert.equal(s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length, extraction)
})

// A claim about a relative file is judged against the folder frozen at enqueue, even if
// the Session works somewhere else by the time the review runs. Both folders sit in one
// repository, so the project identity stays the same and only the file root is at stake.
test('a relative file claim is judged against the cwd frozen at enqueue', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'ds-bot-cwd-'))
  const first = join(repo, 'a')
  const second = join(repo, 'b')
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(first, { recursive: true })
  mkdirSync(second, { recursive: true })
  writeFileSync(join(first, 'notes.txt'), 'the suite passed: tests 12/12')
  writeFileSync(join(second, 'notes.txt'), 'something else entirely')
  const s = start({ cwd: first, items: [{ claim: 0, topic: '', text: '发布脚本的测试通过', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  const claim = { kind: 'file', statement: '测试通过', evidence: 'tests 12/12', ref: 'notes.txt' }
  await s.tool('complete_task', { ...report, claims: [claim] }, 'b2', 'call-cwd')
  const [record] = s.plans()
  assert.equal(record.cwd, first, 'the folder is frozen with the candidate')
  // The Session moves on before the review runs; the file is still the one in `first`.
  s.setCwd(second)
  idle(s.ctx)
  await until(() => s.plans()[0].status === 'DONE')
  const text = readFileSync(s.memoryPathOf(s.plans()[0]), 'utf8')
  assert.match(text, /发布脚本的测试通过/)
})

// A file claim is checked against the file, not against a line of the conversation, so the
// only thing the semantic gate can be told about where the quote came from is the file it
// came from. That string is the whole of `context` on this path (#84): dropping it leaves
// the gate reading a bare quote with no source at all, and nothing else in the request says
// which file the words were found in.
test('a file claim tells the check which file its quote came from', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-file-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'notes.txt'), 'the suite passed: tests 12/12')
  const s = start({ cwd: root, items: [{ claim: 0, topic: '', text: '发布脚本的测试通过', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  const claim = { kind: 'file', statement: '测试通过', evidence: 'tests 12/12', ref: 'notes.txt' }
  await s.tool('complete_task', { ...report, claims: [claim] }, 'b2', 'call-file-context')
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'DONE')
  const check = s.requests.find(request => String(request.system).startsWith('You check whether'))
  assert.ok(check !== undefined, 'the semantic gate was asked')
  const sent = check.messages.at(-1).content.map(block => block?.text ?? '').join('\n')
  assert.match(sent, /"context":"file notes.txt"/, 'the check is told which file the quote was read from')
  assert.match(sent, /"kind":"file"/)
  assert.match(sent, /"evidence":"tests 12\/12"/)
})

test('a relative file claim that leaves the folder is refused', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-cwd-out-'))
  const inner = join(root, 'inner')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(root, 'outside.txt'), 'the suite passed: tests 12/12')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const s = start({ cwd: inner, items: [{ claim: 0, topic: '', text: '越界的教训', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  const claim = { kind: 'file', statement: '测试通过', evidence: 'tests 12/12', ref: '../outside.txt' }
  await s.tool('complete_task', { ...report, claims: [claim] }, 'b2', 'call-esc')
  idle(s.ctx)
  await until(() => s.plans().length === 1)
  await until(() => s.plans()[0].status === 'HELD')
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
  assert.equal(existsSync(s.memoryPathOf(s.plans()[0])), false)
})

test('a failed lesson is written with its outcome, so it is told apart from one that held', async t => {
  const s = start({ items: [{ claim: 0, topic: '', text: '发布脚本在测试未过时不能发布', outcome: 'failed' }], support: ['yes'] })
  t.after(() => s.stop())
  assert.match(await s.tool('complete_task', report, 'b2', 'call-failed'), /Recorded as a candidate/)
  idle(s.ctx)
  await until(() => existsSync(s.memoryFile()) && s.plans()[0]?.status === 'DONE')
  const text = readFileSync(s.memoryFile(), 'utf8')
  assert.match(text, /outcome: failed/)
  assert.match(text, /source: bash k1/)
  assert.match(text, /added: \d{4}-\d{2}-\d{2}/)
  assert.equal(parseMemory(text).entries.length, 1)
})

test('an explicit re-verify reuses the stored lesson without extracting again', async t => {
  const s = start({ items: ONE_ITEM, support: [['no'], ['yes']] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-reverify')
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'HELD')
  const extractions = s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length
  const id = s.plans()[0].candidateId
  const rechecked = await s.json('memory-task-reverify', { candidateId: id })
  assert.equal(rechecked.value.ok, true)
  assert.equal(rechecked.value.rechecked, 1)
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.equal(s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length, extractions, 'the lesson is reused, not extracted again')
  const written = parseMemory(readFileSync(s.memoryPathOf(s.plans()[0]), 'utf8'))
  assert.equal(written.entries.length, 1)
  // Re-verified or extracted, an entry carries the same metadata: a lesson that came
  // back through the explicit retry must not be the one line without a source or a date.
  const line = readFileSync(s.memoryPathOf(s.plans()[0]), 'utf8')
  assert.match(line, /source: bash k1/)
  assert.match(line, /outcome: verified/)
  assert.match(line, /added: \d{4}-\d{2}-\d{2}/)
})

// The re-verify replays a lesson the gate refused, and the negation that made it wrong has
// to travel with it: the stored context is what the check reads, so losing it on either end
// — when the refusal is recorded, or when the request is rebuilt — would let the model see
// a quote with no negation and answer yes. Both ends are pinned here, in that order, so a
// red test says which end broke.
test('a re-verify carries the stored negation into the check request', async t => {
  const s = start({ items: ONE_ITEM, support: [['no'], ['yes']] })
  t.after(() => s.stop())
  // The quote alone ("run the release script") reads as an instruction; only the whole
  // line around it ("... now.") makes the condition visible, so the context is what the
  // check has to see, and it is not part of the evidence.
  const negated = { ...CLAIM, kind: 'user', statement: '发布前不要自动跑脚本，先问我', evidence: 'run the release script', ref: 'part 1 #10' }
  await s.tool('complete_task', { ...report, claims: [negated] }, 'b2', 'call-negation')
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'HELD')
  const refused = s.plans()[0].unverified[0]
  // Stored end: the line the gate quoted is kept with the refusal.
  assert.equal(refused.reason, 'model-unsupported')
  assert.match(String(refused.context ?? ''), /Please run the release script now\./, 'the refusal keeps the whole line around the quote')
  // Replayed end: the same text is what the re-verify sends the model.
  const before = s.requests.length
  const id = s.plans()[0].candidateId
  const rechecked = await s.json('memory-task-reverify', { candidateId: id })
  assert.equal(rechecked.value.ok, true)
  const verifyRequests = s.requests.slice(before).filter(request => String(request.system).startsWith('You check whether'))
  assert.equal(verifyRequests.length, 1, 'one check request is made')
  const body = String(verifyRequests[0].messages[0].content[0].text)
  assert.match(body, /Please run the release script now\./, 'the replayed request carries the whole line, not just the quote')
})

test('a re-verify whose lesson the freeze refuses is held instead of marked done with nothing written', async t => {
  const s = start({ items: ONE_ITEM, support: [['no'], ['yes']] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-reverify-refused')
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'HELD')
  const id = s.plans()[0].candidateId
  // The candidate file is plain JSON a person can edit; the stored quote is made too
  // long for the memory limits after the gates refused it, so only the freeze-time
  // re-check can catch it.
  const planPath = join(s.planDir(), `${id}.json`)
  const stored = JSON.parse(readFileSync(planPath, 'utf8'))
  stored.unverified[0].text = `发布脚本的教训：${'很长的说明'.repeat(90)}`
  writeFileSync(planPath, `${JSON.stringify(stored, null, 2)}\n`)
  const rechecked = await s.json('memory-task-reverify', { candidateId: id })
  assert.equal(rechecked.value.ok, true)
  assert.equal(rechecked.value.rechecked, 0, 'nothing was frozen')
  const after = s.plans()[0]
  assert.equal(after.status, 'HELD', 'an empty plan is never stored as PLANNED')
  assert.equal(after.plan, null, 'no plan is stored')
  assert.equal(existsSync(s.memoryPathOf(after)), false, 'nothing was written to memory')
  assert.equal(after.unverified.at(-1).reason, 'invalid-at-freeze')
})

// #64: the pre-write state is bound to the write inside the memory write queue. A
// plain commit that lands after an interrupted item's pre-write state is part of the
// content the decision sees, because the decision itself runs in the queue's critical
// section: stale state stops as a conflict with the person's line kept, and state
// that matches what the queue now holds goes on to write.
test('a plain commit landing after the pre-write state is decided inside the queue', async t => {
  const sha = text => createHash('sha256').update(text).digest('hex')
  const planPathOf = s => join(s.planDir(), `${s.plans()[0].candidateId}.json`)
  const interrupt = async (callId, pendingFromCurrent) => {
    const s = start({ items: [{ claim: 0, topic: '', text: `发布用脚本 ${callId}`, outcome: 'verified' }], support: ['yes'] })
    t.after(() => s.stop())
    assert.match(await s.tool('complete_task', report, 'b2', callId), /Recorded as a candidate/)
    idle(s.ctx)
    await until(() => existsSync(s.memoryFile()) && s.plans()[0]?.status === 'DONE')
    const record = JSON.parse(readFileSync(planPathOf(s), 'utf8'))
    writeFileSync(s.memoryFile(), '# Memory\n\n## Index\n')
    await s.tool('remember', { text: `插队提交 ${callId}` }, 'b2', `rem-${callId}`)
    const hash = sha(readFileSync(s.memoryFile(), 'utf8'))
    record.status = 'APPLYING'
    record.progress = { done: [], conflicts: [], pending: { reviewId: record.plan.items[0].reviewId, scope: record.plan.items[0].scope, files: { 'MEMORY.md': pendingFromCurrent ? hash : sha('# Memory\n\n## Index\n') } } }
    writeFileSync(planPathOf(s), JSON.stringify(record, null, 2))
    idle(s.ctx)
    return s
  }
  // Stale pre-write state: the person's remembered line is the change, nothing above
  // explains it, and the item stops without touching the file.
  {
    const s = await interrupt('x-1', false)
    await until(() => s.plans()[0].status === 'CONFLICT')
    assert.equal(s.plans()[0].progress.conflicts.at(-1).reason, 'pre-write content changed')
    const text = readFileSync(s.memoryFile(), 'utf8')
    assert.match(text, /插队提交 x-1/, "the person's line stays")
    assert.ok(!text.includes('发布用脚本 x-1'), 'the item was not written over it')
  }
  // Matching pre-write state: the decision ran on the content the queue now holds,
  // so the item goes on and both lines live side by side.
  {
    const s = await interrupt('x-2', true)
    await until(() => s.plans()[0].status === 'DONE')
    const text = readFileSync(s.memoryFile(), 'utf8')
    assert.match(text, /插队提交 x-2/)
    assert.match(text, /发布用脚本 x-2/)
    assert.equal(s.plans()[0].progress.pending, undefined)
  }
})

// A project's memory is shared by every Bot that works there, so an entry kept by the
// review must name the Bot it came from — the same rule `remember` follows through
// `metaFor`. A Bot's own memory is that Bot's already, and must not gain a writer.
test('a reviewed lesson in a project names the Bot that kept it, and one in its own memory does not', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'ds-bot-project-by-'))
  mkdirSync(join(repo, '.git'), { recursive: true })
  t.after(() => rmSync(repo, { recursive: true, force: true }))

  const project = start({ cwd: repo, items: ONE_ITEM, support: ['yes'] })
  t.after(() => project.stop())
  await project.tool('complete_task', report, 'b2', 'call-project-by')
  idle(project.ctx)
  await until(() => project.plans()[0]?.status === 'DONE')
  const record = project.plans()[0]
  assert.notEqual(record.project, null, 'the report was made in a repository')
  const line = readFileSync(project.memoryPathOf(record), 'utf8')
  assert.match(line, /by: Writer/, 'the project entry names the Bot that kept it')
  // Frozen with the plan, like the other metadata: the plan carries the same value.
  assert.equal(record.plan.items[0].meta.by, 'Writer')

  // The same report with no project: the entry lives in the Bot's own memory.
  const own = start({ items: ONE_ITEM, support: ['yes'] })
  t.after(() => own.stop())
  await own.tool('complete_task', report, 'b2', 'call-own-by')
  idle(own.ctx)
  await until(() => own.plans()[0]?.status === 'DONE')
  const ownLine = readFileSync(own.memoryFile(), 'utf8')
  assert.doesNotMatch(ownLine, /by:/, 'own memory does not name a writer; the scope already is that Bot')
  assert.equal('by' in own.plans()[0].plan.items[0].meta, false)
})

// The re-verify path builds its own metadata rather than reusing the extraction's, so it
// has to name the writer too; otherwise a lesson that came back through the explicit retry
// would be the project entry with no author.
test('a re-verified lesson in a project also names the Bot that kept it', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'ds-bot-project-by-reverify-'))
  mkdirSync(join(repo, '.git'), { recursive: true })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const s = start({ cwd: repo, items: ONE_ITEM, support: [['no'], ['yes']] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-project-reverify-by')
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'HELD')
  const id = s.plans()[0].candidateId
  const rechecked = await s.json('memory-task-reverify', { candidateId: id })
  assert.equal(rechecked.value.rechecked, 1)
  idle(s.ctx)
  await until(() => s.plans()[0]?.status === 'DONE')
  const record = s.plans()[0]
  assert.notEqual(record.project, null)
  assert.equal(record.plan.items[0].meta.by, 'Writer', 'frozen with the plan')
  assert.match(readFileSync(s.memoryPathOf(record), 'utf8'), /by: Writer/)
})
