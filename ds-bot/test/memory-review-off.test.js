// `memoryReview:false` stops the task review: no new candidate is taken, and the startup
// recovery does not scan the queue either. Scanning would call `check`, which has no
// verdict to give while the switch is off, and the candidate would be rewritten as
// WAITING — a state that means "waiting on something", not "switched off". The record
// keeps its bytes; turning the review on again lets the next check decide, on the same
// evidence, with no new state and no approval step.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1, whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'writer', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}

// The line the candidate quotes: the evidence must be a verbatim substring of this
// Session's own conversation, or the mechanical gate refuses it.
const HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh; the suite passed: tests 12/12.' }] } } } },
  ],
}

const CANDIDATE_ID = 'c0ffee1234567890abcdef1234567890'
const CANDIDATE = {
  version: 1,
  candidateId: CANDIDATE_ID,
  botId: 'b2',
  sessionId: 'b2',
  roomId: null,
  project: null,
  cwd: null,
  createdAt: '2026-10-23T00:00:00.000Z',
  status: 'PENDING',
  invalid: 0,
  retry: 0,
  result: '发布脚本跑通了',
  claims: [{ kind: 'test', statement: '发布脚本跑通', evidence: 'tests 12/12', ref: 'part 1 #11' }],
  notes: '',
  plan: null,
  progress: { done: [], conflicts: [] },
}

function start(t, home, config, requests) {
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream(request) {
        requests.push(String(request.system ?? ''))
        const system = String(request.system ?? '')
        let reply = ''
        if (system.startsWith('You keep the long-term memory')) reply = '{"changes":[]}'
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items: [{ claim: 0, topic: '', text: '发布用 scripts/ship.sh', outcome: 'verified' }] })
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support: ['yes'] })
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (HISTORY[sessionId] ?? [{ event: { seq: 0 } }]).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq }) => ({ records: (HISTORY[address.sessionId] ?? []).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq), hasMore: false }),
    },
    sessions: { messageProjections: [], get: () => undefined },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  apply(ctx, { home, ...config })
  const candidatePath = () => join(home, 'memory', 'task-plans', `${CANDIDATE_ID}.json`)
  const memoryText = () => {
    const path = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const tool = (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId })
  return { ctx, candidatePath, memoryText, tool }
}

const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, detail) {
  for (let tries = 0; tries < 250 && !check(); tries += 1) await settle()
  assert.ok(check(), typeof detail === 'function' ? detail() : 'the condition did not hold within 5 s')
}

test('the review being off leaves a queued candidate untouched, and turning it on continues it', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-review-off-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  mkdirSync(join(home, 'memory', 'task-plans'), { recursive: true })
  const original = `${JSON.stringify(CANDIDATE, null, 2)}\n`
  writeFileSync(join(home, 'memory', 'task-plans', `${CANDIDATE_ID}.json`), original)

  // --- Switched off: startup recovery must not scan, rewrite or extract anything.
  const requests = []
  const off = start(t, home, { memoryReview: false }, requests)
  await settle(600)
  assert.equal(readFileSync(off.candidatePath(), 'utf8'), original, 'the candidate keeps its bytes while the review is off')
  assert.equal(off.memoryText(), '', 'nothing is written to memory while the review is off')
  assert.equal(requests.length, 0, 'no model call while the review is off')
  assert.deepEqual(readdirSync(join(home, 'memory', 'task-plans')).filter(name => name.endsWith('.json')), [`${CANDIDATE_ID}.json`], 'no second candidate appears')

  // A new report is refused, not queued and not held.
  const refused = await off.tool('complete_task', { result: 'done', claims: [{ kind: 'test', statement: '发布脚本跑通', evidence: 'tests 12/12', ref: 'part 1 #11' }] }, 'off-1')
  assert.match(String(refused), /Task review is turned off/)
  assert.deepEqual(readdirSync(join(home, 'memory', 'task-plans')).filter(name => name.endsWith('.json')), [`${CANDIDATE_ID}.json`], 'the refused report adds no file')
  await off.ctx.dispose()

  // --- Switched on: the same record goes on through the ordinary check, no extra step.
  const on = start(t, home, { memoryReviewDelayMs: 0 }, requests)
  t.after(() => on.ctx.dispose())
  await until(() => JSON.parse(readFileSync(on.candidatePath(), 'utf8')).status === 'DONE', () => `status=${JSON.parse(readFileSync(on.candidatePath(), 'utf8')).status}`)
  assert.match(on.memoryText(), /发布用 scripts\/ship\.sh/)
  assert.ok(requests.some(system => system.startsWith('You turn a reported finished task')), 'the extract ran once the review came back on')
})
