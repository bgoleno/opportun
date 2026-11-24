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
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/** How far below a column's top the card's centre is put: inside the header of an expanded
 *  column, and well inside a rail. */
const CENTRE_DROP = 40;

/** The space between the board's columns, as its class and in pixels: they go together. */
export const BOARD_GAP_CLASS = 'gap-3';
const BOARD_GAP_PX = 12;

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
 * Where a keyboard drag is (#886), both null when there is none.
 * - `at` is what the card is over, whatever its centre is under: the card itself from its pick-up,
 *   the column after Left or Right. Null once Up or Down has moved it.
 * - `column` is the column that is in. A chain column narrower than the card leaves the card's
 *   centre under a pinned column beside it, so after Up or Down the card stays in this column
 *   while its centre is anywhere in it, on screen or not.
 */
export interface KeyboardStep {
  at: UniqueIdentifier | null;
  column: string | null;
}

/**
 * Scrolls the board's area, at once, so that a chain column is in view, centred when it is wider
 * than the area. A pinned terminal column is always in view.
 */
function bringIntoView(target: HTMLElement | null | undefined) {
  const area = target?.closest(`[${BOARD_SCROLLER_ATTR}]`);
  if (target == null || area == null) return;
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
 * what the card is over is decided by where it is.
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
      if (next !== undefined && step !== undefined) step.at = null;
      return next;
    }
    event.preventDefault();
    const { active, collisionRect, droppableContainers, droppableRects, over } = args.context;
    if (active === null || collisionRect === null) return undefined;
    const order = columns();
    // Where the card is now: what the step says, or what it is over, or at the start of a drag its
    // own column.
    const current = columnOf(step?.at ?? over?.id ?? active.id) ?? columnOf(active.id);
    const at = current === undefined ? -1 : order.indexOf(current);
    if (current === undefined || at === -1) return undefined;
    const target = order[at + (event.code === KeyboardCode.Right ? 1 : -1)];
    if (target === undefined) return undefined;
    const node = droppableContainers.get(target)?.node.current;
    bringIntoView(node);
    // The board has scrolled itself. dnd-kit's sensor next scrolls the card's scrollable ancestors
    // toward the arrow by its own rule, reading them from this same context, which would take the
    // column away from under the card again, so a step leaves it none to scroll.
    args.context.scrollableAncestors = [];
    // dnd-kit's measured rectangles follow the scroll, so this is where the column is now.
    const measured = droppableRects.get(target);
    if (measured === undefined) return undefined;
    if (step !== undefined) {
      step.at = target;
      step.column = target;
    }
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
 * What a keyboard drag is over (#886): what its step says (`KeyboardStep.at`); else, after Up or
 * Down, its column's droppable that holds the card's centre, on screen or not, smallest first; else
 * `boardCollision`. A pointer drag has pointer coordinates and no step: always `boardCollision`.
 */
export function keyboardFirst(
  step: Readonly<KeyboardStep>,
  columnOf: (id: UniqueIdentifier) => string | undefined,
): CollisionDetection {
  return (args) => {
    if (args.pointerCoordinates !== null) return boardCollision(args);
    const at = args.droppableContainers.find((c) => c.id === step.at);
    if (at !== undefined) return [{ id: at.id, data: { droppableContainer: at, value: 0 } }];
    if (step.column !== null) {
      const own = args.droppableContainers.filter((c) => columnOf(c.id) === step.column);
      const holding = holdingCentre(args, own, (rect) => rect);
      if (holding.length > 0) return holding;
    }
    return boardCollision(args);
  };
}

const area = (r: ClientRect) => r.width * r.height;

/** The containers whose rectangle, as `seen` gives it, holds the card's centre, smallest first. */
function holdingCentre(
  args: Parameters<CollisionDetection>[0],
  containers: readonly DroppableContainer[],
  seen: (rect: ClientRect, node: HTMLElement | null) => ClientRect | null,
): CollisionDescriptor[] {
  const { collisionRect, droppableRects } = args;
  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  const holding: CollisionDescriptor[] = [];
  for (const container of containers) {
    const measured = droppableRects.get(container.id);
    if (measured === undefined) continue;
    const r = seen(measured, container.node.current);
    if (r === null) continue;
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      holding.push({ id: container.id, data: { droppableContainer: container, value: area(r) } });
    }
  }
  return holding.sort((a, b) => a.data.value - b.data.value);
}

/** Every droppable's visible part (visibleRect); one with none has no rectangle here. */
function visibleRects({
  droppableContainers,
  droppableRects,
}: Parameters<CollisionDetection>[0]): Map<UniqueIdentifier, ClientRect> {
  const seen = new Map<UniqueIdentifier, ClientRect>();
  for (const { id, node } of droppableContainers) {
    const measured = droppableRects.get(id);
    const visible = measured === undefined ? null : visibleRect(measured, node.current);
    if (visible !== null) seen.set(id, visible);
  }
  return seen;
}

type Point = NonNullable<Parameters<CollisionDetection>[0]['pointerCoordinates']>;

/** What is under `point` on screen, as dnd-kit orders it: a card before the column it is in. */
function pointerOver(
  args: Parameters<CollisionDetection>[0],
  seen: ReadonlyMap<UniqueIdentifier, ClientRect>,
  point: Point,
) {
  return pointerWithin({ ...args, pointerCoordinates: point }).filter(({ id }) => {
    const rect = seen.get(id);
    return rect !== undefined && point.x >= rect.left && point.x <= rect.right;
  });
}

/**
 * For a point in a gap beside a column on screen, at its height: the point at the same height on the
 * nearest such column's centre line (the left one's, half way), so a card there keeps its place.
 * Null for a point that is in no gap. A card is inside its column, so never the nearest itself.
 */
function besideGap(seen: ReadonlyMap<UniqueIdentifier, ClientRect>, point: Point): Point | null {
  let nearest: { rect: ClientRect; away: number } | null = null;
  for (const rect of seen.values()) {
    if (point.y < rect.top || point.y > rect.bottom) continue;
    const onLeft = point.x > rect.right;
    const away = onLeft ? point.x - rect.right : rect.left - point.x;
    if (away < 0 || away > BOARD_GAP_PX) continue;
    if (nearest === null || away < nearest.away || (away === nearest.away && onLeft)) {
      nearest = { rect, away };
    }
  }
  if (nearest === null) return null;
  return { x: (nearest.rect.left + nearest.rect.right) / 2, y: point.y };
}

/**
 * The pointer's column first (a pointer drag, as before); then every droppable whose rectangle
 * holds the dragged card's centre, smallest first, so a rail wins against the card overlapping
 * its neighbour too, and a card wins against the column it sits in; then rectangle overlap.
 *
 * For a pointer, all three are of what is on screen (#960): a chain column scrolled behind a pinned
 * one is under the pointer too, and a drop there moved the card to a stage nobody saw. So a card
 * that touches no column on screen is over nothing. And a pointer in a gap is in the column beside
 * it: the card's centre, a hand's width away, could be over a rail, and while the board scrolls
 * itself every gap passes under the pointer. With no pointer the steps are as they were: a keyboard
 * drag has its own way to what it is over (`keyboardFirst`).
 */
export const boardCollision: CollisionDetection = (args) => {
  const { pointerCoordinates: pointer } = args;
  const seen = pointer === null ? args.droppableRects : visibleRects(args);
  if (pointer !== null) {
    const under = pointerOver(args, seen, pointer);
    if (under.length > 0) return under;
    const beside = besideGap(seen, pointer);
    if (beside !== null) return pointerOver(args, seen, beside);
  }
  // Only what is on screen can be under the card (#833): see visibleRect.
  const holding = holdingCentre(args, args.droppableContainers, visibleRect);
  if (holding.length > 0) return holding;
  return rectIntersection({ ...args, droppableRects: seen });
};
