// The A2 verdict and the cursor rule, kept apart from the run so that a counterexample can
// be fed to the same code the bench judges with.

// The review's place is a number per key. Progress is a strict increase on this run's key
// with no key going backwards; a different key changing is not progress.
export const cursorProgress = (before, after) => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const advanced = keys.filter(key => Number(after[key] ?? 0) > Number(before[key] ?? 0))
  const regressed = keys.filter(key => Number(after[key] ?? 0) < Number(before[key] ?? 0))
  return { advanced, regressed, moved: advanced.length > 0 && regressed.length === 0 }
}

// Mechanical only: the 20 inputs had to review and replace something on the team memory, the
// review's place had to move during the batch phase itself, and neither file may pass its
// growth budget or its size limit. A file that only grows must not pass by the other one
// staying still, so ownDelta is a verdict, not just a printed number.
export const a2Pass = ({ delta, ownDelta, teamReplaces, overLimit, cursorMoved, reviews }) =>
  delta <= 14 && ownDelta <= 14 && teamReplaces >= 1 && !overLimit && cursorMoved && reviews >= 1
