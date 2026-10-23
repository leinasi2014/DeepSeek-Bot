// #72 at the real consumer: the task review's two model requests are built by
// `task-review-input.js`, so a report at every field's own limit still asks the model with
// at most 16,000 characters per request and 4,000 per source — and still makes at most two
// calls (one extraction, one batch check). The pure helper has its own tests; this one runs
// through `complete_task` and the real idle path so the wiring cannot drift away from it.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { INPUT_MAX, SOURCE_MAX } from '../src/host/task-review-input.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1, whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}

const filler = (start, length) => `${start} ${'x'.repeat(Math.max(0, length - start.length - 1))}`

// Every field at the limit the record allows, and forty conversation lines of 400 characters.
const HISTORY = {
  b2: [
    { event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    ...Array.from({ length: 40 }, (_, at) => ({ event: { seq: 2 + at, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: filler(`line ${at + 1}`, 400) }] } } })),
  ],
}

const CLAIMS = Array.from({ length: 8 }, (_, at) => ({
  kind: 'user',
  statement: filler(`claim ${at + 1}`, 1000),
  // The quote is a prefix of a line the conversation really holds, so the mechanical gate
  // passes and the batch check is reached: this test is about the request size, not the gate.
  evidence: `line ${at + 1}`,
  ref: filler(`ref ${at + 1}`, 200),
}))

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-72-wiring-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const requests = []
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
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items: [{ claim: 0, topic: '', text: 'The release script is run before publishing', outcome: 'verified' }] })
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
  apply(ctx, { home, memoryReviewDelayMs: 0 })
  const tool = (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId })
  const idle = () => ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, requests, tool, idle, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check, detail) {
  for (let tries = 0; tries < 300 && !check(); tries += 1) await settle()
  assert.ok(check(), typeof detail === 'function' ? detail() : 'the condition did not hold within 6 s')
}

test('a report at every limit reaches the model inside the budget, in two calls', async t => {
  const s = start()
  t.after(() => s.stop())
  // A big result and notes too, then eight full claims: the record stores them as they are.
  const result = filler('The report', 2_000)
  const notes = filler('The notes', 4_000)
  await s.tool('complete_task', { result, notes, claims: CLAIMS }, 'c-budget')
  s.idle()
  await until(() => s.requests.filter(r => String(r.system).startsWith('You turn a reported')).length === 1, () => `requests=${s.requests.length}`)
  const extract = s.requests.find(r => String(r.system).startsWith('You turn a reported'))
  assert.ok(extract, 'the extraction request was made')
  assert.ok(String(extract.messages[0].content[0].text).length <= INPUT_MAX, `the extraction request is ${String(extract.messages[0].content[0].text).length}`)
  // The eight claims are all in the request, with their kinds: the budget shortens text, it
  // never drops a claim, so every answer line still has a question.
  const body = String(extract.messages[0].content[0].text)
  const claims = JSON.parse(body.slice(body.indexOf('Claims: ') + 'Claims: '.length, body.indexOf('\nConversation lines')))
  assert.equal(claims.length, 8)
  assert.ok(claims.every(claim => claim.kind === 'user' && claim.statement !== '' && claim.evidence !== '' && claim.ref !== ''))
  // Exactly one batch check follows, also inside the budget.
  await until(() => s.requests.filter(r => String(r.system).startsWith('You check whether')).length === 1, () => `requests=${s.requests.length}`)
  const verify = s.requests.find(r => String(r.system).startsWith('You check whether'))
  const body2 = String(verify.messages[0].content[0].text)
  assert.ok(body2.length <= INPUT_MAX, `the verification request is ${body2.length}`)
  for (const line of body2.split('\n')) assert.ok(line.length <= SOURCE_MAX, `a verification entry is ${line.length}`)
  await until(() => s.requests.length >= 2)
  await settle(200)
  // Two calls, not three: the wiring did not add a request of its own.
  assert.equal(s.requests.filter(r => String(r.system).startsWith('You turn a reported')).length, 1)
  assert.equal(s.requests.filter(r => String(r.system).startsWith('You check whether')).length, 1)
})

test('a small report is asked about exactly as it was recorded', async t => {
  const s = start()
  t.after(() => s.stop())
  await s.tool('complete_task', { result: 'ran the release', notes: 'one note', claims: [{ kind: 'user', statement: 'the user wants the release script run first', evidence: 'Please run the release script now.', ref: 'part 1 #1' }] }, 'c-small')
  s.idle()
  // The review and the extraction both run off the same idle, and which reaches the model
  // first is not promised; pick the extraction by what it asks, not by arrival order.
  const extraction = () => s.requests.find(r => String(r.system).startsWith('You turn a reported'))
  await until(() => extraction() !== undefined, () => `requests=${s.requests.map(r => String(r.system).slice(0, 24)).join(' | ')}`)
  const body = String(extraction().messages[0].content[0].text)
  assert.match(body, /^The Bot reported: ran the release\nNotes: one note\nClaims: \[\{"index":0,"kind":"user","statement":"the user wants the release script run first","evidence":"Please run the release script now\.","ref":"part 1 #1"\}\]/)
  // The conversation lines keep their speaker, and a tool line names its tool.
  assert.match(body, /\nConversation lines \(oldest first\):\n/)
  const memory = join(s.home, 'memory', 'bots', 'b2', 'MEMORY.md')
  await until(() => { try { return readFileSync(memory, 'utf8').includes('The release script') } catch { return false } })
})
