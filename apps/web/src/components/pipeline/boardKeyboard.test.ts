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
import {
  BOARD_SCROLLER_ATTR,
  boardCollision,
  boardKeyboardCoordinates,
  keyboardFirst,
  type KeyboardStep,
} from './boardKeyboard';

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

// #886: the board's chain scrolls sideways when it is narrower than its columns. A step names its
// column and scrolls it into view, so a column scrolled away can be reached.
describe('the board keyboard drag on a board narrower than its columns (#886)', () => {
  /** Four 288 px chain columns in a 600 px area at x 100, then a rail in the area beside it. */
  function narrowBoard(scrollLeft: number, areaWidth = 600) {
    const columns = ['new', 'interested', 'preparing', 'offer', 'closed'];
    const area = document.createElement('div');
    area.setAttribute(BOARD_SCROLLER_ATTR, '');
    document.body.append(area);
    Object.defineProperty(area, 'scrollWidth', { value: 1188 });
    area.scrollLeft = scrollLeft;
    area.getBoundingClientRect = () => rect(100, 0, areaWidth, 700) as DOMRect;
    const ends = document.createElement('div');
    ends.setAttribute(BOARD_SCROLLER_ATTR, '');
    document.body.append(ends);
    ends.getBoundingClientRect = () => rect(100 + areaWidth + 12, 0, 56, 700) as DOMRect;
    const rects = new Map<UniqueIdentifier, ClientRect>();
    const droppables = new Map<UniqueIdentifier, DroppableContainer>();
    columns.forEach((id, i) => {
      const node = document.createElement('section');
      const end = id === 'closed';
      (end ? ends : area).append(node);
      // Live, as dnd-kit's are: a chain column's place follows the area's scroll.
      const place = () =>
        end
          ? rect(100 + areaWidth + 12, 100, 56, 600)
          : rect(100 + i * 300 - area.scrollLeft, 100, 288, 600);
      node.getBoundingClientRect = () => place() as DOMRect;
      const live = Object.defineProperties(
        {},
        Object.fromEntries(
          (['left', 'right', 'top', 'bottom', 'width', 'height'] as const).map((k) => [
            k,
            { get: () => place()[k], enumerable: true },
          ]),
        ),
      ) as ClientRect;
      rects.set(id, live);
      droppables.set(id, { id, node: { current: node } } as unknown as DroppableContainer);
    });
    const step: KeyboardStep = { at: null, column: null };
    const getter = boardKeyboardCoordinates(
      () => columns,
      (id) => String(id),
      step,
    );
    const dragged = rect(108, 160, 272, 96);
    let last: { scrollableAncestors: Element[] };
    const go = (code: string, over: string, scrollableAncestors: Element[] = []) => {
      const context = {
        active: { id: 'new' },
        collisionRect: dragged,
        droppableRects: rects,
        droppableContainers: droppables,
        over: { id: over },
        scrollableAncestors,
      };
      last = context;
      return getter({ code, preventDefault: vi.fn() } as unknown as KeyboardEvent, {
        active: 'new',
        currentCoordinates: { x: dragged.left, y: dragged.top },
        context: context as never,
      });
    };
    return { area, ends, step, go, rects, droppables, lastContext: () => last };
  }

  /** The card's centre for the coordinates the getter gave. */
  const centre = (at: { x: number } | undefined | void) => (at?.x ?? NaN) + 272 / 2;

  it('scrolls a column that is out of view into view, and puts the card on it', () => {
    const b = narrowBoard(0);
    const at = b.go(KeyboardCode.Right, 'interested');
    expect(b.step.at).toBe('preparing');
    expect(b.area.scrollLeft).toBe(288);
    expect(centre(at)).toBe(100 + 600 - 288 / 2);
    // And back, leftwards.
    b.step.at = 'interested';
    b.area.scrollLeft = 588;
    b.go(KeyboardCode.Left, 'interested');
    expect(b.area.scrollLeft).toBe(0);
  });

  it('steps on from the column it stepped to, whatever dnd-kit still says it is over', () => {
    const b = narrowBoard(0);
    for (const column of ['interested', 'preparing', 'offer', 'closed']) {
      b.go(KeyboardCode.Right, 'new');
      expect(b.step.at).toBe(column);
    }
    expect(b.go(KeyboardCode.Right, 'new')).toBeUndefined();
    expect(b.step.at).toBe('closed');
  });

  it('centres a column wider than the area', () => {
    const b = narrowBoard(0, 136);
    b.go(KeyboardCode.Right, 'new');
    expect(b.area.scrollLeft).toBe(300 + 144 - 68);
  });

  it('reaches every column when the area has no width at all', () => {
    const b = narrowBoard(0, 0);
    expect(b.go(KeyboardCode.Right, 'new')).toBeDefined();
    expect(b.step.at).toBe('interested');
  });

  it('scrolls neither area for an end column that is in view', () => {
    const b = narrowBoard(10);
    b.go(KeyboardCode.Right, 'offer');
    expect(b.step.at).toBe('closed');
    expect(b.area.scrollLeft).toBe(10);
    expect(b.ends.scrollLeft).toBe(0);
  });

  // #902: both end columns expanded on a narrow board scroll in an area of their own.
  it('scrolls the end columns’ own area, and no other, for an end column that is out of view', () => {
    const b = narrowBoard(10, 288);
    Object.defineProperty(b.ends, 'scrollWidth', { value: 332 });
    b.ends.getBoundingClientRect = () => rect(400, 0, 180, 700) as DOMRect;
    const closed = () => rect(400 + 172 - b.ends.scrollLeft, 100, 160, 600);
    const node = b.droppables.get('closed')!.node.current!;
    node.getBoundingClientRect = () => closed() as DOMRect;
    const live = {
      get left() {
        return closed().left;
      },
      get right() {
        return closed().right;
      },
      top: 100,
      bottom: 700,
      width: 160,
      height: 600,
    };
    b.rects.set('closed', live);
    const at = b.go(KeyboardCode.Right, 'offer');
    expect(b.step.at).toBe('closed');
    expect(b.ends.scrollLeft).toBe(152);
    expect(b.area.scrollLeft).toBe(10);
    // On the centre of the column, as it is drawn now.
    expect(centre(at)).toBe(420 + 80);
  });

  it('leaves dnd-kit nothing to scroll on a step, and what it had on Up and Down', () => {
    const b = narrowBoard(0);
    const stepped = b.go(KeyboardCode.Right, 'new', [b.area]);
    expect(stepped).toBeDefined();
    expect(b.lastContext().scrollableAncestors).toEqual([]);
    vi.mocked(sortableKeyboardCoordinates).mockReturnValueOnce({ x: 1, y: 2 });
    b.go(KeyboardCode.Down, 'interested', [b.area]);
    expect(b.lastContext().scrollableAncestors).toEqual([b.area]);
  });

  it('forgets its step on Up and Down when they move, and keeps it when they do not', () => {
    const b = narrowBoard(0);
    const spy = vi.mocked(sortableKeyboardCoordinates);
    b.step.at = 'offer';
    spy.mockReturnValueOnce(undefined);
    b.go(KeyboardCode.Down, 'offer');
    expect(b.step.at).toBe('offer');
    spy.mockReturnValueOnce({ x: 1, y: 2 });
    b.go(KeyboardCode.Up, 'offer');
    expect(b.step.at).toBeNull();
  });

  it('keeps the column it is in with the step', () => {
    const b = narrowBoard(0);
    b.go(KeyboardCode.Right, 'new');
    expect(b.step).toEqual({ at: 'interested', column: 'interested' });
    vi.mocked(sortableKeyboardCoordinates).mockReturnValueOnce({ x: 1, y: 2 });
    b.go(KeyboardCode.Down, 'interested');
    expect(b.step).toEqual({ at: null, column: 'interested' });
  });

  const at = (over: Partial<Parameters<typeof boardCollision>[0]> = {}) => ({
    active: { id: 'other' } as never,
    collisionRect: rect(1010, 170, 272, 96),
    droppableRects: RECTS,
    droppableContainers: containers,
    pointerCoordinates: null,
    ...over,
  });

  it('is over what the step says, wherever the card is; a pointer is as before', () => {
    for (const id of ['closed', 'card']) {
      const step: KeyboardStep = { at: id, column: columnOf(id)! };
      const far = at({ collisionRect: rect(0, 0, 272, 96) });
      expect(keyboardFirst(step, columnOf)(far).map((c) => c.id)).toEqual([id]);
      const pointer = at({ pointerCoordinates: { x: 1100, y: 200 } });
      expect(keyboardFirst(step, columnOf)(pointer)).toEqual(boardCollision(pointer));
    }
    for (const none of [
      { at: null, column: null },
      { at: 'gone', column: null },
    ]) {
      expect(keyboardFirst(none, columnOf)(at())).toEqual(boardCollision(at()));
    }
    expect(boardCollision(at())[0]?.id).toBe('card');
  });

  // #833: a chain card scrolled away under a pinned column is not under the dragged card.
  it('by where it is, only what is on screen can be under the card', () => {
    const b = narrowBoard(0, 112);
    const node = document.createElement('article');
    b.area.append(node);
    b.rects.set('hidden card', rect(230, 150, 200, 96));
    b.droppables.set('hidden card', {
      id: 'hidden card',
      node: { current: node },
    } as unknown as DroppableContainer);
    const placed = at({
      collisionRect: rect(114, 160, 272, 96),
      droppableRects: b.rects,
      droppableContainers: [...b.droppables.values()],
    });
    expect(boardCollision(placed).map((c) => c.id)).toEqual(['closed']);
  });

  // 768 px with one end column expanded: 112 px of chain, so a 272 px card's centre is past its
  // end, under the pinned column (qa on #900).
  it('after Up or Down stays in its column while its centre is in it, on screen or not', () => {
    const b = narrowBoard(0, 112);
    const own = (id: UniqueIdentifier) => String(id);
    const placed = at({
      collisionRect: rect(108, 160, 272, 96),
      droppableRects: b.rects,
      droppableContainers: [...b.droppables.values()],
    });
    expect(boardCollision(placed)[0]?.id).toBe('closed');
    const step: KeyboardStep = { at: null, column: 'new' };
    expect(keyboardFirst(step, own)(placed)[0]?.id).toBe('new');
    // Out of its column, where it is decides.
    step.column = 'offer';
    expect(keyboardFirst(step, own)(placed)).toEqual(boardCollision(placed));
  });

  // A chain column scrolled past the area's end lies behind the pinned columns, under the pointer
  // too, and a drop there moved the card to it.
  describe('what a pointer drag is over (#960)', () => {
    // At 150 px: new to 238, interested 250 to 538, preparing from 550, cut at 700; offer, at 850,
    // is out of sight; the pinned rail is 712 to 768.
    type Extra = { id: string; at: ClientRect; pinned?: true };
    const over = (
      pointer: { x: number; y: number } | null,
      dragged: ClientRect,
      ...extras: Extra[]
    ) => {
      const b = narrowBoard(150);
      for (const { id, at: place, pinned } of extras) {
        const node = document.createElement('article');
        (pinned === true ? document.body : b.area).append(node);
        b.rects.set(id, place);
        b.droppables.set(id, { id, node: { current: node } } as unknown as DroppableContainer);
      }
      return boardCollision(
        at({
          collisionRect: dragged,
          droppableRects: b.rects,
          droppableContainers: [...b.droppables.values()],
          pointerCoordinates: pointer,
        }),
      ).map((c) => c.id);
    };
    const hiddenCard = (place: ClientRect): Extra => ({ id: 'hidden card', at: place });
    const anywhere = rect(600, 140, 272, 96);

    it('a column or a card is under the pointer only where it is on screen', () => {
      expect(over({ x: 740, y: 150 }, anywhere, hiddenCard(rect(705, 140, 60, 30)))).toEqual([
        'closed',
      ]);
      expect(over({ x: 740, y: 150 }, anywhere)).toEqual(['closed']);
      // The part of a column that is on screen still is.
      expect(over({ x: 690, y: 150 }, anywhere)).toEqual(['preparing']);
    });

    describe('in a gap between columns: the nearest, as if the pointer were in it', () => {
      // The dragged card's centre is far off, over the rail.
      const far = rect(604, 140, 272, 96);
      const rail: Extra = { id: 'second rail', at: rect(780, 100, 56, 600), pinned: true };
      const cards: Extra[] = [
        { id: 'first', at: rect(258, 140, 272, 96) },
        { id: 'second', at: rect(258, 250, 272, 96) },
      ];

      it('in the chain, the column on either side, the left one half way', () => {
        // New ends at 238, interested starts at 250.
        expect(over({ x: 240, y: 500 }, far)).toEqual(['new']);
        expect(over({ x: 244, y: 500 }, far)).toEqual(['new']);
        expect(over({ x: 246, y: 500 }, far)).toEqual(['interested']);
      });

      it('between the chain and the rails, and between two rails', () => {
        // Preparing is cut at 700, the rail starts at 712; the second starts at 780, after 768.
        expect(over({ x: 703, y: 500 }, far, rail)).toEqual(['preparing']);
        expect(over({ x: 709, y: 500 }, far, rail)).toEqual(['closed']);
        expect(over({ x: 770, y: 500 }, far, rail)).toEqual(['closed']);
        expect(over({ x: 778, y: 500 }, far, rail)).toEqual(['second rail']);
      });

      it('at a card’s height, that card; below the last, the column', () => {
        expect(over({ x: 246, y: 280 }, far, ...cards)).toEqual(['second', 'interested']);
        expect(over({ x: 246, y: 500 }, far, ...cards)).toEqual(['interested']);
      });

      it('is a gap only beside a column, at its height', () => {
        // Above every column: where the card's centre is.
        expect(over({ x: 244, y: 90 }, rect(314, 80, 272, 96))).toEqual(['interested']);
        // Past the last rail by more than a gap.
        expect(over({ x: 800, y: 500 }, rect(314, 140, 272, 96))).toEqual(['interested']);
      });
    });

    it('with neither, the most overlap with what is on screen', () => {
      // Just under the columns, which end at 700.
      const under = rect(460, 690, 272, 96);
      expect(over({ x: 500, y: 720 }, under, hiddenCard(rect(705, 680, 24, 20)))).toEqual([
        'preparing',
        'interested',
        'closed',
      ]);
    });

    it('touching nothing on screen, nothing', () => {
      expect(over({ x: 150, y: 740 }, rect(100, 720, 272, 96))).toEqual([]);
      // Over offer, all of it out of sight.
      expect(over({ x: 960, y: 320 }, rect(900, 300, 272, 96))).toEqual([]);
    });

    it('a drag with no pointer keeps its own last step', () => {
      expect(over(null, rect(900, 300, 272, 96))).toEqual(['offer']);
    });
  });
});
