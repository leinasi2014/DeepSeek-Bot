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
// still, so ownDelta is a verdict, not a printed number. The replace count is reported, not
// judged: A2 has no update in its messages, so a zero says nothing about the review.
export const a2Pass = ({ delta, ownDelta, indexDelta, overLimit, cursorMoved, reviews }) =>
  delta <= 14 && ownDelta <= 14 && indexDelta <= 6 && !overLimit && cursorMoved && reviews >= 1
