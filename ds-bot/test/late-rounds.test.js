/**
 * Behaviour tests for the group late-round patch.
 *
 * These drive the real round machinery with `group-work.test.js`'s harness, so
 * every assertion reads `state.json` — what the plugin actually persisted — not
 * the shape of its source.
 *
 * What is pinned:
 *
 * 1. a Main Bot opening a round with `post_to_group` resets the late-round budget;
 * 2. a Main Bot's late reply does not reset it (it spends one, as before);
 * 3. a Main Bot's step line does not reset it either;
 * 4. an admin that is not a Main Bot does not reset it;
 * 5. a post the limit kept quiet carries the note; one under the limit does not.
 *
 * @module ds-bot/test/late-rounds
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_LATE_ROUNDS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'

// A mid-budget seed, so "spent one" (6) and "reset" (0) cannot be confused.
const SEEDED = 5

// Chief is the Main Bot AND the admin of 'r1'; Writer and Tester are ordinary
// members. `lateRounds` seeds the counter.
const seed = (room = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a',
      named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {},
      ...room,
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

/**
 * Start the plugin on a temporary home and expose the round helpers, the same
 * harness `group-work.test.js` uses.
 * @param {object} t - the node:test context.
 * @param {object} [room] - room overrides, e.g. `{ lateRounds: 5 }`.
 * @returns {Promise<object>} the harness.
 */
async function start(t, room) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-late-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room)))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const held = []
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) {
          const at = held.findIndex((message) => message.id === id)
          if (at === -1) return false
          held.splice(at, 1)
          return true
        },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, {
        session: { id: sessionId }, calls, cancelled: [], inbox, followup: keep, steer: keep,
        cancel(reason) { this.cancelled.push(reason) },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async (path) => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async (sessionId) => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    return () => result
  }
  const say = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  const lateRounds = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1.lateRounds
  await tool('list_bots', {}, 'a')
  return { home, agentOf, emit, tool, begin, finish, round, say, takePost, lateRounds }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = (message) => message.content.map((block) => block.text ?? '').join('\n')

test('a Main Bot opening a round with post_to_group resets the late limit', async (t) => {
  const host = await start(t, { lateRounds: SEEDED })
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下进度' }, 'a')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.late, undefined, 'a post_to_group post carries no late flag')
  assert.equal(post.source.progress, undefined, 'nor a progress flag')
  // The post opens a round that calls Writer; the reset happens when the round
  // consumes the post, before Writer answers.
  host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(host.lateRounds(), 0, 'a Main Bot opened a new round, so the budget is fresh')
  host.finish('gb', '看过了。')
})

test('a Main Bot\'s late reply spends one round, it does not reset the limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { lateRounds: SEEDED })
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  // Chief's turn ends after the round moved on: a late reply, not a new round.
  host.finish('ga', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.late, true)
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  // The user's c1 round reset the counter to 0; the late reply spent exactly one.
  // A wrong patch would leave 0 here (the reply "reset" itself).
  assert.equal(host.lateRounds(), 1, 'a late reply spends one round and buys no reset')
})

test('a Main Bot\'s step line spends one round, it does not reset the limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { lateRounds: SEEDED })
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  // A line Chief posts while working past the round: a step line (`progress`).
  await host.tool('message_bot', { to: 'Writer', message: '先把目录理好' }, 'ga')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.progress, true)
  host.round('c2', post)
  // The step line calls Writer, so the round opens; the counter was already
  // settled when the round consumed the post, before Writer answers.
  await settle(() => host.agentOf('gb').calls.length === 1)
  // As with the late reply: the user's round reset it to 0, the step line spent
  // one, and no reset may hide that.
  assert.equal(host.lateRounds(), 1, 'a step line spends one round and buys no reset')
})

test('an admin that is not a Main Bot does not reset the late limit', async (t) => {
  // Writer is the room's admin here, but not a Main Bot.
  const host = await start(t, { lateRounds: SEEDED, admin: 'b' })
  await host.tool('post_to_group', { group: 'Ops', message: '@Chief 看一下进度' }, 'b')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.lateRounds(), SEEDED, 'only a Main Bot earns the reset')
  host.finish('ga', '看过了。')
})

test('a post the limit kept quiet says so', async (t) => {
  const host = await start(t, { lateRounds: ROOM_LATE_ROUNDS })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', {
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', hop: 0, askedBy: 'a' },
  })
  host.finish('gb', '做完了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.quiet, true)
  assert.match(text(post), /迟到轮次已达上限/u)
  assert.match(text(post), /没有叫醒任何人/u)
})

test('a post under the limit carries no note', async (t) => {
  const host = await start(t, { lateRounds: 0 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', {
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', hop: 0, askedBy: 'a' },
  })
  host.finish('gb', '做完了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.quiet, undefined)
  assert.doesNotMatch(text(post), /迟到轮次已达上限/u)
})
