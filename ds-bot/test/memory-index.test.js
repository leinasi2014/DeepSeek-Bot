import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { memoryIndex, termsOf } from '../src/host/memory-index.js'
import { parseMemory } from '../src/host/memory.js'

// A clean root, closed first and only then removed: an open SQLite file cannot be deleted
// on Windows. node:test runs after-hooks in registration order, so one hook does both.
function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-memory-index-'))
  const closes = []
  t.after(() => {
    for (const close of closes) { try { close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { dir, close: fn => closes.push(fn) }
}

// The files of each scope handed to readScopes, so the module runs without a Session, a
// model, or a real DSH_HOME.
function fixture(t, { root: givenRoot, temp: givenTemp, files, parse = parseMemory } = {}) {
  const temp = givenTemp ?? tempRoot(t)
  const root = givenRoot ?? temp.dir
  const state = { files }
  const warnings = []
  const index = memoryIndex({
    root,
    readScopes: scopes => scopes.filter(scope => state.files[scope] !== undefined).map(scope => ({
      scope,
      files: Object.entries(state.files[scope]).map(([file, content]) => ({ file, topic: file === 'MEMORY.md' ? '' : file.slice(0, -3), content })),
    })),
    parse: content => parse(content),
    runInMemoryQueue: fn => fn(),
    warn: message => warnings.push(String(message)),
  })
  temp.close(() => index.close())
  return {
    root,
    index,
    warnings,
    set: next => { state.files = next },
    scope: (scope, next) => { state.files[scope] = next },
  }
}

const memory = (...lines) => `# Memory\n\n${lines.map(line => `- ${line}`).join('\n')}\n\n## Index\n`
const rows = result => result.rows.map(row => `${row.scope}|${row.file}|${row.text}`)

test('a query is split into at most six deduplicated words', () => {
  assert.deepEqual(termsOf('  Alpha   alpha  Beta  '), ['alpha', 'beta'])
  assert.equal(termsOf('一 二 三 四 五 六 七').length, 6)
  assert.equal(termsOf('x'.repeat(200)).length, 1)
})

test('a long term is matched by the index and a short Chinese term falls back to a literal pass', async t => {
  const f = fixture(t, { files: { 'bot:a': { 'MEMORY.md': memory('项目记忆用 Git 派生 id', '团队部署约定') } } })
  const long = await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '项目记忆' })
  assert.equal(long.ok, true)
  assert.equal(long.degraded, false, 'the index answered, no scan')
  assert.deepEqual(rows(long), ['bot:a|MEMORY.md|项目记忆用 Git 派生 id'])
  // Two characters cannot match a trigram: only the literal pass can find it.
  const short = await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '记忆' })
  assert.deepEqual(rows(short), ['bot:a|MEMORY.md|项目记忆用 Git 派生 id'])
})

test('the scope whitelist filters before the limit', async t => {
  const many = Array.from({ length: 40 }, (_, i) => `部署约定 条目 ${i}`)
  const f = fixture(t, {
    files: {
      'bot:a': { 'MEMORY.md': memory('部署约定 自己的') },
      'project:a': { 'MEMORY.md': memory('部署约定 只在 A 项目') },
      'project:b': { 'MEMORY.md': memory(...many) },
    },
  })
  const onlyA = await f.index.query({ scopes: ['project:a'], ownScope: 'project:a', query: '部署约定', limit: 30 })
  assert.equal(onlyA.rows.length, 1, 'a LIMIT applied before the scope filter would return 30 rows of B')
  assert.equal(onlyA.rows[0].scope, 'project:a')
  // own ranks above project no matter how BM25 scored the two hits.
  const both = await f.index.query({ scopes: ['bot:a', 'project:a', 'project:b'], ownScope: 'bot:a', query: '部署约定', limit: 30 })
  assert.equal(both.rows.length, 30)
  assert.equal(both.rows[0].scope, 'bot:a')
})

test('every word must match first, then the rows with the most words', async t => {
  const f = fixture(t, {
    files: { 'bot:a': { 'MEMORY.md': memory('部署约定 与发布脚本', '部署约定 单独'), 'ops.md': '# ops\n\n- 发布脚本 单独\n' } },
  })
  const all = await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '部署约定 发布脚本' })
  assert.equal(all.matchedAll, true)
  assert.deepEqual(rows(all), ['bot:a|MEMORY.md|部署约定 与发布脚本'])
  const partial = await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '部署约定 不存在词' })
  assert.equal(partial.matchedAll, false)
  assert.deepEqual(partial.rows.map(row => row.text), ['部署约定 与发布脚本', '部署约定 单独'])
})

test('a file that disappears loses its rows, and an edited file is rebuilt from its hash', async t => {
  const f = fixture(t, {
    files: { 'bot:a': { 'MEMORY.md': memory('部署约定 用脚本'), 'ops.md': '# ops\n\n- 旧主题条目\n' } },
  })
  assert.equal((await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '旧主题' })).rows.length, 1)
  // The topic disappeared from the committed view: its rows must go with it.
  f.scope('bot:a', { 'MEMORY.md': memory('部署约定 用脚本') })
  assert.equal((await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '旧主题' })).rows.length, 0)
  // Same length, different words: only a content hash notices (size and mtime would not).
  f.scope('bot:a', { 'MEMORY.md': memory('发布流程 用脚本') })
  assert.equal((await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '部署约定' })).rows.length, 0)
  assert.equal((await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '发布流程' })).rows.length, 1)
})

test('quotes, percent, underscore and backslash are literals, not query syntax', async t => {
  const text = '进度 100%_done "quoted" 与 C:\\temp'
  const f = fixture(t, { files: { 'bot:a': { 'MEMORY.md': memory(text) } } })
  for (const query of ['%_done', '"quoted"', 'C:\\temp']) {
    assert.deepEqual(rows(await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query })), [`bot:a|MEMORY.md|${text}`], query)
  }
  // A short term is a literal substring: `_` must not act as a single-character wildcard.
  f.scope('bot:a', { 'MEMORY.md': memory('a_ 前缀', 'ab 前缀') })
  assert.deepEqual(rows(await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: 'a_' })), ['bot:a|MEMORY.md|a_ 前缀'])
})

test('without SQLite the same snapshot is scanned, and the answer is not empty', async t => {
  // A root that cannot be created as a directory puts the module in scan mode for good.
  const temp = tempRoot(t)
  const root = join(temp.dir, 'not-a-directory')
  writeFileSync(root, 'occupied')
  const files = { 'bot:a': { 'MEMORY.md': memory('项目记忆 一条', '另一条 记忆') } }
  const scan = fixture(t, { root, temp, files })
  const indexed = fixture(t, { files })
  const scanned = await scan.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '记忆' })
  const found = await indexed.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '记忆' })
  assert.equal(scan.index.mode, 'scan')
  assert.equal(scanned.degraded, true)
  assert.equal(scanned.ok, true)
  assert.deepEqual(rows(scanned), rows(found), 'the fallback answers the same query the same way')
  assert.equal(rows(scanned).length, 2)
})

test('a Markdown read that fails twice is reported, never answered with an empty list', async t => {
  const temp = tempRoot(t)
  const index = memoryIndex({
    root: temp.dir,
    readScopes: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
    parse: parseMemory,
    runInMemoryQueue: fn => fn(),
  })
  temp.close(() => index.close())
  const result = await index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '记忆' })
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message), /EACCES/)
})

test('a deleted index file is rebuilt, and the same query answers again', async t => {
  const f = fixture(t, { files: { 'bot:a': { 'MEMORY.md': memory('项目记忆 可重建') } } })
  assert.equal((await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '项目记忆' })).rows.length, 1)
  f.index.close()
  f.index.close()
  rmSync(join(f.root, 'index.sqlite'), { force: true, maxRetries: 10, retryDelay: 50 })
  assert.equal(existsSync(join(f.root, 'index.sqlite')), false)
  assert.equal((await f.index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '项目记忆' })).rows.length, 1)
  assert.equal(f.index.mode, 'index')
})

test('a failed refresh publishes nothing and the recall still answers from the snapshot', async t => {
  const temp = tempRoot(t)
  const files = { 'bot:a': { 'MEMORY.md': memory('项目记忆 一条'), 'ops.md': '# ops\n\n- 坏条目\n' } }
  let broken = true
  const index = memoryIndex({
    root: temp.dir,
    readScopes: scopes => scopes.map(scope => ({
      scope,
      files: Object.entries(files[scope]).map(([file, content]) => ({ file, topic: file === 'MEMORY.md' ? '' : file.slice(0, -3), content })),
    })),
    // The binding fails inside the transaction, after MEMORY.md's rows were inserted.
    parse: content => {
      const parsed = parseMemory(content)
      if (broken && content.includes('坏条目')) return { ...parsed, entries: parsed.entries.map(entry => ({ ...entry, meta: { added: Symbol('bad') } })) }
      return parsed
    },
    runInMemoryQueue: fn => fn(),
    warn: () => {},
  })
  temp.close(() => index.close())
  const first = await index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '项目记忆' })
  assert.equal(first.ok, true)
  assert.equal(first.degraded, true, 'the failed refresh fell back to the snapshot')
  // Nothing from the half-finished refresh may be visible: no rows at all were committed.
  const { DatabaseSync } = await import('node:sqlite')
  const probe = new DatabaseSync(join(temp.dir, 'index.sqlite'))
  temp.close(() => probe.close())
  assert.equal(probe.prepare('SELECT count(*) AS count FROM entries').get().count, 0)
  assert.equal(probe.prepare('SELECT count(*) AS count FROM files').get().count, 0)
  broken = false
  const second = await index.query({ scopes: ['bot:a'], ownScope: 'bot:a', query: '项目记忆' })
  assert.equal(second.degraded, false)
  assert.equal(second.rows.length, 1, 'the retried refresh inserted each row once')
})

test('cleanup drops the rows of deleted Bots and keeps team and project scopes', async t => {
  const temp = tempRoot(t)
  const files = {
    'bot:gone': { 'MEMORY.md': memory('已删 Bot 的记忆') },
    'bot:live': { 'MEMORY.md': memory('在册 Bot 的记忆') },
    team: { 'MEMORY.md': memory('团队记忆') },
    'project:a': { 'MEMORY.md': memory('项目记忆') },
  }
  const index = memoryIndex({
    root: temp.dir,
    readScopes: scopes => scopes.map(scope => ({
      scope,
      files: Object.entries(files[scope]).map(([file, content]) => ({ file, topic: file === 'MEMORY.md' ? '' : file.slice(0, -3), content })),
    })),
    parse: parseMemory,
    runInMemoryQueue: fn => fn(),
    warn: () => {},
  })
  temp.close(() => index.close())
  for (const scope of Object.keys(files)) await index.query({ scopes: [scope], ownScope: scope, query: '记忆' })
  delete files['bot:gone']
  assert.deepEqual(await index.cleanup(['bot:live']), { ok: true })
  // Nothing refreshes bot:gone any more, so only cleanup can remove it.
  const { DatabaseSync } = await import('node:sqlite')
  const probe = new DatabaseSync(join(temp.dir, 'index.sqlite'))
  temp.close(() => probe.close())
  const left = probe.prepare('SELECT DISTINCT scope FROM entries ORDER BY scope').all().map(row => row.scope)
  assert.deepEqual(left, ['bot:live', 'project:a', 'team'])
  const filesLeft = probe.prepare('SELECT DISTINCT scope FROM files ORDER BY scope').all().map(row => row.scope)
  assert.deepEqual(filesLeft, ['bot:live', 'project:a', 'team'])
})
