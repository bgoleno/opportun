import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { parseSse, type ChatMessage, type TailoringSession } from './api';
import { ChatPanel } from './ChatPanel';

const NOW = Date.now();

function session(messages: ChatMessage[]): TailoringSession {
  return { id: 's1', resumeId: 'r1', acceptedAt: null, createdAt: NOW, messages };
}

/** A fetch stub: the messages endpoint streams `chunks` as SSE, the session POST returns `current`. */
function stub(chunks: string[], after: TailoringSession) {
  let current = session([]);
  const calls: { path: string; body: unknown }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      calls.push({
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (path === '/tailoring/s1/messages') {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(chunks[0] ?? ''));
            await gate;
            for (const c of chunks.slice(1)) controller.enqueue(encoder.encode(c));
            current = after;
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/resumes/r1/tailoring') return new Response(JSON.stringify(current));
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    }),
  );
  return { calls, release };
}

const ev = (e: object) => `data: ${JSON.stringify(e)}\n\n`;

describe('ChatPanel', () => {
  it('parses SSE frames split across chunks', () => {
    const first = parseSse('data: {"type":"delta","text":"Hel');
    expect(first.events).toEqual([]);
    const second = parseSse(`${first.rest}lo"}\n\ndata: {"type":"delta","text":"!"}\n\n`);
    expect(second.events).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: '!' },
    ]);
    expect(second.rest).toBe('');
  });

  it('streams a reply as it arrives, then shows the saved transcript with suggestion cards', async () => {
    const user = userEvent.setup();
    const edit = { find: 'old text', replace: 'new text', rationale: 'why' };
    const done: ChatMessage = {
      role: 'assistant',
      content: 'Here is a change.',
      at: NOW + 2,
      edits: [edit],
      incomplete: false,
    };
    const userTurn: ChatMessage = {
      role: 'user',
      content: 'Tailor it',
      at: NOW + 1,
      edits: [],
      incomplete: false,
    };
    const { calls, release } = stub(
      [
        ev({ type: 'start', message: userTurn }) + ev({ type: 'delta', text: 'Here is ' }),
        ev({ type: 'delta', text: 'a change.\n\n```json\n{"edits":' }),
        ev({ type: 'done', message: done }),
      ],
      session([userTurn, done]),
    );
    renderWithProviders(<ChatPanel resumeId="r1" />);
    await user.type(await screen.findByLabelText('Message'), 'Tailor it');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // Mid-stream: the partial reply is visible and the input is locked.
    expect(await screen.findByText('Here is')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(calls.find((c) => c.path === '/tailoring/s1/messages')?.body).toEqual({
      content: 'Tailor it',
    });

    release();
    // After the stream: the server transcript, with the edit as a card; the json is not shown.
    expect(await screen.findByText('Here is a change.')).toBeInTheDocument();
    expect(await screen.findByRole('deletion')).toHaveTextContent('old text');
    expect(screen.queryByText(/```json/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
  });

  it('shows a provider failure and keeps the conversation usable', async () => {
    const user = userEvent.setup();
    const userTurn: ChatMessage = {
      role: 'user',
      content: 'Hi',
      at: NOW + 1,
      edits: [],
      incomplete: false,
    };
    const { release } = stub(
      [
        ev({ type: 'start', message: userTurn }),
        ev({ type: 'error', code: 'ai_unavailable', reason: 'provider_error' }),
      ],
      session([userTurn]),
    );
    release();
    renderWithProviders(<ChatPanel resumeId="r1" />);
    await user.type(await screen.findByLabelText('Message'), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/your message is saved/i);
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
    expect(screen.getByText('Hi')).toBeInTheDocument();
  });
});

// Issue #35: from xl the conversation scrolls inside the chat column, so it has to show its
// newest message the way a page would after the reader scrolled down to the composer. jsdom has
// no layout, so the list's scroll box is simulated: scrollHeight and clientHeight come from
// `layout`, and scrollTop is stored per element.
describe('ChatPanel conversation scrolling (issue #35)', () => {
  const layout = { scrollHeight: 1000, clientHeight: 300 };
  const tops = new WeakMap<Element, number>();
  const proto = HTMLOListElement.prototype;

  beforeEach(() => {
    layout.scrollHeight = 1000;
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => layout.scrollHeight,
    });
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get: () => layout.clientHeight,
    });
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        tops.set(this, value);
      },
    });
  });

  afterEach(() => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
      Reflect.deleteProperty(proto, key);
    }
  });

  const turn = (role: 'user' | 'assistant', content: string, at: number): ChatMessage => ({
    role,
    content,
    at,
    edits: [],
    incomplete: false,
  });

  it('opens at the newest message', async () => {
    const saved = session([turn('user', 'First', NOW), turn('assistant', 'Reply', NOW + 1)]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(saved))),
    );
    renderWithProviders(<ChatPanel resumeId="r1" />);
    expect(await screen.findByText('Reply')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conversation' }).scrollTop).toBe(1000);
  });

  it('follows a reply as it streams in while the reader is at the newest message', async () => {
    const user = userEvent.setup();
    const reply = turn('assistant', 'Here is a change.', NOW + 2);
    const { release } = stub(
      [ev({ type: 'delta', text: 'Here is ' }), ev({ type: 'delta', text: 'a change.' })],
      session([turn('user', 'Tailor it', NOW + 1), reply]),
    );
    renderWithProviders(<ChatPanel resumeId="r1" />);
    await user.type(await screen.findByLabelText('Message'), 'Tailor it');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Here is')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Conversation' });
    expect(list.scrollTop).toBe(1000);

    layout.scrollHeight = 1400; // the rest of the reply makes the conversation taller
    release();
    expect(await screen.findByText('Here is a change.')).toBeInTheDocument();
    await waitFor(() => expect(list.scrollTop).toBe(1400));
  });

  it('leaves a reader who scrolled up to an earlier message where they are', async () => {
    const user = userEvent.setup();
    const reply = turn('assistant', 'Here is a change.', NOW + 2);
    const { release } = stub(
      [ev({ type: 'delta', text: 'Here is ' }), ev({ type: 'delta', text: 'a change.' })],
      session([turn('user', 'Tailor it', NOW + 1), reply]),
    );
    renderWithProviders(<ChatPanel resumeId="r1" />);
    await user.type(await screen.findByLabelText('Message'), 'Tailor it');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Here is')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Conversation' });

    list.scrollTop = 100; // the reader scrolls up to reread an earlier message
    fireEvent.scroll(list);
    layout.scrollHeight = 1400;
    release();
    expect(await screen.findByText('Here is a change.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
    expect(list.scrollTop).toBe(100);
  });

  it('goes to the newest message when the reader sends one, even after scrolling up', async () => {
    const user = userEvent.setup();
    const { release } = stub([ev({ type: 'delta', text: 'Sure.' })], session([]));
    renderWithProviders(<ChatPanel resumeId="r1" />);
    const input = await screen.findByLabelText('Message');
    const list = screen.getByRole('list', { name: 'Conversation' });
    list.scrollTop = 100; // reading an earlier message
    fireEvent.scroll(list);

    layout.scrollHeight = 1200; // the message just sent, at the end
    await user.type(input, 'One more change');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('One more change')).toBeInTheDocument();
    expect(list.scrollTop).toBe(1200);
    release();
  });

  it('can be scrolled from the keyboard, so it takes focus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(session([turn('user', 'Hi', NOW)])))),
    );
    renderWithProviders(<ChatPanel resumeId="r1" />);
    expect(await screen.findByText('Hi')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conversation' })).toHaveAttribute('tabindex', '0');
  });
});
