import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
