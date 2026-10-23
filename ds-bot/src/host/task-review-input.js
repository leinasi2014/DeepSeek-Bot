// The task review's two model inputs, kept inside one budget (#72). The design allows at
// most 8 claims, 16K characters of input and 4K per source; before this the separate
// per-field limits still added up to about 31K in one extraction request.
//
// A source is one thing the model reads: what the Bot reported, the notes, one claim, or
// the block of conversation lines. The whole request, labels and JSON included, stays at or
// below INPUT_MAX, and no source above SOURCE_MAX. When it does not fit, the fields shrink
// in a fixed order — notes, the report, the lines from 40 to 10, the evidence, the
// statement, the ref — and no claim is dropped: a claim cut short can still be answered,
// one left out cannot.

export const INPUT_MAX = 16_000
export const SOURCE_MAX = 4_000
export const CLAIMS_MAX = 8
export const EXCERPT_LINES = 40
export const EXCERPT_FLOOR_LINES = 10

// How much of each field the full request shows. `lines` is a count of conversation lines.
export const FULL_SHAPE = { notes: 4_000, result: 2_000, lines: EXCERPT_LINES, evidence: 500, statement: 1_000, ref: 200 }

const text = value => (typeof value === 'string' ? value : String(value ?? ''))
const clip = (value, max) => text(value).slice(0, max)

// The lines keep their speaker and up to the 400 characters the review has always shown.
// The block is one source, so when it would pass SOURCE_MAX the lines share what is left
// instead — 40 lines of about 99 characters, or 10 of about 399. A turn's last lines are
// what its result rests on, so the oldest go first once the count is the step being cut.
const excerpt = (lines, count) => {
  if (count <= 0) return []
  const kept = lines.slice(-count).map(line => `${text(line?.who)}: ${text(line?.text)}`.replace(/\s+/g, ' ').slice(0, 400))
  if (kept.join('\n').length <= SOURCE_MAX) return kept
  const width = Math.max(1, Math.floor((SOURCE_MAX - (kept.length - 1)) / kept.length))
  return kept.map(line => line.slice(0, width))
}

const claimsOf = (claims) => claims.slice(0, CLAIMS_MAX).map((claim, index) => ({
  index: Number.isInteger(claim?.index) ? claim.index : index,
  kind: clip(claim?.kind, 32),
  statement: text(claim?.statement),
  evidence: text(claim?.evidence),
  ref: text(claim?.ref),
}))

const extractText = (result, notes, claims, lines, shape) => [
  `The Bot reported: ${clip(result, shape.result)}`,
  `Notes: ${clip(notes, shape.notes)}`,
  `Claims: ${JSON.stringify(claims.map(claim => ({
    index: claim.index,
    kind: claim.kind,
    statement: clip(claim.statement, shape.statement),
    evidence: clip(claim.evidence, shape.evidence),
    ref: clip(claim.ref, shape.ref),
  })))}`,
  'Conversation lines (oldest first):',
  ...excerpt(lines, shape.lines),
].join('\n')

const EXTRACT_STEPS = [
  shape => ({ ...shape, notes: Math.min(shape.notes, 1_200) }),
  shape => ({ ...shape, result: Math.min(shape.result, 600) }),
  shape => ({ ...shape, lines: Math.min(shape.lines, EXCERPT_FLOOR_LINES) }),
  shape => ({ ...shape, evidence: Math.min(shape.evidence, 100) }),
  shape => ({ ...shape, statement: Math.min(shape.statement, 200) }),
  shape => ({ ...shape, ref: Math.min(shape.ref, 40) }),
]

// The shape the request is built with: the full one while it fits, otherwise the steps of
// the fixed order one at a time, stopping at the first that fits. Exported so the order can
// be checked without a model.
export function extractShape(report = {}) {
  const claims = claimsOf(report.claims ?? [])
  const lines = report.lines ?? []
  let shape = { ...FULL_SHAPE }
  for (const step of EXTRACT_STEPS) {
    if (extractText(report.result ?? '', report.notes ?? '', claims, lines, shape).length <= INPUT_MAX) break
    shape = step(shape)
  }
  return shape
}

export function extractInput(report = {}) {
  return extractText(report.result ?? '', report.notes ?? '', claimsOf(report.claims ?? []), report.lines ?? [], extractShape(report))
}

const VERIFY_FULL = { claim: 1_000, evidence: 500, context: 300 }

const VERIFY_STEPS = [
  shape => ({ ...shape, evidence: Math.min(shape.evidence, 100) }),
  shape => ({ ...shape, context: Math.min(shape.context, 120) }),
  shape => ({ ...shape, claim: Math.min(shape.claim, 200) }),
]

// The batch check: one JSON object per candidate, in the order the answers come back. The
// kind, the source type, the tool's name and its failure state travel with the quote, and
// the budget never cuts them away; only the quoted text and the claim's wording shrink.
const verifyEntry = (entry, shape) => ({
  ...entry,
  claim: clip(entry?.claim, shape.claim),
  evidence: clip(entry?.evidence, shape.evidence),
  context: clip(entry?.context, shape.context),
})

const verifyText = (entries, shape) => entries.map(entry => JSON.stringify(verifyEntry(entry, shape))).join('\n')

export function verifyShape(entries = []) {
  const kept = entries.slice(0, CLAIMS_MAX)
  let shape = { ...VERIFY_FULL }
  for (const step of VERIFY_STEPS) {
    if (verifyText(kept, shape).length <= INPUT_MAX) break
    shape = step(shape)
  }
  return shape
}

export function verifyInput(entries = []) {
  return verifyText(entries.slice(0, CLAIMS_MAX), verifyShape(entries))
}
