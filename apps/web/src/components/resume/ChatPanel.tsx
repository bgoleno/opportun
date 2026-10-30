// The tailoring chat. Replies stream in over SSE; suggestions arrive as cards, and nothing
// reaches the document until the user applies a card.
import { useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
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
  return (
    <li
      data-session={sessionId}
      className={
        mine
          ? 'ml-8 justify-self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
          : 'mr-4 grid gap-3 rounded-lg border bg-card px-3 py-2 text-sm'
      }
    >
      <span className="sr-only">{mine ? 'You:' : 'Assistant:'}</span>
      {children}
    </li>
  );
}

function MessageItem({
  message,
  resumeId,
  sessionId,
  canApply,
}: {
  message: ChatMessage;
  resumeId: string;
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
            <SuggestionCard
              key={`${message.at}-${i}`}
              resumeId={resumeId}
              sessionId={sessionId}
              edit={edit}
            />
          ))}
        </div>
      ) : null}
    </Bubble>
  );
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tailoring chat</CardTitle>
        <CardDescription>
          Ask for changes for this job. Suggestions never touch the document until you apply them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {session.isPending ? (
          <p className="text-sm text-muted-foreground">Loading conversation...</p>
        ) : session.isError ? (
          <FormError message={resumeErrorMessage(session.error) ?? errorMessage(session.error)} />
        ) : (
          <>
            <ol aria-label="Conversation" aria-live="polite" className="grid gap-3">
              {messages.length === 0 && pendingUser === null ? (
                <li className="text-sm text-muted-foreground">
                  No messages yet. Try: &quot;Tailor this resume for the job and propose
                  edits.&quot;
                </li>
              ) : null}
              {messages.map((m, i) => (
                <MessageItem
                  key={`${m.at}-${i}`}
                  message={m}
                  resumeId={resumeId}
                  sessionId={sessionId}
                  canApply
                />
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
