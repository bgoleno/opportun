// https://github.com/bgoleno/opportun/issues/475 (tl's shaping): a keyboard drag reaches every
// column in on-screen order, a collapsed 56 px rail included. Driven through the getter and the
// collision with given rectangles, as dnd-kit's KeyboardSensor would call them.
import {
  KeyboardCode,
  type ClientRect,
  type Collision,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { describe, expect, it, vi } from 'vitest';
import { boardCollision, boardKeyboardCoordinates } from './boardKeyboard';

// Spied on, not replaced: Left and Right never reach it, and Up and Down must (#508).
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return { ...mod, sortableKeyboardCoordinates: vi.fn(mod.sortableKeyboardCoordinates) };
});

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

// The right end of the board, as the default layout has it: Offer expanded (288 px), then the
// two terminal columns collapsed to 56 px rails, 12 px apart. One card in Offer.
const COLUMNS = ['offer', 'dismissed', 'closed'];
// Closed is listed before Dismissed on purpose. A 272 px card placed at the Dismissed rail covers
// both 56 px rails in full, so rectangle overlap scores them the same, and the old collision fell
// to whichever droppable came first: in the browser that was Closed (qa on #475). The board's
// collision must pick the rail under the card's centre, whatever the order.
const RECTS = new Map<UniqueIdentifier, ClientRect>([
  ['offer', rect(1000, 100, 288, 600)],
  ['card', rect(1008, 160, 272, 96)],
  ['closed', rect(1368, 100, 56, 600)],
  ['dismissed', rect(1300, 100, 56, 600)],
]);
const columnOf = (id: UniqueIdentifier) =>
  COLUMNS.includes(String(id)) ? String(id) : id === 'card' ? 'offer' : undefined;

function container(id: UniqueIdentifier): DroppableContainer {
  const node = document.createElement('div');
  document.body.append(node);
  return {
    id,
    key: String(id),
    data: { current: {} },
    disabled: false,
    node: { current: node },
    rect: { current: RECTS.get(id) ?? null },
  } as unknown as DroppableContainer;
}

const containers = [...RECTS.keys()].map(container);
const enabled = Object.assign(new Map(containers.map((c) => [c.id, c])), {
  getEnabled: () => containers,
  getNodeFor: (id: UniqueIdentifier) => containers.find((c) => c.id === id)?.node.current,
});

/** One arrow press: the new top-left from the getter, then which droppable is "over". */
function press(
  getter: KeyboardCoordinateGetter,
  code: string,
  dragged: ClientRect,
  over: UniqueIdentifier,
): { rect: ClientRect; over: UniqueIdentifier | undefined } | undefined {
  const event = { code, preventDefault: vi.fn() } as unknown as KeyboardEvent;
  const next = getter(event, {
    active: 'card',
    currentCoordinates: { x: dragged.left, y: dragged.top },
    context: {
      active: { id: 'card' },
      collisionRect: dragged,
      droppableRects: RECTS,
      droppableContainers: enabled,
      over: { id: over },
      scrollableAncestors: [],
    } as never,
  });
  if (next === undefined) return undefined;
  const moved = rect(next.x, next.y, dragged.width, dragged.height);
  const hits: Collision[] = boardCollision({
    active: { id: 'card' } as never,
    collisionRect: moved,
    droppableRects: RECTS,
    droppableContainers: containers.filter((c) => c.id !== 'card'),
    pointerCoordinates: null,
  });
  return { rect: moved, over: hits[0]?.id };
}

describe('the board keyboard drag (#475)', () => {
  const getter = boardKeyboardCoordinates(() => COLUMNS, columnOf);
  const start = RECTS.get('card')!;

  it('ArrowRight from Offer reaches the collapsed Dismissed rail, then Closed', () => {
    const first = press(getter, KeyboardCode.Right, start, 'card');
    expect(first?.over).toBe('dismissed');
    const second = press(getter, KeyboardCode.Right, first!.rect, 'dismissed');
    expect(second?.over).toBe('closed');
  });

  it('ArrowLeft from Closed reaches Dismissed, then Offer', () => {
    const atClosed = press(
      getter,
      KeyboardCode.Right,
      press(getter, KeyboardCode.Right, start, 'card')!.rect,
      'dismissed',
    )!;
    const back = press(getter, KeyboardCode.Left, atClosed.rect, 'closed');
    expect(back?.over).toBe('dismissed');
    expect(press(getter, KeyboardCode.Left, back!.rect, 'dismissed')?.over).toBe('offer');
  });

  it('does not move past the last column, or before the first', () => {
    const atClosed = press(
      getter,
      KeyboardCode.Right,
      press(getter, KeyboardCode.Right, start, 'card')!.rect,
      'dismissed',
    )!;
    expect(press(getter, KeyboardCode.Right, atClosed.rect, 'closed')).toBeUndefined();
    expect(press(getter, KeyboardCode.Left, start, 'card')).toBeUndefined();
  });

  it('a centre inside a card wins over the column the card sits in', () => {
    const hits = boardCollision({
      active: { id: 'other' } as never,
      collisionRect: rect(1010, 170, 272, 96),
      droppableRects: RECTS,
      droppableContainers: containers,
      pointerCoordinates: null,
    });
    expect(hits[0]?.id).toBe('card');
  });

  // #508 (and #517's second point): reordering within a column (#240) still steps as dnd-kit's
  // sortable getter does, because Up and Down are handed to it unchanged.
  it('passes ArrowUp and ArrowDown to sortableKeyboardCoordinates, with the same arguments', () => {
    const spy = vi.mocked(sortableKeyboardCoordinates);
    for (const code of [KeyboardCode.Up, KeyboardCode.Down]) {
      spy.mockClear();
      spy.mockReturnValueOnce({ x: 11, y: 22 });
      const event = { code, preventDefault: vi.fn() } as unknown as KeyboardEvent;
      const args = {
        active: 'card',
        currentCoordinates: { x: 0, y: 0 },
        context: { active: { id: 'card' } } as never,
      };
      expect(getter(event, args)).toEqual({ x: 11, y: 22 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(event, args);
    }
  });
});
