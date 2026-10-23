// #55: the dual check. A plan is checked when it is frozen and checked again on the way
// to the file, because the plan file is plain JSON a person can edit in between. The
// freeze half is pinned in task-review.test.js; this pins the apply half at the real host
// entry, where `memory.js` re-runs the memory module's own limits before it writes.
//
// The window is made real rather than simulated: a one-shot EIO stops the first apply
// after the plan is frozen, the plan file is edited the way a person would, and the
// candidate's own backoff then walks into the apply-side check.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { candidateIdOf } from '../src/host/task-review.js'

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1, whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}
const HISTORY = {
  b2: [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please run the release script now.' }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'On it — running the release script.' }] } } } },
  ],
}

// The entry limit the memory module itself applies, and a key shape it refuses. Both are
// what `entryProblem` / `secretEntry` read on the apply path.
const TOO_LONG = '长'.repeat(400)
const A_KEY = 'ghp_abcdefghijklmnopqrstuvwxyz12'

test('a plan edited after the freeze is checked again at apply, and a refusal stops it', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-apply-check-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
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
        else if (system.startsWith('You turn a reported finished task')) reply = JSON.stringify({ items: [{ claim: 0, topic: '', text: '发布用脚本发布', outcome: 'verified' }] })
        else if (system.startsWith('You check whether')) reply = JSON.stringify({ support: ['yes'] })
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 12 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq }) => ({ records: HISTORY[address.sessionId].filter(r => beforeSeq === undefined || r.event.seq < beforeSeq), hasMore: false }),
    },
    sessions: { messageProjections: [], get: () => undefined },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  // The first temp write of an entry under the Bot's own memory fails once per candidate:
  // the plan is frozen by then, so each candidate is left waiting with its plan on disk.
  const fs = await import('node:fs/promises')
  let faultsLeft = 2
  const patchedModule = {
    ...fs,
    writeFile: async (...args) => {
      if (faultsLeft > 0 && String(args[0]).endsWith('.tmp') && String(args[0]).includes(join('memory', 'bots'))) {
        faultsLeft -= 1
        throw Object.assign(new Error('EIO (injected)'), { code: 'EIO' })
      }
      return fs.writeFile(...args)
    },
  }
  t.mock.module('node:fs/promises', { namedExports: patchedModule })
  const { apply } = await import('../index.js')
  apply(ctx, { home, memoryReviewDelayMs: 0 })
  t.after(() => ctx.dispose())
  const tool = (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId })
  const planDir = join(home, 'memory', 'task-plans')
  // Two candidates live in this run, so the file is named by the candidate, not by being
  // the only one in the folder.
  const planFileOf = callId => join(planDir, `${candidateIdOf('b2', callId)}.json`)
  const memoryFile = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
  const readPlan = callId => JSON.parse(readFileSync(planFileOf(callId), 'utf8'))
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))
  // A wait that only polls says nothing when it runs out: the next assertion then blames
  // the state it wanted, not the wait that never got there. On a slow CI machine this read
  // as "the plan is not APPLYING" when the truth was "5 s was not enough" (#98).
  const until = async (check, describe) => {
    for (let tries = 0; tries < 100 && !check(); tries += 1) await settle()
    assert.ok(check(), `did not reach the expected state within 5 s; it is ${describe()}`)
  }

  // Freeze the plan, stop the first apply, edit the plan, let the backoff walk into the
  // apply-side check, and hand back what the record says afterwards.
  const stoppedByEdit = async (callId, edit) => {
    await tool('complete_task', { result: 'done', claims: [{ kind: 'user', statement: '发布前先跑发布脚本', evidence: 'Please run the release script now.', ref: 'part 1 #10' }] }, callId)
    ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
    const read = () => { try { return readPlan(callId) } catch { return {} } }
    const say = () => `status=${read().status} retry=${read().retry}`
    await until(() => read().status === 'APPLYING' && read().retry === 1, say)
    const waiting = read()
    assert.equal(waiting.status, 'APPLYING', 'the plan is frozen and the first apply failed transiently')
    assert.equal(waiting.plan.items.length, 1, 'the plan holds the lesson')
    assert.equal(existsSync(memoryFile), false, 'nothing was written yet')
    const edited = structuredClone(waiting)
    edit(edited)
    writeFileSync(planFileOf(callId), `${JSON.stringify(edited, null, 2)}\n`, 'utf8')
    await until(() => read().status === 'CONFLICT', say)
    return read()
  }

  const tooLong = await stoppedByEdit('apply-check-limit', plan => { plan.plan.items[0].text = TOO_LONG })
  assert.equal(tooLong.status, 'CONFLICT', 'a permanent refusal stops the candidate for a person')
  assert.equal(tooLong.progress.conflicts.at(-1).reason, 'invalid-at-apply')
  assert.match(String(tooLong.progress.conflicts.at(-1).problem ?? ''), /at most 300 characters/)
  assert.equal(tooLong.retry, 1, 'the apply-side check spends no retry of its own')
  assert.equal(existsSync(memoryFile), false, 'nothing reached the memory file')

  const withKey = await stoppedByEdit('apply-check-secret', plan => { plan.plan.items[0].meta = { ...plan.plan.items[0].meta, source: A_KEY } })
  assert.equal(withKey.status, 'CONFLICT', 'a secret is a person\'s conflict, not a retry')
  assert.equal(withKey.progress.conflicts.at(-1).reason, 'invalid-at-apply')
  assert.match(String(withKey.progress.conflicts.at(-1).problem ?? ''), /secret/i)
  assert.equal(withKey.retry, 1, 'the apply-side check spends no retry of its own')
  assert.equal(existsSync(memoryFile), false, 'nothing reached the memory file')
})
