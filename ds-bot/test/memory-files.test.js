import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as actual from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { mock } from 'node:test'
import { memoryFiles } from '../src/host/memory-files.js'
import { writeTextTo } from '../src/host/memory.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-memory-files-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const main = join(dir, 'MEMORY.md')
  const topic = join(dir, 'ops.md')
  const journal = join(dir, 'journal.jsonl')
  writeFileSync(main, '# Memory\n\n- Original fact [added: 2026-01-02]\n\n## Index\n')
  writeFileSync(journal, '{"op":"earlier"}\n')
  return { dir, main, topic, journal, before: readFileSync(main, 'utf8'), log: readFileSync(journal, 'utf8') }
}

const read = path => readFileSync(path, 'utf8')
const noBackups = dir => assert.deepEqual(readdirSync(dir).filter(name => /\.(bak|tmp)$/.test(name)), [])
let scenario = 0
async function injected(t, overrides) {
  const { default: defaultExport, ...namedExports } = actual
  mock.module('node:fs/promises', { defaultExport: { ...defaultExport }, namedExports: { ...namedExports, ...overrides } })
  t.after(() => mock.reset())
  return (await import(`${pathToFileURL(join(import.meta.dirname, '../src/host/memory-files.js')).href}?test=${scenario++}`)).memoryFiles
}

test('a memory change commits its files and one journal record, then removes backups', async t => {
  const f = fixture(t)
  const files = memoryFiles(f.dir, writeTextTo, () => {})
  await files.commit([{ path: f.main, text: 'Updated' }, { path: f.topic, text: 'New topic' }], { op: 'add' })
  assert.equal(read(f.main), 'Updated')
  assert.equal(read(f.topic), 'New topic')
  assert.deepEqual(read(f.journal).trim().split('\n').map(line => JSON.parse(line).op), ['earlier', 'add'])
  noBackups(f.dir)
})

test('a failed backup changes no file, and cleans up the backups already allocated', async t => {
  const f = fixture(t)
  writeFileSync(f.topic, 'Original topic')
  const create = await injected(t, { copyFile: async (from, ...args) => {
    if (from === f.topic) throw Object.assign(new Error('ENOSPC allocating backup'), { code: 'ENOSPC' })
    return actual.copyFile(from, ...args)
  } })
  const files = create(f.dir, writeTextTo, () => {})
  await assert.rejects(files.commit([{ path: f.main, text: 'Changed' }, { path: f.topic, text: 'Changed topic' }], { op: 'add' }), /ENOSPC/)
  assert.equal(read(f.main), f.before)
  assert.equal(read(f.topic), 'Original topic')
  assert.equal(read(f.journal), f.log)
  noBackups(f.dir)
})

test('a failed index write removes a new topic and leaves the entry point and history intact', async t => {
  const f = fixture(t)
  const files = memoryFiles(f.dir, async (path, text) => {
    if (path === f.main) throw Object.assign(new Error('EPERM writing index'), { code: 'EPERM' })
    return writeTextTo(path, text)
  }, () => {})
  await assert.rejects(files.commit([{ path: f.topic, text: 'New topic' }, { path: f.main, text: 'New index' }], { op: 'add' }), /EPERM/)
  assert.equal(existsSync(f.topic), false)
  assert.equal(read(f.main), f.before)
  assert.equal(read(f.journal), f.log)
  noBackups(f.dir)
})

test('a failed append restores replaced and deleted files without allocating another body write', async t => {
  const f = fixture(t)
  writeFileSync(f.topic, 'Original topic [source: original]')
  const create = await injected(t, { open: async (path, flags) => {
    const file = await actual.open(path, flags)
    return { stat: () => file.stat(), truncate: n => file.truncate(n), close: () => file.close(), write: async () => { throw Object.assign(new Error('ENOSPC appending'), { code: 'ENOSPC' }) } }
  } })
  let writes = 0
  const files = create(f.dir, async (...args) => { writes++; return writeTextTo(...args) }, () => {})
  await assert.rejects(files.commit([{ path: f.main, text: 'Changed' }, { path: f.topic, text: null }], { op: 'remove' }), /ENOSPC/)
  assert.equal(writes, 1, 'rollback restores backups by rename, not a fresh allocation')
  assert.equal(read(f.main), f.before)
  assert.equal(read(f.topic), 'Original topic [source: original]')
  assert.equal(read(f.journal), f.log)
  noBackups(f.dir)
})

test('a partial append rolls back only its own bytes, with other journal writers queued behind it', async t => {
  const f = fixture(t)
  let began, resume
  const started = new Promise(resolve => { began = resolve })
  const wait = new Promise(resolve => { resume = resolve })
  const create = await injected(t, { open: async (path, flags) => {
    const file = await actual.open(path, flags)
    return {
      stat: () => file.stat(), truncate: n => file.truncate(n), close: () => file.close(),
      async write(bytes, offset, length, position) {
        if (!bytes.toString().includes('"op":"replace"')) return file.write(bytes, offset, length, position)
        await file.write(bytes, offset, 10, position)
        began()
        await wait
        throw Object.assign(new Error('ENOSPC after partial append'), { code: 'ENOSPC' })
      },
    }
  } })
  const files = create(f.dir, writeTextTo, () => {})
  const changing = files.commit([{ path: f.main, text: 'Changed' }], { op: 'replace' })
  const rejected = assert.rejects(changing, /ENOSPC/)
  await started
  const skipped = files.journal({ op: 'skip', reason: 'invalid-review' })
  resume()
  await rejected
  await skipped
  assert.equal(read(f.main), f.before)
  assert.ok(read(f.journal).startsWith(f.log), `prior journal must survive: ${JSON.stringify(read(f.journal))}`)
  assert.deepEqual(read(f.journal).trim().split('\n').map(line => JSON.parse(line).op), ['earlier', 'skip'])
  noBackups(f.dir)
})

test('short journal writes preserve complete UTF-8 records and their byte positions', async t => {
  const f = fixture(t)
  writeFileSync(f.journal, '{"op":"已有记录"}\n')
  const create = await injected(t, { open: async (path, flags) => {
    const file = await actual.open(path, flags)
    return { stat: () => file.stat(), truncate: n => file.truncate(n), close: () => file.close(), write: (bytes, offset, length, position) => file.write(bytes, offset, Math.min(length, 7), position) }
  } })
  await create(f.dir, writeTextTo, () => {}).journal({ op: 'add', after: '用户喜欢简短回答' })
  assert.deepEqual(read(f.journal).trim().split('\n').map(line => JSON.parse(line).op), ['已有记录', 'add'])
  assert.equal(JSON.parse(read(f.journal).trim().split('\n').at(-1)).after, '用户喜欢简短回答')
})

test('a failed journal rollback reports the original byte length and blocks further appends', async t => {
  const f = fixture(t)
  let writes = 0
  const create = await injected(t, { open: async (path, flags) => {
    const file = await actual.open(path, flags)
    return {
      stat: () => file.stat(), close: () => file.close(), truncate: async () => { throw new Error('EPERM truncating') },
      async write(bytes, offset, _length, position) {
        writes++
        await file.write(bytes, offset, 10, position)
        throw new Error('ENOSPC writing')
      },
    }
  } })
  const files = create(f.dir, writeTextTo, () => {})
  const change = files.commit([{ path: f.main, text: 'Changed' }], { op: 'replace' })
  await assert.rejects(change, error => error.message.includes(f.journal) && error.message.includes(`${Buffer.byteLength(f.log)} bytes`))
  assert.equal(read(f.main), f.before)
  assert.ok(read(f.journal).startsWith(f.log))
  const held = read(f.journal)
  await assert.rejects(files.journal({ op: 'skip' }), /restart DSH/)
  assert.equal(read(f.journal), held)
  assert.equal(writes, 1)
  noBackups(f.dir)
})

test('an unrestorable body keeps its recovery backup and reports its location', async t => {
  const f = fixture(t)
  const create = await injected(t, {
    open: async () => { throw new Error('EPERM opening journal') },
    rename: async () => { throw new Error('EPERM restoring original') },
  })
  const files = create(f.dir, writeTextTo, () => {})
  let failure
  try { await files.commit([{ path: f.main, text: 'Changed' }], { op: 'replace' }) } catch (error) { failure = error }
  const backups = readdirSync(f.dir).filter(name => name.endsWith('.bak'))
  assert.equal(backups.length, 1)
  assert.equal(read(join(f.dir, backups[0])), f.before)
  assert.equal(read(f.main), 'Changed')
  assert.ok(failure.message.includes(join(f.dir, backups[0])))
  assert.match(failure.message, /could not be fully rolled back/)
  assert.equal(files.read(f.main, read), f.before, 'readers retain the last committed contents while recovery is required')
  await assert.rejects(files.commit([{ path: f.main, text: 'Another change' }], { op: 'replace' }), /could not be fully rolled back/)
  assert.equal(read(join(f.dir, backups[0])), f.before, 'a retry must not overwrite the recovery copy')
})

test('a journal close failure does not undo successfully committed files or history', async t => {
  const f = fixture(t)
  const warnings = []
  const create = await injected(t, { open: async (path, flags) => {
    const file = await actual.open(path, flags)
    return { stat: () => file.stat(), truncate: n => file.truncate(n), write: (...args) => file.write(...args), async close() { await file.close(); throw new Error('EIO closing') } }
  } })
  await create(f.dir, writeTextTo, (...args) => warnings.push(args)).commit([{ path: f.main, text: 'Changed' }], { op: 'replace' })
  assert.equal(read(f.main), 'Changed')
  assert.equal(JSON.parse(read(f.journal).trim().split('\n').at(-1)).op, 'replace')
  assert.equal(warnings.length, 1)
  noBackups(f.dir)
})
