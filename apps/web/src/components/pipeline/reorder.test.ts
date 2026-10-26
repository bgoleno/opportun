import { describe, expect, it } from 'vitest';
import { reorderColumn } from './reorder';

describe('reorderColumn (issue #240)', () => {
  it('renumbers an untouched column (every card tied at 0) on its first drag', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const sortOrder = new Map(ids.map((id) => [id, 0]));
    // Drag the last card ('d') to the front. Every card is tied at 0, including 'd' itself,
    // so 'd' landing at index 0 (rank 0) is coincidentally unchanged; a, b, c shift down.
    const changes = reorderColumn(ids, 3, 0, sortOrder);
    expect(changes).toEqual([
      { id: 'a', sortOrder: 10 },
      { id: 'b', sortOrder: 20 },
      { id: 'c', sortOrder: 30 },
    ]);
  });

  it('after the first renumber, a later drag only touches the cards between old and new position', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const sortOrder = new Map([
      ['a', 0],
      ['b', 10],
      ['c', 20],
      ['d', 30],
    ]);
    // Move 'c' up to just after 'a' (index 1): a, c, b, d.
    const changes = reorderColumn(ids, 2, 1, sortOrder);
    expect(changes).toEqual([
      { id: 'c', sortOrder: 10 },
      { id: 'b', sortOrder: 20 },
    ]);
  });

  it('dropping a card back on its own position changes nothing', () => {
    const ids = ['a', 'b', 'c'];
    const sortOrder = new Map([
      ['a', 0],
      ['b', 10],
      ['c', 20],
    ]);
    expect(reorderColumn(ids, 1, 1, sortOrder)).toEqual([]);
  });

  it('moving the top card to the bottom only shifts the ones it passed', () => {
    const ids = ['a', 'b', 'c'];
    const sortOrder = new Map([
      ['a', 0],
      ['b', 10],
      ['c', 20],
    ]);
    const changes = reorderColumn(ids, 0, 2, sortOrder);
    expect(changes).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'c', sortOrder: 10 },
      { id: 'a', sortOrder: 20 },
    ]);
  });
});
