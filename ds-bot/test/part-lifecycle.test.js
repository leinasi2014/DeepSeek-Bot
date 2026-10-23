import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A part ends in two ways, and each has to renew the Session's frozen memory: condensing
// it in place (parts.js condense) and moving the Bot on to a fresh part (parts.js
// runSwitch). A third way a snapshot goes is a deleted Bot (memory.js archiveBotMemory).
// memory.test.js:472 removes a snapshot by hand and shows the next render freezes again;
// it says nothing about who removes it in the product, and nothing else named these
// calls, so deleting any of them left the suite green.

const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, segments: [{ sessionId: 'old-b', endedAt: 3 }] },
    c: { id: 'c', name: 'Coder', role: 'Code', sessionId: 'c', createdAt: 4, segments: [{ sessionId: 'old-c', endedAt: 5 }] },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'c', named: true, sessions: { c: 'g-c' } },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// DSH_HOME, the team's data inside it, and a project folder beside it. `tokens` is what
// the token meter reports, so a part can be put past the context lines the way a long
// conversation is. The compaction backend answers as the real one does, and leaves the
// part small afterwards.
async function start({ tokens = 0 } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-part-lifecycle-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const bench = { tokens, compacted: 0 }
  const compaction = {
    summarize() {},
    async compactIfNeeded() {
      bench.compacted += 1
      bench.tokens = 100
      return {}
    },
    async compactNow() {},
    async compactRegion() {},
  }
  const ctx = fakeContext({ services: { compaction, tokenMeter: { measure: () => ({ totalTokens: bench.tokens }) } } })
  const created = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        id: sessionId,
        session: {
          id: sessionId,
          seq: 0,
          header: { cwd: cwds.get(sessionId) ?? team },
          requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4', maxTokens: 8_000 } }),
          deriveMessages: () => [],
          toolHistory: () => [],
        },
        calls: [],
        status: 'idle',
        followup(message) { this.calls.push(['followup', message]) },
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({
        context: { contextWindow: 100_000 },
        defaultMaxTokens: 8_000,
        reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
      }),
      async* stream(request) {
        const system = String(request.system ?? '')
        // The context steward's call: DS Bot's own request, not the Bot's round.
        if (system.startsWith('You are the context steward')) {
          yield { type: 'text-delta', index: 0, text: '{"action":"compact"}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        // The shared semantic gate (#66): a canned yes for each quoted entry.
        if (system.startsWith('You check whether quoted evidence supports')) {
          const raw = request.messages?.at(-1)?.content
          const body = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(block => block?.text ?? '').join('\n') : String(raw ?? '')
          const entries = body.split('\n').filter(line => line.trim().startsWith('{')).length
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ support: Array.from({ length: entries }, () => 'yes') }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? registry.get(options.workspaceId)?.path)
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  // parts.js calls rt.renewMemory at call time, so this counts the product's own calls.
  const renewals = []
  const renewMemory = rt.renewMemory
  rt.renewMemory = (sessionId) => {
    renewals.push(sessionId)
    return renewMemory(sessionId)
  }

  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // The memory section as the prompt hook renders it for that Session, with its Session
  // record so its working folder, and so its project, is the real one.
  const section = sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId, session: agentOf(sessionId).session } })
  const snapshot = sessionId => join(home, 'memory', 'snapshots', `${sessionId}.md`)
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const preStep = (sessionId, messages = [], step = 1) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  const stop = () => {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { bench, created, agentOf, call, tool, section, snapshot, state, preStep, renewals, project, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check) => {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await settle()
  assert.ok(check(), 'the condition did not hold within 4 s')
}

test('condensing a part renews its frozen memory, so the next render catches up', async (t) => {
  const { bench, tool, section, snapshot, preStep, renewals, stop } = await start({ tokens: 90_000 })
  t.after(stop)
  assert.match(await tool('remember', { text: 'Likes tea' }, 'b'), /^Saved to your memory/)
  const opened = section('b')
  assert.match(opened, /- Likes tea \[/)
  assert.equal(existsSync(snapshot('b')), true)
  // Saved during the part, but the part's memory is frozen: the render holds still.
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b')
  assert.equal(section('b'), opened)

  // Past the hard line the steward says the work is under way: the part is condensed in
  // place, which renews its memory.
  assert.equal(await preStep('b'), 'next')
  assert.equal(bench.compacted, 1)
  assert.deepEqual(renewals, ['b'])
  assert.equal(existsSync(snapshot('b')), false)
  // The next render freezes the memory as it is now, not as it was.
  assert.match(section('b'), /- Likes tea \[/)
  assert.match(section('b'), /- Lives in Hangzhou \[/)
})

test('moving a Bot to a fresh part renews the memory of the part it left', async (t) => {
  const { call, tool, section, snapshot, state, renewals, project, stop } = await start()
  t.after(stop)
  await tool('remember', { text: 'Likes tea' }, 'b')
  assert.match(section('b'), /- Likes tea \[/)
  assert.equal(existsSync(snapshot('b')), true)

  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  await until(() => state().bots.b.sessionId === 's1')
  await until(() => renewals.includes('b'))
  assert.deepEqual(renewals, ['b'])
  assert.equal(existsSync(snapshot('b')), false)
})

test('deleting a Bot drops the frozen memory of its chat, its earlier parts and its group', async (t) => {
  const { call, section, snapshot, state, stop } = await start()
  t.after(stop)
  // Three Sessions speak for Coder: its own chat, an earlier part of it, and its group.
  for (const sessionId of ['c', 'old-c', 'g-c', 'a']) {
    assert.equal(section(sessionId).startsWith('<!-- ds-bot:memory v2'), true, sessionId)
    assert.equal(existsSync(snapshot(sessionId)), true, sessionId)
  }

  assert.equal((await call('delete-bot', { id: 'c' })).ok, true)
  assert.equal(state().bots.c, undefined)
  for (const sessionId of ['c', 'old-c', 'g-c']) assert.equal(existsSync(snapshot(sessionId)), false, sessionId)
  // Another Bot's frozen memory is not the deleted one's to drop.
  assert.equal(existsSync(snapshot('a')), true)
})
