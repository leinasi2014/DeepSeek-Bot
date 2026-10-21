import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReview } from '../src/host/memory.js'

// The type is judged once, for every op the review may return. An unknown type must make
// the whole answer invalid rather than be dropped quietly, or the model is told its change
// went through when it did not. parseReview returns the list of changes, or undefined.
const answer = change => JSON.stringify({ changes: [change] })

test('an unknown kind invalidates the whole review, for add, edit and move', () => {
  for (const op of ['add', 'edit', 'move']) {
    for (const kind of ['fact', '', 'HOWTO']) {
      assert.equal(parseReview(answer({ op, entry: 1, text: 'x', topic: 'ops', kind })), undefined, `${op} with kind ${JSON.stringify(kind)} is refused`)
    }
  }
})

test('leaving the kind out is always allowed', () => {
  for (const op of ['add', 'edit', 'move']) {
    const parsed = parseReview(answer({ op, entry: 1, text: 'x', topic: 'ops' }))
    assert.ok(Array.isArray(parsed), `${op} without a kind is valid`)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].kind, undefined, 'no kind is invented')
  }
})

test('kind howto is allowed on every op', () => {
  for (const op of ['add', 'edit', 'move']) {
    const parsed = parseReview(answer({ op, entry: 1, text: 'x', topic: 'ops', kind: 'howto' }))
    assert.ok(Array.isArray(parsed), `${op} with kind howto is valid`)
    assert.equal(parsed[0].kind, 'howto')
  }
})
