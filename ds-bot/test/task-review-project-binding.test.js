// What a task candidate keeps of its project, and what it is allowed to do with it later
// (issue #70, design §5:116-120).
//
// The real runtime is built by `createRuntime` — the same call `apply` makes — over a temp
// home, with a canned model and a real project resolver on real folders. Nothing here is a
// stub of the wiring under test: the candidate is written by `complete_task`, woken by a
// real `agent/status` idle, checked, frozen and applied by the product's own code.
//
// The four states are kept as four, not folded into `project: null`:
//   ok         the identity changing is DROPPED / `project-changed`, never re-bound;
//   unresolved re-resolves the folder of the report only, binds once, and never falls
//              into the Bot's own memory while it cannot tell;
//   none       stays the Bot's own memory while it is none, and binds once it becomes ok;
//   off        waits until project memory is on again, then decides from the same folder.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../index.js'
import { taskReview } from '../src/host/task-review.js'
import { formatEntry, parseMemory } from '../src/host/memory.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Reader', role: '审阅', model: 'deepseek/v4', instructions: '', createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// The line the claim quotes, and the answer it is quoted from. `partLines` flushes an
// answer only when it reaches the message it answers, exactly as a real part does.
const HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh; the suite passed: tests 12/12.' }] } } } },
  ],
  'desk-b2': [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh; the suite passed: tests 12/12.' }] } } } },
  ],
}

const CLAIM = { kind: 'command', statement: '发布脚本跑通了，测试 12/12 通过', evidence: 'tests 12/12', ref: 'part 1 #11' }
const report = { result: '完成发布脚本验证', claims: [CLAIM], notes: '' }
const ONE_ITEM = [{ claim: 0, topic: '', text: '发布用 scripts/ship.sh，测试通过后再发布', outcome: 'verified' }]

// One isolated host: a temp home, a team workspace folder, and the folders the Sessions
// work in. `folders` is read at every resolver call, so a test can move a Session or turn
// a folder into a project the way the real disk changes.
function start(t, { folders = {}, team, state = {}, config = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-binding-'))
  const dirs = { ...folders }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, ...state }))
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
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items: ONE_ITEM })
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
    // A Session exists only while it is the one its chat speaks from: an archived part
    // reads as absent, as DSH reports it.
    sessions: { messageProjections: [], get: id => (dirs[id] === undefined ? undefined : { id, header: { cwd: dirs[id] } }) },
    workspaceRegistry: { get: () => (team === undefined ? undefined : { id: 'w1', path: team }), archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, memoryReviewDelayMs: 0, ...config })
  const tool = (name, args, sessionId, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId })
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, seq: ++seq, data })
  }
  const idle = sessionId => ctx.emit('agent/status', { agent: { id: sessionId }, status: 'idle' })
  const planDir = () => join(home, 'memory', 'task-plans')
  const plans = () => (existsSync(planDir())
    ? readdirSync(planDir()).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(planDir(), name), 'utf8')))
    : [])
  const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const ownMemory = botId => read(join(home, 'memory', 'bots', botId, 'MEMORY.md'))
  const projectMemory = hash => read(join(home, 'memory', 'projects', hash, 'MEMORY.md'))
  const savePlan = (record) => {
    writeFileSync(join(planDir(), `${record.candidateId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  }
  const extractionCalls = () => requests.filter(request => String(request.system).startsWith('You turn a reported')).length
  const move = (sessionId, folder) => { dirs[sessionId] = folder }
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { ctx, rt, home, tool, emit, idle, plans, savePlan, ownMemory, projectMemory, extractionCalls, move, dirs, requests, seq: () => seq }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check) {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await settle()
  assert.ok(check(), 'the condition did not hold within 8 s')
}

// Two real repositories and one broken gitdir: the folder whose project cannot be told
// apart, which is `unresolved` and not `none`.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-project-binding-dirs-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const a = join(root, 'alpha')
  const b = join(root, 'beta')
  const broken = join(root, 'broken')
  const team = join(root, 'team')
  for (const path of [a, b, team]) mkdirSync(path, { recursive: true })
  mkdirSync(join(a, '.git'), { recursive: true })
  mkdirSync(join(b, '.git'), { recursive: true })
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, '.git'), 'gitdir: ../missing-git-dir\n')
  return { root, a, b, broken, team }
}

// A folder is only read once per 10 s, so a test that changes the disk says so explicitly:
// that is exactly what the plugin does when a person changes it in DSH.
const refresh = rt => rt.projectScope.clearCache()

test('an unresolved report waits, keeps its cwd, and binds once the folder resolves', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.broken } })
  await s.tool('complete_task', report, 'b2', 'call-unresolved')
  const [candidate] = s.plans()
  assert.equal(candidate.projectKind, 'unresolved', 'the state survives as itself, not as a null project')
  assert.equal(candidate.project, null)
  assert.equal(candidate.cwd, f.broken, 'the folder of the report is kept')

  s.idle('b2')
  await until(() => s.plans()[0].status === 'WAITING')
  assert.equal(s.extractionCalls(), 0, 'nothing is asked of the model while the project is unknown')
  assert.equal(s.ownMemory('b2'), '', 'an unresolved candidate never falls into the Bot\'s own memory')
  assert.equal(s.plans()[0].plan, null)

  // The repository is repaired: the same folder now resolves, and the candidate binds once.
  rmSync(join(f.broken, '.git'), { force: true })
  mkdirSync(join(f.broken, '.git'), { recursive: true })
  refresh(s.rt)
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DONE')
  const done = s.plans()[0]
  assert.equal(done.projectKind, 'ok')
  const project = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.broken } })
  assert.equal(done.project, `project:${project.hash}`, 'the binding names the project the recorded folder is in')
  assert.ok(done.boundAt, 'the binding is recorded once, with the moment it was made')
  assert.deepEqual(done.plan.items.map(item => item.scope), [`project:${project.hash}`])
  assert.match(s.projectMemory(project.hash), /发布用 scripts\/ship\.sh/)
  assert.equal(s.ownMemory('b2'), '', 'the lesson went to the project, not to the Bot')
})

test('a bound project that becomes another project is DROPPED, not re-bound and not written', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.a } })
  await s.tool('complete_task', report, 'b2', 'call-a-to-b')
  const [candidate] = s.plans()
  const alpha = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.a } })
  assert.equal(candidate.project, `project:${alpha.hash}`)
  assert.equal(candidate.projectKind, 'ok')

  // The same conversation now works in another repository.
  s.move('b2', f.b)
  refresh(s.rt)
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DROPPED')
  const after = s.plans()[0]
  assert.equal(after.droppedReason, 'project-changed')
  assert.equal(s.extractionCalls(), 0, 'a changed project is not extracted')
  const beta = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.b } })
  assert.equal(s.projectMemory(alpha.hash), '', 'nothing was written to the old project')
  assert.equal(s.projectMemory(beta.hash), '', 'nothing was written to the new project')
  assert.equal(s.ownMemory('b2'), '', 'nothing was written to the Bot either')
})

test('an unresolved candidate whose conversation moved elsewhere is not bound to that project', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.broken } })
  await s.tool('complete_task', report, 'b2', 'call-unresolved-moved')
  // The repository is repaired, but the conversation has moved to another one: the
  // recorded folder is no longer where this chat works, so the report cannot inherit it.
  rmSync(join(f.broken, '.git'), { force: true })
  mkdirSync(join(f.broken, '.git'), { recursive: true })
  s.move('b2', f.a)
  refresh(s.rt)
  s.idle('b2')
  await settle()
  await settle()
  const record = s.plans()[0]
  assert.equal(record.status, 'WAITING', 'a moved conversation cannot bind the old folder')
  assert.equal(s.extractionCalls(), 0)
  assert.equal(s.ownMemory('b2'), '')
  const alpha = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.a } })
  assert.equal(s.projectMemory(alpha.hash), '')
})

test('a none report keeps the Bot\'s own memory while it is none, and binds when the folder becomes a project', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.team } })
  await s.tool('complete_task', report, 'b2', 'call-none')
  const [candidate] = s.plans()
  assert.equal(candidate.projectKind, 'none', 'no project is a state of its own')
  assert.equal(candidate.project, null)

  // Still no project: the Bot's own memory is the only scope it ever had, and it is used.
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DONE')
  assert.match(s.ownMemory('b2'), /发布用 scripts\/ship\.sh/)
  assert.equal(s.plans()[0].plan.items[0].scope, 'bot:b2')

  // A second report in the same folder, now that the folder became a repository: it is
  // re-checked and bound, and the lesson goes to the project — never silently to own.
  mkdirSync(join(f.team, '.git'), { recursive: true })
  refresh(s.rt)
  await s.tool('complete_task', report, 'b2', 'call-none-now-project')
  s.idle('b2')
  await until(() => s.plans().some(record => record.candidateId !== candidate.candidateId && record.status === 'DONE'))
  const bound = s.plans().find(record => record.candidateId !== candidate.candidateId)
  const project = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.team } })
  assert.equal(bound.projectKind, 'ok')
  assert.equal(bound.project, `project:${project.hash}`)
  assert.match(s.projectMemory(project.hash), /发布用 scripts\/ship\.sh/)
})

test('a frozen plan cannot be pointed at another project by editing its file', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.a } })
  await s.tool('complete_task', report, 'b2', 'call-plan-edit')
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DONE')
  const alpha = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.a } })
  const beta = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.b } })
  assert.equal(s.plans()[0].plan.items[0].scope, `project:${alpha.hash}`)

  // A person edits the plan file to write into the other project, and puts the candidate
  // back to the state a crash before its first apply would leave.
  const record = s.plans()[0]
  record.plan.items[0].scope = `project:${beta.hash}`
  record.status = 'PLANNED'
  record.progress = { done: [], conflicts: [] }
  s.savePlan(record)
  refresh(s.rt)
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DROPPED')
  assert.equal(s.plans()[0].droppedReason, 'project-changed', 'a plan is not a permission of its own')
  assert.equal(s.projectMemory(beta.hash), '', 'the edited scope is never written')
  assert.equal(s.extractionCalls(), 1, 'the frozen plan is not extracted again')
})

test('project memory that is switched off holds the candidate, and switching it on continues', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.a }, config: { projectMemory: false } })
  await s.tool('complete_task', report, 'b2', 'call-off')
  const [candidate] = s.plans()
  assert.equal(candidate.projectKind, 'off', 'the off state is recorded as itself')

  s.idle('b2')
  await until(() => s.plans()[0].status === 'WAITING')
  assert.equal(s.extractionCalls(), 0)
  assert.equal(s.ownMemory('b2'), '', 'a report made in a project never moves into own when the feature is off')
  assert.equal(s.plans()[0].plan, null)

  // The switch goes back on: the folder on disk is the only fact left, and it decides.
  s.rt.config.projectMemory = true
  refresh(s.rt)
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DONE')
  const alpha = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.a } })
  assert.equal(s.plans()[0].project, `project:${alpha.hash}`)
  assert.match(s.projectMemory(alpha.hash), /发布用 scripts\/ship\.sh/)
  assert.equal(s.ownMemory('b2'), '')
})

// A frozen plan names its scope once. The same candidate looked at while its project is
// temporarily unreadable waits; it is never re-frozen, re-scoped, or moved to own — and
// when the folder resolves again to the same project it finishes in the scope it froze.
test('a frozen plan waits while its project is unreadable and finishes in the same scope', async t => {
  const f = fixture(t)
  const s = start(t, { team: f.team, folders: { b2: f.a } })
  await s.tool('complete_task', report, 'b2', 'call-freeze-then-broken')
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DONE')
  const alpha = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.a } })
  const frozen = s.plans()[0].plan.items[0].scope
  assert.equal(frozen, `project:${alpha.hash}`)

  // The same candidate is put back to the state a crash before its first apply leaves, and
  // its repository breaks: it may not finish anywhere else while the project is unknown.
  const record = s.plans()[0]
  record.status = 'PLANNED'
  record.progress = { done: [], conflicts: [] }
  s.savePlan(record)
  rmSync(join(f.a, '.git'), { recursive: true })
  writeFileSync(join(f.a, '.git'), 'gitdir: ../missing-git-dir\n')
  refresh(s.rt)
  s.idle('b2')
  await until(() => s.plans()[0].status === 'WAITING')
  assert.equal(s.plans()[0].plan.items[0].scope, frozen, 'the frozen scope did not move')
  assert.equal(s.ownMemory('b2'), '', 'a waiting project candidate never falls into own')

  // The repository is repaired: the same plan finishes in the same scope, no new model call.
  rmSync(join(f.a, '.git'), { force: true })
  mkdirSync(join(f.a, '.git'), { recursive: true })
  refresh(s.rt)
  s.idle('b2')
  await until(() => s.plans()[0].status === 'DONE')
  assert.equal(s.plans()[0].plan.items[0].scope, frozen)
  assert.equal(s.extractionCalls(), 1, 'a frozen plan is never extracted again')
  assert.match(s.projectMemory(alpha.hash), /发布用 scripts\/ship\.sh/)
})

// The second argument of `applyItem` is the shared interface #64 introduced: a hooks bag
// carrying `decide` (fresh hashes/entries/hasLink, and the persisted pre-write state) —
// #70 adds `record` beside it for its standing re-check and must never replace the bag
// with the record alone. This pins that contract at the module boundary (#70, #64).
test('applyItem is called with a hooks bag: record beside the decide hook, never the record alone', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-binding-hooks-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const seen = []
  const review = taskReview({
    root,
    check: async () => ({ ok: true, project: 'project:a' }),
    extract: async () => ({ items: [{ scope: 'project:a', text: '用脚本发布', outcome: 'verified', source: 'part 1 #2' }] }),
    applyItem: async (item, hooks) => {
      seen.push({ item, hooks })
      const verdict = await hooks.decide({ hashes: { 'MEMORY.md': 'h' }, entries: [], hasLink: true })
      assert.equal(verdict.kind, 'proceed', 'the #64 hook still decides inside the queued job')
      return { changed: true, file: 'MEMORY.md' }
    },
    linkTopic: async () => {},
    readScope: () => [{ file: 'MEMORY.md', topic: '', content: '# Memory\n\n## Index\n' }],
    parse: parseMemory,
    format: formatEntry,
    now: () => '2026-10-23T00:00:00.000Z',
  })
  const record = await review.enqueue({ botId: 'b1', sessionId: 's1', roomId: null, project: 'project:a', projectKind: 'ok', cwd: null, callId: 'c-hooks', result: 'done', claims: [], notes: '' })
  const done = await review.process(record.candidateId)
  assert.equal(done.status, 'DONE')
  assert.equal(seen.length, 1)
  const [call] = seen
  assert.equal(typeof call.hooks, 'object', 'the second argument is a hooks bag')
  assert.equal(typeof call.hooks.decide, 'function', '#64 decide is still there')
  assert.equal(call.hooks.record?.candidateId, record.candidateId, '#70 record travels beside it')
  assert.notEqual(call.hooks, call.hooks.record, 'the bag is not the record itself')
})

test('a candidate whose Bot left the group is dropped instead of written', async t => {
  const f = fixture(t)
  const s = start(t, {
    team: f.team,
    folders: { 'desk-b2': f.a },
    state: {
      rooms: {
        desk: {
          id: 'desk',
          name: 'Desk',
          members: ['b2', 'b3'],
          admin: 'b3',
          mode: 'everyone',
          sessions: { b2: 'desk-b2' },
          log: [],
          seq: 0,
          seen: {},
        },
      },
    },
  })
  s.emit('desk-b2', 'turn/start', { turn: 1 })
  await s.tool('complete_task', report, 'desk-b2', 'call-member')
  assert.equal(s.plans()[0].roomId, 'desk')

  // The member is removed from the group while the candidate waits.
  s.rt.state.rooms.desk.members = ['b3']
  s.idle('desk-b2')
  await until(() => s.plans()[0].status === 'DROPPED')
  assert.equal(s.plans()[0].droppedReason, 'member-gone')
  assert.equal(s.extractionCalls(), 0)
  const alpha = s.rt.projectScope.resolve({ id: 'probe', header: { cwd: f.a } })
  assert.equal(s.projectMemory(alpha.hash), '')
  assert.equal(s.ownMemory('b2'), '')
})

