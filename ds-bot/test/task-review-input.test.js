// #72: the task review's model inputs have one total budget and one per-source budget.
// These cover the request the old code could build (about 31K characters), the boundary,
// and what must survive a cut: every claim with its index and kind, the tool identity and
// failure state of a quote, and the fixed order in which fields are shortened.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLAIMS_MAX, EXCERPT_FLOOR_LINES, EXCERPT_LINES, FULL_SHAPE, INPUT_MAX, SOURCE_MAX,
  extractInput, extractShape, verifyInput,
} from '../src/host/task-review-input.js'

const filler = (start, length) => `${start} ${'x'.repeat(Math.max(0, length - start.length - 1))}`
const lines = (count, width = 400) => Array.from({ length: count }, (_, at) => ({ who: at % 2 ? 'tool' : 'user', text: filler(`line ${at + 1}`, width) }))
const claims = (count = CLAIMS_MAX) => Array.from({ length: count }, (_, at) => ({
  index: at,
  kind: at % 2 ? 'command' : 'user',
  statement: filler(`claim ${at + 1}`, 1000),
  evidence: filler(`evidence ${at + 1}`, 500),
  ref: filler(`ref ${at + 1}`, 200),
}))

// What the code before the budget built: every field at its own limit, every line at 400
// characters and no total check. Kept as the counterexample the issue describes.
const unbudgeted = ({ result, notes, claims: list, lines: conversation }) => [
  `The Bot reported: ${result.slice(0, 2000)}`,
  `Notes: ${notes.slice(0, 4000)}`,
  `Claims: ${JSON.stringify(list.map(claim => ({ index: claim.index, kind: claim.kind, statement: claim.statement.slice(0, 1000), evidence: claim.evidence.slice(0, 500), ref: claim.ref.slice(0, 200) })))}`,
  'Conversation lines (oldest first):',
  ...conversation.slice(-40).map(line => `${line.who}: ${line.text}`.replace(/\s+/g, ' ').slice(0, 400)),
].join('\n')

const huge = {
  result: filler('The report', 2000),
  notes: filler('The notes', 4000),
  claims: claims(),
  lines: lines(EXCERPT_LINES),
}

const claimsOf = request => JSON.parse(request.slice(request.indexOf('Claims: ') + 'Claims: '.length, request.indexOf('\nConversation lines')))
const blockOf = request => request.slice(request.indexOf('Conversation lines (oldest first):\n') + 'Conversation lines (oldest first):\n'.length)
const notesOf = request => request.slice(request.indexOf('Notes: ') + 'Notes: '.length, request.indexOf('\nClaims: '))
const reportedOf = request => request.slice('The Bot reported: '.length, request.indexOf('\nNotes: '))

test('the old fields add up to about 31K characters in one extraction request', () => {
  const request = unbudgeted(huge)
  assert.ok(request.length > 31_000, `the counterexample is ${request.length} characters`)
})

test('the same report now fits the total budget, labels and JSON included', () => {
  const request = extractInput(huge)
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length} characters`)
  assert.match(request, /^The Bot reported: /)
  assert.match(request, /\nNotes: /)
  assert.match(request, /\nClaims: \[/)
  assert.match(request, /\nConversation lines \(oldest first\):\n/)
})

test('every claim is kept, with its index and kind, so every answer still has a question', () => {
  const parsed = claimsOf(extractInput(huge))
  assert.equal(parsed.length, CLAIMS_MAX)
  assert.deepEqual(parsed.map(claim => claim.index), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(parsed.map(claim => claim.kind), ['user', 'command', 'user', 'command', 'user', 'command', 'user', 'command'])
  assert.ok(parsed.every(claim => claim.statement.length > 0 && claim.evidence.length > 0 && claim.ref.length > 0), 'no field is emptied to make room')
})

test('more claims than the limit keep the first eight, never more', () => {
  const many = Array.from({ length: 10 }, (_, at) => ({ ...claims(1)[0], index: at }))
  const parsed = claimsOf(extractInput({ ...huge, claims: many }))
  assert.equal(parsed.length, CLAIMS_MAX)
  assert.deepEqual(parsed.map(claim => claim.index), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('each source stays at or below its own limit: the report, the notes, each claim, the line block', () => {
  for (const report of [huge, { ...huge, claims: [], lines: lines(EXCERPT_LINES, 4000) }]) {
    const request = extractInput(report)
    assert.ok(reportedOf(request).length <= SOURCE_MAX, `the report is ${reportedOf(request).length}`)
    assert.ok(notesOf(request).length <= SOURCE_MAX, `the notes are ${notesOf(request).length}`)
    assert.ok(blockOf(request).length <= SOURCE_MAX, `the line block is ${blockOf(request).length}`)
    for (const claim of claimsOf(request)) assert.ok(JSON.stringify(claim).length <= SOURCE_MAX)
  }
})

test('a request that already fits is left whole: nothing is cut for room it does not need', () => {
  const report = { result: 'ran the release', notes: 'one note', claims: [{ index: 0, kind: 'command', statement: 'the suite passes', evidence: 'tests 12/12', ref: 'bash k1' }], lines: [{ who: 'tool', text: 'tests 12/12 passing' }] }
  assert.equal(extractInput(report), [
    'The Bot reported: ran the release',
    'Notes: one note',
    'Claims: [{"index":0,"kind":"command","statement":"the suite passes","evidence":"tests 12/12","ref":"bash k1"}]',
    'Conversation lines (oldest first):',
    'tool: tests 12/12 passing',
  ].join('\n'))
})

// The realised shape must always be the full one with the first steps of the order applied,
// and no others: that is what "fixed priority" means, and it is what keeps a mild overflow
// from cutting the evidence a claim will be judged on.
const steps = [
  next => ({ ...next, notes: 1_200 }),
  next => ({ ...next, result: 600 }),
  next => ({ ...next, lines: EXCERPT_FLOOR_LINES }),
  next => ({ ...next, evidence: 100 }),
  next => ({ ...next, statement: 200 }),
  next => ({ ...next, ref: 40 }),
]
const prefix = at => {
  let shape = { ...FULL_SHAPE }
  for (let step = 0; step < at; step += 1) shape = steps[step](shape)
  return shape
}
const isPrefix = shape => [0, 1, 2, 3, 4, 5, 6].some(at => JSON.stringify(prefix(at)) === JSON.stringify(shape))

test('the cut is a fixed prefix of one order: notes, report, lines, evidence, statement, ref', () => {
  const reports = [
    huge,
    { ...huge, lines: [] },
    { ...huge, claims: [] },
    { result: '', notes: '', claims: claims(), lines: lines(EXCERPT_LINES, 4000) },
  ]
  for (const report of reports) {
    const shape = extractShape(report)
    assert.ok(isPrefix(shape), `the shape is not a prefix of the order: ${JSON.stringify(shape)}`)
    assert.ok(extractInput(report).length <= INPUT_MAX)
  }
})

test('the order stops as soon as the request fits: a mild overflow shortens the notes only', () => {
  // Four full claims, a full report, the notes and forty ordinary lines: the notes are the
  // first step and are enough, so the report, the lines and the claim fields keep the shape
  // the review always had.
  const report = { result: filler('The report', 2000), notes: filler('The notes', 4000), claims: claims(4), lines: lines(EXCERPT_LINES, 80) }
  assert.ok(extractInput(report).length <= INPUT_MAX)
  const shape = extractShape(report)
  assert.equal(shape.notes, 1_200)
  assert.equal(shape.result, FULL_SHAPE.result)
  assert.equal(shape.lines, FULL_SHAPE.lines)
  assert.equal(shape.evidence, FULL_SHAPE.evidence)
  assert.equal(shape.statement, FULL_SHAPE.statement)
})

test('a backlog of long lines drops to ten before any claim field is cut, and the newest stay', () => {
  const report = { result: filler('The report', 2000), notes: filler('The notes', 4000), claims: claims(), lines: lines(EXCERPT_LINES, 4000) }
  const shape = extractShape(report)
  assert.equal(shape.lines, EXCERPT_FLOOR_LINES)
  const block = blockOf(extractInput(report))
  assert.equal(block.split('\n').length, EXCERPT_FLOOR_LINES)
  assert.match(block, /line 40 /)
  assert.doesNotMatch(block, /line 1 /)
})

test('with the lines at their floor, the evidence is cut before the statement and the ref', () => {
  const report = { result: '', notes: '', claims: claims(), lines: lines(EXCERPT_LINES, 4000) }
  const shape = extractShape(report)
  assert.equal(shape.evidence, 100)
  assert.equal(shape.statement, FULL_SHAPE.statement)
  assert.equal(shape.ref, FULL_SHAPE.ref)
  const request = extractInput(report)
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length}`)
  assert.equal(claimsOf(request).length, CLAIMS_MAX, 'nothing is dropped to fit')
})

test('the boundary is exact: a request of exactly the limit is kept whole, one more character cuts', () => {
  // Seven full claims and a full report leave room in the notes; the notes are sized to land
  // exactly on the limit. Nothing may be cut at the boundary, and one more character must be.
  const report = { result: filler('The report', 2000), notes: '', claims: claims(7), lines: [] }
  const room = INPUT_MAX - extractInput(report).length
  assert.ok(room > 0 && room <= FULL_SHAPE.notes, `the notes have ${room} characters of room`)
  const exact = { ...report, notes: 'n'.repeat(room) }
  assert.equal(extractInput(exact).length, INPUT_MAX, 'the fixture sits on the boundary')
  assert.equal(extractShape(exact).notes, FULL_SHAPE.notes, 'no step runs while the request fits')
  const over = { ...report, notes: 'n'.repeat(room + 1) }
  assert.ok(extractInput(over).length <= INPUT_MAX, `one character over must still fit: ${extractInput(over).length}`)
  assert.equal(extractShape(over).notes, 1_200, 'the first step is the one that ran')
})

// --- boundary cases found on the first pure-helper review (#72) ----------------

const NUL = '\u0000'

// What the old helper did with these inputs: the fields were measured in raw characters and
// the verification entry was a spread of the caller's object, so JSON escaping and metadata
// were never counted. Both builders are the counterexamples, not the implementation.
const oldExtract = (report) => [
  `The Bot reported: ${report.result.slice(0, 2000)}`,
  `Notes: ${report.notes.slice(0, 4000)}`,
  `Claims: ${JSON.stringify(report.claims.map(claim => ({ index: claim.index, kind: claim.kind, statement: claim.statement.slice(0, 1000), evidence: claim.evidence.slice(0, 500), ref: claim.ref.slice(0, 200) })))}`,
  'Conversation lines (oldest first):',
  ...report.lines.slice(-40).map(line => `${line.who}: ${line.text}`.replace(/\s+/g, ' ').slice(0, 400)),
].join('\n')
const oldVerify = (entries) => entries.map(entry => JSON.stringify({ ...entry, claim: String(entry.claim).slice(0, 1000), evidence: String(entry.evidence).slice(0, 500), context: String(entry.context).slice(0, 300) })).join('\n')

const controlClaims = () => Array.from({ length: CLAIMS_MAX }, (_, at) => ({
  index: at,
  kind: at % 2 ? 'command' : 'user',
  statement: NUL.repeat(1000),
  evidence: NUL.repeat(500),
  ref: NUL.repeat(200),
}))

test('control characters are measured as they serialize, not as they are stored', () => {
  const report = { result: '', notes: '', claims: controlClaims(), lines: [] }
  assert.ok(oldExtract(report).length > 22_000, `the counterexample is ${oldExtract(report).length} characters`)
  const request = extractInput(report)
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length} characters`)
  // Both claims and structure survive: eight claims, each with its index and kind.
  const parsed = claimsOf(request)
  assert.equal(parsed.length, CLAIMS_MAX)
  assert.deepEqual(parsed.map(claim => claim.kind), ['user', 'command', 'user', 'command', 'user', 'command', 'user', 'command'])
  // The control characters are gone from what the model reads.
  assert.equal([...request].some(character => character.codePointAt(0) < 32 && character !== '\n'), false)
})

test('the same control characters in a verification request cannot grow it sixfold', () => {
  const entries = controlClaims().map(claim => ({
    claim: claim.statement,
    kind: claim.kind,
    evidence: claim.evidence,
    context: claim.ref,
    sourceType: 'tool',
    tool: 'bash',
    toolCallFailed: false,
  }))
  assert.ok(oldVerify(entries).length > 20_000, `the counterexample is ${oldVerify(entries).length} characters`)
  const request = verifyInput(entries)
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length} characters`)
  const parsed = request.split('\n').map(line => JSON.parse(line))
  assert.equal(parsed.length, CLAIMS_MAX, 'every candidate keeps its line, in order')
  assert.ok(parsed.every(entry => entry.sourceType === 'tool' && entry.tool === 'bash' && entry.toolCallFailed === false))
  assert.equal([...request].some(character => character.codePointAt(0) < 32 && character !== '\n'), false)
})

test('unbounded metadata in one entry is bounded, and the entry is not dropped', () => {
  const entry = {
    claim: '发布脚本跑通了',
    kind: 'command',
    evidence: 'tests 12/12',
    context: 'tests 12/12 passing',
    sourceType: 'tool',
    tool: 'bash',
    toolCallFailed: false,
    toolError: 'E'.repeat(20_000),
  }
  assert.ok(oldVerify([entry]).length > 20_000, `the counterexample is ${oldVerify([entry]).length} characters`)
  const request = verifyInput([entry])
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length} characters`)
  assert.ok(request.length <= SOURCE_MAX, `one entry is one source: ${request.length}`)
  const parsed = JSON.parse(request)
  assert.equal(parsed.claim, '发布脚本跑通了', 'the claim itself is kept')
  assert.equal(parsed.kind, 'command')
  assert.equal(parsed.tool, 'bash')
  assert.equal(parsed.toolCallFailed, false)
  assert.ok(parsed.toolError.length <= 120, `the error code is ${parsed.toolError.length}`)
})

test('normal content is preserved whole: only the budget cuts, never the shape', () => {
  const report = {
    result: '发布脚本 scripts/ship.sh 跑完了',
    notes: '先跑 npm test，再发布',
    claims: [
      { index: 0, kind: 'command', statement: '发布前必须先跑测试', evidence: 'tests 12/12 passing', ref: 'bash k1' },
      { index: 1, kind: 'user', statement: '用户希望发布在周五', evidence: 'Deploys go out on Friday', ref: 'part 1 #10' },
    ],
    lines: [{ who: 'tool', text: 'tests 12/12 passing\n[exit code: 0]' }, { who: 'user', text: 'Deploys go out on Friday' }],
  }
  assert.equal(extractInput(report), oldExtract(report), 'a request inside the budget is byte-for-byte what it was')
  assert.equal(verifyInput([{ claim: '发布前必须先跑测试', kind: 'command', evidence: 'tests 12/12 passing', context: 'tests 12/12 passing', sourceType: 'tool', tool: 'bash', toolCallFailed: false }]),
    JSON.stringify({ claim: '发布前必须先跑测试', kind: 'command', evidence: 'tests 12/12 passing', context: 'tests 12/12 passing', sourceType: 'tool', tool: 'bash', toolCallFailed: false }))
})

test('characters that grow under JSON escaping are counted as they serialize', () => {
  // A backslash becomes two characters and a quote two, so a field of 4,000 of them is 8,000
  // in the JSON. The budget is measured on the serialized text, so the request still fits.
  const report = {
    result: '\\'.repeat(4000),
    notes: '"'.repeat(8000),
    claims: Array.from({ length: CLAIMS_MAX }, (_, at) => ({ index: at, kind: 'command', statement: '\\'.repeat(1000), evidence: '"'.repeat(500), ref: '\\"'.repeat(100) })),
    lines: Array.from({ length: EXCERPT_LINES }, () => ({ who: 'user', text: '\\'.repeat(4000) })),
  }
  const request = extractInput(report)
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length}`)
  assert.equal(claimsOf(request).length, CLAIMS_MAX)
  const entries = Array.from({ length: CLAIMS_MAX }, () => ({
    claim: '\\'.repeat(1000), kind: 'command', evidence: '"'.repeat(500), context: '\\'.repeat(300),
    sourceType: 'tool', tool: 'bash', toolCallFailed: false, toolError: '\\'.repeat(20_000),
  }))
  const verify = verifyInput(entries)
  assert.ok(verify.length <= INPUT_MAX, `the verification request is ${verify.length}`)
  for (const line of verify.split('\n')) assert.ok(line.length <= SOURCE_MAX, `an entry is ${line.length}`)
})

test('a resolved entry keeps its own shape: provenance and booleans are typed, not shorten', () => {
  const parsed = JSON.parse(verifyInput([{ claim: 'c', kind: 'command', evidence: 'e', context: 'x', sourceType: 'tool', tool: 'bash', toolCallFailed: true, toolReportedFailure: false, toolError: 'E_FAIL' }]))
  assert.deepEqual(parsed, { claim: 'c', kind: 'command', evidence: 'e', context: 'x', sourceType: 'tool', tool: 'bash', toolError: 'E_FAIL', toolCallFailed: true, toolReportedFailure: false })
})

test('a candidate as taskReview.enqueue stores it is what the helpers are given', () => {
  // The record's own limits, from task-review.js/enqueue and the complete_task tool: a 2,000
  // character result, 4,000 characters of notes and eight claims of kind/statement/evidence/
  // ref at 1,000/500/200. This is the shape the wiring passes in, not a hand-made one.
  const record = {
    result: filler('The report', 2000),
    notes: filler('The notes', 4000),
    claims: claims(8).map((claim, at) => ({ kind: at % 2 ? 'command' : 'user', statement: claim.statement, evidence: claim.evidence, ref: claim.ref })),
  }
  const request = extractInput({ ...record, lines: lines(EXCERPT_LINES, 400) })
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length}`)
  assert.deepEqual(claimsOf(request).map(claim => claim.kind), ['user', 'command', 'user', 'command', 'user', 'command', 'user', 'command'])
  // Fields the record does not carry, or a caller's extra ones, never reach the model.
  const extra = extractInput({ result: 'done', notes: '', claims: [{ kind: 'user', statement: 's', evidence: 'e', ref: 'r', internal: 'x'.repeat(5000) }], lines: [], secret: 'y'.repeat(5000) })
  assert.equal(extra, ['The Bot reported: done', 'Notes: ', 'Claims: [{"index":0,"kind":"user","statement":"s","evidence":"e","ref":"r"}]', 'Conversation lines (oldest first):'].join('\n'))
})

test('a report of nothing still produces a well-formed request', () => {
  assert.equal(extractInput(), ['The Bot reported: ', 'Notes: ', 'Claims: []', 'Conversation lines (oldest first):'].join('\n'))
  assert.match(extractInput({ claims: [{ kind: 'user', statement: 's', evidence: 'e', ref: 'r' }] }), /"index":0/, 'a claim without an index gets its position')
})

// --- the batch verification request -----------------------------------------

const candidates = (count = CLAIMS_MAX) => Array.from({ length: count }, (_, at) => ({
  claim: filler(`claim ${at + 1}`, 1000),
  kind: at % 2 ? 'command' : 'user',
  evidence: filler(`evidence ${at + 1}`, 500),
  context: filler(`context ${at + 1}`, 300),
  sourceType: 'tool',
  tool: 'bash',
  toolCallFailed: false,
}))

test('the verification request fits the same budget and keeps every candidate in order', () => {
  const request = verifyInput(candidates())
  assert.ok(request.length <= INPUT_MAX, `the request is ${request.length}`)
  const parsed = request.split('\n').map(line => JSON.parse(line))
  assert.equal(parsed.length, CLAIMS_MAX)
  assert.deepEqual(parsed.map(entry => entry.claim.slice(0, 7)), ['claim 1', 'claim 2', 'claim 3', 'claim 4', 'claim 5', 'claim 6', 'claim 7', 'claim 8'])
  assert.ok(parsed.every(entry => entry.sourceType === 'tool' && entry.tool === 'bash' && entry.toolCallFailed === false), 'the provenance is never cut')
})

test('a verification entry that fits is unchanged, field for field', () => {
  const entry = { claim: '发布脚本跑通了，测试 12/12 通过', kind: 'command', evidence: 'tests 12/12', context: 'tests 12/12 passing', sourceType: 'tool', tool: 'bash', toolCallFailed: false, toolReportedFailure: false }
  assert.equal(verifyInput([entry]), JSON.stringify(entry))
})

test('an empty or oversized verification list is one object per kept candidate', () => {
  assert.equal(verifyInput(), '')
  assert.equal(verifyInput(candidates(10)).split('\n').length, CLAIMS_MAX)
})
