// Design §6: a frozen plan survives a process exit, including its author and date.
// The workers run serially against an isolated home. This does not claim support for
// concurrent hosts writing the same data root, power loss, or external file edits.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { mock } from 'node:test'
import { fakeContext } from './fake-ctx.js'

const FIRST_DAY = '2026-10-22T12:00:00.000Z'
const NEXT_DAY = '2026-10-24T12:00:00.000Z'
const USER_WORDS = 'Run scripts/ship.sh before release and publish only after tests pass.'
const LESSON = 'Run scripts/ship.sh and pass tests before release.'
const planOf = home => {
  const dir = join(home, 'memory', 'task-plans')
  const names = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')) : []
  assert.equal(names.length, 1, 'exactly one accepted report remains on disk')
  return JSON.parse(readFileSync(join(dir, names[0]), 'utf8'))
}

async function worker(home, stage, window) {
  const first = stage === 'freeze'
  mock.timers.enable({ apis: ['Date'], now: new Date(first ? FIRST_DAY : NEXT_DAY) })
  const calls = { extract: 0, verify: 0 }
  const fs = await import('node:fs/promises')
  const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
  if (first) {
    mock.module('node:fs/promises', { namedExports: {
      ...fs,
      rename: async (...args) => {
        await fs.rename(...args)
        const path = String(args[1])
        const planned = window === 'plan' && path.includes(join('memory', 'task-plans')) && path.endsWith('.json') && JSON.parse(readFileSync(path, 'utf8')).status === 'PLANNED'
        const body = window === 'body' && path.includes(join('memory', 'projects')) && path.endsWith('release.md')
        if (planned || body) {
          // Stop after the real rename. A parent SIGKILL cannot execute catch/finally
          // rollback and the next host must read the actual partial commit from disk.
          await send({ window, pid: process.pid, calls })
          await new Promise(() => {})
        }
      },
    } })
  }
  const ctx = fakeContext()
  const history = [
    { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: USER_WORDS }] } } },
    { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I will follow this release procedure.' }] } } } },
  ]
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      async* stream(request) {
        const system = String(request.system ?? '')
        let reply = '{"changes":[]}'
        if (system.startsWith('You turn a reported finished task')) {
          calls.extract += 1
          assert.equal(first, true, 'restarting a frozen plan must not extract again')
          reply = JSON.stringify({ items: [{ claim: 0, topic: 'release', text: LESSON, outcome: 'verified' }] })
        } else if (system.startsWith('You check whether')) {
          calls.verify += 1
          assert.equal(first, true, 'restarting a frozen plan must not verify again')
          reply = '{"support":["yes"]}'
        }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 12 } } }),
      selectModel: async () => {},
      page: async ({ beforeSeq }) => ({ records: history.filter(record => beforeSeq === undefined || record.event.seq < beforeSeq), hasMore: false }),
    },
    sessions: { messageProjections: [], get: id => ({ id, header: { cwd: join(home, 'project') } }) },
    workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
  })
  const { createRuntime } = await import('../index.js')
  const rt = createRuntime(ctx, { home, memoryReviewDelayMs: 0, timeZone: 'UTC' })
  await rt.load()
  if (first) {
    await ctx.registeredTools.get('complete_task').execute({
      result: 'Recorded the requested release procedure',
      claims: [{ kind: 'user', statement: USER_WORDS, evidence: USER_WORDS, ref: 'part 1 #10' }],
      notes: '',
    }, { agent: { id: 'writer' }, callId: 'release-report' })
    ctx.emit('agent/status', { agent: { id: 'writer' }, status: 'idle' })
    return
  }
  // Only the startup recovery runs: no idle, retry, or complete_task replay wakes it.
  const deadline = performance.now() + 10_000
  while (planOf(home).status !== 'DONE' && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(planOf(home).status, 'DONE', 'startup recovery finishes the persisted plan')
  await ctx.dispose()
  await send({ pid: process.pid, calls })
  mock.timers.reset()
  process.disconnect()
}

async function runWorker(t, home, stage, window) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = fork(fileURLToPath(import.meta.url), ['--restart-worker', home, stage, window], {
    execArgv: ['--experimental-test-module-mocks', '--import', new URL('./harness-resolve.mjs', import.meta.url).href],
    env, windowsHide: true, silent: true,
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const closed = once(child, 'close')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
  t.after(async () => {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  let reply
  child.on('message', message => {
    reply = message
    if (message.window !== undefined) child.kill('SIGKILL')
  })
  const [code, signal] = await closed
  clearTimeout(timeout)
  assert.ok(reply !== undefined, `worker exited without its result (${code}, ${signal}): ${output}`)
  assert.equal(reply.error, undefined, output || reply.error)
  if (stage === 'freeze') {
    assert.equal(reply.window, window, 'the kill happens at the requested persisted boundary')
    assert.equal(signal, 'SIGKILL', 'the original host was killed rather than disposed gracefully')
  } else assert.equal(code, 0, output)
  return reply
}

if (process.argv[2] === '--restart-worker') {
  worker(...process.argv.slice(3)).catch(error => {
    process.send({ error: error.stack }, () => process.exit(1))
  })
} else {
  for (const window of ['plan', 'body']) {
    test(`a ${window} commit killed before progress recovers across days in fresh hosts`, { timeout: 60_000 }, async t => {
      const home = mkdtempSync(join(tmpdir(), 'ds-bot-review-restart-'))
      t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
      mkdirSync(join(home, 'project', '.git'), { recursive: true })
      const team = {
        version: 1, mainBotIds: ['writer'], revision: 1, whaleStored: true,
        bots: { writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Engineer', model: 'deepseek/v4', instructions: '', createdAt: 1 } },
        rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
      }
      writeFileSync(join(home, 'state.json'), JSON.stringify(team))
      const frozen = await runWorker(t, home, 'freeze', window)
      assert.deepEqual(frozen.calls, { extract: 1, verify: 1 })
      const before = planOf(home)
      assert.equal(before.status, window === 'plan' ? 'PLANNED' : 'APPLYING')
      assert.deepEqual(before.progress.done, [])
      const [item] = before.plan.items
      assert.equal(before.plan.items.length, 1)
      assert.equal(item.meta.added, '2026-10-22')
      assert.equal(item.meta.by, 'Writer')
      assert.equal(item.meta.kind, 'howto')
      assert.equal(item.meta.source, 'part 1 #10')
      assert.equal(item.meta.outcome, 'verified')
      assert.equal(item.meta.evidence, USER_WORDS)
      assert.match(item.scope, /^project:/)
      const project = join(home, 'memory', 'projects', item.scope.slice('project:'.length))
      const topic = join(project, 'release.md')
      const main = join(project, 'MEMORY.md')
      assert.equal(existsSync(topic), window === 'body', 'the body boundary leaves a real committed topic')
      assert.equal(existsSync(main), false, 'the link has not been committed at either kill boundary')
      if (window === 'body') assert.ok(readFileSync(topic, 'utf8').includes(item.line))

      // The source identity and wall date now differ, so recomputing either value at
      // apply would be visible. No candidate or memory file is edited by the test.
      team.bots.writer.name = 'Renamed Writer'
      writeFileSync(join(home, 'state.json'), JSON.stringify(team))
      const resumed = await runWorker(t, home, 'recover', window)
      assert.notEqual(resumed.pid, frozen.pid)
      assert.deepEqual(resumed.calls, { extract: 0, verify: 0 })
      const after = planOf(home)
      assert.deepEqual(after.plan, before.plan, 'scope, topic, text, metadata and exact line remain frozen')
      assert.equal(after.doneAt, NEXT_DAY, 'the new host actually ran with a later clock')
      assert.deepEqual(after.progress.done, [{ reviewId: item.reviewId, file: 'release.md' }])
      assert.equal(after.progress.pending, undefined)
      const { parseMemory, formatEntry } = await import('../src/host/memory.js')
      const body = readFileSync(topic, 'utf8')
      const index = readFileSync(main, 'utf8')
      const entries = parseMemory(body).entries
      assert.equal(entries.length, 1, 'the interrupted write is not duplicated')
      assert.equal(formatEntry(entries[0].text, entries[0].meta), item.line, 'the Markdown preserves every frozen field')
      assert.deepEqual(parseMemory(index).links, ['release'], 'startup repairs the missing link')
      const completed = JSON.stringify(after)
      const restarted = await runWorker(t, home, 'recover', window)
      assert.notEqual(restarted.pid, resumed.pid)
      assert.deepEqual(restarted.calls, { extract: 0, verify: 0 })
      assert.equal(JSON.stringify(planOf(home)), completed, 'a further host leaves DONE progress unchanged')
      assert.equal(readFileSync(topic, 'utf8'), body)
      assert.equal(readFileSync(main, 'utf8'), index)
    })
  }
}
