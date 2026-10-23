// Acceptance skeletons for the memory redesign (issue #55). Each group mirrors one
// row of the acceptance checklist in docs/plans/2026-10-22-memory-isolation-retrieval-review.md
// (§7, final design).
//
// #52 project-scope, #53 memory-index and #54 task-review have all landed, so no group
// below is waiting for a module. Each is skipped for a reason this fixture cannot reach,
// and none of them counts as passed:
//   cache      — needs a session switch (A -> B -> A) and an expiry clock; only a real
//                Session timeline produces that order.
//   acceptance — judges a whole review run end to end; the cloud bench drives it with the
//                mock model, so it is an acceptance-stage check, not a unit case.
//   waiting    — needs a turn held pending across a segment switch and a restart; there is
//                no hook to hold a turn open here.
//   recovery   — needs a crash injected between writes; the product has no crash hook, so
//                these stay implementation-stage checks. The file layout and the
//                DONE/APPLYING semantics they describe are asserted by the task-review tests.
//   limits     — needs a batch budget and retry backoff observed across review rounds; that
//                is a bench-scale run.
// The design's §7 mapping lists where each row is covered instead.
// All fixtures use temp dirs under os.tmpdir() (prefix .dsh-test-memory-), the mock
// model only, and never the real DSH_HOME.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'

// --- scope: real assertions over the merged #52 (design §7 rows not covered by
// test/memory-project.test.js: the panel write path, the project list of a Bot,
// and the never-fall-back-to-own rule at the tool and panel entries). The fixture
// mirrors memory-project.test.js: two .git folders are two projects, a folder
// that no longer exists makes its session's project unresolved.
import { fakeContext } from './fake-ctx.js'
import { install as installProjectScope } from '../src/host/project-scope.js'
import { install as installMemory } from '../src/host/memory.js'

const scopeWork = mkdtempSync(join(tmpdir(), '.dsh-test-memory-scope-'))
const projectA = join(scopeWork, 'alpha')
const projectB = join(scopeWork, 'beta')
mkdirSync(join(projectA, '.git'), { recursive: true })
mkdirSync(join(projectB, '.git'), { recursive: true })
// A .git pointer to nowhere: the session's project is unresolved, not absent.
mkdirSync(join(scopeWork, 'broken'))
writeFileSync(join(scopeWork, 'broken', '.git'), 'gitdir: ../nowhere\n')
const scopeSessions = {
  sA: { id: 'sA', header: { cwd: projectA } },
  sB: { id: 'sB', header: { cwd: projectB } },
  sLost: { id: 'sLost', header: { cwd: join(scopeWork, 'gone', 'x') } },
}
const scopeBots = { b2: { id: 'b2', name: 'Writer' }, b3: { id: 'b3', name: 'Reader' } }

function startScoped(t, replies = []) {
  const ctx = fakeContext()
  // The panel ask path calls the model once; a canned reply drives it, the way
  // test/memory.test.js fakes llm.stream for its panel tests.
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream() {
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        yield { type: 'text-delta', index: 0, text: reply ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const home = mkdtempSync(join(tmpdir(), '.dsh-test-memory-rt-'))
  const rt = {
    ctx, home, config: { memoryReview: false }, state: { rooms: {} },
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    desiredModel: async () => undefined, defaultModel: async () => 'deepseek/v4',
    botOf: id => scopeBots[id], findBot: name => Object.values(scopeBots).find(bot => bot.name === name),
    selfOf: id => (id === 'sB' ? 'b3' : 'b2'), isMain: () => false,
    chatOf: botId => `chat-${botId}`, groupSessionsOf: () => [],
    sessionsOfBot: () => ['sA', 'sLost'],
    groupOwners: new Map(), roomOf: () => undefined, partsOf: id => [{ sessionId: id }],
    clock: () => '12:00', teamFolder: () => join(scopeWork, 'team'),
    sessionFolder: session => scopeSessions[session?.id ?? session]?.header?.cwd,
    async* eventsBackwards() {},
  }
  installProjectScope(rt)
  installMemory(rt)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  return {
    home, rt,
    tool: (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId, session: scopeSessions[sessionId] } }),
    endpoint: (endpoint, body) => rt.memoryEndpoint(endpoint, body),
    read: (...path) => readFileSync(join(home, 'memory', ...path), 'utf8'),
  }
}

test('scope: the panel writes a project entry only through a session that works in it', async t => {
  const answer = '```json\n{"reply": "Saved.", "changes": [{"op": "add", "text": "Alpha deploys with a script"}]}\n```'
  const s = startScoped(t, [answer])
  await s.endpoint('memory-ask', { botId: 'b2', session: 'sA', scope: 'project', op: 'add', text: 'Add: Alpha deploys with a script' })
  const alpha = s.rt.projectScope.resolve(scopeSessions.sA)
  assert.match(s.read('projects', alpha.hash, 'MEMORY.md'), /Alpha deploys with a script/)
  // A foreign session is not a way into another Bot's project.
  await assert.rejects(() => s.endpoint('memory-ask', { botId: 'b2', session: 'sB', scope: 'project', op: 'add', text: 'Nope' }), /does not belong to this Bot/)
})

test('scope: an unresolved project never falls back to own, tool or panel', async t => {
  const s = startScoped(t)
  assert.match(await s.tool('remember', { text: 'Anything' }, 'sLost'), /Cannot tell which project/)
  await assert.rejects(() => s.endpoint('memory-ask', { botId: 'b2', session: 'sLost', scope: 'project', op: 'add', text: 'Anything' }), /cannot be told apart/)
  assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
})

test('scope: the panel project list is server-computed from the Bot\'s own sessions', async t => {
  const s = startScoped(t)
  const view = await s.endpoint('memory-view', { botId: 'b2', session: 'sA' })
  const alpha = s.rt.projectScope.resolve(scopeSessions.sA)
  // The host names each project; the panel shows that name and never derives one (#61).
  assert.deepEqual(view.projects, [{ hash: alpha.hash, root: alpha.root, session: 'sA', name: 'alpha' }])
  // sLost resolves to nothing, so it never appears as a project choice.
})

// The summary side of the same fixture (#71): the canned model records every request it
// answers, `uiLanguage` is fixed so the fingerprint's language term is stable, and a
// project's memory file can be seeded directly. A project's entries belong in the
// summary request, and a cache written by an older request must not keep serving a
// summary that lacks them.
function startSummaryBench(t, replies = [], { oneBot = false } = {}) {
  const ctx = fakeContext()
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream(request) {
        requests.push(request)
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        yield { type: 'text-delta', index: 0, text: reply ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const home = mkdtempSync(join(tmpdir(), '.dsh-test-memory-sum-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const rt = {
    ctx, home, config: { memoryReview: false }, state: { rooms: {} },
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    desiredModel: async () => undefined, defaultModel: async () => 'deepseek/v4',
    botOf: id => scopeBots[id], findBot: name => Object.values(scopeBots).find(bot => bot.name === name),
    selfOf: id => (oneBot || id !== 'sB' ? 'b2' : 'b3'), isMain: () => false,
    chatOf: botId => `chat-${botId}`, groupSessionsOf: () => [],
    sessionsOfBot: id => (id === 'b3' && !oneBot ? ['sB'] : ['sA', ...(oneBot ? ['sB'] : []), 'sLost']),
    groupOwners: new Map(), roomOf: () => undefined, partsOf: id => [{ sessionId: id }],
    clock: () => '12:00', teamFolder: () => join(scopeWork, 'team'),
    sessionFolder: session => scopeSessions[session?.id ?? session]?.header?.cwd,
    uiLanguage: () => 'Chinese',
    async* eventsBackwards() {},
  }
  installProjectScope(rt)
  installMemory(rt)
  return {
    home, rt, requests,
    endpoint: (endpoint, body) => rt.memoryEndpoint(endpoint, body),
    text: () => String(requests.at(-1)?.messages?.[0]?.content?.[0]?.text ?? ''),
    writeEntry: (scope, text) => {
      const dir = join(home, 'memory', 'projects', scope.hash)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'MEMORY.md'), `# Memory\n\n- ${text}\n\n## Index\n`)
    },
    memoryFiles: () => {
      const root = join(home, 'memory', 'projects')
      const listing = {}
      for (const name of existsSync(root) ? readdirSync(root) : []) {
        const file = join(root, name, 'MEMORY.md')
        listing[name] = existsSync(file) ? readFileSync(file, 'utf8') : ''
      }
      return listing
    },
  }
}

const summarySettle = () => new Promise(resolve => setTimeout(resolve, 20))
async function summarized(endpoint, body) {
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await endpoint('memory-view', body)).summarizing === false) return
    await summarySettle()
  }
  throw new Error('the memory summary did not finish')
}

test('scope: the summary request restates the selected project\'s entries, and only that project\'s', async t => {
  const s = startSummaryBench(t, ['## A\nAlpha project.', '## B\nBeta project.'])
  s.writeEntry(s.rt.projectScope.resolve(scopeSessions.sA), 'Alpha deploys with a script')
  s.writeEntry(s.rt.projectScope.resolve(scopeSessions.sB), 'Beta deploys on Fridays')
  await s.endpoint('memory-view', { botId: 'b2', session: 'sA', summarize: true })
  await summarized(s.endpoint, { botId: 'b2', session: 'sA' })
  assert.match(s.text(), /then the project memory of alpha that every Bot working in that project shares/)
  assert.match(s.text(), /## Project memory of alpha\n- Alpha deploys with a script/)
  assert.ok(!s.text().includes('Beta deploys'), "the other project's entries stay out")
  await s.endpoint('memory-view', { botId: 'b3', session: 'sB', summarize: true })
  await summarized(s.endpoint, { botId: 'b3', session: 'sB' })
  assert.match(s.text(), /## Project memory of beta\n- Beta deploys on Fridays/)
  assert.ok(!s.text().includes('Alpha deploys'), "the other project's entries stay out")
})

test('scope: a summary cached by an older fingerprint is rewritten with the project entries, in place', async t => {
  const s = startSummaryBench(t, ['## Overview\nThe alpha project memory is in.'])
  const alpha = s.rt.projectScope.resolve(scopeSessions.sA)
  s.writeEntry(alpha, 'Alpha deploys with a script')
  // The cache an older build left behind: same entries, but the fingerprint of the
  // request that had no project section (no version term, #71).
  const key = `b2|bot:b2,project:${alpha.hash},team`
  const file = join(s.home, 'memory', 'summaries', `b2-${createHash('sha256').update(key).digest('hex').slice(0, 8)}.json`)
  const oldHash = createHash('sha256').update(JSON.stringify(['Chinese', [], [], ['- Alpha deploys with a script']])).digest('hex')
  mkdirSync(join(s.home, 'memory', 'summaries'), { recursive: true })
  writeFileSync(file, JSON.stringify({ hash: oldHash, scopes: key.slice(key.indexOf('|') + 1), text: 'Old summary without the project.', at: 1 }))
  const before = s.memoryFiles()
  const stale = await s.endpoint('memory-view', { botId: 'b2', session: 'sA', summarize: true })
  assert.equal(stale.fresh, false, 'a cache from the older request is not fresh')
  await summarized(s.endpoint, { botId: 'b2', session: 'sA' })
  const done = await s.endpoint('memory-view', { botId: 'b2', session: 'sA' })
  assert.equal(done.fresh, true)
  assert.equal(done.summary.text, '## Overview\nThe alpha project memory is in.')
  assert.match(s.text(), /## Project memory of alpha\n- Alpha deploys with a script/)
  // The old file was replaced in place: still one file under the same name, a new
  // fingerprint inside it, and the memory itself untouched.
  const dir = join(s.home, 'memory', 'summaries')
  assert.deepEqual(readdirSync(dir), [basename(file)])
  assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).hash, oldHash)
  assert.deepEqual(s.memoryFiles(), before)
  // The same input reads the cache now: no further model call.
  assert.equal(s.requests.length, 1)
  await s.endpoint('memory-view', { botId: 'b2', session: 'sA', summarize: true })
  assert.equal(s.requests.length, 1)
})

// One Bot with two projects is the shape the panel really uses: its summary cache
// key carries the project scope, so a summary asked for A, left in flight while the
// panel reads B, comes back as A's — never B's — and A→B→A answers from the cache.
test('scope: one Bot reading two projects keeps each summary to its own project across A to B to A', async t => {
  const replies = []
  const s = startSummaryBench(t, replies, { oneBot: true })
  const alpha = s.rt.projectScope.resolve(scopeSessions.sA)
  const beta = s.rt.projectScope.resolve(scopeSessions.sB)
  s.writeEntry(alpha, 'Alpha deploys with a script')
  s.writeEntry(beta, 'Beta deploys on Fridays')
  // The project-A summary is held until the test releases it, so B is read while A
  // is still being written.
  let releaseA
  const heldA = new Promise(resolve => { releaseA = resolve })
  replies.push(heldA.then(() => '## A\nAlpha project summary.'), '## B\nBeta project summary.')
  const aStart = await s.endpoint('memory-view', { botId: 'b2', session: 'sA', summarize: true })
  assert.equal(aStart.project.hash, alpha.hash)
  assert.ok(aStart.entries.some(entry => entry.scope === 'project' && entry.text === 'Alpha deploys with a script'))
  assert.equal(aStart.summarizing, true)
  await s.endpoint('memory-view', { botId: 'b2', session: 'sB', summarize: true })
  await summarized(s.endpoint, { botId: 'b2', session: 'sB' })
  const bDone = await s.endpoint('memory-view', { botId: 'b2', session: 'sB' })
  assert.equal(bDone.project.hash, beta.hash)
  assert.ok(bDone.entries.some(entry => entry.scope === 'project' && entry.text === 'Beta deploys on Fridays'))
  assert.equal(bDone.fresh, true)
  assert.equal(bDone.summary.text, '## B\nBeta project summary.')
  // A is still in flight, and its pending answer is not B's summary.
  const aMid = await s.endpoint('memory-view', { botId: 'b2', session: 'sA' })
  assert.equal(aMid.project.hash, alpha.hash)
  assert.equal(aMid.summarizing, true)
  releaseA()
  await summarized(s.endpoint, { botId: 'b2', session: 'sA' })
  const aDone = await s.endpoint('memory-view', { botId: 'b2', session: 'sA' })
  assert.equal(aDone.project.hash, alpha.hash)
  assert.equal(aDone.fresh, true)
  assert.equal(aDone.summary.text, '## A\nAlpha project summary.')
  // Two model calls in total, each carrying only its own project's entries.
  assert.equal(s.requests.length, 2)
  assert.match(String(s.requests[0].messages[0].content[0].text), /## Project memory of alpha\n- Alpha deploys with a script/)
  assert.ok(!String(s.requests[0].messages[0].content[0].text).includes('Beta deploys'), "B's entries stayed out of A's request")
  assert.match(String(s.requests[1].messages[0].content[0].text), /## Project memory of beta\n- Beta deploys on Fridays/)
  assert.ok(!String(s.requests[1].messages[0].content[0].text).includes('Alpha deploys'), "A's entries stayed out of B's request")
  // Back on A the cached summary answers: no further model call.
  const again = await s.endpoint('memory-view', { botId: 'b2', session: 'sA', summarize: true })
  assert.equal(again.project.hash, alpha.hash)
  assert.equal(again.fresh, true)
  assert.equal(again.summary.text, '## A\nAlpha project summary.')
  assert.equal(s.requests.length, 2)
})

// The review path over the fixed #52 (d4ca7d9): the architect's regression covers
// the unresolved refusal; this one adds the other side — a review add in a session
// with a healthy project lands in that project, not in the Bot's own memory.
test('scope: the automatic review defaults to project and rejects unresolved', async t => {
  const broken = join(scopeWork, 'broken')
  // The change quotes the user line the fixture yields (#66): a review entry rests on the
  // exact words it came from, so the fixture carries them rather than relying on a looser
  // gate that no longer exists.
  const reply = JSON.stringify({ changes: [{ op: 'add', text: 'The deploy window is 8pm', evidence: 'The deploy window is 8pm.' }] })
  const startReview = (session, modelReplies) => {
    const ctx = fakeContext()
    const home = mkdtempSync(join(tmpdir(), '.dsh-test-memory-rt-'))
    const rt = {
      ctx, home, config: { memoryReviewDelayMs: 0 }, state: { rooms: {} },
      load: async () => {}, readOnly: () => undefined, warn: () => {},
      botOf: id => scopeBots[id], findBot: () => undefined,
      selfOf: () => 'b2', isMain: () => true, isBotSession: () => true,
      chatOf: botId => `chat-${botId}`, groupSessionsOf: () => [],
      sessionsOfBot: () => [session.id],
      chatOwners: new Map([[session.id, 'b2']]), groupOwners: new Map(), pastOwners: new Map(),
      roomOf: () => undefined, partsOf: id => [{ sessionId: id }],
      clock: () => '12:00', teamFolder: () => join(scopeWork, 'team'),
      sessionFolder: s => (s?.id ?? s) === session.id ? session.header.cwd : scopeSessions[s?.id ?? s]?.header?.cwd,
      desiredModel: async () => undefined, defaultModel: async () => 'deepseek/v4',
      async* eventsBackwards() {},
      async* partLines() { yield { who: 'user', text: 'The deploy window is 8pm.', seq: 10 } },
    }
    Object.assign(ctx, {
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
        async* stream(request) {
          // The shared semantic gate (#66) asks its own question once per review, so it must
          // not consume the review replies. Every change here quotes the real user line the
          // fixture yields, so a canned 'yes' per entry is the honest answer.
          if (String(request?.system ?? '').startsWith('You check whether')) {
            const body = [].concat(request?.messages?.at(-1)?.content ?? []).map(part => String(part?.text ?? '')).join('')
            const entries = body.split('\n').filter(line => line.trim().startsWith('{')).length
            yield { type: 'text-delta', index: 0, text: JSON.stringify({ support: Array.from({ length: entries }, () => 'yes') }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          const out = modelReplies.shift()
          yield { type: 'text-delta', index: 0, text: out ?? '' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    })
    installProjectScope(rt)
    installMemory(rt)
    return { ctx, home, rt }
  }

  // Wait for the review to settle on its observable outcome — the memory file (or the
  // journal record) — instead of a fixed sleep: the write lands slightly after the
  // status turns idle, and a fixed 50 ms read races it (seen once as ENOENT).
  const waitFor = async (fn, what) => {
    for (let tries = 0; tries < 200 && !fn(); tries += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(fn(), `the review did not settle: ${what}`)
  }

  // A healthy project session: the review add lands in the project memory.
  {
    const s = startReview(scopeSessions.sA, [reply])
    t.after(async () => { await s.ctx.dispose(); rmSync(s.home, { recursive: true, force: true }) })
    s.ctx.emit('agent/status', { agent: { id: 'sA', session: scopeSessions.sA }, status: 'idle' })
    const alpha = s.rt.projectScope.resolve(scopeSessions.sA)
    await waitFor(() => existsSync(join(s.home, 'memory', 'projects', alpha.hash, 'MEMORY.md')), 'the project entry never landed')
    assert.match(readFileSync(join(s.home, 'memory', 'projects', alpha.hash, 'MEMORY.md'), 'utf8'), /The deploy window is 8pm/)
    assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2')), false)
  }
  // A broken gitdir session: the same add is skipped and journaled, own stays empty.
  {
    const brokenSession = { id: 'sBroken', header: { cwd: broken } }
    const s = startReview(brokenSession, [reply])
    t.after(async () => { await s.ctx.dispose(); rmSync(s.home, { recursive: true, force: true }) })
    s.ctx.emit('agent/status', { agent: { id: 'sBroken', session: brokenSession }, status: 'idle' })
    await waitFor(() => existsSync(join(s.home, 'memory', 'journal.jsonl')) && /project-unresolved/.test(readFileSync(join(s.home, 'memory', 'journal.jsonl'), 'utf8')), 'the skip was never journaled')
    assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2')), false)
    const log = readFileSync(join(s.home, 'memory', 'journal.jsonl'), 'utf8')
    assert.match(log, /"reason":"project-unresolved"/)
    assert.match(log, /The deploy window is 8pm/)
  }
  // An explicit team add by a Bot that may not write the team is refused — skipped
  // and journaled, never redirected to own or project (fix 5542df2, final ruling:
  // the refusal stays; the revert episode is recorded in the branch history).
  {
    const teamReply = JSON.stringify({ changes: [{ op: 'add', text: 'Ship on Friday', team: true }] })
    const s = startReview(scopeSessions.sA, [teamReply])
    s.rt.isMain = () => false
    t.after(async () => { await s.ctx.dispose(); rmSync(s.home, { recursive: true, force: true }) })
    s.ctx.emit('agent/status', { agent: { id: 'sA', session: scopeSessions.sA }, status: 'idle' })
    await waitFor(() => existsSync(join(s.home, 'memory', 'journal.jsonl')) && /Ship on Friday/.test(readFileSync(join(s.home, 'memory', 'journal.jsonl'), 'utf8')), 'the refusal was never journaled')
    assert.equal(existsSync(join(s.home, 'memory', 'team')), false, 'team not written')
    assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2')), false, 'own not written')
    const alpha = s.rt.projectScope.resolve(scopeSessions.sA)
    assert.equal(existsSync(join(s.home, 'memory', 'projects', alpha.hash)), false, 'project not the fallback either')
    const log = readFileSync(join(s.home, 'memory', 'journal.jsonl'), 'utf8')
    assert.match(log, /"reason":"team-write-denied"/)
    assert.match(log, /Ship on Friday/)
  }
})

// --- caches (skipped: needs a session switch and an expiry clock) ----------------
test.skip('cache: old snapshots invalidate; scope or teamRule change rebuilds', () => {})
test.skip('cache: ordinary content updates stay frozen within a session', () => {})
test.skip('cache: every summary cache is scope-keyed; A->B->A stale reply dropped', () => {})

// --- platform note (CI blind spot): the identity rows about real casing ("the case
// of a folder is the case on disk", two same-name-different-case folders) hold only
// where the file system reports the creation case — Windows with 8.3 expansion and
// macOS, not Linux CI runners, whose case-insensitive-looking assertions fail (PR #57
// CI, run 39770798812). #52's project-scope tests are being made platform-aware;
// this branch's acceptance runs on Windows native only, so the casing rows are marked
// here rather than silently green.

// --- retrieval & consistency: every row is asserted by test/memory-index.test.js
// (#53, merged here), plus these mapping notes: empty-query listing and whole-topic
// reads are unchanged recall behavior with coverage in test/memory.test.js; mixed
// zh 1–2/3+ char queries map to the short-Chinese LIKE and long-term MATCH cases.
// (#53, merged here): whitelist before LIMIT, all-terms first, literal quotes/%/_/\,
// short-Chinese LIKE fallback, disappeared/edited files reindexed by content (same
// size+mtime included — the freshness key is the content hash), deleted index rebuilt,
// failed refresh publishes nothing, dead-scope cleanup, no-SQLite scan fallback, double
// read failure reported. The write-queue serialization of move's two steps is pinned by
// test/memory-read-commit.test.js; recall's empty-query listing and whole-topic reads
// are unchanged pre-existing behavior with their own coverage in test/memory.test.js.

// --- acceptance rules (skipped: judged end to end on the bench) -----------------
test.skip('acceptance: idle/switch/overflow never trigger a review', () => {})
test.skip('acceptance: forged completion, self-reported exit code, green tool wrapper around failed tests are not success', () => {})
test.skip('acceptance: short user confirmation can verify; forged excerpt is rejected', () => {})

// --- permissions: two genuinely uncovered edges of #54's evidence gates, driven the
// way test/task-review-wiring.test.js drives the wiring (fake llm by system prompt).
// The remaining permission rows are covered elsewhere: a changed project drops the
// candidate (task-review.test.js), and secret-shaped values by its dual checks plus
// test/secrets.test.js.
import { apply as applyPlugin } from '../index.js'

const TEAM_TASK = {
  version: 1, mainBotIds: ['m1'], revision: 1, whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}
// b2's own part has a user line only; the evidence lives in another session's log.
const TASK_HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'On it; the run is in progress.' }] } } } },
  ],
  b3: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ran scripts/ship.sh; the suite passed: tests 12/12.' }] } } } },
  ],
}
function startTask({ items = [], support = [], cwd } = {}) {
  const home = mkdtempSync(join(tmpdir(), '.dsh-test-memory-task-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM_TASK))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream(request) {
        const system = String(request.system ?? '')
        let reply = ''
        if (system.startsWith('You keep the long-term memory')) reply = '{"changes":[]}'
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items })
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support })
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (TASK_HISTORY[sessionId] ?? [{ event: { seq: 1 } }]).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq }) => ({ records: (TASK_HISTORY[address.sessionId] ?? []).filter(r => beforeSeq === undefined || r.event.seq < beforeSeq), hasMore: false }),
    },
    sessions: { messageProjections: [], get: id => (cwd === undefined ? undefined : { id, header: { cwd } }) },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  applyPlugin(ctx, { home, memoryReviewDelayMs: 0 })
  const plans = () => (existsSync(join(home, 'memory', 'task-plans'))
    ? readdirSync(join(home, 'memory', 'task-plans')).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(home, 'memory', 'task-plans', n), 'utf8')))
    : [])
  return {
    ctx, home, plans,
    tool: (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId }),
    stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) },
  }
}
const settleTask = () => new Promise(r => setTimeout(r, 20))
async function untilTask(check) {
  for (let tries = 0; tries < 300 && !check(); tries += 1) await settleTask()
  assert.ok(check(), 'the condition did not hold within 6 s')
}
const TASK_CLAIM = { kind: 'command', statement: '发布脚本跑通', evidence: 'tests 12/12', ref: 'part 1 #11' }

test('permissions: evidence that exists only in another session\'s log is refused', async t => {
  const s = startTask({ items: [{ claim: 0, topic: '', text: '借来的证据', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  await s.tool('complete_task', { result: 'done', claims: [TASK_CLAIM] }, 'cross-1')
  s.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await untilTask(() => s.plans().length === 1)
  await untilTask(() => s.plans()[0].status === 'HELD')
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
  assert.equal(existsSync(join(s.home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
})

test('permissions: a junction inside the folder that leads outside is refused', async t => {
  const repo = mkdtempSync(join(tmpdir(), '.dsh-test-memory-jct-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 5 }) })
  const work = join(repo, 'work')
  const outside = join(repo, 'elsewhere')
  mkdirSync(work, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(outside, 'notes.txt'), 'the suite passed: tests 12/12')
  // A link named inside the working folder that points outside it. Node can make both
  // kinds itself, so the case needs no shell: a directory junction on Windows, a
  // directory symlink elsewhere. Both are the same escape once the real path resolves,
  // so the assertions below are about the rule, not the platform's flavour of link.
  const junction = join(work, 'link')
  symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
  const s = startTask({ cwd: work, items: [{ claim: 0, topic: '', text: '穿链接的证据', outcome: 'verified' }], support: ['yes'] })
  t.after(() => s.stop())
  const claim = { kind: 'file', statement: '测试通过', evidence: 'tests 12/12', ref: 'link/notes.txt' }
  await s.tool('complete_task', { result: 'done', claims: [claim] }, 'jct-1')
  s.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await untilTask(() => s.plans().length === 1)
  await untilTask(() => s.plans()[0].status === 'HELD')
  assert.equal(s.plans()[0].unverified[0].reason, 'evidence-unsupported')
  assert.equal(existsSync(join(s.home, 'memory', 'projects')), false, 'nothing written anywhere')
})

// --- waiting (skipped: needs a turn held across a segment switch) ---------------
test.skip('waiting: related work/question pending waits; other groups never block', () => {})
test.skip('waiting: question survives a segment switch; restart recovers plan-less candidates', () => {})
test.skip('waiting: memoryReview:false skips review; no evidence means no extra model calls', () => {})

// --- recovery (skipped: needs a crash hook the product does not have) -----------
test.skip('recovery: kill after candidate persisted replays; fixed plan is never re-extracted', () => {})
test.skip('recovery: meta/by/added never drift across an overnight restart', () => {})
test.skip('recovery: dual length/secret checks at plan-write and apply', () => {})
test.skip('recovery: kill around every write; same id written exactly once', () => {})
test.skip('recovery: changed:false finishes and records the actual file; deleted entries never revive', () => {})
test.skip('recovery: manual conflict never overwritten; corrupt plan quarantined, others continue', () => {})
test.skip('recovery: memory/full pauses without spending retry budget', () => {})

// --- limits (skipped: needs a multi-round bench budget) -------------------------
test.skip('limits: 8 claims cap, input caps, batch budget, format-retry and I/O backoff caps', () => {})
test.skip('limits: a repeated model call with a new callId does not pass as the same candidate', () => {})
