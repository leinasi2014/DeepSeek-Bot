// Real wiring for the two shapes a report cannot get a workId from: a turn in the Bot's
// own chat (the user spoke, so nothing is above it) that sends another Bot a task, and a
// turn in a group where the member it called has not answered yet. Design §6, R4.
//
// Nothing here is injected into the work map by hand: every id comes from the product's
// own `message_bot` / group round.
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
  },
  rooms: {
    desk: { id: 'desk', name: 'Desk', members: ['chief', 'writer'], admin: 'chief', mode: 'everyone', sessions: { chief: 'desk-chief', writer: 'desk-writer' }, log: [], seq: 0, seen: {} },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const HISTORY = {
  chief: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please have the release notes written.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I asked Writer; the notes say tests 12/12.' }] } } } },
  ],
  'desk-chief': [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '@Writer 写发布说明，测试 12/12 通过。' }] } } } },
  ],
  'desk-writer': [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'bot', role: 'room' }, content: [{ type: 'text', text: '你的回合' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '写好了，测试 12/12 通过。' }] } } } },
  ],
}

const ITEM = [{ claim: 0, topic: '', text: '发布说明由 Writer 写，测试通过后再发', outcome: 'verified' }]
const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: 'tests 12/12', ref: 'part 1 #11' }
const report = { result: '完成发布脚本验证', claims: [CLAIM], notes: '' }

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wiring-waits-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const requests = []
  const delivered = []
  const agents = new Map()
  let seq = 0
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      // `calls` is what the product delivered to this Session; the inbox keeps it until a
      // turn takes it up, which is what `begin` does below.
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
      // The Session the controller hands out carries a request header: the parts module
      // reads it on idle to decide whether the context is tight.
      resolveAgent: async sessionId => ({
        agent: {
          ...agentOf(sessionId),
          session: { id: sessionId, seq: (HISTORY[sessionId] ?? [{ event: { seq: 0 } }]).at(-1).event.seq + 1, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }) },
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
  // member Session actually receives the brief, so replacing `deliver` outright would
  // leave `group_relay` unable to do anything.

  const deliver = rt.deliver
  rt.deliver = async message => { delivered.push(message); return deliver(message) }
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, seq: ++seq, data })
  }
  const turnStart = (sessionId, turn = 1) => emit(sessionId, 'turn/start', { turn })
  const userSays = (sessionId, text) => emit(sessionId, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
  const tool = (name, args, sessionId, callId, extra = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId, ...extra })
  // The idle event carries the Session object, as dsh sends it: the parts module reads its
  // request header to decide whether the context is tight.
  const idle = (sessionId) => ctx.emit('agent/status', {
    agent: { id: sessionId, session: { id: sessionId, seq: 12, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }) } },
    status: 'idle',
  })
  const planDir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(planDir())
    ? readdirSync(planDir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(planDir(), name), 'utf8')))
    : [])
  const memoryText = () => {
    const path = join(home, 'memory', 'bots', 'chief', 'MEMORY.md')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { ctx, rt, emit, turnStart, userSays, idle, tool, plans, memoryText, requests, delivered, agentOf, settle }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check, detail) {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await settle()
  if (!check() && typeof detail === 'function') console.log('STUCK:', detail())
  assert.ok(check(), 'the condition did not hold within 8 s')
}

test('a task the Bot sends from its own chat holds the report until the other Bot answers', async t => {
  const s = await start(t)
  // The user speaks in the Bot's own chat: nothing is above this turn.
  s.turnStart('chief')
  s.userSays('chief', 'Please have the release notes written.')
  const sent = await s.tool('message_bot', { to: 'Writer', message: 'Write the release notes.' }, 'chief', 'call-send')
  assert.match(sent, /Delivered to Writer/)
  // The child work `message_bot` opened, as the product recorded it — not injected.
  const spawned = Object.keys(s.rt.state.works)
  assert.equal(spawned.length, 1, 'message_bot opened exactly one piece of work')
  assert.equal(s.rt.state.works[spawned[0]].from, 'chief')

  await s.tool('complete_task', report, 'chief', 'call-report')
  s.idle('chief')
  await until(() => s.plans()[0]?.status === 'WAITING', () => `status=${s.plans()[0]?.status} work=${JSON.stringify(s.plans()[0]?.work)} groups=${JSON.stringify(s.plans()[0]?.groupWaits)} unverified=${JSON.stringify((s.plans()[0]?.unverified ?? []).map(u => u.reason))}`)
  const waiting = s.plans()[0]
  assert.deepEqual(waiting.work, [spawned[0]], 'the report waits for the task it sent, not for nothing')
  assert.equal(waiting.plan, null)
  assert.equal(s.memoryText(), '')
  assert.equal(s.requests.filter(request => String(request.system).startsWith('You turn a reported')).length, 0, 'nothing was extracted while waiting')

  // The other Bot answers: the work closes and the candidate goes on at the next idle.
  s.rt.closeWork(spawned[0], 'Writer', 'Notes are written; tests 12/12 passed.')
  s.idle('chief')
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.match(s.memoryText(), /发布说明由 Writer 写/)
})

test('an own-chat turn that sent nothing does not wait', async t => {
  const s = await start(t)
  s.turnStart('chief')
  s.userSays('chief', 'Just remember this: tests 12/12 passed.')
  await s.tool('complete_task', report, 'chief', 'call-no-send')
  s.idle('chief')
  await until(() => s.plans()[0]?.status === 'DONE')
  assert.deepEqual(s.plans()[0].work, [], 'a turn with no request above or below it waits for nothing')
})

// A report made in a group waits on the member that group round called, and stops waiting
// when that member really speaks. The capture happens where the line is written — `say`
// for a member holding its place in a round, `postStep` for one posting outside it — because
// anything the round only records after the turn ends is too late for a report made inside
// that turn.
test('a member the admin called in a group holds the report until it answers there', async t => {
  const s = await start(t)
  // The product's own round: the user writes in the group and `group_relay` starts it.
  const stop = new AbortController()
  t.after(() => stop.abort())
  s.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void s.tool('group_relay', {}, 'desk', 'call-relay', { signal: stop.signal }).catch(() => {})

  // Chief takes its turn and writes a line naming Writer, while that turn is still open.
  await until(() => s.agentOf('desk-chief').calls.length === 1)
  const chiefBrief = s.agentOf('desk-chief').calls.at(-1)
  s.emit('desk-chief', 'turn/start', { turn: 1 })
  s.emit('desk-chief', 'user/message', { content: chiefBrief.content, source: chiefBrief.source })
  await s.rt.roomStepText('desk-chief', s.rt.live.get('desk-chief')?.info, '@Writer 写发布说明，测试 12/12 通过。', true)
  const roomCalls = Object.keys(s.rt.state.works).filter(id => id.startsWith('room:'))
  assert.equal(roomCalls.length, 1, 'the line that named Writer opened exactly one call')

  // The report is made inside the same turn, before `turn/end`: the call is already there.
  // The evidence must be in this group Session's own lines, so the claim quotes what the
  // user said there.
  const groupReport = { result: '完成发布说明安排', claims: [{ kind: 'command', statement: '发布说明已安排', evidence: '@Chief 安排一下发布说明', ref: 'part 1 #10' }], notes: '' }
  const accepted = await s.tool('complete_task', groupReport, 'desk-chief', 'call-group-report')
  assert.match(String(accepted), /Recorded as a candidate/)
  assert.equal(s.plans().length, 1, 'the report was accepted as a candidate')
  assert.deepEqual(s.plans()[0].work, [], 'the group call is not a handoff work')
  assert.equal(s.plans()[0].groupWaits.length, 1, 'the candidate is bound before the turn ends')
  // Only the real end of Chief's turn hands the round on to Writer; an idle event is not a
  // turn end. The candidate is checked at that idle.
  s.emit('desk-chief', 'assistant/message', { message: { content: [{ type: 'text', text: '@Writer 写发布说明，测试 12/12 通过。' }] } })
  s.emit('desk-chief', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  s.idle('desk-chief')
  await until(() => s.plans()[0]?.status === 'WAITING')
  assert.deepEqual(s.plans()[0].groupWaits, roomCalls, 'the report waits for the call its own turn made')
  assert.equal(s.plans()[0].plan, null, 'no plan is frozen while waiting')
  assert.equal(s.memoryText(), '', 'nothing is written while waiting')

  // Writer answers in the group: the call closes and the candidate goes on.
  await until(() => s.agentOf('desk-writer').calls.length === 1)
  const writerBrief = s.agentOf('desk-writer').calls.at(-1)
  s.emit('desk-writer', 'turn/start', { turn: 1 })
  s.emit('desk-writer', 'user/message', { content: writerBrief.content, source: writerBrief.source })
  s.emit('desk-writer', 'assistant/message', { message: { content: [{ type: 'text', text: '写好了，测试 12/12 通过。' }] } })
  s.emit('desk-writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  s.idle('desk-chief')
  await until(() => s.plans()[0]?.status === 'DONE')
})
