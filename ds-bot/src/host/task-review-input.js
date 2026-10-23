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
//
// Two things a length check alone gets wrong, both found on the boundary (#72): JSON escapes
// a control character to six characters (`\u0000`), so a field measured in raw characters
// can serialize six times larger; and an object spread carries whatever metadata a caller
// had, unbounded. Text is normalised before it is measured, the verification entry is built
// from the fields the check actually uses, and both requests end in a measured loop that
// keeps shrinking until the serialized request fits — never by slicing the JSON, which
// would leave it malformed.

export const INPUT_MAX = 16_000
export const SOURCE_MAX = 4_000
export const CLAIMS_MAX = 8
export const EXCERPT_LINES = 40
export const EXCERPT_FLOOR_LINES = 10

// How much of each field the full request shows. `lines` is a count of conversation lines.
export const FULL_SHAPE = { notes: 4_000, result: 2_000, lines: EXCERPT_LINES, evidence: 500, statement: 1_000, ref: 200 }

const text = value => (typeof value === 'string' ? value : String(value ?? ''))
// Control characters carry nothing a review can use, and each one costs six characters in
// the JSON the model reads. They become a space before anything is measured or cut.
const plain = (value) => {
  const source = text(value)
  let clean = ''
  for (const character of source) {
    const code = character.codePointAt(0)
    clean += code < 32 || (code >= 127 && code <= 159) ? ' ' : character
  }
  return clean
}
const clip = (value, max) => plain(value).slice(0, max)

// The lines keep their speaker and up to the 400 characters the review has always shown.
// The block is one source, so when it would pass SOURCE_MAX the lines share what is left
// instead — 40 lines of about 99 characters, or 10 of about 399. A turn's last lines are
// what its result rests on, so the oldest go first once the count is the step being cut.
const excerpt = (lines, count) => {
  if (count <= 0) return []
  const kept = lines.slice(-count).map(line => `${plain(line?.who)}: ${plain(line?.text)}`.replace(/\s+/g, ' ').slice(0, 400))
  if (kept.join('\n').length <= SOURCE_MAX) return kept
  const width = Math.max(1, Math.floor((SOURCE_MAX - (kept.length - 1)) / kept.length))
  return kept.map(line => line.slice(0, width))
}

const claimsOf = (claims) => claims.slice(0, CLAIMS_MAX).map((claim, index) => ({
  index: Number.isInteger(claim?.index) ? claim.index : index,
  kind: clip(claim?.kind, 32),
  statement: plain(claim?.statement),
  evidence: plain(claim?.evidence),
  ref: plain(claim?.ref),
}))

const extractText = (result, notes, claims, lines, shape) => [
  `The Bot reported: ${clip(result, shape.result)}`,
  `Notes: ${clip(notes, shape.notes)}`,
  `Claims: ${JSON.stringify(claims.map(claim => ({
    index: claim.index,
    kind: claim.kind,
    statement: claim.statement.slice(0, shape.statement),
    evidence: claim.evidence.slice(0, shape.evidence),
    ref: claim.ref.slice(0, shape.ref),
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

// What the fixed order cannot do alone: a field can serialize far wider than its raw
// length, and eight claims still add up. These halve the widths until the measured request
// fits, with a floor per field so the shape stays usable; the lines go last, and are already
// bounded by SOURCE_MAX.
const EXTRACT_FLOOR = { statement: 40, evidence: 20, ref: 10, notes: 0, result: 0 }
const halve = (value, floor) => Math.max(floor, Math.floor(value / 2))
const sameShape = (a, b) => Object.keys(a).every(key => a[key] === b[key])

// The shape the request is built with: the full one while it fits, otherwise the steps of
// the fixed order one at a time, then the measured halving. Exported so the order can be
// checked without a model.
export function extractShape(report = {}) {
  const claims = claimsOf(report.claims ?? [])
  const lines = report.lines ?? []
  const measure = shape => extractText(report.result ?? '', report.notes ?? '', claims, lines, shape).length
  let shape = { ...FULL_SHAPE }
  for (const step of EXTRACT_STEPS) {
    if (measure(shape) <= INPUT_MAX) return shape
    shape = step(shape)
  }
  for (let guard = 0; guard < 32 && measure(shape) > INPUT_MAX; guard += 1) {
    const next = {
      ...shape,
      statement: halve(shape.statement, EXTRACT_FLOOR.statement),
      evidence: halve(shape.evidence, EXTRACT_FLOOR.evidence),
      ref: halve(shape.ref, EXTRACT_FLOOR.ref),
      notes: halve(shape.notes, EXTRACT_FLOOR.notes),
      result: halve(shape.result, EXTRACT_FLOOR.result),
    }
    if (sameShape(next, shape)) break
    shape = next
  }
  return shape
}

export function extractInput(report = {}) {
  return extractText(report.result ?? '', report.notes ?? '', claimsOf(report.claims ?? []), report.lines ?? [], extractShape(report))
}

// The batch check: one JSON object per candidate, in the order the answers come back. It is
// built from the fields the check uses and nothing else, so a caller's own object cannot
// carry an unbounded field into the request; the kind, the source type, the tool's name and
// its failure state are what make the quote's provenance checkable, and the budget never
// cuts them away. Only the quoted text and the claim's wording shrink.
const VERIFY_FIELDS = { claim: 1_000, evidence: 500, context: 300 }
const VERIFY_FLOOR = { claim: 20, evidence: 10, context: 0 }

const verifyEntry = (entry, shape) => {
  const out = {
    claim: clip(entry?.claim, shape.claim),
    kind: clip(entry?.kind, 32),
    evidence: clip(entry?.evidence, shape.evidence),
    context: clip(entry?.context, shape.context),
  }
  if (entry?.sourceType !== undefined) out.sourceType = clip(entry.sourceType, 16)
  if (entry?.tool !== undefined) out.tool = clip(entry.tool, 64)
  // An error code, not a report: whatever a caller passes, the model gets at most this.
  if (entry?.toolError !== undefined) out.toolError = clip(entry.toolError, 120)
  if (typeof entry?.toolCallFailed === 'boolean') out.toolCallFailed = entry.toolCallFailed
  if (typeof entry?.toolReportedFailure === 'boolean') out.toolReportedFailure = entry.toolReportedFailure
  return out
}

const verifyText = (entries, shape) => entries.map(entry => JSON.stringify(verifyEntry(entry, shape))).join('\n')

// One entry is one source: its own JSON stays inside SOURCE_MAX even when a field holds
// characters that double under JSON escaping.
const fitEntry = (entry, shape) => {
  let next = shape
  for (let guard = 0; guard < 24; guard += 1) {
    if (JSON.stringify(verifyEntry(entry, next)).length <= SOURCE_MAX) break
    const grown = {
      ...next,
      claim: halve(next.claim, VERIFY_FLOOR.claim),
      evidence: halve(next.evidence, VERIFY_FLOOR.evidence),
      context: halve(next.context, VERIFY_FLOOR.context),
    }
    if (sameShape(grown, next)) break
    next = grown
  }
  return next
}

export function verifyShape(entries = []) {
  const kept = entries.slice(0, CLAIMS_MAX)
  const measure = shape => verifyText(kept, shape).length
  let shape = { ...VERIFY_FIELDS }
  for (const step of [
    shape => ({ ...shape, evidence: Math.min(shape.evidence, 100) }),
    shape => ({ ...shape, context: Math.min(shape.context, 120) }),
    shape => ({ ...shape, claim: Math.min(shape.claim, 200) }),
  ]) {
    if (measure(shape) <= INPUT_MAX) return shape
    shape = step(shape)
  }
  for (let guard = 0; guard < 32 && measure(shape) > INPUT_MAX; guard += 1) {
    const next = {
      ...shape,
      claim: halve(shape.claim, VERIFY_FLOOR.claim),
      evidence: halve(shape.evidence, VERIFY_FLOOR.evidence),
      context: halve(shape.context, VERIFY_FLOOR.context),
    }
    if (sameShape(next, shape)) break
    shape = next
  }
  return shape
}

export function verifyInput(entries = []) {
  const kept = entries.slice(0, CLAIMS_MAX)
  const shape = verifyShape(kept)
  return kept.map(entry => JSON.stringify(verifyEntry(entry, fitEntry(entry, shape)))).join('\n')
}
