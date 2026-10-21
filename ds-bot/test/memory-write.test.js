// writeTextTo, the atomic write behind every memory file: the temp file must never
// survive a failed write, and the retry the code promises must really happen. Fault
// injection runs at the module boundary (node:test mock.module over node:fs/promises,
// which needs --experimental-test-module-mocks), so the product code stays untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock } from 'node:test'
import { writeTextTo } from '../src/host/memory.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'ep0-write-'))

test('writeTextTo is exported for this contract', () => {
  assert.equal(typeof writeTextTo, 'function')
})

test('a good write lands and leaves no temp file', async () => {
  const dir = tempDir()
  const target = join(dir, 'MEMORY.md')
  writeFileSync(target, 'before', 'utf8')
  await writeTextTo(target, 'after')
  assert.equal(readFileSync(target, 'utf8'), 'after')
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0, 'no temp file left after a good write')
})

test('a rename that keeps failing retries once, cleans the temp file and reports the failure', async () => {
  const dir = tempDir()
  const warnings = []
  const target = join(dir, 'MEMORY.md')
  // A directory where the target should be: every rename onto it fails (EISDIR/EPERM),
  // and the failure is not transient — the retry cannot land either.
  mkdirSync(target)
  await assert.rejects(writeTextTo(target, 'x', (...args) => warnings.push(args[0])), /MEMORY\.md/)
  const left = readdirSync(dir).filter(name => name.endsWith('.tmp'))
  assert.equal(left.length, 0, `the temp file must be cleaned up, left: ${left.join(', ')}`)
  assert.ok(warnings.length >= 1 && /atomic write/.test(String(warnings[0])), `a warning names the failed write: ${JSON.stringify(warnings)}`)
})

// ---------------------------------------------------------------------------
// Fault injection at the module boundary. Each scenario re-imports memory.js with a
// query so it sees the mocked node:fs/promises of that scenario only. The transient
// refusal-then-retry-lands path needs a live file system race, so it is verified on
// the bench machine (issue #20); here the steady failures are pinned.

const inject = async (name, { failWrite = false, failRename = false } = {}) => {
  const dir = tempDir()
  const target = join(dir, 'MEMORY.md')
  const before = '# Memory\n\n- an entry that must survive\n'
  writeFileSync(target, before, 'utf8')
  const actual = await import('node:fs/promises')
  const calls = { writeFile: 0, rename: 0, unlink: 0 }
  mock.module('node:fs/promises', {
    namedExports: {
      ...actual,
      writeFile: async (...args) => {
        calls.writeFile++
        if (!failWrite) return actual.writeFile(...args)
        // A half write: the temp file exists with a partial body, then the write fails.
        await actual.writeFile(args[0], String(args[1]).slice(0, 5), 'utf8')
        const error = new Error('EIO: injected half write')
        error.code = 'EIO'
        throw error
      },
      rename: async (...args) => {
        calls.rename++
        if (!failRename) return actual.rename(...args)
        const error = new Error('EPERM: injected rename refusal')
        error.code = 'EPERM'
        throw error
      },
      unlink: async (...args) => { calls.unlink++; return actual.unlink(...args) },
    },
  })
  const memoryUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'host', 'memory.js')).href
  const { writeTextTo: injected } = await import(`${memoryUrl}?scenario=${name}`)
  let threw
  const warnings = []
  try {
    await injected(target, '# Memory\n\n- a new entry\n', (...args) => warnings.push(args[0]))
  } catch (error) {
    threw = error?.code ?? String(error)
  }
  const leftovers = readdirSync(dir).filter(file => file.endsWith('.tmp'))
  const targetUnchanged = readFileSync(target, 'utf8') === before
  mock.reset()
  return { calls, threw, leftovers, targetUnchanged, warnings }
}

test('a steady rename refusal is retried exactly once (two rename calls)', async () => {
  const { calls, threw, leftovers, targetUnchanged } = await inject('retry-count', { failRename: true })
  assert.equal(threw, 'EPERM', 'the original refusal is reported')
  assert.equal(calls.rename, 2, `the retry must really happen: rename calls=${calls.rename}`)
  assert.equal(calls.writeFile, 1)
  assert.equal(leftovers.length, 0, `no temp file left, found: ${leftovers.join(', ')}`)
  assert.ok(targetUnchanged, 'the target was never replaced')
})

test('a writeFile that fails half way leaves no temp file behind', async () => {
  const { threw, leftovers, targetUnchanged, warnings } = await inject('half-write', { failWrite: true })
  assert.equal(threw, 'EIO', 'the write failure is reported')
  assert.equal(leftovers.length, 0, `the half-written temp file must be cleaned up, left: ${leftovers.join(', ')}`)
  assert.ok(targetUnchanged, 'the target was never replaced')
  assert.ok(warnings.some(line => /atomic write/.test(String(line))), `a warning names the failed write: ${JSON.stringify(warnings)}`)
})
