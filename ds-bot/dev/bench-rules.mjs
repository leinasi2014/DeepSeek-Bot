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

// Mechanical only: the 20 inputs had to review and replace something on the team memory, the
// review's place had to move in this run's conversation during the batch phase itself, and
// neither file may pass its growth budget or its size limit. A file that only grows must not
// pass by the other one staying still, so ownDelta is a verdict, not just a printed number.
export const a2Pass = ({ delta, ownDelta, teamReplaces, overLimit, cursorMoved, reviews }) =>
  delta <= 14 && ownDelta <= 14 && teamReplaces >= 1 && !overLimit && cursorMoved && reviews >= 1
