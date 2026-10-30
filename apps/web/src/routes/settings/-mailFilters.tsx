// Mail filter settings components (spec D7). Presentational and prop-driven, so each piece is
// testable without the query layer.
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { JobSender, MailFilterEffect, MailFilterRule, PatternTest } from './-mailFiltersApi';

/** Gmail has no escape for a quote inside a quoted term, so these cannot be asked for. */
const LABEL_UNSAFE = /["\\\n\r]/;
export const labelIsSafe = (label: string): boolean =>
  label.trim().length > 0 && label.length <= 200 && !LABEL_UNSAFE.test(label);

export function LabelScopeField(props: {
  label: string | null;
  saving: boolean;
  onSave: (label: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.label ?? '';
  const valid = labelIsSafe(shown);

  return (
    <div className="grid grid-cols-1 gap-2">
      <Label htmlFor="mail-label">Gmail label</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="mail-label"
          className="w-64 max-w-full"
          placeholder="JobSearch"
          value={shown}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button
          type="button"
          disabled={props.saving || !valid}
          onClick={() => {
            props.onSave(shown.trim());
            setDraft(null);
          }}
        >
          Save label
        </Button>
        {props.label === null ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={props.saving}
            onClick={() => {
              props.onSave(null);
              setDraft(null);
            }}
          >
            Watch the whole mailbox
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Mail outside this label is never fetched, so it never reaches Opportun at all. This is the
        strongest control here, and it applies to every sync, not just the first. Leave it empty to
        watch the whole mailbox.
      </p>
      {valid || shown.length === 0 ? null : (
        <p className="text-xs text-destructive">
          A label cannot contain a quote, a backslash, or a line break.
        </p>
      )}
    </div>
  );
}

export function ConsumerVetoToggle(props: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="flex items-center gap-2">
        <input
          id="consumer-veto"
          type="checkbox"
          className="size-4"
          checked={props.enabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <Label htmlFor="consumer-veto">Skip mail from personal email providers</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        Gmail, Outlook, iCloud, ISP addresses and the like. Job mail almost never comes from one.
        Your own address is always exempt, and an allow rule beats this for any sender you name.
      </p>
    </div>
  );
}

export function RuleList(props: {
  title: string;
  description: string;
  effect: MailFilterEffect;
  rules: MailFilterRule[];
  onAdd: (pattern: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const addId = `add-${props.effect}`;

  return (
    <section className="grid grid-cols-1 gap-3">
      <div>
        <h3 className="text-sm font-medium">{props.title}</h3>
        {props.description === '' ? null : (
          <p className="text-xs text-muted-foreground">{props.description}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={addId} className="sr-only">
          Add to {props.title}
        </Label>
        <Input
          id={addId}
          className="w-72 max-w-full"
          placeholder="*@example.com or someone@example.com"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button
          type="button"
          disabled={draft.trim().length === 0}
          onClick={() => {
            props.onAdd(draft.trim());
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>

      {props.rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-1">
          {props.rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                aria-label={`Enable ${rule.pattern}`}
                checked={rule.enabled}
                onChange={(e) => props.onToggle(rule.id, e.currentTarget.checked)}
              />
              <code className="font-mono">{rule.pattern}</code>
              {rule.note === null ? null : (
                <span className="text-xs text-muted-foreground">{rule.note}</span>
              )}
              {rule.source === 'seed' ? (
                <span className="text-xs text-muted-foreground">(your own address)</span>
              ) : null}
              <IconButton
                type="button"
                variant="ghost"
                label={`Remove ${rule.pattern}`}
                onClick={() => props.onDelete(rule.id)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Rule 4's pass list (spec D7 item 4). Two things it has to say out loud:
 *
 *   - what being on it MEANS, in words that cannot be confused with the alert-digest senders
 *     under Integrations. A digest sender's mail is parsed into job leads and never classified;
 *     a job sender's mail is ordinary mail that the filters are told not to second-guess.
 *   - that a built-in is switched off rather than deleted (decision D-3). Deleting one would
 *     freeze today's copy of a list that ships with the release, and the next release could not
 *     fix or extend it without clobbering the choice.
 */
export function JobSenderList(props: {
  senders: JobSender[];
  onToggle: (sender: JobSender, enabled: boolean) => void;
  onAdd: (pattern: string) => void;
  onDelete: (ruleId: string) => void;
}) {
  const [draft, setDraft] = useState('');

  return (
    <section className="grid grid-cols-1 gap-3">
      <p className="text-xs text-muted-foreground">
        Mail from these senders is always treated as job mail, so it is never dropped for looking
        private or for carrying no job words. Your deny list still beats this, and so does anything
        that reads as medical, financial or personal content.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="add-job-sender" className="sr-only">
          Add a job sender
        </Label>
        <Input
          id="add-job-sender"
          className="w-72 max-w-full"
          placeholder="*@example.com or someone@example.com"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button
          type="button"
          disabled={draft.trim().length === 0}
          onClick={() => {
            props.onAdd(draft.trim());
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>

      <ul className="grid grid-cols-1 gap-1">
        {props.senders.map((sender) => (
          <li key={sender.pattern} className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              aria-label={`Enable ${sender.pattern}`}
              checked={sender.enabled}
              onChange={(e) => props.onToggle(sender, e.currentTarget.checked)}
            />
            <code className="font-mono">{sender.pattern}</code>
            {sender.platform === '' ? null : (
              <span className="text-xs text-muted-foreground">{sender.platform}</span>
            )}
            {sender.sends === '' ? null : (
              <span className="text-xs text-muted-foreground">{sender.sends}</span>
            )}
            <span className="text-xs text-muted-foreground">
              matches {sender.matchCount} of your senders
            </span>
            {sender.builtIn ? (
              <span className="text-xs text-muted-foreground">
                {sender.enabled ? 'built in' : 'built in, switched off'}
              </span>
            ) : (
              <IconButton
                type="button"
                variant="ghost"
                label={`Remove ${sender.pattern}`}
                onClick={() => {
                  if (sender.ruleId !== null) props.onDelete(sender.ruleId);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PatternTester(props: {
  onTest: (pattern: string) => void;
  testing: boolean;
  result: PatternTest | undefined;
}) {
  const [pattern, setPattern] = useState('');
  const result = props.result;

  return (
    <section className="grid grid-cols-1 gap-2">
      <Label htmlFor="pattern-test">Pattern</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="pattern-test"
          className="w-72 max-w-full font-mono"
          placeholder="*.gmail.com"
          value={pattern}
          onChange={(e) => setPattern(e.currentTarget.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={props.testing || pattern.trim().length === 0}
          onClick={() => props.onTest(pattern.trim())}
        >
          Test
        </Button>
      </div>

      {result === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="pattern-match-count">
          {!result.valid
            ? 'That is not a sender pattern.'
            : `Matches ${result.matchCount} of the senders in your mail${
                result.sampleDomains.length === 0 ? '' : ` (${result.sampleDomains.join(', ')})`
              }.`}
        </p>
      )}

      {/* Offered, never applied: quietly broadening a rule the user wrote is the surprise
          this page exists to prevent. */}
      {result?.suggestions.map((s) => (
        <div key={s.pattern} className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setPattern(s.pattern)}>
            Use {s.pattern} instead
          </Button>
          <span className="text-xs text-muted-foreground">matches {s.matchCount}</span>
        </div>
      ))}
    </section>
  );
}
