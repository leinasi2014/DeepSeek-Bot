// Acceptance skeletons for the memory redesign (issue #55). Each group mirrors one
// row of the acceptance checklist in docs/plans/2026-10-22-memory-isolation-retrieval-review.md
// (§7, final design). They stay skipped until the feature modules (#52 project-scope,
// #53 memory-index, #54 task-review) land; each skip names the module it waits for.
// All fixtures use temp dirs under os.tmpdir() (prefix .dsh-test-memory-), the mock
// model only, and never the real DSH_HOME.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testHome = () => mkdtempSync(join(tmpdir(), '.dsh-test-memory-'))

// --- identity (waits for #52: src/host/project-scope.js) ---------------------
test.skip('identity: repo root equals teamFolder is still a project, not none', () => { assert.ok(testHome()) })
test.skip('identity: ds-bot subdir resolves to the parent git root', () => {})
test.skip('identity: a marker file inside a git repo does not split a monorepo', () => {})
test.skip('identity: two worktrees of one repo share one project id', () => {})
test.skip('identity: a plain submodule gets its own id (different common dir)', () => {})
test.skip('identity: absolute and relative gitdir, with and without commondir', () => {})
test.skip('identity: deep non-git directory stays one root regardless of depth', () => {})
test.skip('identity: none/unresolved recovers after .git appears (cache expiry)', () => {})
test.skip('identity: real casing is kept, no folding; UNC paths', () => {})
test.skip('identity: hash collision is refused, not merged', () => {})

// --- scope (waits for #52: writeScopeOf) -------------------------------------
test.skip('scope: project A entries are invisible to a project B session', () => {})
test.skip('scope: every first-party write path defaults to project when one exists', () => {})
test.skip('scope: unresolved never falls back to own silently', () => {})
test.skip('scope: Main Bot cross-bot power does not reach project memory', () => {})
test.skip('scope: panel rejects fake hash / wrong session / disabled config', () => {})

// --- caches (waits for #52: snapshot v2 + panel keys) ------------------------
test.skip('cache: old snapshots invalidate; scope or teamRule change rebuilds', () => {})
test.skip('cache: ordinary content updates stay frozen within a session', () => {})
test.skip('cache: every summary cache is scope-keyed; A->B->A stale reply dropped', () => {})

// --- retrieval (waits for #53: src/host/memory-index.js) ---------------------
test.skip('retrieval: empty query lists the directory; topic reads a whole file', () => {})
test.skip('retrieval: all-terms first, then partial; mixed zh 1/2/3-char queries', () => {})
test.skip('retrieval: quote and LIKE wildcards are literal; ordering is stable', () => {})
test.skip('retrieval: scope whitelist filters before LIMIT', () => {})
test.skip('retrieval: index failure still finds fixture via scan; true no-match may be empty', () => {})

// --- consistency (waits for #53) ----------------------------------------------
test.skip('consistency: recall queued between move steps never sees the middle state', () => {})
test.skip('consistency: delete/archive/same-size-same-mtime edits are detected by content', () => {})
test.skip('consistency: dead bot scope rows are cleaned from entries/files', () => {})
test.skip('consistency: sqlite removed or corrupted rebuilds; failed transaction publishes nothing', () => {})

// --- acceptance rules (waits for #54) -----------------------------------------
test.skip('acceptance: idle/switch/overflow never trigger a review', () => {})
test.skip('acceptance: forged completion, self-reported exit code, green tool wrapper around failed tests are not success', () => {})
test.skip('acceptance: short user confirmation can verify; forged excerpt is rejected', () => {})

// --- permissions (waits for #54) ----------------------------------------------
test.skip('permissions: cross-bot/project anchors, ../, prefix-sibling dirs, junctions refused', () => {})
test.skip('permissions: re-check scope before executing; fixed plan never changes scope', () => {})
test.skip('permissions: secret-looking values in any field stay out of every store', () => {})

// --- waiting (waits for #54) ---------------------------------------------------
test.skip('waiting: related work/question pending waits; other groups never block', () => {})
test.skip('waiting: question survives a segment switch; restart recovers plan-less candidates', () => {})
test.skip('waiting: memoryReview:false skips review; no evidence means no extra model calls', () => {})

// --- recovery (waits for #54) ---------------------------------------------------
test.skip('recovery: kill after candidate persisted replays; fixed plan is never re-extracted', () => {})
test.skip('recovery: meta/by/added never drift across an overnight restart', () => {})
test.skip('recovery: dual length/secret checks at plan-write and apply', () => {})
test.skip('recovery: kill around every write; same id written exactly once', () => {})
test.skip('recovery: changed:false finishes and records the actual file; deleted entries never revive', () => {})
test.skip('recovery: manual conflict never overwritten; corrupt plan quarantined, others continue', () => {})
test.skip('recovery: memory/full pauses without spending retry budget', () => {})

// --- limits (waits for #54) -----------------------------------------------------
test.skip('limits: 8 claims cap, input caps, batch budget, format-retry and I/O backoff caps', () => {})
test.skip('limits: a repeated model call with a new callId does not pass as the same candidate', () => {})
