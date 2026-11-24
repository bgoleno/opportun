// Where the queue's keyboard cursor goes when a read brings a list its row is no longer in
// (https://github.com/bgoleno/opportun/issues/968).
import { rowKey, type ResultGroup } from './groupResults';

/**
 * The row to select in `next`, read after `prev` in the same order: the selected one while it is
 * still there, else the nearest one still there after it, else before it, else none. A row is
 * followed by its members, not its key alone: a card of two locations that loses one becomes a
 * plain result with a key of its own, and the reverse.
 */
export function selectionAfterRead(
  prev: readonly ResultGroup[],
  next: readonly ResultGroup[],
  selectedKey: string,
): string | null {
  const at = prev.findIndex((g) => rowKey(g) === selectedKey);
  if (at === -1) return selectedKey;
  const rowOfMember = new Map(
    next.flatMap((g) => g.members.map((m) => [m.id, rowKey(g)] as const)),
  );
  const nearest = [...prev.slice(at), ...prev.slice(0, at).reverse()];
  for (const group of nearest) {
    for (const member of group.members) {
      const key = rowOfMember.get(member.id);
      if (key !== undefined) return key;
    }
  }
  return null;
}
