// Local full-text index over the memory Markdown files.
//
// The Markdown files stay the only memory. This SQLite file is a derived copy used for
// BM25 ranking; deleting it only costs a rebuild. Freshness comes from a sha256 of each
// file's committed content, never from mtime or a write hook: a recall reads every file
// of the visible scopes once (inside the memory write queue, so no memory write can land
// between two reads), compares the whole file set with the `files` table, refreshes the
// index in one transaction, and queries it from that same in-memory snapshot. Nothing
// below awaits between the first and the last file read.
//
// If SQLite is missing, or the refresh fails, the already-read snapshot is scanned
// instead. A broken index therefore never turns into "there is no memory": only a
// Markdown read that fails twice is reported as an error.
import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const INDEX_VERSION = 1
// The same limits recall has always used (memory.js): query text, words, and results.
export const QUERY_TEXT_MAX = 120
export const QUERY_TERMS_MAX = 6
export const RECALL_MAX = 30

// The same normalization as memory.js's squash, so the scanned fallback scores a query
// exactly as recall scored it before the index existed.
export const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
// The words a query is made of, deduplicated in order.
export const termsOf = query => [...new Set(squash(query).slice(0, QUERY_TEXT_MAX).split(' ').filter(Boolean))].slice(0, QUERY_TERMS_MAX)

const hashOf = content => createHash('sha256').update(content).digest('hex')
// A trigram cannot match a term shorter than three characters, so those are filtered as
// literal substrings instead (the same split chat-index.js:25-45 makes).
const isShort = term => [...term].length < 3
// A literal substring test, case-folded like `squash`. Not LIKE: FTS5 answers a LIKE
// constraint with no MATCH by returning no rows at all (measured), and `instr` cannot
// treat `%` or `_` as wildcards in the first place.
const LITERAL = '(instr(lower(text), ?) > 0 OR instr(lower(topic), ?) > 0)'
const phraseOf = term => `"${term.replace(/"/g, '""')}"`
const keyOf = (scope, file) => `${scope}\u0000${file}`
const plain = ({ count: _count, ...row }) => row
const BOT_PREFIX = 'bot:'

// memoryIndex({ root, readScopes, parse, runInMemoryQueue, warn })
//
// - `readScopes(scopes)` is synchronous and returns `[{ scope, files: [{ file, topic,
//   content }] }]` from the committed view, so a commit in flight reads as it was
//   committed and a rolled-back change is never indexed.
// - `parse(content)` returns `{ entries: [{ line, text, meta }] }`; memory.js passes its
//   own parseMemory so the index sees exactly the entries recall sees.
// - `runInMemoryQueue(fn)` runs a synchronous `fn` after every queued memory write, and
//   resolves with its value. The collection must not await: that is what keeps a queue
//   move's two writes (memory.js:767/771) out of the same snapshot.
export function memoryIndex({ root, readScopes, parse, runInMemoryQueue, warn = () => {} }) {
  const indexPath = join(root, 'index.sqlite')
  const queued = runInMemoryQueue ?? (fn => Promise.resolve().then(fn))
  const warned = new Set()
  const warnOnce = (message, error) => {
    const text = `${message}: ${error?.message ?? error}`
    if (warned.has(text)) return
    warned.add(text)
    warn('ds-bot: %s', text)
  }

  // `undefined` means "not opened yet"; `null` means "no SQLite here, scan for good":
  // a runtime without node:sqlite must not retry the import on every recall.
  let opened
  let opening

  function open() {
    if (opened !== undefined) return Promise.resolve(opened)
    opening ??= (async () => {
      let DatabaseSync
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        await mkdir(root, { recursive: true })
      } catch (error) {
        warnOnce('no memory index, recall scans the Markdown', error)
        return null
      }
      // A damaged file is rebuilt from the Markdown once.
      for (const fresh of [false, true]) {
        try {
          if (fresh) await unlink(indexPath).catch(() => {})
          return create(new DatabaseSync(indexPath))
        } catch (error) {
          if (fresh) warnOnce('no memory index, recall scans the Markdown', error)
        }
      }
      return null
    })().then((created) => {
      if (opening === undefined) {
        created?.db.close()
        return null
      }
      return opened = created
    })
    return opening
  }

  function create(db) {
    // WAL is nice to have, not required: an odd filesystem must not disable the index.
    try { db.exec('PRAGMA journal_mode = WAL') } catch { /* keep the default journal */ }
    if (db.prepare('PRAGMA user_version').get().user_version !== INDEX_VERSION) {
      db.exec(`
        DROP TABLE IF EXISTS entries;
        DROP TABLE IF EXISTS files;
        CREATE VIRTUAL TABLE entries USING fts5(text, topic, scope UNINDEXED, file UNINDEXED, line UNINDEXED, added UNINDEXED, tokenize = 'trigram');
        CREATE TABLE files (scope TEXT NOT NULL, file TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (scope, file));
        PRAGMA user_version = ${INDEX_VERSION};`)
    }
    return {
      db,
      known: db.prepare('SELECT scope, file, hash FROM files WHERE scope IN (SELECT value FROM json_each(?))'),
      scopes: db.prepare('SELECT DISTINCT scope FROM files'),
      insert: db.prepare('INSERT INTO entries (text, topic, scope, file, line, added) VALUES (?, ?, ?, ?, ?, ?)'),
      deleteFile: db.prepare('DELETE FROM entries WHERE scope = ? AND file = ?'),
      deleteScope: db.prepare('DELETE FROM entries WHERE scope = ?'),
      setHash: db.prepare('INSERT OR REPLACE INTO files (scope, file, hash) VALUES (?, ?, ?)'),
      dropHash: db.prepare('DELETE FROM files WHERE scope = ? AND file = ?'),
      dropScopeFiles: db.prepare('DELETE FROM files WHERE scope = ?'),
    }
  }

  // Every file of the visible scopes, read once: `content` is what gets hashed and what
  // the fallback scans, and `entries` is what gets indexed. Synchronous by contract.
  function snapshotOf(scopes) {
    return readScopes(scopes).map(({ scope, files }) => ({
      scope,
      files: (files ?? []).map((file) => {
        const content = String(file.content ?? '')
        return { file: file.file, topic: file.topic ?? '', content, hash: hashOf(content), entries: parse(content).entries }
      }),
    }))
  }

  // Compares the whole file set with the index: a disappeared file loses every row, a new
  // or changed file is rebuilt. One transaction, so a failure publishes nothing.
  function refresh(index, scopes, snapshot) {
    const known = new Map()
    for (const row of index.known.all(JSON.stringify(scopes))) known.set(keyOf(row.scope, row.file), row.hash)
    const wanted = new Map()
    for (const { scope, files } of snapshot) {
      for (const file of files) wanted.set(keyOf(scope, file.file), { scope, file })
    }
    const writes = []
    for (const key of known.keys()) {
      if (!wanted.has(key)) {
        const [scope, name] = key.split('\u0000')
        writes.push({ scope, name, kind: 'drop' })
      }
    }
    for (const [key, { scope, file }] of wanted) {
      const before = known.get(key)
      if (before === file.hash) continue
      writes.push({ scope, name: file.file, file, kind: before === undefined ? 'insert' : 'replace' })
    }
    if (writes.length === 0) return
    index.db.exec('BEGIN IMMEDIATE')
    try {
      for (const write of writes) {
        index.deleteFile.run(write.scope, write.name)
        if (write.kind === 'drop') {
          index.dropHash.run(write.scope, write.name)
          continue
        }
        for (const entry of write.file.entries) {
          index.insert.run(entry.text, write.file.topic, write.scope, write.name, entry.line + 1, entry.meta?.added ?? '')
        }
        index.setHash.run(write.scope, write.name, write.file.hash)
      }
      index.db.exec('COMMIT')
    } catch (error) {
      try { index.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  // All words at once. The scope whitelist is a subquery, so it filters before LIMIT: a
  // query that took the first N rows of every scope and filtered afterwards would return
  // short results. `rank` is BM25; a query of only short words has no MATCH and no rank.
  function searchSql({ scopes, ownScope, terms, limit }) {
    const long = terms.filter(term => !isShort(term))
    const short = terms.filter(isShort)
    const where = ['scope IN (SELECT value FROM json_each(?))']
    const args = [JSON.stringify(scopes)]
    if (long.length > 0) {
      where.push('entries MATCH ?')
      args.push(long.map(phraseOf).join(' '))
    }
    for (const term of short) {
      where.push(LITERAL)
      args.push(term, term)
    }
    const rank = long.length > 0 ? 'rank, ' : ''
    args.push(ownScope, limit)
    return {
      sql: `SELECT scope, file, line, text, topic, added FROM entries
        WHERE ${where.join(' AND ')}
        ORDER BY ${rank}CASE WHEN scope = ? THEN 0 WHEN scope LIKE 'project:%' THEN 1 ELSE 2 END, added DESC, scope, file, line
        LIMIT ?`,
      args,
    }
  }

  // The same scoring recall used before the index: every word must appear, else the rows
  // with the most words. Used for the partial-match pass and for every degraded recall,
  // so both paths answer a query the same way.
  function scan(snapshot, { terms, limit }) {
    const scored = []
    for (const { scope, files } of snapshot) {
      for (const file of files) {
        for (const entry of file.entries) {
          const hay = squash(`${entry.text} ${file.topic}`)
          const count = terms.reduce((hits, term) => (hay.includes(term) ? hits + 1 : hits), 0)
          if (count === 0) continue
          scored.push({ scope, file: file.file, line: entry.line + 1, text: entry.text, topic: file.topic, added: entry.meta?.added ?? '', count })
        }
      }
    }
    const every = scored.filter(hit => hit.count === terms.length)
    if (every.length > 0) return { rows: every.slice(0, limit).map(plain), matchedAll: true }
    // Rows are ordered by how many words each matched; the sort is stable, so rows that
    // tie keep the scope, file and line order they were collected in.
    scored.sort((left, right) => right.count - left.count)
    return { rows: scored.slice(0, limit).map(plain), matchedAll: false }
  }

  // One recall: collect inside the memory write queue, refresh, and query that same
  // snapshot. Resolves `{ ok: true, rows, matchedAll, degraded }`, or `{ ok: false,
  // error }` when the Markdown could not be read even on a second try — which the caller
  // must report, never turn into an empty result.
  async function query({ scopes, ownScope, query: text, limit = RECALL_MAX }) {
    const terms = termsOf(text ?? '')
    const index = await open()
    const attempt = () => queued(() => {
      const snapshot = snapshotOf(scopes)
      if (index !== null && terms.length > 0) {
        try {
          refresh(index, scopes, snapshot)
          const { sql, args } = searchSql({ scopes, ownScope, terms, limit })
          const found = index.db.prepare(sql).all(...args)
          if (found.length > 0) return { ok: true, rows: found, matchedAll: true, degraded: false }
        } catch (error) {
          warnOnce('memory index refresh failed, recall scans the Markdown', error)
        }
      }
      return { ok: true, ...scan(snapshot, { terms, limit }), degraded: true }
    })
    try {
      return await attempt()
    } catch {
      // A file that vanished between the listing and the read is worth one more try; a
      // file that stays unreadable is reported.
      try { return await attempt() } catch (again) { return { ok: false, error: again } }
    }
  }

  // A deleted Bot's scope never enters a whitelist again, so it would keep its rows
  // forever: the caller drops them on startup and after archiving, by live Bot id
  // (a `bot:`-prefixed scope key is accepted too, so a mistaken call cannot delete every
  // Bot's rows). The dead scopes are computed here because an FTS5 table answers
  // `scope LIKE 'bot:%'` with no MATCH by returning no rows, so the predicate has to be
  // plain equality.
  async function cleanup(liveBotIds) {
    const index = await open()
    if (index === null) return { ok: false }
    const live = new Set([...liveBotIds].map((id) => {
      const text = String(id)
      return text.startsWith(BOT_PREFIX) ? text : `${BOT_PREFIX}${text}`
    }))
    const dead = index.scopes.all()
      .map(row => row.scope)
      .filter(scope => scope.startsWith(BOT_PREFIX) && !live.has(scope))
    if (dead.length === 0) return { ok: true }
    index.db.exec('BEGIN IMMEDIATE')
    try {
      for (const scope of dead) {
        index.deleteScope.run(scope)
        index.dropScopeFiles.run(scope)
      }
      index.db.exec('COMMIT')
    } catch (error) {
      try { index.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    return { ok: true }
  }

  function close() {
    opening = undefined
    opened?.db.close()
    opened = undefined
  }

  return {
    query,
    cleanup,
    close,
    get mode() { return opened === null ? 'scan' : opened === undefined ? 'unopened' : 'index' },
  }
}
