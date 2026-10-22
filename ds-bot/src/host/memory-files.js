import { randomUUID } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { copyFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// A failed append may have written part of its line. Keep all journal writers in
// one queue so restoring its previous length cannot discard somebody else's entry.
export function memoryFiles(root, writeText, warn) {
  const journalPath = join(root, 'journal.jsonl')
  let appending = Promise.resolve()
  let journalFailure
  let commitFailure
  const pending = new Map()
  const assertWritable = () => {
    if (commitFailure !== undefined) throw commitFailure
    if (journalFailure !== undefined) throw journalFailure
  }

  // A synchronous prompt render can run while the journal is awaiting I/O. It
  // must freeze committed memory, including the old list of topic files.
  const read = (path, fallback) => pending.has(path) ? pending.get(path) ?? '' : fallback(path)
  function list(dir, fallback) {
    const names = new Set(fallback(dir))
    for (const [path, before] of pending) {
      if (dirname(path) !== dir) continue
      if (before === undefined) names.delete(basename(path))
      else names.add(basename(path))
    }
    return [...names]
  }
  function journal(record) {
    const run = appending.then(async () => {
      assertWritable()
      const line = `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`
      await mkdir(root, { recursive: true })
      // Windows append-only handles cannot truncate a partial write. This queue
      // owns the tail, so use a read/write handle and an explicit end position.
      let file
      try { file = await open(journalPath, 'r+') } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        file = await open(journalPath, 'wx+')
      }
      try {
        const info = await file.stat()
        if (!info.isFile()) throw new Error(`Memory journal ${journalPath} is not a regular file`)
        const before = info.size
        try {
          const bytes = Buffer.from(line, 'utf8')
          for (let offset = 0; offset < bytes.length;) {
            const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, before + offset)
            if (bytesWritten === 0) throw new Error('Memory journal write made no progress')
            offset += bytesWritten
          }
        } catch (failure) {
          try {
            await file.truncate(before)
          } catch (rollback) {
            journalFailure = new Error(`Memory journal append failed (${failure.message}); its partial line could not be removed (${rollback.message}). Restore ${journalPath} to ${before} bytes and restart DSH before trying again.`, { cause: failure })
            throw journalFailure
          }
          throw failure
        }
      } finally {
        // Once the write completed the record is committed; a close error must
        // not roll the body back while leaving a successful journal entry behind.
        await file.close().catch(error => warn('ds-bot: memory journal close failed: %s', error))
      }
    })
    appending = run.catch(() => {})
    return run
  }

  async function commit(changes, record) {
    assertWritable()
    const saved = []
    const changed = []
    try {
      // Allocate every backup before changing anything. In particular, an ENOSPC
      // during the journal append can then be rolled back by rename, not a write.
      for (const change of changes) {
        await mkdir(dirname(change.path), { recursive: true })
        const backup = `${change.path}.${process.pid}.${randomUUID()}.bak`
        let exists = true
        try {
          await copyFile(change.path, backup, constants.COPYFILE_EXCL)
        } catch (error) {
          await unlink(backup).catch(cleanup => { if (cleanup?.code !== 'ENOENT') warn('ds-bot: incomplete memory backup cleanup failed at %s: %s', backup, cleanup) })
          if (error?.code !== 'ENOENT') throw error
          exists = false
        }
        const kept = { ...change, backup: exists ? backup : undefined }
        saved.push(kept)
        kept.before = exists ? readFileSync(backup, 'utf8') : undefined
      }
      for (const change of saved) pending.set(change.path, change.before)
      for (const change of saved) {
        if (change.text === null) await unlink(change.path).catch(error => { if (error?.code !== 'ENOENT') throw error })
        else await writeText(change.path, change.text)
        changed.push(change)
      }
      await journal(record)
      pending.clear()
    } catch (failure) {
      const unrestored = []
      for (const change of changed.reverse()) {
        try {
          if (change.backup === undefined) await unlink(change.path).catch(error => { if (error?.code !== 'ENOENT') throw error })
          else {
            try { await rename(change.backup, change.path) } catch { await rename(change.backup, change.path) }
            change.backup = undefined
          }
        } catch (error) {
          change.keep = true
          unrestored.push(`${change.path}: ${error.message}${change.backup === undefined ? '' : `; previous contents are in ${change.backup}`}`)
        }
      }
      if (unrestored.length > 0) {
        commitFailure = new Error(`Memory change failed (${failure.message}) and could not be fully rolled back. Restore these files and restart DSH before trying again: ${unrestored.join('; ')}`, { cause: failure })
        throw commitFailure
      }
      pending.clear()
      throw failure
    } finally {
      for (const change of saved) {
        if (change.backup !== undefined && !change.keep) {
          await unlink(change.backup).catch(error => warn('ds-bot: memory backup cleanup failed at %s: %s', change.backup, error))
        }
      }
    }
  }

  return { journal, commit, read, list, assertWritable }
}
