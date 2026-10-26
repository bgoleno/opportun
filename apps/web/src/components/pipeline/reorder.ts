/**
 * Manual order within a pipeline column (issue #240): a pure function so the rank math is
 * testable without a real drag. `sortOrder` is a sparse, step-10 integer (same shape as
 * `resumeRules.sortOrder`), and every existing row defaults to 0 -- so the very first drag in
 * an untouched column drops a card into a run of ties, not a clean gap. Rather than detect
 * that case specially, every call renumbers the whole column fresh (0, 10, 20, ...) in its
 * post-drop order and returns only the ids whose rank actually changed, which is exactly the
 * run between the card's old and new position. A column nobody has ever reordered pays one
 * full renumber on its first drag; every drag after that only touches what moved.
 */
export function reorderColumn(
  ids: readonly string[],
  fromIndex: number,
  toIndex: number,
  currentSortOrder: ReadonlyMap<string, number>,
): { id: string; sortOrder: number }[] {
  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return [];
  next.splice(toIndex, 0, moved);
  const changes: { id: string; sortOrder: number }[] = [];
  next.forEach((id, i) => {
    const rank = i * 10;
    if (currentSortOrder.get(id) !== rank) changes.push({ id, sortOrder: rank });
  });
  return changes;
}
