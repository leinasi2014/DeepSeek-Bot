// #67: the bounded wake at the real host entry. A candidate whose apply failed once
// is retried when its backoff expires — with no further idle, no further message, no
// external process call: the timer the memory module armed does it, through the same
// pass every other wake uses. The failure is a one-shot EIO injected into the memory
// queue's rename, the exact write the apply performs; the fault clears itself, so the
// second attempt lands.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fakeContext } from './fake-ctx.js'

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

test('a backed-off apply retries itself when its wait expires, with no new idle', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-autowake-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
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
  // Patch the queue's fs before the plugin loads: the first temp write of the entry
  // under the Bot's own memory fails once (writeTextTo retries the rename itself, so
  // the fault goes into the temp write, which has no such retry).
  const fs = await import('node:fs/promises')
  let tempWritesLeft = 1
  let patched = true
  const patchedModule = {
    ...fs,
    writeFile: async (...args) => {
      if (patched && tempWritesLeft > 0 && String(args[0]).endsWith('.tmp') && String(args[0]).includes(join('memory', 'bots'))) {
        tempWritesLeft -= 1
        throw Object.assign(new Error('EIO (injected)'), { code: 'EIO' })
      }
      return fs.writeFile(...args)
    },
  }
  t.mock.module('node:fs/promises', { namedExports: patchedModule })
  const { apply } = await import('../index.js')
  apply(ctx, { home, memoryReviewDelayMs: 0 })
  const tool = (name, args, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'b2' }, callId })
  const planDir = join(home, 'memory', 'task-plans')
  const planFile = () => join(planDir, readdirSync(planDir).find(n => n.endsWith('.json')))
  const memoryFile = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')

  // Exactly one idle: the report turn ends, the first apply fails with EIO. The claim
  // is the user's own line 10, verbatim — a real user preference, not a self-report.
  await tool('complete_task', { result: 'done', claims: [{ kind: 'user', statement: '发布前先跑发布脚本', evidence: 'Please run the release script now.', ref: 'part 1 #10' }] }, 'autowake-1')
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))
  for (let i = 0; i < 100; i++) {
    const record = JSON.parse(readFileSync(planFile(), 'utf8'))
    if (record.status === 'APPLYING' && record.retry === 1) break
    await settle()
  }
  const failed = JSON.parse(readFileSync(planFile(), 'utf8'))
  assert.equal(failed.status, 'APPLYING', 'the first apply failed transiently')
  assert.equal(failed.retry, 1)
  assert.ok(failed.retryAt !== undefined, 'the wait is on the record')
  assert.equal(existsSync(memoryFile), false, 'nothing landed yet')
  patched = false // the fault clears itself

  // No further idle, no further message, no external process: the timer does it.
  // The first backoff is one second; allow five for slow machines.
  const done = () => JSON.parse(readFileSync(planFile(), 'utf8')).status === 'DONE'
  for (let i = 0; i < 100 && !done(); i += 1) await settle()
  assert.ok(done(), 'the candidate finished by itself when its wait expired')
  const record = JSON.parse(readFileSync(planFile(), 'utf8'))
  assert.equal(record.retry, 1, 'the retried apply succeeded on its second attempt')
  assert.match(readFileSync(memoryFile, 'utf8'), /发布用脚本发布/)
  // One extraction for the whole life of the candidate, wake included.
  assert.equal(requests.filter(r => String(r.system).startsWith('You turn a reported')).length, 1)
  await ctx.dispose()
})
