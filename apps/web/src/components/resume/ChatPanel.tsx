// The tailoring chat. Replies stream in over SSE; suggestions arrive as cards, and nothing
// reaches the document until the user applies a card.
import { useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { FormError } from '@/components/FormError';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import {
  aiReason,
  resumeErrorMessage,
  rk,
  streamMessage,
  useCompleteSession,
  useTailoringSession,
  visibleProse,
  type ChatMessage,
} from './api';
import { SuggestionCard } from './SuggestionCard';

function Bubble({
  message,
  sessionId,
  children,
}: {
  message: Pick<ChatMessage, 'role'>;
  sessionId: string;
  children: React.ReactNode;
}) {
  const mine = message.role === 'user';
  // Each bubble stops at reading width (issue #35), border included, so a reply's border never
  // runs on past text that wraps at 65ch when the conversation is wider than that.
  return (
    <li
      data-session={sessionId}
      className={
        mine
          ? 'ml-8 max-w-prose justify-self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
          : 'mr-4 grid max-w-prose gap-3 rounded-lg border bg-card px-3 py-2 text-sm'
      }
    >
      <span className="sr-only">{mine ? 'You:' : 'Assistant:'}</span>
      {children}
    </li>
  );
}

function MessageItem({
  message,
  sessionId,
  canApply,
}: {
  message: ChatMessage;
  sessionId: string;
  canApply: boolean;
}) {
  if (message.role === 'user') {
    return (
      <Bubble message={message} sessionId={sessionId}>
        <p className="whitespace-pre-wrap">{message.content}</p>
      </Bubble>
    );
  }
  return (
    <Bubble message={message} sessionId={sessionId}>
      {message.content.length > 0 ? <Markdown>{message.content}</Markdown> : null}
      {message.incomplete ? (
        <p className="text-xs text-muted-foreground">This reply was cut off.</p>
      ) : null}
      {canApply && message.edits.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            Suggested edits ({message.edits.length})
          </p>
          {message.edits.map((edit, i) => (
            <SuggestionCard key={`${message.at}-${i}`} sessionId={sessionId} edit={edit} />
          ))}
        </div>
      ) : null}
    </Bubble>
  );
}

/**
 * Keeps a scrolling list at its newest item while the reader is there (issue #35). When the chat
 * has a column of its own the conversation scrolls inside it, so a new message or a streaming
 * reply would otherwise land out of sight below. A reader who scrolled up to an earlier message
 * is left where they are. Where the list does not scroll (stacked, as tall as its content),
 * setting scrollTop does nothing.
 *
 * It runs after every render rather than on a list of what can grow the conversation, so nothing
 * that adds to it (a message, a streamed delta, a suggestion card) can be missed; for a reader
 * already at the end, scrolling to the end again changes nothing.
 */
function useFollowNewest() {
  const ref = useRef<HTMLOListElement>(null);
  const atNewest = useRef(true);
  useLayoutEffect(() => {
    const list = ref.current;
    if (list !== null && atNewest.current) list.scrollTop = list.scrollHeight;
  });
  const onScroll = () => {
    const list = ref.current;
    if (list === null) return;
    // Within a line of the end counts as at the end, so rounding cannot unstick it.
    atNewest.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  };
  return { ref, onScroll };
}

export function ChatPanel({ resumeId }: { resumeId: string }) {
  const session = useTailoringSession(resumeId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionId = session.data?.id ?? '';
  const complete = useCompleteSession(resumeId, sessionId);
  const busy = streamText !== null;

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const content = draft.trim();
    if (content.length === 0 || session.data === undefined || busy) return;
    setDraft('');
    setError(null);
    setPendingUser(content);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamMessage(
        session.data.id,
        content,
        (event) => {
          if (event.type === 'delta') setStreamText((t) => (t ?? '') + event.text);
          else if (event.type === 'error') setError(aiReason(event.reason, event.keyHint));
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(resumeErrorMessage(err) ?? errorMessage(err));
    } finally {
      if (!controller.signal.aborted) {
        // The server holds the transcript (user turn first, then the reply): show its copy.
        await qc.invalidateQueries({ queryKey: rk.session(resumeId) });
        setPendingUser(null);
        setStreamText(null);
      }
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
  }

  const messages = session.data?.messages ?? [];
  const follow = useFollowNewest();

  // The card fills the height its container gives it, and the conversation takes what the header
  // and composer leave, scrolling inside it, so the composer stays at the bottom. Where nothing
  // limits the height (stacked below xl), everything is as tall as its content, as before.
  return (
    <Card className="h-full min-h-0">
      <CardHeader>
        <CardTitle>Tailoring chat</CardTitle>
        <CardDescription>
          Ask for changes for this job. Suggestions never touch the document until you apply them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {session.isPending ? (
          <p className="text-sm text-muted-foreground">Loading conversation...</p>
        ) : session.isError ? (
          <FormError message={resumeErrorMessage(session.error) ?? errorMessage(session.error)} />
        ) : (
          <>
            <ol
              ref={follow.ref}
              onScroll={follow.onScroll}
              aria-label="Conversation"
              aria-live="polite"
              className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto"
            >
              {messages.length === 0 && pendingUser === null ? (
                <li className="text-sm text-muted-foreground">
                  No messages yet. Try: &quot;Tailor this resume for the job and propose
                  edits.&quot;
                </li>
              ) : null}
              {messages.map((m, i) => (
                <MessageItem key={`${m.at}-${i}`} message={m} sessionId={sessionId} canApply />
              ))}
              {pendingUser !== null ? (
                <Bubble message={{ role: 'user' }} sessionId={sessionId}>
                  <p className="whitespace-pre-wrap">{pendingUser}</p>
                </Bubble>
              ) : null}
              {streamText !== null ? (
                <Bubble message={{ role: 'assistant' }} sessionId={sessionId}>
                  {streamText.length === 0 ? (
                    <p className="text-muted-foreground">Thinking...</p>
                  ) : (
                    <Markdown>{visibleProse(streamText)}</Markdown>
                  )}
                </Bubble>
              ) : null}
            </ol>
            <FormError message={error} />
            <form onSubmit={(e) => void send(e)} className="grid gap-2">
              <Label htmlFor="tailor-message">Message</Label>
              <Textarea
                id="tailor-message"
                rows={3}
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={onKeyDown}
                placeholder="What should change for this job?"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || complete.isPending || messages.length === 0}
                  onClick={() =>
                    complete.mutate(undefined, {
                      onSuccess: () =>
                        toast({
                          title: 'Tailoring finished',
                          description: 'The resume is now in review.',
                          variant: 'success',
                        }),
                      onError: (err) =>
                        toast({
                          title: 'Could not finish',
                          description: errorMessage(err),
                          variant: 'destructive',
                        }),
                    })
                  }
                >
                  Finish tailoring
                </Button>
                <Button type="submit" disabled={busy || draft.trim().length === 0}>
                  <Send aria-hidden="true" />
                  {busy ? 'Replying...' : 'Send'}
                </Button>
              </div>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
