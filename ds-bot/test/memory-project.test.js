import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install as installProjectScope } from '../src/host/project-scope.js'
import { install as installMemory } from '../src/host/memory.js'

// Two projects on disk (a .git folder each) and one folder that is no project.
const work = mkdtempSync(join(tmpdir(), 'ds-bot-memory-project-'))
const projectA = join(work, 'alpha')
const projectB = join(work, 'beta')
mkdirSync(join(projectA, '.git'), { recursive: true })
mkdirSync(join(projectB, '.git'), { recursive: true })
mkdirSync(join(projectA, 'pkg'), { recursive: true })
// A repository whose .git pointer leads nowhere: not "no project", but one whose
// project cannot be told apart — the state a broken gitdir leaves a Session in.
const broken = join(work, 'broken')
mkdirSync(broken)
writeFileSync(join(broken, '.git'), 'gitdir: ../nowhere\n')
const lost = join(work, 'gone')

// Sessions with a working folder, the way DSH reports one.
const sessions = {
  sA: { id: 'sA', header: { cwd: join(projectA, 'pkg') } },
  sB: { id: 'sB', header: { cwd: projectB } },
  sLost: { id: 'sLost', header: { cwd: join(lost, 'x') } },
  sBroken: { id: 'sBroken', header: { cwd: broken } },
}
const bots = { b2: { id: 'b2', name: 'Writer' }, b3: { id: 'b3', name: 'Reader' } }

function start(t) {
  const ctx = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-project-rt-'))
  const rt = {
    ctx, home, config: { memoryReview: false }, state: { rooms: {} },
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    botOf: id => bots[id], findBot: name => Object.values(bots).find(bot => bot.name === name),
    selfOf: id => (id === 'sA' || id === 'sBroken' || id === 'sLost' ? 'b2' : id === 'sB' ? 'b3' : undefined),
    isMain: () => false, chatOf: botId => `chat-${botId}`, groupSessionsOf: () => [],
    sessionsOfBot: botId => (botId === 'b2' ? ['sA', 'sLost', 'sBroken'] : ['sB']),
    groupOwners: new Map(), roomOf: () => undefined, partsOf: id => [{ sessionId: id }],
    clock: () => '12:00', teamFolder: () => join(work, 'team'),
    sessionFolder: session => sessions[session?.id ?? session]?.header?.cwd,
    async* eventsBackwards() { /* no saved history in this fixture */ },
  }
  installProjectScope(rt)
  installMemory(rt)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  return {
    home, rt, ctx,
    tool: (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId, session: sessions[sessionId] } }),
    section: sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId, session: sessions[sessionId] } }),
    view: async body => (await rt.memoryEndpoint('memory-view', body)),
    read: (...path) => readFileSync(join(home, 'memory', ...path), 'utf8'),
  }
}

test('a Session saves to its project by default, and only its project is visible to it', async t => {
  const s = start(t)
  assert.match(await s.tool('remember', { text: 'Alpha uses pnpm' }, 'sA'), /Saved to the project memory/)
  assert.match(await s.tool('remember', { text: 'Beta ships on Friday' }, 'sB'), /Saved to the project memory/)
  const alpha = s.rt.projectScope.resolve(sessions.sA)
  const beta = s.rt.projectScope.resolve(sessions.sB)
  assert.notEqual(alpha.hash, beta.hash)
  assert.match(s.read('projects', alpha.hash, 'MEMORY.md'), /- Alpha uses pnpm \[source: [^;]*; by: Writer; added: /)
  assert.match(s.read('projects', beta.hash, 'MEMORY.md'), /- Beta ships on Friday/)
  // Neither landed in a Bot's own memory, and each project sees only itself.
  assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
  assert.doesNotMatch(await s.tool('recall', { query: 'Alpha' }, 'sB'), /Alpha uses pnpm/)
  assert.match(await s.tool('recall', { query: 'Alpha' }, 'sA'), /Alpha uses pnpm/)
  assert.doesNotMatch(await s.tool('recall', { query: 'Beta' }, 'sA'), /Beta ships on Friday/)
  // The project keyword means the caller's own project, never another one's.
  assert.doesNotMatch(await s.tool('recall', { query: 'Alpha', scope: 'project' }, 'sB'), /Alpha uses pnpm/)
})

test('an explicit own or team scope still writes there, from a project session', async t => {
  const s = start(t)
  assert.match(await s.tool('remember', { text: 'Likes tea', scope: 'own' }, 'sA'), /Saved to your memory/)
  assert.match(s.read('bots', 'b2', 'MEMORY.md'), /Likes tea/)
  const alpha = s.rt.projectScope.resolve(sessions.sA)
  assert.equal(existsSync(join(s.home, 'memory', 'projects', alpha.hash, 'MEMORY.md')), false)
})

test('a session whose project cannot be told apart writes nothing by default', async t => {
  const s = start(t)
  assert.match(await s.tool('remember', { text: 'Anything' }, 'sLost'), /Cannot tell which project this conversation works in/)
  assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
  assert.match(await s.tool('remember', { text: 'Anything', scope: 'own' }, 'sLost'), /Saved to your memory/)
})

test('the frozen section names its scopes and shows the project memory', async t => {
  const s = start(t)
  await s.tool('remember', { text: 'Alpha uses pnpm' }, 'sA')
  const alpha = s.rt.projectScope.resolve(sessions.sA)
  const text = s.section('sA')
  assert.match(text, new RegExp(`^<!-- ds-bot:memory v2 scopes=bot:b2,project:${alpha.hash},team -->`))
  assert.match(text, /## Project memory of alpha \(project\/MEMORY\.md\)\n- Alpha uses pnpm/)
  // Another project's session carries its own header, and none of alpha's entries.
  const beta = s.rt.projectScope.resolve(sessions.sB)
  const other = s.section('sB')
  assert.match(other, new RegExp(`^<!-- ds-bot:memory v2 scopes=bot:b3,project:${beta.hash},team -->`))
  assert.doesNotMatch(other, /Alpha uses pnpm/)
})

test('the panel names a conversation and reads its project; a foreign session is refused', async t => {
  const s = start(t)
  await s.tool('remember', { text: 'Alpha uses pnpm' }, 'sA')
  const view = await s.view({ botId: 'b2', session: 'sA' })
  const alpha = s.rt.projectScope.resolve(sessions.sA)
  assert.equal(view.project.hash, alpha.hash)
  assert.ok(view.projects.some(project => project.hash === alpha.hash))
  assert.ok(view.entries.some(entry => entry.scope === 'project' && entry.text === 'Alpha uses pnpm'))
  // A session that is not this Bot's is not a way in.
  await assert.rejects(() => s.view({ botId: 'b2', session: 'sB' }), /does not belong to this Bot/)
  // A single project entry is removed through the same queue; the file's heading
  // stays, the entry is gone.
  await rt_forget(s, { botId: 'b2', session: 'sA', scope: 'project', text: 'Alpha uses pnpm' })
  assert.doesNotMatch(s.read('projects', alpha.hash, 'MEMORY.md'), /Alpha uses pnpm/)
})

async function rt_forget(s, body) {
  await s.rt.memoryEndpoint('memory-forget', body)
}

// A review of a conversation whose project cannot be told apart (a broken gitdir)
// must skip its project changes with a journal record, not save them to the Bot's
// own memory — the same refusal the tools make.
test('the memory review skips project writes when the project is unresolved, and journals them', async t => {
  const ctx = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-project-rt-'))
  const replies = [JSON.stringify({ changes: [
    { op: 'add', text: 'The deploy window is 8pm to 11pm' },
    { op: 'add', text: 'Ship on Friday too', team: true },
  ] })]
  const rt = {
    ctx, home, config: { memoryReviewDelayMs: 0 }, state: { rooms: {} },
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    botOf: id => bots[id], findBot: () => undefined,
    selfOf: id => (id === 'sBroken' ? 'b2' : undefined),
    // A Main Bot, so the team change in the reply lands; the project one must not.
    isMain: () => true, isBotSession: () => true, chatOf: botId => `chat-${botId}`, groupSessionsOf: () => [],
    sessionsOfBot: () => ['sBroken'],
    chatOwners: new Map([['sBroken', 'b2']]), groupOwners: new Map(), pastOwners: new Map(),
    roomOf: () => undefined, partsOf: id => [{ sessionId: id }],
    clock: () => '12:00', teamFolder: () => join(work, 'team'),
    sessionFolder: session => sessions[session?.id ?? session]?.header?.cwd,
    desiredModel: async () => undefined, defaultModel: async () => 'deepseek/v4',
    async* eventsBackwards() { /* no saved history in this fixture */ },
    async* partLines() { yield { who: 'user', text: 'The deploy window is 8pm to 11pm, and ship on Friday.', seq: 10 } },
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream() {
        const reply = replies.shift()
        yield { type: 'text-delta', index: 0, text: reply ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  installProjectScope(rt)
  installMemory(rt)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  ctx.emit('agent/status', { agent: { id: 'sBroken', session: sessions.sBroken }, status: 'idle' })
  for (let tries = 0; tries < 200 && rt.memoryReviews() > 0; tries += 1) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rt.memoryReviews(), 0, 'the review finished')
  // The project change went nowhere near the Bot's own memory; the team change, an
  // explicit choice, still landed.
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2')), false)
  assert.match(readFileSync(join(home, 'memory', 'team', 'MEMORY.md'), 'utf8'), /Ship on Friday too/)
  const records = readFileSync(join(home, 'memory', 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const skipped = records.find(record => record.reason === 'project-unresolved')
  assert.equal(skipped.op, 'skip')
  assert.equal(skipped.after, 'The deploy window is 8pm to 11pm')
  assert.match(skipped.problem, /nowhere/)
})

// A review that names the team memory while the Bot may not write it skips the
// change with a record; it never lands in the Bot's own memory instead.
test('the memory review refuses a team write the Bot may not make, instead of saving it to own', async t => {
  const ctx = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-project-rt-'))
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'Ship on Friday', team: true }] })]
  const rt = {
    ctx, home, config: { memoryReviewDelayMs: 0 }, state: { rooms: {} },
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    botOf: id => bots[id], findBot: () => undefined,
    selfOf: id => (id === 'sA' ? 'b2' : undefined),
    // No Main Bot, no group admin: the team write is not this Bot's to make.
    isMain: () => false, isBotSession: () => true, chatOf: botId => `chat-${botId}`, groupSessionsOf: () => [],
    sessionsOfBot: () => ['sA'],
    chatOwners: new Map([['sA', 'b2']]), groupOwners: new Map(), pastOwners: new Map(),
    roomOf: () => undefined, partsOf: id => [{ sessionId: id }],
    clock: () => '12:00', teamFolder: () => join(work, 'team'),
    sessionFolder: session => sessions[session?.id ?? session]?.header?.cwd,
    desiredModel: async () => undefined, defaultModel: async () => 'deepseek/v4',
    async* eventsBackwards() { /* no saved history in this fixture */ },
    async* partLines() { yield { who: 'user', text: 'Tell the team to ship on Friday.', seq: 10 } },
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream() {
        const reply = replies.shift()
        yield { type: 'text-delta', index: 0, text: reply ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  installProjectScope(rt)
  installMemory(rt)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  ctx.emit('agent/status', { agent: { id: 'sA', session: sessions.sA }, status: 'idle' })
  for (let tries = 0; tries < 200 && rt.memoryReviews() > 0; tries += 1) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rt.memoryReviews(), 0, 'the review finished')
  // Neither the team memory nor the Bot's own was written.
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2')), false)
  assert.equal(existsSync(join(home, 'memory', 'team')), false)
  const records = readFileSync(join(home, 'memory', 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const skipped = records.find(record => record.reason === 'team-write-denied')
  assert.equal(skipped.op, 'skip')
  assert.equal(skipped.scope, 'team')
  assert.equal(skipped.after, 'Ship on Friday')
})
