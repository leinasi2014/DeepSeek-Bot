// #66: both memory paths share one source and evidence gate. What the Bot says about its
// own work is never evidence that the work succeeded; a command or a test claim rests on a
// real tool result, with its name and its failure state; the per-turn review may still keep
// a preference the user stated or a summary of what the user said, and cannot write a
// sentence that no line carries.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1, whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}

const userLine = (seq, text) => ({ event: { seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
const botLine = (seq, text) => ({ event: { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } } })
const toolCall = (seq, callId, name) => ({ event: { seq, type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: '{}' } } })
const toolResult = (seq, callId, text, { isError = false } = {}) => ({
  event: {
    seq,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } },
  },
})

function start({ history, items = [], support = ['yes'], review = '{"changes":[]}' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-66-'))
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
        if (system.startsWith('You keep the long-term memory')) reply = review
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items })
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support })
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId] ?? [{ event: { seq: 0 } }]).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq }) => ({ records: (history[address.sessionId] ?? []).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq), hasMore: false }),
    },
    sessions: { messageProjections: [], get: () => undefined },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home, memoryReviewDelayMs: 0 })
  // The team has to be loaded before an idle event names a Bot, as in the product.
  const json = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const dir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(dir()) ? readdirSync(dir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir(), name), 'utf8'))) : [])
  const memory = () => {
    const path = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const tool = (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId })
  const idle = () => ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, dir, plans, memory, tool, idle, json, stop, requests }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check, detail) {
  for (let tries = 0; tries < 300 && !check(); tries += 1) await settle()
  assert.ok(check(), typeof detail === 'function' ? detail() : 'the condition did not hold within 6 s')
}
const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: 'tests 12/12', ref: 'bash k1' }
const ITEM = [{ claim: 0, topic: '', text: '发布用 scripts/ship.sh，测试通过后再发布', outcome: 'verified' }]

// --- A: the task review's source gate ---------------------------------------

test('a command claim that only the Bot itself reports is refused', async t => {
  // The words "tests 12/12" exist, but only in the Bot's own message: before #66 that was
  // enough, and a self-reported success became a verified lesson.
  const s = start({
    history: {
      b2: [
        userLine(10, 'Please run the release script now.'),
        botLine(11, 'Ran scripts/ship.sh; the suite passed: tests 12/12.'),
      ],
    },
    items: ITEM,
  })
  t.after(() => s.stop())
  await s.tool('complete_task', { result: '完成发布脚本验证', claims: [CLAIM] }, 'c-self')
  s.idle()
  await until(() => s.plans()[0]?.status === 'HELD', () => `status=${s.plans()[0]?.status}`)
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
  assert.equal(s.memory(), '', 'nothing was written')
  assert.equal(s.requests.filter(r => String(r.system).startsWith('You check whether')).length, 0, 'it never reached the semantic gate')
})

test('a command claim that quotes a real tool result is kept, with the tool as its source', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'Please run the release script now.'),
        botLine(11, 'Ran scripts/ship.sh.'),
        toolCall(12, 'k1', 'bash'),
        toolResult(13, 'k1', 'tests 12/12 passing\n[exit code: 0]'),
      ],
    },
    items: ITEM,
  })
  t.after(() => s.stop())
  await s.tool('complete_task', { result: '完成发布脚本验证', claims: [CLAIM] }, 'c-tool')
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE', () => `status=${s.plans()[0]?.status}`)
  const line = s.memory()
  assert.match(line, /发布用 scripts\/ship\.sh/)
  assert.match(line, /source: bash k1/)
  // The semantic gate was told which tool ran and that it did not fail.
  const verify = s.requests.find(r => String(r.system).startsWith('You check whether'))
  assert.match(String(verify.messages[0].content[0].text), /"sourceType":"tool","tool":"bash","toolCallFailed":false/)
})

test('a tool result that failed never becomes a rule that held', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'Please run the release script now.'),
        botLine(11, 'Ran scripts/ship.sh.'),
        toolCall(12, 'k1', 'bash'),
        toolResult(13, 'k1', 'tests 12/12 failing\n[exit code: 1]', { isError: true }),
      ],
    },
    items: ITEM,
  })
  t.after(() => s.stop())
  await s.tool('complete_task', { result: '完成发布脚本验证', claims: [CLAIM] }, 'c-fail')
  s.idle()
  await until(() => s.plans()[0]?.status === 'HELD', () => `status=${s.plans()[0]?.status}`)
  assert.equal(s.plans()[0].unverified[0].reason, 'tool-failed')
  assert.equal(s.memory(), '', 'a failed run writes no lesson')
})

test('a failed run is still kept as a failure, so the lesson is not lost', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'Please run the release script now.'),
        botLine(11, 'Ran scripts/ship.sh.'),
        toolCall(12, 'k1', 'bash'),
        toolResult(13, 'k1', 'tests 12/12 failing\n[exit code: 1]', { isError: true }),
      ],
    },
    items: [{ claim: 0, topic: '', text: '发布前必须先修好测试，否则 ship.sh 会失败', outcome: 'failed' }],
  })
  t.after(() => s.stop())
  await s.tool('complete_task', { result: '完成发布脚本验证', claims: [CLAIM] }, 'c-failed-lesson')
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE', () => `status=${s.plans()[0]?.status}`)
  assert.match(s.memory(), /outcome: failed/)
})

// --- B: the per-turn review's source gate ----------------------------------

test('a per-turn review cannot write a sentence that no line carries', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'Please run the release script now.'),
        botLine(11, 'Ran scripts/ship.sh; the suite passed: tests 12/12.'),
      ],
    },
    review: JSON.stringify({ changes: [{ op: 'add', text: 'Production deploys must run only on Tuesday evenings' }] }),
  })
  t.after(() => s.stop())
  await s.json('state')
  s.idle()
  await until(() => s.requests.length === 1, () => `requests=${s.requests.length}`)
  await settle(200)
  assert.equal(s.memory(), '', 'the hallucinated entry never lands')
  const journal = existsSync(join(s.home, 'memory', 'journal.jsonl'))
    ? readFileSync(join(s.home, 'memory', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  // No quote and words the user never wrote: the host refuses it on the words themselves.
  assert.equal(journal[0]?.reason, 'evidence-unsupported')
  assert.equal(journal[0]?.op, 'skip')
})

test('a per-turn review keeps a preference the user stated', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'I like a plain style, mostly black and white.'),
        botLine(11, 'Here is a plainer one.'),
      ],
    },
    review: JSON.stringify({ changes: [{ op: 'add', text: 'The user likes a plain style, mostly black and white', evidence: 'I like a plain style, mostly black and white' }] }),
  })
  t.after(() => s.stop())
  await s.json('state')
  s.idle()
  await until(() => s.memory() !== '', () => 'nothing was written')
  assert.match(s.memory(), /The user likes a plain style/)
})

test('a per-turn review may merge what the user said, quoting the sentence it rests on', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'Keep replies short.'),
        userLine(11, 'Plain text only, no tables.'),
        botLine(12, 'Understood.'),
      ],
    },
    review: JSON.stringify({ changes: [{ op: 'add', text: 'The user wants short, plain replies without tables', evidence: 'Plain text only, no tables' }] }),
  })
  t.after(() => s.stop())
  await s.json('state')
  s.idle()
  await until(() => s.memory() !== '', () => 'nothing was written')
  assert.match(s.memory(), /short, plain replies without tables/)
})

test('a per-turn howto that quotes the Bot itself is refused', async t => {
  const s = start({
    history: {
      b2: [
        userLine(10, 'Please run the release script now.'),
        botLine(11, 'Deploys must run only on Tuesday evenings.'),
      ],
    },
    review: JSON.stringify({ changes: [{ op: 'add', text: 'Deploys run only on Tuesday evenings', kind: 'howto', evidence: 'Deploys must run only on Tuesday evenings' }] }),
  })
  t.after(() => s.stop())
  await s.json('state')
  s.idle()
  await until(() => s.requests.length === 1, () => `requests=${s.requests.length}`)
  await settle(200)
  assert.equal(s.memory(), '', 'the Bot\'s own words prove nothing')
})
