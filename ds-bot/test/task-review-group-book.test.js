// What the group call book records, against what the round really does: the admin's
// "@all" must open a call for every member the round will ask, a member's "@all" opens
// none, a member the round passes over must not leave a call behind, and a restart must
// settle only calls whose member can never answer again — never a live one.
//
// Everything comes from the product's own group round (`group_relay`, `roomStepText`,
// turn events); no work id is written into the book by hand.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    tester: { id: 'tester', sessionId: 'tester', name: 'Tester', role: 'Test', model: 'deepseek/v4', instructions: '', createdAt: 3 },
  },
  rooms: {
    desk: {
      id: 'desk',
      name: 'Desk',
      members: ['chief', 'writer', 'tester'],
      admin: 'chief',
      mode: 'everyone',
      sessions: { chief: 'desk-chief', writer: 'desk-writer', tester: 'desk-tester' },
      log: [],
      seq: 0,
      seen: {},
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const HISTORY = {
  'desk-chief': [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '@Writer @Tester 一起看发布说明，测试 12/12 通过。' }] } } } },
  ],
  'desk-writer': [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'bot', role: 'room' }, content: [{ type: 'text', text: '你的回合' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '写好了，测试 12/12 通过。' }] } } } },
  ],
  'desk-tester': [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请复核发布说明，测试 12/12 通过。' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '复核中。' }] } } } },
  ],
}

const ITEM = [{ claim: 0, topic: '', text: '发布说明由 Writer 写，测试通过后再发', outcome: 'verified' }]
const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: '测试 12/12 通过', ref: 'part 1 #11' }
const report = { result: '完成发布说明安排', claims: [CLAIM], notes: '' }

async function start(t, { home: existing } = {}) {
  const home = existing ?? mkdtempSync(join(tmpdir(), 'ds-bot-group-book-'))
  if (existing === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const requests = []
  const agents = new Map()
  let seq = 0
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const held = []
      const inbox = { nextStep: [], nextTurn: held, remove: () => false }
      agents.set(sessionId, {
        session: { id: sessionId },
        calls,
        inbox,
        followup: (message) => { calls.push(message); held.push(message) },
        steer: (message) => { calls.push(message) },
        cancel: () => {},
      })
    }
    return agents.get(sessionId)
  }
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
      create: async () => ({ sessionId: `s${agents.size + 1}` }),
      resolveAgent: async sessionId => ({
        agent: {
          ...agentOf(sessionId),
          session: {
            id: sessionId,
            seq: (HISTORY[sessionId] ?? [{ event: { seq: 0 } }]).at(-1).event.seq + 1,
            requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
          },
        },
      }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (HISTORY[address.sessionId] ?? []).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      messageProjections: [],
      flush: async () => {},
      get: id => ({ id, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }) }),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => register(options)
  const rt = createRuntime(ctx, { home, memoryReviewDelayMs: 0 })
  await rt.load()
  // Record what is sent, then deliver it for real: a group round only starts when its
  // member Session actually receives the brief.
  const deliver = rt.deliver
  rt.deliver = async message => deliver(message)
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, seq: ++seq, data })
  }
  const turns = new Map()
  const tool = (name, args, sessionId, callId, extra = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId, ...extra })
  // The member Session takes the brief it was delivered: a real turn, whose trigger is
  // the room request itself.
  const begin = (sessionId) => {
    const brief = agentOf(sessionId).calls.at(-1)
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: brief.content, source: brief.source })
    return turn
  }
  const say = (sessionId, text) => rt.roomStepText(sessionId, rt.live.get(sessionId)?.info, text, true)
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const idle = (sessionId) => ctx.emit('agent/status', {
    agent: {
      id: sessionId,
      session: { id: sessionId, seq: 12, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }) },
    },
    status: 'idle',
  })
  const planDir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(planDir())
    ? readdirSync(planDir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(planDir(), name), 'utf8')))
    : [])
  const memoryOf = botId => {
    const path = join(home, 'memory', 'bots', botId, 'MEMORY.md')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const roomCalls = () => Object.keys(rt.state.works ?? {}).filter(id => id.startsWith('room:')).sort()
  const stop = async () => {
    await ctx.dispose()
    if (existing === undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  t.after(stop)
  return { ctx, rt, home, emit, begin, say, finish, idle, tool, plans, memoryOf, roomCalls, agentOf, requests, turns }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check, detail) {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await settle()
  if (!check() && typeof detail === 'function') console.log('STUCK:', detail())
  assert.ok(check(), 'the condition did not hold within 8 s')
}
// The round runs one member after another; each brief is a real delivery to that Session.
const called = (s, sessionId) => until(() => s.agentOf(sessionId).calls.length > (s.turns.get(sessionId) ?? 0), () => JSON.stringify(Object.keys(s.rt.state.works ?? {})))

test('the admins @all opens a call for every member the round will ask', async t => {
  const s = await start(t)
  const stop = new AbortController()
  t.after(() => stop.abort())
  s.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void s.tool('group_relay', {}, 'desk', 'relay-all', { signal: stop.signal }).catch(() => {})

  await called(s, 'desk-chief')
  s.begin('desk-chief')
  await s.say('desk-chief', '@all 都看下发布说明，测试 12/12 通过。')
  assert.deepEqual(s.roomCalls(), ['room:desk:chief:tester', 'room:desk:chief:writer'], 'the book holds exactly the members @all calls')

  const accepted = await s.tool('complete_task', report, 'desk-chief', 'report-all')
  assert.match(String(accepted), /Recorded as a candidate/)
  assert.equal(s.plans()[0].groupWaits.length, 2, 'the report waits for both calls')
  s.finish('desk-chief', '@all 都看下发布说明，测试 12/12 通过。')
  s.idle('desk-chief')
  await until(() => s.plans()[0]?.status === 'WAITING')

  // Writer answers: one call settles, the other still holds the report.
  await called(s, 'desk-writer')
  s.begin('desk-writer')
  s.finish('desk-writer', '写好了，测试 12/12 通过。')
  s.idle('desk-chief')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(s.plans()[0]?.status, 'WAITING', 'the call to Tester is still open')
  assert.equal(s.memoryOf('chief'), '', 'nothing is written while one member has not answered')

  // Tester answers: now both are settled and the report goes on.
  await called(s, 'desk-tester')
  s.begin('desk-tester')
  s.finish('desk-tester', '复核过了，测试 12/12 通过。')
  s.idle('desk-chief')
  await until(() => s.plans()[0]?.status === 'DONE', () => `status=${s.plans()[0]?.status} calls=${JSON.stringify(s.roomCalls())}`)
  assert.deepEqual(s.roomCalls(), [], 'no call is left in the book')
  assert.match(s.memoryOf('chief'), /发布说明由 Writer 写/)
})

test('a members @all calls nobody and opens no call', async t => {
  const s = await start(t)
  const stop = new AbortController()
  t.after(() => stop.abort())
  s.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Writer 写发布说明.' }], source: { kind: 'user' } })
  void s.tool('group_relay', {}, 'desk', 'relay-member-all', { signal: stop.signal }).catch(() => {})

  await called(s, 'desk-writer')
  s.begin('desk-writer')
  await s.say('desk-writer', '@all 大家都看一下。')
  assert.deepEqual(s.roomCalls(), [], 'only the admin @all calls everyone')
  s.finish('desk-writer', '@all 大家都看一下。')
})

// A member that already used its turns in this round is passed over. The line still named
// it, so a call was opened; if it stayed, a report made in that turn would wait forever on
// a member the round will never ask.
