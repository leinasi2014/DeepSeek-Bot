// The A2 verdict and the cursor rule, kept apart from the run so that a counterexample can
// be fed to the same code the bench judges with.

// The review's place is a number per key. Only this run's own conversation counts: another
// chat moving on is not this run reviewing. Progress is a strict increase on that key with
// no key going backwards; the other keys are reported, never judged.
export const cursorProgress = (before, after, key) => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const advanced = keys.filter(name => Number(after[name] ?? 0) > Number(before[name] ?? 0))
  const regressed = keys.filter(name => Number(after[name] ?? 0) < Number(before[name] ?? 0))
  return {
    advanced,
    regressed,
    elsewhere: advanced.filter(name => name !== key),
    moved: advanced.includes(key) && !regressed.includes(key),
  }
}

// Mechanical only: growth stays within budget in both files, topics do not multiply (a detail
// belongs in a topic that fits, not a new one per fact), the review ran and its place moved in
// this run's own conversation. A file that only grows must not pass by the other one standing
// still, so ownDelta is a verdict, not a printed number.
//
// This scenario says nothing about merging: its twenty messages hold no update, so a zero
// replace count is expected and the count is reported, never judged. Whether a changed fact
// becomes one entry or two is A2b's verdict — an A2 PASS is not evidence that memory kept no
// duplicates.
export const a2Pass = ({ delta, ownDelta, indexDelta, overLimit, cursorMoved, reviews }) =>
  delta <= 14 && ownDelta <= 14 && indexDelta <= 6 && !overLimit && cursorMoved && reviews >= 1

// A2b: one fact that changed, and what the team's files say about it afterwards. The value is
// matched whole — "三条以内" also sits inside "十三条以内" — and every team file counts, so an
// entry moved into a topic is still that one entry, not a lost one.
export const saysValue = (text, value) => new RegExp(`(^|[^\\d一二三四五六七八九十百])${value}`).test(text)
export const a2bOutcome = (entries, fresh = '三条以内', old = '五条以内') => {
  const saysNew = entries.filter(entry => saysValue(entry.text, fresh)).length
  const saysOld = entries.filter(entry => saysValue(entry.text, old)).length
  if (entries.length === 0) return 'lost'
  if (entries.length > 1) return 'duplicate'
  if (saysNew === 1) return 'updated'
  if (saysOld === 1) return 'untouched'
  return 'other'
}

// Three completed rounds: an errored round is not a round, so a run cannot pass on two results
// and a crash. No round may leave two entries about the fact, and at least two must end with
// one entry saying the new value.
export const a2bSummary = rounds => {
  const done = rounds.filter(item => item.outcome !== undefined)
  const updated = done.filter(item => item.outcome === 'updated').length
  const bad = done.filter(item => item.outcome === 'duplicate' || item.outcome === 'lost').length
  return { done: done.length, updated, bad, incomplete: rounds.length - done.length, pass: done.length >= 3 && bad === 0 && updated >= 2 }
}
