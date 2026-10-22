import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
function start({ items = [], support = [], memory = '{"changes":[]}' } = {}) {
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
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support })
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
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  apply(ctx, { home, memoryReviewDelayMs: 0 })
  const tool = (name, args, sessionId, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId })
  const memoryFile = () => join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
  const planDir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(planDir())
    ? readdirSync(planDir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(planDir(), name), 'utf8')))
    : [])
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, tool, memoryFile, planDir, plans, requests, stop }
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
  await until(() => s.plans()[0].status === 'DONE')
  assert.equal(existsSync(s.memoryFile()), false, 'nothing was written to memory')
  assert.equal(s.plans()[0].plan.items.length, 0, 'the mechanical gate dropped the item')
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
  await until(() => existsSync(s.memoryFile()))
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
  await until(() => s.plans()[0].status === 'DONE')
  assert.equal(existsSync(s.memoryFile()), false)
  assert.equal(s.plans()[0].plan.items.length, 0)
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
})

test('a model that does not support the claim writes no memory', async t => {
  const s = start({ items: ONE_ITEM, support: ['no'] })
  t.after(() => s.stop())
  await s.tool('complete_task', report, 'b2', 'call-2')
  idle(s.ctx)
  await until(() => s.plans().length === 1)
  await until(() => s.plans()[0].status === 'DONE')
  assert.equal(existsSync(s.memoryFile()), false)
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
