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

/** The column a keyboard drag last stepped to, or null: not yet, or Up or Down since. */
export interface KeyboardStep {
  current: string | null;
}

/**
 * Scrolls the board's area, at once, so that a chain column is in view (centred when it is wider
 * than the area). A pinned terminal column is always in view: the area is then scrolled to its end
 * beside it, which also leaves dnd-kit's sensor nothing of its own to scroll (it scrolls a card's
 * scrollable ancestors toward the arrow, and would scroll instead of moving the card).
 */
function bringIntoView(
  target: HTMLElement | null | undefined,
  from: HTMLElement | null | undefined,
) {
  const board = `[${BOARD_SCROLLER_ATTR}]`;
  const area = target?.closest(board);
  if (target == null) return;
  if (area == null) {
    const fromArea = from?.closest(board);
    if (fromArea != null) fromArea.scrollLeft = fromArea.scrollWidth;
    return;
  }
  const a = area.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  if (t.width > a.width) area.scrollLeft += t.left + t.width / 2 - (a.left + a.width / 2);
  else if (t.left < a.left) area.scrollLeft += t.left - a.left;
  else if (t.right > a.right) area.scrollLeft += t.right - a.right;
}

/**
 * Left and Right: the previous or next column in `columns()` (the on-screen order), scrolled into
 * view when the board is narrower than its columns (#886), with the dragged card's centre on the
 * centre line of its visible part, near its top; nothing at either end. `step` records the column,
 * which is what the card is then over (`keyboardFirst`), wherever scrolling leaves the card.
 * Up and Down: sortableKeyboardCoordinates, so reordering within a column (#240) is unchanged, and
 * what the card is over is again decided by where it is.
 * `columnOf` names the column of a droppable: a column itself, or a card's column.
 */
export function boardKeyboardCoordinates(
  columns: () => readonly string[],
  columnOf: (id: UniqueIdentifier) => string | undefined,
  step?: KeyboardStep,
): KeyboardCoordinateGetter {
  return (event, args) => {
    if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) {
      const next = sortableKeyboardCoordinates(event, args);
      if (next !== undefined && step !== undefined) step.current = null;
      return next;
    }
    event.preventDefault();
    const { active, collisionRect, droppableContainers, droppableRects, over } = args.context;
    if (active === null || collisionRect === null) return undefined;
    const order = columns();
    // Where the card is now: the column it stepped to, or what it is over, or at the start of a
    // drag its own column.
    const current = step?.current ?? columnOf(over?.id ?? active.id) ?? columnOf(active.id);
    const at = current === undefined ? -1 : order.indexOf(current);
    if (current === undefined || at === -1) return undefined;
    const target = order[at + (event.code === KeyboardCode.Right ? 1 : -1)];
    if (target === undefined) return undefined;
    const node = droppableContainers.get(target)?.node.current;
    bringIntoView(node, droppableContainers.get(current)?.node.current);
    // dnd-kit's measured rectangles follow the scroll, so this is where the column is now.
    const measured = droppableRects.get(target);
    if (measured === undefined) return undefined;
    if (step !== undefined) step.current = target;
    // Its visible part (#833): the centre of a column half scrolled away can be hidden under
    // the pinned terminal columns. Null only when the board's area has no width left at all.
    const rect = visibleRect(measured, node) ?? measured;
    return {
      x: rect.left + rect.width / 2 - collisionRect.width / 2,
      y: rect.top + Math.min(CENTRE_DROP, rect.height / 2) - collisionRect.height / 2,
    };
  };
}

/**
 * The column a keyboard drag stepped to, when it has (#886); otherwise `boardCollision`. A step
 * names its column, so it does not depend on where the card and a scrolled column ended up. Only
 * for the keyboard: a pointer drag has pointer coordinates, and never a step.
 */
export function keyboardFirst(step: Readonly<KeyboardStep>): CollisionDetection {
  return (args) => {
    if (args.pointerCoordinates === null && step.current !== null) {
      const container = args.droppableContainers.find((c) => c.id === step.current);
      if (container !== undefined) {
        return [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
      }
    }
    return boardCollision(args);
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
