import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// A user line, then the answer that holds the evidence: `partLines` flushes an answer
// only when it reaches the message it answers, exactly as a real part does.
const HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh; the suite passed: tests 12/12.' }] } } } },
  ],
}

// The three model calls are answered by their system prompt, so the order in which the
// idle handlers happen to run does not matter.
function start({ items = [], support = [], memory = '{"changes":[]}', cwd } = {}) {
  // Each verify call takes the next list, so a retry can be answered differently.
  const supportQueue = Array.isArray(support[0]) ? [...support] : undefined
  let folder = cwd
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-review-wiring-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
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

const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: 'tests 12/12', ref: 'part 1 #11' }
const report = { result: '完成发布脚本验证', claims: [CLAIM], notes: '' }
const ONE_ITEM = [{ claim: 0, topic: '', text: '发布用 scripts/ship.sh，测试通过后再发布', outcome: 'verified' }]

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
  assert.match(text, /- 发布用 scripts\/ship\.sh，测试通过后再发布 \[kind: howto; claim: 0; evidence: tests 12\/12; review_id: [0-9a-f]{16}\]/)
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
  assert.equal(parseMemory(readFileSync(s.memoryPathOf(s.plans()[0]), 'utf8')).entries.length, 1)
})