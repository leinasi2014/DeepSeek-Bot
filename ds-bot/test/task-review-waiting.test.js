// What a task candidate waits for: the work and the question it was bound to when the
// report was made, never whatever else the Bot happens to be doing (design §6, R4).
//
// The runtime is the real one (index.js createRuntime) over a temp home; only the model is
// canned. Each case drives a turn so `turn.info` carries the request the Bot answers,
// which is what `complete_task` records.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../index.js'
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

const HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh; the suite passed: tests 12/12.' }] } } } },
  ],
}

const ITEM = [{ claim: 0, topic: '', text: '发布用 scripts/ship.sh，测试通过后再发布', outcome: 'verified' }]
const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: 'tests 12/12', ref: 'part 1 #11' }
const report = { result: '完成发布脚本验证', claims: [CLAIM], notes: '' }

// `works` and `questions` seed state.json: what is open when the report is made.
async function start({ home: existing, works, questions } = {}) {
  const home = existing ?? mkdtempSync(join(tmpdir(), 'ds-bot-task-waiting-'))
  if (existing === undefined) {
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      ...TEAM,
      works: works ?? {},
      questions: questions ?? {},
    }))
  }
  const ctx = fakeContext()
  const requests = []
  let seq = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream(request) {
        requests.push(request)
        const system = String(request.system ?? '')
        let reply = ''
        if (system.startsWith('You keep the long-term memory')) reply = '{"changes":[]}'
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items: ITEM })
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support: ['yes'] })
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (HISTORY[sessionId] ?? [{ event: { seq: 0 } }]).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (HISTORY[address.sessionId] ?? []).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [], get: () => undefined },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, memoryReviewDelayMs: 0 })
  // The team has to be loaded before Session events count: an unknown Session's events are
  // dropped, which is how a real host behaves after a restart.
  await rt.load()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, seq: ++seq, data })
  }
  // A turn that answers a Bot request: `turn.info` is that request, so the candidate
  // records its exchange id as the work of the reporting turn.
  const turnAnswering = (sessionId, workId, text = 'done') => {
    emit(sessionId, 'turn/start', { turn: 1 })
    emit(sessionId, 'user/message', {
      content: [{ type: 'text', text }],
      source: { kind: 'bot', role: 'request', exchangeId: workId, senderSessionId: 'm1', senderName: 'Chief', hop: 1 },
    })
  }
  const idle = () => ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  const tool = (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId })
  const planDir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(planDir())
    ? readdirSync(planDir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(planDir(), name), 'utf8')))
    : [])
  const memoryText = () => {
    const path = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const stop = async () => {
    await ctx.dispose()
    if (existing === undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  return { ctx, rt, home, emit, turnAnswering, idle, tool, planDir, plans, memoryText, requests, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check) {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await settle()
  assert.ok(check(), 'the condition did not hold within 8 s')
}

// One open child on a work: `waitsWork` answers true until that child comes back.
const openWork = (id) => ({ [id]: { from: 'm1', to: 'b2', open: ['child-1'], results: [], at: 1 } })

test('a candidate whose own work is still out waits, and goes on once it comes back', async t => {
  const s = await start({ works: openWork('w-1') })
  t.after(() => s.stop())
  s.turnAnswering('b2', 'w-1')
  await s.tool('complete_task', report, 'call-work-waiting')
  s.idle()
  await until(() => s.plans()[0]?.status === 'WAITING')
  const waiting = s.plans()[0]
  assert.deepEqual(waiting.work, ['w-1'], 'the candidate recorded the work of its own turn')
  assert.equal(waiting.plan, null, 'no plan is frozen while waiting')
  assert.equal(waiting.retry, 0, 'waiting does not spend the retry budget')
  assert.equal(s.memoryText(), '', 'nothing was written')

  // The child comes back: the work leaves the book, and the same candidate goes on at the
  // next idle, with no new report.
  delete s.rt.state.works['w-1']
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.match(s.memoryText(), /发布用 scripts\/ship\.sh/)
})

test('work open in another chat never blocks a report made here', async t => {
  // The same Bot has work open elsewhere — another group, another chat, a handoff that
  // has not come back. Only the work the reporting turn was doing may hold this candidate:
  // looking the Bot's work up by botId is exactly the cross-chat stall §6 forbids. The
  // request this turn answers is already settled, so it is not in the book any more.
  const s = await start({
    works: {
      'w-elsewhere': { from: 'm1', to: 'b2', room: 'r9', open: ['child-9'], results: [], at: 2 },
    },
  })
  t.after(() => s.stop())
  s.turnAnswering('b2', 'w-mine')
  await s.tool('complete_task', report, 'call-other-work')
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.deepEqual(s.plans()[0].work, ['w-mine'], 'only the work this turn reported is recorded')
  assert.match(s.memoryText(), /发布用 scripts\/ship\.sh/)
})

test('a question the Bot asked keeps the candidate waiting, also after the next part took it', async t => {
  const s = await start({ questions: { b2: { id: 'q-1', question: 'Which branch?', options: [], askedAt: 1 } } })
  t.after(() => s.stop())
  s.turnAnswering('b2', 'w-2')
  await s.tool('complete_task', report, 'call-question')
  s.idle()
  await until(() => s.plans()[0]?.status === 'WAITING')
  assert.deepEqual(s.plans()[0].questions, ['q-1'], 'the question id is what is remembered, not the Session')

  // A part switch moves the card to the fresh Session under the same id (parts.js:805-808).
  // The idle that follows is a real pass over the candidate: it must still find the card
  // by id, so the status stays WAITING and nothing is written. Merely re-reading WAITING
  // would prove nothing — it was already WAITING before this pass.
  s.rt.state.questions = { 'b2-next': s.rt.state.questions.b2 }
  s.idle()
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(s.plans()[0]?.status, 'WAITING', 'the card moved to the next part and still holds the candidate')
  assert.equal(s.memoryText(), '', 'still nothing written while the card is up')

  // Answered: the card is gone from wherever it lived, and the candidate goes on.
  s.rt.state.questions = {}
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.match(s.memoryText(), /发布用 scripts\/ship\.sh/)
})

test('a candidate recorded under the old part goes on when the new part is idle', async t => {
  const s = await start({ works: openWork('w-4') })
  t.after(() => s.stop())
  s.turnAnswering('b2', 'w-4')
  await s.tool('complete_task', report, 'call-old-part')
  s.idle()
  await until(() => s.plans()[0]?.status === 'WAITING')
  assert.equal(s.plans()[0].sessionId, 'b2', 'the candidate keeps the Session it was reported in')

  // The conversation moves to a fresh part: b2 is archived, b2-next speaks for the Bot.
  // The candidate is still filed under b2, so only a wake-up compared by Bot (not by
  // Session id) reaches it. Work comes back at the same moment.
  s.rt.state.bots.b2.segments = [{ sessionId: 'b2' }]
  s.rt.state.bots.b2.sessionId = 'b2-next'
  delete s.rt.state.works['w-4']
  s.rt.chatOwners.delete('b2')
  s.rt.pastOwners.set('b2', { botId: 'b2' })
  s.rt.chatOwners.set('b2-next', 'b2')
  s.ctx.emit('agent/status', { agent: { id: 'b2-next' }, status: 'idle' })
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.match(s.memoryText(), /发布用 scripts\/ship\.sh/)
})

test('a waiting candidate is picked up again after a restart', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-waiting-restart-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  // The first host's state is written here: `start({ home })` only seeds a fresh folder.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, works: openWork('w-3'), questions: {} }))
  const first = await start({ home })
  first.turnAnswering('b2', 'w-3')
  await first.tool('complete_task', report, 'call-restart')
  first.idle()
  await until(() => first.plans()[0]?.status === 'WAITING')
  await first.ctx.dispose()

  // The child came back while the host was down; a fresh runtime must resume the file.
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  delete state.works['w-3']
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))

  const second = await start({ home })
  t.after(() => second.ctx.dispose())
  await until(() => second.plans()[0]?.status === 'DONE')
  assert.match(second.memoryText(), /发布用 scripts\/ship\.sh/)
})


// A turn can send more requests than a report makes claims. The association list must hold
// every one of them: dropping the extras would let a report be written while a request it
// opened is still unanswered. Nine children, eight closed, the ninth still out: it waits.
test('every request a turn opened is kept, not cut at the claims limit', async t => {
  const works = {}
  for (let i = 0; i < 9; i += 1) works[`w-${i}`] = { from: 'b2', to: 'b3', open: [], results: [], at: i }
  const s = await start({ works })
  t.after(() => s.stop())
  s.turnAnswering('b2', 'w-0')
  for (let i = 1; i < 9; i += 1) s.rt.openWork(`w-${i}`, { from: 'b2', to: 'b3', session: 'b2' })
  await s.tool('complete_task', report, 'call-nine')
  const recorded = s.plans()[0].work
  assert.equal(recorded.length, 9, 'all nine requests are recorded')
  assert.equal(new Set(recorded).size, 9, 'and none of them twice')
  assert.equal(recorded.includes('w-8'), true, 'the ninth is not dropped')

  // Eight come back, the ninth does not: the candidate must still wait.
  for (let i = 0; i < 8; i += 1) delete s.rt.state.works[`w-${i}`]
  s.idle()
  await until(() => s.plans()[0]?.status === 'WAITING')
  assert.equal(s.memoryText(), '', 'nothing is written while the ninth is out')

  delete s.rt.state.works['w-8']
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE')
})

// A call opened without naming the Session it came from must not be pinned on some other
// turn. Guessing from the sender would put a group line on that Bot's own-chat turn, and a
// report made there would then wait for a conversation it never had.
test('a call opened without a Session is not pinned on the senders own-chat turn', async t => {
  const s = await start()
  t.after(() => s.stop())
  s.turnAnswering('b2', 'w-own')
  // No `session`: the record stays in the book but belongs to no turn.
  s.rt.openWork('w-anonymous', { from: 'b2', to: 'b3' })
  assert.deepEqual(s.rt.live.get('b2')?.spawned ?? [], [], 'nothing was pinned on the turn')
  await s.tool('complete_task', report, 'call-anonymous')
  s.idle()
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.equal(s.plans()[0].work.includes('w-anonymous'), false, 'the anonymous call is not this candidates business')
})