// The board's keyboard drag (https://github.com/bgoleno/opportun/issues/475, tl's shaping):
// Left and Right step through the columns in on-screen order, collapsed rails included, and the
// column under the card's centre is the one it is over. No React here, so both are tested alone.
//
// Why: dnd-kit's sortableKeyboardCoordinates steps by geometry (the nearest droppable to the
// right, by corners) and places the card's top-left there, and rectangle overlap cannot prefer a
// 56 px rail that a 272 px card covers along with its neighbour. With Dismissed and Closed both
// collapsed, ArrowRight from Offer went straight to Closed, and Dismissed was never reachable.
import {
  KeyboardCode,
  pointerWithin,
  rectIntersection,
  type ClientRect,
  type CollisionDescriptor,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/** How far below a column's top the card's centre is put: inside the header of an expanded
 *  column, and well inside a rail. */
const CENTRE_DROP = 40;

/** Marks the board's scrolling area: the chain's columns, beside the pinned terminal ones. */
export const BOARD_SCROLLER_ATTR = 'data-board-scroller';

/**
 * The part of a droppable's rectangle that is on screen (#833, qa): a chain column scrolled
 * partly out of the board's scrolling area keeps its whole rectangle, which then overlaps the
 * terminal columns pinned beside that area (an expanded Dismissed column covers the end of
 * Offer). Clipped to the area, a hidden part is never "under" the card. Null when none of it is
 * on screen; the rectangle itself for a droppable outside the area (or with no node, in tests).
 */
export function visibleRect(
  rect: ClientRect,
  node: HTMLElement | null | undefined,
): ClientRect | null {
  const area = node?.closest(`[${BOARD_SCROLLER_ATTR}]`);
  if (area == null) return rect;
  const a = area.getBoundingClientRect();
  const left = Math.max(rect.left, a.left);
  const right = Math.min(rect.right, a.right);
  if (right <= left) return null;
  return { ...rect, left, right, width: right - left };
}

/**
 * Left and Right: the previous or next column in `columns()` (the on-screen order), with the
 * dragged card's centre on that column's centre line, near its top; nothing at either end.
 * Up and Down: sortableKeyboardCoordinates, so reordering within a column (#240) is unchanged.
 * `columnOf` names the column of a droppable: a column itself, or a card's column.
 */
export function boardKeyboardCoordinates(
  columns: () => readonly string[],
  columnOf: (id: UniqueIdentifier) => string | undefined,
): KeyboardCoordinateGetter {
  return (event, args) => {
    if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) {
      return sortableKeyboardCoordinates(event, args);
    }
    event.preventDefault();
    const { active, collisionRect, droppableContainers, droppableRects, over } = args.context;
    if (active === null || collisionRect === null) return undefined;
    const order = columns();
    // Where the card is now: what it is over, or at the start of a drag its own column.
    const current = columnOf(over?.id ?? active.id) ?? columnOf(active.id);
    const at = current === undefined ? -1 : order.indexOf(current);
    if (at === -1) return undefined;
    const target = order[at + (event.code === KeyboardCode.Right ? 1 : -1)];
    if (target === undefined) return undefined;
    const measured = droppableRects.get(target);
    if (measured === undefined) return undefined;
    // Its visible part (#833): the centre of a column half scrolled away can be hidden under
    // the pinned terminal columns, where the card would be over one of those instead.
    const rect = visibleRect(measured, droppableContainers.get(target)?.node.current);
    if (rect === null) return undefined;
    return {
      x: rect.left + rect.width / 2 - collisionRect.width / 2,
      y: rect.top + Math.min(CENTRE_DROP, rect.height / 2) - collisionRect.height / 2,
    };
  };
}

const area = (r: ClientRect) => r.width * r.height;

/**
 * The pointer's column first (a pointer drag, as before); then every droppable whose rectangle
 * holds the dragged card's centre, smallest first, so a rail wins against the card overlapping
 * its neighbour too, and a card wins against the column it sits in; then rectangle overlap.
 */
export const boardCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length > 0) return pointer;
  const { collisionRect, droppableRects, droppableContainers } = args;
  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  const holding: CollisionDescriptor[] = [];
  for (const container of droppableContainers) {
    const measured = droppableRects.get(container.id);
    if (measured === undefined) continue;
    // Only what is on screen can be under the card (#833): see visibleRect.
    const r = visibleRect(measured, container.node.current);
    if (r === null) continue;
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      holding.push({ id: container.id, data: { droppableContainer: container, value: area(r) } });
    }
  }
  if (holding.length > 0) return holding.sort((a, b) => a.data.value - b.data.value);
  return rectIntersection(args);
};
