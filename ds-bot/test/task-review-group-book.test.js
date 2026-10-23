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
  const rt = createRuntime(ctx, { home, memoryReviewDelayMs: 0, roomRecoveryDelayMs: 20 })
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

test('a member the round passes over leaves no call behind, and the report does not wait', async t => {
  const s = await start(t)
  const stop = new AbortController()
  t.after(() => stop.abort())
  s.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 开始复核.' }], source: { kind: 'user' } })
  void s.tool('group_relay', {}, 'desk', 'relay-cap', { signal: stop.signal }).catch(() => {})

  // Chief (the admin, four turns each) calls Writer and Tester.
  await called(s, 'desk-chief')
  s.begin('desk-chief')
  await s.say('desk-chief', '@Writer @Tester 一起看发布说明，测试 12/12 通过。')
  s.finish('desk-chief', '@Writer @Tester 一起看发布说明，测试 12/12 通过。')

  // Writer, first turn.
  await called(s, 'desk-writer')
  s.begin('desk-writer')
  s.finish('desk-writer', '第一步做完了。')

  // Tester, first turn: calls Writer (its second turn).
  await called(s, 'desk-tester')
  s.begin('desk-tester')
  await s.say('desk-tester', '@Writer 请复核一下。')
  s.finish('desk-tester', '@Writer 请复核一下。')

  // Writer, second turn: calls Tester back (its second turn).
  await called(s, 'desk-writer')
  s.begin('desk-writer')
  await s.say('desk-writer', '@Tester 结果如下，请确认。')
  s.finish('desk-writer', '@Tester 结果如下，请确认。')

  // Tester, second turn: it has used its two turns as a member's callee, so a further call
  // to it is passed over by the round. The line opens the call first.
  await called(s, 'desk-tester')
  s.begin('desk-tester')
  await s.say('desk-tester', '@Writer 再确认一下。')
  // Both are open right now: the line just opened Tester's call to Writer, and Writer's
  // earlier call to Tester is only closed when Tester's turn really ends.
  assert.deepEqual(s.roomCalls(), ['room:desk:tester:writer', 'room:desk:writer:tester'])
  const accepted = await s.tool('complete_task', report, 'desk-tester', 'report-cap')
  assert.match(String(accepted), /Recorded as a candidate/)
  assert.deepEqual(s.plans()[0].groupWaits, ['room:desk:tester:writer'])
  s.finish('desk-tester', '@Writer 再确认一下。')

  // The dispatcher passed Writer over (two turns used), so it drops the call it opened.
  await until(() => s.roomCalls().length === 0, () => JSON.stringify(s.roomCalls()))
  assert.equal(s.roomCalls().includes('room:desk:tester:writer'), false, 'the passed-over call is dropped, not left waiting')
  s.idle('desk-tester')
  await until(() => s.plans()[0]?.status === 'DONE', () => `status=${s.plans()[0]?.status} calls=${JSON.stringify(s.roomCalls())}`)
  assert.match(s.memoryOf('tester'), /发布说明由 Writer 写/, 'the report goes on instead of waiting forever')
})

// Restart, member gone: the group no longer holds the Bot the call names, so no turn can
// ever answer it. The call is settled from what is on disk, and the report goes on.

test('a call whose member was removed is settled when the team loads', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-book-restart-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const first = await start(t, { home })
  const stop = new AbortController()
  t.after(() => stop.abort())
  first.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void first.tool('group_relay', {}, 'desk', 'relay-removed', { signal: stop.signal }).catch(() => {})
  await called(first, 'desk-chief')
  first.begin('desk-chief')
  await first.say('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  await first.tool('complete_task', report, 'desk-chief', 'report-removed')
  first.finish('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  first.idle('desk-chief')
  await until(() => first.plans()[0]?.status === 'WAITING')
  assert.deepEqual(first.roomCalls(), ['room:desk:chief:writer'])
  await first.ctx.dispose()

  // The member left the group while the host was down.
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  state.rooms.desk.members = state.rooms.desk.members.filter(id => id !== 'writer')
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))

  const second = await start(t, { home })
  await until(() => second.roomCalls().length === 0, () => JSON.stringify(second.roomCalls()))
  second.idle('chief')
  await until(() => second.plans()[0]?.status === 'DONE', () => `status=${second.plans()[0]?.status}`)
  assert.match(second.memoryOf('chief'), /发布说明由 Writer 写/)
})

// A call saved and never asked: the line that named the member is in the group log and the
// call is in the book, but the round did not get as far as delivering the brief before the
// host went down, and nothing was noted in inflight for the member. A restart must ask the
// member again through the same room delivery a round uses; the report keeps waiting until
// the member really answers.
test('a call saved but never asked is asked again after a restart, and the report waits', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-book-unasked-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const first = await start(t, { home })
  const stop = new AbortController()
  t.after(() => stop.abort())
  first.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void first.tool('group_relay', {}, 'desk', 'relay-unasked', { signal: stop.signal }).catch(() => {})
  await called(first, 'desk-chief')
  first.begin('desk-chief')
  await first.say('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  await first.tool('complete_task', report, 'desk-chief', 'report-unasked')
  // The report is checked while Chief's turn is still open, so the call is open and the
  // candidate waits. The round has not reached Writer yet: no brief, no inflight note.
  first.idle('desk-chief')
  await until(() => first.plans()[0]?.status === 'WAITING')
  assert.deepEqual(first.roomCalls(), ['room:desk:chief:writer'])
  assert.equal(first.agentOf('desk-writer').calls.length, 0, 'Writer was never asked before the restart')
  await first.ctx.dispose()

  const second = await start(t, { home })
  // The member is still in the group, so the call must not be dropped: it is asked again.
  await until(() => second.agentOf('desk-writer').calls.length === 1, () => JSON.stringify(second.roomCalls()))
  const brief = second.agentOf('desk-writer').calls.at(-1)
  assert.equal(brief.source.role, 'room')
  assert.equal(brief.source.roomId, 'desk')
  assert.deepEqual(second.roomCalls(), ['room:desk:chief:writer'], 'the call is still open until it is answered')
  second.idle('chief')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(second.plans()[0]?.status, 'WAITING', 'being asked again is not an answer')
  assert.equal(second.memoryOf('chief'), '', 'nothing is written before the member answers')

  // Writer takes the brief and answers in the group: the ordinary late path closes the call.
  second.emit('desk-writer', 'turn/start', { turn: 1 })
  second.emit('desk-writer', 'user/message', { content: brief.content, source: brief.source })
  second.emit('desk-writer', 'assistant/message', { message: { content: [{ type: 'text', text: '写好了，测试 12/12 通过。' }] } })
  second.emit('desk-writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => second.roomCalls().length === 0, () => JSON.stringify(second.roomCalls()))
  second.idle('chief')
  await until(() => second.plans()[0]?.status === 'DONE', () => `status=${second.plans()[0]?.status}`)
  assert.match(second.memoryOf('chief'), /发布说明由 Writer 写/)
})

// The same crash window, but the member was taken out of the group while the host was down.
// Nobody can answer, so the call is settled and the report goes on instead of waiting.
test('a call saved but never asked is settled after a restart when its member was removed', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-book-unasked-gone-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const first = await start(t, { home })
  const stop = new AbortController()
  t.after(() => stop.abort())
  first.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void first.tool('group_relay', {}, 'desk', 'relay-unasked-gone', { signal: stop.signal }).catch(() => {})
  await called(first, 'desk-chief')
  first.begin('desk-chief')
  await first.say('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  await first.tool('complete_task', report, 'desk-chief', 'report-unasked-gone')
  first.idle('desk-chief')
  await until(() => first.plans()[0]?.status === 'WAITING')
  assert.equal(first.agentOf('desk-writer').calls.length, 0)
  await first.ctx.dispose()

  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  state.rooms.desk.members = state.rooms.desk.members.filter(id => id !== 'writer')
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))

  const second = await start(t, { home })
  await until(() => second.roomCalls().length === 0, () => JSON.stringify(second.roomCalls()))
  assert.equal(second.agentOf('desk-writer').calls.length, 0, 'a member who left is not asked')
  second.idle('chief')
  await until(() => second.plans()[0]?.status === 'DONE', () => `status=${second.plans()[0]?.status}`)
  assert.match(second.memoryOf('chief'), /发布说明由 Writer 写/)
})

// The other crash window: the member did answer, its line is on disk, and the close that
// would have deleted the call never landed. After a restart the call is settled from the
// log — not asked again, and not left waiting.
test('a call whose member already answered is settled after a restart instead of asked again', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-book-answered-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const first = await start(t, { home })
  const stop = new AbortController()
  t.after(() => stop.abort())
  first.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void first.tool('group_relay', {}, 'desk', 'relay-answered', { signal: stop.signal }).catch(() => {})
  await called(first, 'desk-chief')
  first.begin('desk-chief')
  await first.say('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  await first.tool('complete_task', report, 'desk-chief', 'report-answered')
  // Chief's turn really ends, so the round hands on to Writer.
  first.finish('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  first.idle('desk-chief')
  await until(() => first.plans()[0]?.status === 'WAITING')

  // Writer answers in the group through the product's own step path, which writes its
  // line into the log and saves it while the round still waits for the turn to end. The
  // host goes down before that turn ends, so the round's closing pass never runs.
  await called(first, 'desk-writer')
  first.begin('desk-writer')
  await first.say('desk-writer', '写好了，测试 12/12 通过。')
  await new Promise(resolve => setTimeout(resolve, 150))
  await first.ctx.dispose()
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.rooms.desk.log.some(line => line.botId === 'writer' && line.text.includes('写好了')), true, 'the answer line is on disk')
  assert.equal(state.works['room:desk:chief:writer'] !== undefined, true, 'the close never landed, so the call is still in the book')

  const second = await start(t, { home })
  // Settled from the log: the call is closed and no recovery brief is sent. (The cut-off
  // turn itself is a separate note in inflight.json and may still be picked up; that is
  // the ordinary resume path, not this call.)
  await until(() => second.roomCalls().length === 0, () => JSON.stringify(second.roomCalls()))
  assert.equal(second.agentOf('desk-writer').calls.some(call => String(call.source?.exchangeId ?? '').startsWith('room-recover:')), false, 'a member that already answered is not asked again')
  second.idle('chief')
  await until(() => second.plans()[0]?.status === 'DONE', () => `status=${second.plans()[0]?.status}`)
  assert.match(second.memoryOf('chief'), /发布说明由 Writer 写/)
})

// Restart, member still in the group: nothing process-local can tell it apart from a
// member between turns, so the call must survive. The member answering in the group is
// what settles it — the existing late path, no restore layer.

test('a call whose member is still in the group survives a restart and settles when it answers', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-book-alive-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const first = await start(t, { home })
  const stop = new AbortController()
  t.after(() => stop.abort())
  first.emit('desk', 'user/message', { content: [{ type: 'text', text: '@Chief 安排一下发布说明.' }], source: { kind: 'user' } })
  void first.tool('group_relay', {}, 'desk', 'relay-alive', { signal: stop.signal }).catch(() => {})
  await called(first, 'desk-chief')
  first.begin('desk-chief')
  await first.say('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  await first.tool('complete_task', report, 'desk-chief', 'report-alive')
  first.finish('desk-chief', '@Writer 写发布说明，测试 12/12 通过。')
  first.idle('desk-chief')
  await until(() => first.plans()[0]?.status === 'WAITING')
  await first.ctx.dispose()

  const second = await start(t, { home })
  assert.deepEqual(second.roomCalls(), ['room:desk:chief:writer'], 'a live call is not dropped at load')
  second.idle('chief')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(second.plans()[0]?.status, 'WAITING', 'the member has not answered, so the report still waits')
  assert.equal(second.memoryOf('chief'), '', 'a restart alone writes nothing')

  // Writer answers in the group after the restart: the late path closes the call.
  second.emit('desk-writer', 'turn/start', { turn: 1 })
  second.emit('desk-writer', 'user/message', { content: [{ type: 'text', text: '写好了，测试 12/12 通过。' }], source: { kind: 'bot', role: 'room', roomId: 'desk', exchangeId: 'room-call-1' } })
  second.emit('desk-writer', 'assistant/message', { message: { content: [{ type: 'text', text: '写好了，测试 12/12 通过。' }] } })
  second.emit('desk-writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => second.roomCalls().length === 0, () => JSON.stringify(second.roomCalls()))
  second.idle('chief')
  await until(() => second.plans()[0]?.status === 'DONE', () => `status=${second.plans()[0]?.status}`)
  assert.match(second.memoryOf('chief'), /发布说明由 Writer 写/)
})
