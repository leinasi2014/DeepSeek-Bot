// writeTextTo, the atomic write behind every memory file: what happens when the rename
// is refused. On Windows the rename can fail with EPERM while the target was just
// created by another process (issue #20: measured on the bench machine — the refusal is
// transient, an immediate retry lands, and no process holds the file once observed).
// Duties under test: retry once; when the rename still fails, clean the temp file up
// and report the failure. The transient-then-lands path needs a live file system race,
// so it is verified on the bench machine; here the steady failure is pinned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('a rename that keeps failing retries, cleans the temp file and reports the failure', async () => {
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
