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
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CANDIDATE_VERSION = 1
export const CLAIMS_MAX = 8
export const INVALID_MAX = 3
export const RETRY_MAX = 3
export const CAPACITY_CODE = 'memory/full'
// Raised by `applyItem` when the conditions the candidate was checked under no longer
// hold at the moment of the write: the Bot left the group, the conversation changed
// hands, project memory was switched off, or the project id is no longer the one the
// frozen plan names. It is not a write failure and not a retry: the candidate stops, and
// the record says why (#70).
export const STALE_CODE = 'memory/task-stale'

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
// The work, question and room-call ids a candidate is bound to, de-duplicated and with the
// empty ones dropped. Deliberately not capped by CLAIMS_MAX: that bounds how many claims a
// report may make, and a turn can open more requests than it makes claims. Cutting the list
// would let a report be written while something it started is still unanswered.
const relatedIds = ids => [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id !== ''))]

// The id that lands in the Markdown metadata. Lower-case and stable per plan item.
export const reviewIdOf = (candidateId, index) => createHash('sha256').update(`${candidateId}:${index}`).digest('hex').slice(0, 16)

// The metadata exactly as the secret check reads it, without `review_id`.
//
// `review_id` is the host's own hash, not content: 16 lower-case hex characters, of which
// about one in a thousand is all digits (`(10/16)^16`), and the memory module's "15 digits
// in a row" rule reads an all-digit id as an ID number. Checking it refused the whole
// entry with "the entry looks like a secret": the user never got the lesson and had no way
// to tell why. Every other value, and the entry text itself, is still checked.
export const metaForSecretCheck = meta => Object.fromEntries(Object.entries(meta ?? {}).filter(([key]) => key !== 'review_id'))

// taskReview({ root, check, extract, applyItem, linkTopic, readScope, parse, format, entryProblem, secretEntry, now, warn })
//
// - `check(candidate)` re-validates the Bot, the session and the project; resolves
//   `{ ok: true, project }`, `{ ok: false, waiting: true }` or `{ ok: false, dropped }`.
// - `extract(candidate)` asks the model for the claims once; resolves
//   `{ items: [...] }` or `{ invalid: reason }`.
// - `applyItem(item, hooks)` writes one entry through the memory queue and resolves
//   `{ changed, file }`; it throws `memory/full` when the file is full. `hooks` carries
//   `record` (the candidate, for the standing re-check #70 makes in the queued job) and
//   `decide` (#64's in-queue hook: fresh hashes/entries/hasLink, and the persisted
//   pre-write state); the second argument is a hooks bag, never the record alone.
// - `linkTopic(scope, topic)` adds the missing `[[topic]]` link to MEMORY.md.
// - `readScope(scope)` and `parse(content)`/`format(text, meta)` are the memory module's
//   own committed reader and entry format, so recovery compares exactly what it wrote.
// - `entryProblem(text)` / `secretEntry(text)` are the memory module's own limits. They
//   run again before the plan is frozen: the extract step may be hours old by then, and
//   the plan file is a plain JSON a person can edit.
export function taskReview({ root, check, extract, applyItem, linkTopic, readScope, parse, format, entryProblem = () => undefined, secretEntry = () => false, now = () => new Date().toISOString(), warn = () => {} }) {
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
    let text
    try {
      text = await readFile(pathOf(id), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    const record = JSON.parse(text)
    // A file that exists but is not this candidate's record is corruption, not absence:
    // only a missing file may be treated as "no candidate yet" (#63).
    if (record === null || typeof record !== 'object' || record.candidateId !== id) {
      throw new Error(`task candidate ${id} is not a valid record`)
    }
    return record
  }

  async function list() {
    try {
      return (await readdir(dir)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  // The quarantine marker outlives the move: a replay of the same session and call must
  // never quietly build a fresh candidate over the evidence, wherever it ended up (#63).
  const markerOf = id => join(dir, `${id}.corrupt`)
  async function quarantined(id) {
    return await access(markerOf(id)).then(() => true, () => false)
  }

  // A file that cannot be parsed keeps its evidence: it is moved aside under a name all
  // its own, marked so the same candidateId is never silently regenerated, and reported
  // for a person to look at. The marker is written first: it is the durable fact that
  // blocks a rebuild, so it must exist before the original path can become empty — a
  // crash between the two leaves the unreadable file in place, never a window where a
  // replay rebuilds over the evidence (#63). When the marker cannot be saved the move
  // does not happen: the original stays where it is and the failure is reported, never
  // swallowed as a successful quarantine.
  async function quarantine(id, error) {
    const marker = { candidateId: id, at: now(), error: String(error?.message ?? error) }
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(markerOf(id), `${JSON.stringify(marker)}\n`, 'utf8')
    } catch (failure) {
      warn('ds-bot: quarantine marker for task candidate %s could not be saved; the unreadable file was left in place: %s', id, failure?.message ?? failure)
      return { candidateId: id, status: STATUS.corrupt, unreadable: true, markerFailed: true, error: marker.error }
    }
    let moved = false
    try {
      await mkdir(corruptDir, { recursive: true })
      const stamp = now().replace(/[:.]/g, '-')
      let target = join(corruptDir, `${id}.${stamp}.json`)
      // A candidate can go bad twice; both copies are evidence, neither replaces the other.
      for (let copy = 2; ; copy += 1) {
        if (await access(target).then(() => true, () => false)) target = join(corruptDir, `${id}.${stamp}-${copy}.json`)
        else break
      }
      await rename(pathOf(id), target)
      moved = true
    } catch (failure) {
      warn('ds-bot: task candidate %s is marked corrupt and could not be moved aside; the unreadable file stays in place: %s', id, failure?.message ?? failure)
    }
    warn('ds-bot: task candidate %s is unreadable and was quarantined: %s', id, marker.error)
    return { candidateId: id, status: STATUS.corrupt, ...(moved ? { quarantined: true } : { unreadable: true }), error: marker.error }
  }

  // Persisted before the tool call returns, so a candidate that was accepted is never
  // lost by a restart.
  //
  // `work`, `questions` and `groupWaits` are what this candidate is bound to, captured when
  // the report is made: the work the reporting turn was doing (and what it opened itself),
  // the question the Bot had asked and not had answered, and the group calls its turn made.
  // They are the only things WAITING may look at. Checking the Bot's other work instead
  // would let one busy group chat stall a report made in another, which is the point of
  // keeping these lists per candidate.
  //
  // `projectKind` is what the resolver answered at the moment of the report — ok, none,
  // unresolved or off — and is kept beside `project`, so the four cases survive as four.
  // Collapsing them into `project: null` lost the difference between "this folder is not a
  // project" and "this folder's project cannot be told apart"; the second is a binding
  // waiting to be made, never a licence to write the Bot's own memory (#70).
  // `sessionChain` is the Sessions this candidate may read from and bind through: the one
  // it was reported in, plus the earlier parts of the same chat.
  async function enqueue({ botId, sessionId, roomId, project, projectKind, cwd, sessionChain, callId, result, claims, notes, work, questions, groupWaits }) {
    if (typeof sessionId !== 'string' || typeof callId !== 'string') throw new Error('A candidate needs the session and the tool call')
    const candidateId = candidateIdOf(sessionId, callId)
    // A replay finds the accepted candidate. An unreadable file is quarantined here —
    // never written over — and a candidate that was quarantined before is not rebuilt:
    // only a missing file counts as absent (#63).
    let existing
    try {
      existing = await read(candidateId)
    } catch (error) {
      return quarantine(candidateId, error)
    }
    if (existing !== undefined) return existing
    if (await quarantined(candidateId)) {
      return { candidateId, status: STATUS.corrupt, quarantined: true }
    }
    const record = {
      version: CANDIDATE_VERSION,
      candidateId,
      botId,
      sessionId,
      roomId: roomId ?? null,
      project: project ?? null,
      // One of ok / none / unresolved / off, as the resolver answered when the report was
      // made. A file written before this field existed reads as `none` with no `project`,
      // which is what it meant then.
      projectKind: ['ok', 'none', 'unresolved', 'off'].includes(String(projectKind))
        ? String(projectKind)
        : (project === null || project === undefined ? 'none' : 'ok'),
      // The folder the report was made in. A file claim is judged against this root for
      // the rest of the candidate's life, even if the Session moves elsewhere; a candidate
      // that was unresolved is bound from this folder only, never from wherever its
      // Session happens to be at the next check.
      cwd: cwd ?? null,
      // The Sessions of the same chat the report may read, oldest first, the reporting one
      // last. A part switch moves the Bot on; the chain is what says the candidate still
      // belongs to that conversation.
      sessionChain: relatedIds(sessionChain).length > 0 ? relatedIds(sessionChain) : [sessionId],
      createdAt: now(),
      status: STATUS.pending,
      invalid: 0,
      retry: 0,
      result: String(result ?? '').slice(0, 2000),
      claims: (Array.isArray(claims) ? claims : []).slice(0, CLAIMS_MAX),
      notes: String(notes ?? '').slice(0, 4000),
      // Work ids, not bot ids: one entry per request this turn opened. These are all kept:
      // `CLAIMS_MAX` bounds how many claims a report may make, not how many requests the
      // turn actually sent. Truncating here would let a candidate pass while a request it
      // opened is still unanswered — the report would be written as if everything it
      // started had come back. A request that is answered or dropped leaves the map, so it
      // stops blocking by itself.
      work: relatedIds(work),
      // Question ids, not Session ids: a question moves to the next Session when the
      // conversation changes part, and its id stays the same.
      questions: relatedIds(questions),
      // Room calls this turn made, as work ids in the same book as the rest: a group line
      // that names a member is work the moment it is posted, which is while the turn is
      // still open, so a report made later in that turn can wait for it.
      groupWaits: relatedIds(groupWaits),
      plan: null,
      progress: { done: [], conflicts: [] },
    }
    await write(record)
    return record
  }

  // The plan is frozen here: every item carries its own scope, topic, text, the exact
  // metadata (including `review_id`) and the exact line those produce. Nothing below ever
  // recomputes metadata or a date, which is what keeps `by` and `added` from drifting.
  // The limits run once more over what will actually be written — the text and every
  // metadata value, since that is what lands in the Markdown. An item that fails is left
  // out of the plan instead of being frozen and then refused on every apply.
  function freeze(record, items) {
    const accepted = []
    const refused = []
    items.slice(0, CLAIMS_MAX).forEach((item, index) => {
      const reviewId = reviewIdOf(record.candidateId, index)
      const meta = { ...(item.meta ?? {}), review_id: reviewId }
      const text = String(item.text ?? '')
      const metaText = Object.entries(metaForSecretCheck(meta)).map(([key, value]) => `${key}: ${value}`).join(' ')
      // The final line is checked as well, and also without `review_id`: the formatter
      // joins values in a way the raw text does not, and a secret must not appear either way.
      const line = format(text, meta)
      const problem = entryProblem(text) ?? (secretEntry(text) || secretEntry(metaText) || secretEntry(format(text, metaForSecretCheck(meta))) ? 'the entry looks like a secret' : undefined)
      if (problem !== undefined) {
        refused.push({ claim: item.meta?.claim, text, topic: item.topic ?? '', outcome: item.outcome ?? 'unverified', reason: 'invalid-at-freeze', problem })
        return
      }
      accepted.push({
        index: accepted.length,
        reviewId,
        scope: item.scope,
        topic: item.topic ?? '',
        text,
        outcome: item.outcome ?? 'unverified',
        source: item.source ?? '',
        meta,
        line,
      })
    })
    return { version: CANDIDATE_VERSION, frozenAt: now(), items: accepted, refused }
  }

  const isDone = (record, reviewId) => record.progress.done.some(item => item.reviewId === reviewId)
  const markDone = (record, reviewId, file) => {
    // Settling the item also clears the pre-write state it left: `done` is the
    // authority from here on (#64).
    delete record.progress.pending
    record.progress.done.push({ reviewId, file })
  }

  // What the scope holds right now, by committed content. One parse per file, and only for
  // the files of the scopes the plan actually touches. The apply path reads nothing here
  // anymore: its reads happen inside the memory write queue (#64).
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
  // `done` / `deduplicated` / `conflict` / `retrying` / `waiting` / `stale`, so the caller
  // only decides status. Every read the decision needs — the scope's current entries, the
  // pre-write hashes, the link state — happens inside the memory write queue, in the same
  // critical section as the write itself, through the hook below: nothing can move under
  // the decision, and no queue-outside snapshot goes stale (#64). `applyItem` is given the
  // candidate as `hooks.record` beside that hook; it re-checks the Bot, the conversation,
  // the group, the configuration and the project in that same queued job, because a
  // candidate can wait hours between its freeze and its last item (#70). The hook itself
  // stays exactly what #64 made it: fresh entries/hashes/hasLink, and the persisted
  // pre-write state.
  async function applyOne(record, item) {
    if (isDone(record, item.reviewId)) return { kind: 'done', skipped: true }
    let result
    try {
      result = await applyItem(item, {
        record,
        decide: async ({ hashes, entries, hasLink }) => {
          // The id says an entry is the one this plan made. Only the exact frozen line
          // counts: a user edit keeps the id but changes the line, and that must not
          // be overwritten. A missing topic link is repaired in the same queued job.
          const sameId = entries.find(entry => entry.meta.review_id === item.reviewId)
          if (sameId !== undefined) {
            if (format(sameId.text, sameId.meta) === item.line) {
              return { kind: 'done', file: sameId.file, ...(item.topic !== '' && !hasLink ? { link: item.topic } : {}) }
            }
            return { kind: 'conflict', file: sameId.file, conflict: { reviewId: item.reviewId, file: sameId.file, expected: item.line, found: format(sameId.text, sameId.meta) } }
          }
          // An interrupted attempt left this item's pre-write state. When a file it
          // was about to write no longer matches it, that change is either the same
          // text elsewhere in the scope (the duplicate below) or a person's edit —
          // the last one stops for the person instead of writing over their words.
          const pending = record.progress.pending
          if (pending !== undefined && pending.reviewId === item.reviewId) {
            const changedFile = Object.keys(pending.files).find(file => hashes[file] !== pending.files[file])
            if (changedFile !== undefined) {
              const twin = entries.find(entry => entry.text === item.text)
              if (twin !== undefined) return { kind: 'deduplicated', file: twin.file }
              return { kind: 'conflict', file: changedFile, conflict: { reviewId: item.reviewId, file: changedFile, expected: item.line, found: null, reason: 'pre-write content changed', expectedHash: pending.files[changedFile], foundHash: hashes[changedFile] } }
            }
          }
          // What the files look like before this item writes them, persisted in the
          // same critical section as the write itself (#64).
          record.progress.pending = { reviewId: item.reviewId, scope: item.scope, files: hashes }
          await write(record)
          return { kind: 'proceed' }
        },
      })
    } catch (error) {
      if (error?.code === CAPACITY_CODE) return { kind: 'capacity' }
      if (error?.code === STALE_CODE) {
        return error.waiting === true ? { kind: 'waiting' } : { kind: 'stale', reason: String(error?.message ?? 'stale') }
      }
      record.retry += 1
      return { kind: 'retrying', error: String(error?.message ?? error) }
    }
    // The queue-side hook decided this item must not write: the link repair and the
    // conflict detail already happened inside the queued job; the file stays as it is.
    if (result?.skipped !== undefined) {
      if (result.skipped === 'conflict') {
        record.progress.conflicts.push(result.conflict)
        return { kind: 'conflict', file: result.file }
      }
      markDone(record, item.reviewId, result.file)
      if (result.skipped === 'done') return { kind: 'done', repaired: true, file: result.file }
      return { kind: 'deduplicated', file: result.file, explained: 'same text elsewhere in the scope' }
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
  // written — all inside the memory write queue, per item. A conflict stops the whole
  // candidate: it needs a person to look.
  async function applyPlan(record) {
    for (const item of record.plan.items) {
      const outcome = await applyOne(record, item)
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
      // The conditions changed under the plan: waiting is not a failure, so the same
      // frozen plan is looked at again; a refusal that can never come true is dropped
      // with its reason, exactly as the first check would have.
      if (outcome.kind === 'waiting') {
        record.status = STATUS.waiting
        await write(record)
        return outcome
      }
      if (outcome.kind === 'stale') {
        record.status = STATUS.dropped
        record.droppedReason = outcome.reason
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
      const frozen = freeze(record, extracted.items)
      if (frozen.refused.length > 0) {
        // What the limits refused at freeze time stays with the candidate, beside the
        // gate refusals, so a person sees why it never became an entry.
        record.unverified = [...record.unverified, ...frozen.refused].slice(0, CLAIMS_MAX * 2)
      }
      if (frozen.items.length === 0) {
        // Nothing survived the freeze-time re-check: no empty plan is stored, and only an
        // explicit retry looks at this task again.
        record.status = STATUS.held
        record.heldAt = now()
        await write(record)
        return record
      }
      record.plan = { version: frozen.version, frozenAt: frozen.frozenAt, items: frozen.items }
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
