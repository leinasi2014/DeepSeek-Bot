// Task candidates: what a Bot says it finished, the evidence that can be checked, and the
// fixed plan that turns verified claims into memory entries.
//
// A candidate becomes a memory entry in two steps that can each be interrupted: the plan
// is written once and never regenerated, and every item is applied through the memory
// write queue with a stable `review_id` in its metadata. Recovery therefore never needs
// the model again: it reads the plan, looks for that id in the Markdown, and finishes or
// repairs exactly the items that are missing. `done` is the authority for "already
// written", so an entry the user deletes afterwards stays deleted.
//
// One file per candidate (`task-plans/<candidateId>.json`) holds the candidate, the plan
// and the progress, so no second queue state can be committed half-way. Every update is a
// temp+rename of that one file, serialized here.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CANDIDATE_VERSION = 1
export const CLAIMS_MAX = 8
export const INVALID_MAX = 3
export const RETRY_MAX = 3
export const CAPACITY_CODE = 'memory/full'

export const STATUS = {
  pending: 'PENDING',
  waiting: 'WAITING',
  retry: 'RETRY',
  skipped: 'SKIPPED',
  planned: 'PLANNED',
  applying: 'APPLYING',
  done: 'DONE',
  dropped: 'DROPPED',
  conflict: 'CONFLICT',
  corrupt: 'CORRUPT',
  capacity: 'CAPACITY',
  // The gates refused every lesson this task offered. Nothing is written and nothing is
  // retried on its own: the candidate waits for an explicit retry, which is the only way
  // the task is looked at again.
  held: 'HELD',
}

// A candidate is identified by the tool call that reported it: replaying the same log
// entry finds the same file, while a model that calls complete_task again gets a new
// callId and therefore a new candidate (its wording cannot be deduplicated, by design).
export const candidateIdOf = (sessionId, callId) => createHash('sha256').update(`${sessionId}\n${callId}`).digest('hex').slice(0, 32)
// The id that lands in the Markdown metadata. Lower-case and stable per plan item.
export const reviewIdOf = (candidateId, index) => createHash('sha256').update(`${candidateId}:${index}`).digest('hex').slice(0, 16)

// taskReview({ root, check, extract, applyItem, linkTopic, readScope, parse, format, now, warn })
//
// - `check(candidate)` re-validates the Bot, the session and the project; resolves
//   `{ ok: true, project }`, `{ ok: false, waiting: true }` or `{ ok: false, dropped }`.
// - `extract(candidate)` asks the model for the claims once; resolves
//   `{ items: [...] }` or `{ invalid: reason }`.
// - `applyItem(item)` writes one entry through the memory queue and resolves
//   `{ changed, file }`; it throws `memory/full` when the file is full.
// - `linkTopic(scope, topic)` adds the missing `[[topic]]` link to MEMORY.md.
// - `readScope(scope)` and `parse(content)`/`format(text, meta)` are the memory module's
//   own committed reader and entry format, so recovery compares exactly what it wrote.
export function taskReview({ root, check, extract, applyItem, linkTopic, readScope, parse, format, now = () => new Date().toISOString(), warn = () => {} }) {
  const dir = join(root, 'task-plans')
  const corruptDir = join(dir, 'corrupt')
  const pathOf = id => join(dir, `${id}.json`)

  // Every write of a candidate file goes through this chain: two updates of the same
  // candidate must not interleave, and the file is replaced, never edited in place.
  let writing = Promise.resolve()
  const serialized = job => {
    const run = writing.then(job)
    writing = run.catch(() => {})
    return run
  }

  async function write(record) {
    await serialized(async () => {
      await mkdir(dir, { recursive: true })
      const temp = `${pathOf(record.candidateId)}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await rename(temp, pathOf(record.candidateId))
    })
  }

  async function read(id) {
    try {
      const text = await readFile(pathOf(id), 'utf8')
      const record = JSON.parse(text)
      if (record === null || typeof record !== 'object' || record.candidateId !== id) return undefined
      return record
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async function list() {
    try {
      return (await readdir(dir)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  // A file that cannot be parsed keeps its evidence: it is moved aside, marked so the
  // same candidateId is never silently regenerated, and reported for a person to look at.
  async function quarantine(id, error) {
    await mkdir(corruptDir, { recursive: true })
    const stamp = now().replace(/[:.]/g, '-')
    try {
      await rename(pathOf(id), join(corruptDir, `${id}.${stamp}.json`))
    } catch (failure) {
      warn('ds-bot: task candidate %s is unreadable and could not be moved aside: %s', id, failure?.message ?? failure)
      return { candidateId: id, status: STATUS.corrupt, unreadable: true, error: String(error?.message ?? error) }
    }
    warn('ds-bot: task candidate %s is unreadable and was moved to task-plans/corrupt: %s', id, error?.message ?? error)
    return { candidateId: id, status: STATUS.corrupt, quarantined: true, error: String(error?.message ?? error) }
  }

  // Persisted before the tool call returns, so a candidate that was accepted is never
  // lost by a restart.
  async function enqueue({ botId, sessionId, roomId, project, callId, result, claims, notes }) {
    if (typeof sessionId !== 'string' || typeof callId !== 'string') throw new Error('A candidate needs the session and the tool call')
    const candidateId = candidateIdOf(sessionId, callId)
    const existing = await read(candidateId).catch(() => undefined)
    if (existing !== undefined) return existing
    const record = {
      version: CANDIDATE_VERSION,
      candidateId,
      botId,
      sessionId,
      roomId: roomId ?? null,
      project: project ?? null,
      createdAt: now(),
      status: STATUS.pending,
      invalid: 0,
      retry: 0,
      result: String(result ?? '').slice(0, 2000),
      claims: (Array.isArray(claims) ? claims : []).slice(0, CLAIMS_MAX),
      notes: String(notes ?? '').slice(0, 4000),
      plan: null,
      progress: { done: [], conflicts: [] },
    }
    await write(record)
    return record
  }

  // The plan is frozen here: every item carries its own scope, topic, text, the exact
  // metadata (including `review_id`) and the exact line those produce. Nothing below ever
  // recomputes metadata or a date, which is what keeps `by` and `added` from drifting.
  function freeze(record, items) {
    const plan = items.slice(0, CLAIMS_MAX).map((item, index) => {
      const reviewId = reviewIdOf(record.candidateId, index)
      const meta = { ...(item.meta ?? {}), review_id: reviewId }
      return {
        index,
        reviewId,
        scope: item.scope,
        topic: item.topic ?? '',
        text: String(item.text ?? ''),
        outcome: item.outcome ?? 'unverified',
        source: item.source ?? '',
        meta,
        line: format(item.text, meta),
      }
    })
    return { version: CANDIDATE_VERSION, frozenAt: now(), items: plan }
  }

  const isDone = (record, reviewId) => record.progress.done.some(item => item.reviewId === reviewId)
  const markDone = (record, reviewId, file) => { record.progress.done.push({ reviewId, file }) }

  // What the scope holds right now, by committed content. One parse per file, and only for
  // the files of the scopes the plan actually touches.
  function entriesOf(scope) {
    const files = readScope(scope) ?? []
    return files.flatMap(file => parse(file.content ?? '').entries.map(entry => ({
      scope,
      file: file.file,
      topic: file.topic ?? '',
      line: entry.line + 1,
      text: entry.text,
      meta: entry.meta ?? {},
    })))
  }

  // Applies one item, or explains why it could not be applied. Returns one of
  // `done` / `deduplicated` / `conflict` / `retrying`, so the caller only decides status.
  async function applyOne(record, item, seen) {
    if (isDone(record, item.reviewId)) return { kind: 'done', skipped: true }
    const sameId = seen.find(entry => entry.meta.review_id === item.reviewId)
    if (sameId !== undefined) {
      // The id says this is the entry the plan made. Only the exact frozen line counts:
      // a user edit keeps the id but changes the line, and that must not be overwritten.
      if (format(sameId.text, sameId.meta) === item.line) {
        if (item.topic !== '' && !(readScope(item.scope).some(file => file.file === item.topic + '.md' && file.content.includes(`[[${item.topic}]]`)))) {
          await linkTopic(item.scope, item.topic)
        }
        markDone(record, item.reviewId, sameId.file)
        return { kind: 'done', repaired: true, file: sameId.file }
      }
      record.progress.conflicts.push({ reviewId: item.reviewId, file: sameId.file, expected: item.line, found: format(sameId.text, sameId.meta) })
      return { kind: 'conflict', file: sameId.file }
    }
    let result
    try {
      result = await applyItem(item)
    } catch (error) {
      if (error?.code === CAPACITY_CODE) return { kind: 'capacity' }
      record.retry += 1
      return { kind: 'retrying', error: String(error?.message ?? error) }
    }
    if (result?.changed === false) {
      // Another topic already holds the same text: the memory has it, so this item is
      // finished, and the file it actually landed in is what we record. Its metadata is
      // not ours to rewrite, and no new evidence is claimed for it.
      markDone(record, item.reviewId, result.file)
      return { kind: 'deduplicated', file: result.file }
    }
    if (item.topic !== '') await linkTopic(item.scope, item.topic)
    markDone(record, item.reviewId, result?.file ?? item.topic ?? 'MEMORY.md')
    return { kind: 'done', file: result?.file }
  }

  // Walks the frozen plan. Items already done are skipped first (so a deletion by the user
  // is not undone), then the Markdown is checked by review id, and only then is anything
  // written. A conflict stops the whole candidate: it needs a person to look.
  async function applyPlan(record) {
    const byScope = new Map()
    for (const item of record.plan.items) {
      if (!byScope.has(item.scope)) byScope.set(item.scope, entriesOf(item.scope))
      const seen = byScope.get(item.scope)
      const outcome = await applyOne(record, item, seen)
      if (outcome.kind === 'conflict') {
        record.status = STATUS.conflict
        record.conflictAt = now()
        await write(record)
        return outcome
      }
      if (outcome.kind === 'capacity') {
        record.status = STATUS.capacity
        record.capacityAt = now()
        await write(record)
        return outcome
      }
      if (outcome.kind === 'retrying') {
        record.status = record.retry >= RETRY_MAX ? STATUS.retry : STATUS.applying
        await write(record)
        return outcome
      }
    }
    record.status = STATUS.done
    record.doneAt = now()
    await write(record)
    return { kind: 'done' }
  }

  // One pass over one candidate: re-validate, extract once, freeze the plan once, then
  // apply it. Extraction and freezing only happen when no plan exists yet, which is what
  // makes recovery independent of the model.
  async function process(id) {
    let record = await read(id)
    if (record === undefined) return undefined
    if (record.status === STATUS.done || record.status === STATUS.skipped || record.status === STATUS.dropped) return record
    if (record.status === STATUS.conflict || record.status === STATUS.corrupt || record.status === STATUS.capacity) return record
    if (record.status === STATUS.held) return record
    const verdict = await check(record)
    if (verdict?.ok !== true) {
      record.status = verdict?.waiting === true ? STATUS.waiting : STATUS.dropped
      if (verdict?.reason !== undefined) record.droppedReason = String(verdict.reason)
      await write(record)
      return record
    }
    if (record.project !== null && verdict.project !== undefined && verdict.project !== record.project) {
      record.status = STATUS.dropped
      record.droppedReason = 'project-changed'
      await write(record)
      return record
    }
    if (record.plan === null) {
      const extracted = await extract(record)
      if (extracted?.items === undefined) {
        record.invalid += 1
        record.lastInvalid = String(extracted?.invalid ?? 'the extraction returned no items')
        record.status = record.invalid >= INVALID_MAX ? STATUS.skipped : STATUS.pending
        await write(record)
        return record
      }
      // What the gates refused stays in this file for a person to look at; it never
      // reaches the Markdown.
      record.unverified = Array.isArray(extracted.dropped) ? extracted.dropped.slice(0, CLAIMS_MAX * 2) : []
      if (extracted.items.length === 0 && record.unverified.length > 0) {
        // Nothing the gates accept: no plan is frozen, and nothing looks at this task
        // again by itself. Only an explicit retry reopens it.
        record.status = STATUS.held
        record.heldAt = now()
        await write(record)
        return record
      }
      record.plan = freeze(record, extracted.items)
      record.status = STATUS.planned
      await write(record)
    }
    record.status = STATUS.applying
    await write(record)
    await applyPlan(record)
    return record
  }

  // The explicit way back for a candidate the gates held. A frozen plan is never
  // re-extracted, so only a candidate that never got one can be reopened; everything
  // else is left exactly as it is.
  async function retry(id) {
    const record = await read(id)
    if (record === undefined) return undefined
    if (record.plan !== null || (record.status !== STATUS.held && record.status !== STATUS.skipped && record.status !== STATUS.retry)) return record
    record.status = STATUS.pending
    record.invalid = 0
    record.retry = 0
    record.retriedAt = now()
    await write(record)
    return record
  }

  // Startup: every candidate file is resumed; one unreadable file is quarantined without
  // stopping the others. Nothing here calls the model for a candidate that has a plan.
  async function recover() {
    const ids = await list()
    const results = []
    for (const id of ids) {
      try {
        const record = await read(id)
        if (record === undefined) continue
        results.push(await process(id))
      } catch (error) {
        results.push(await quarantine(id, error))
      }
    }
    return results.filter(Boolean)
  }

  return { enqueue, process, recover, retry, read, save: write, list, freeze, entriesOf, dir }
}
