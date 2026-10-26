// Issue #15: the alert digest sender list (settings/-mailFilters.tsx's JobSenderList is the
// closest sibling in shape). Presentational and prop-driven, so it is testable without the
// query layer; SourcesManager wires it to useAlertSenders/useSetAlertSenders.
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Loose enough to catch an empty or obviously-not-an-address entry; the server is the real check. */
export const looksLikeAddress = (value: string): boolean => {
  const v = value.trim();
  return v.length >= 3 && v.length <= 320 && v.includes('@') && !v.includes(',');
};

export function AlertSendersList(props: {
  senders: string[];
  usingDefaults: boolean;
  defaults: string[];
  saving: boolean;
  onAdd: (address: string) => void;
  onRemove: (address: string) => void;
  onResetToDefaults: () => void;
}) {
  const [draft, setDraft] = useState('');

  return (
    <section className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        A digest from one of these addresses is parsed for job postings directly and never sent to
        the classifier. Only LinkedIn's and Indeed's alert formats are understood today, so adding
        another sender does nothing unless its digest happens to match one of those shapes — the
        parser, not this list, decides what a digest yields.
      </p>
      <p className="text-xs text-muted-foreground" data-testid="alert-senders-status">
        {props.usingDefaults
          ? 'Using the built-in defaults: LinkedIn and Indeed.'
          : props.senders.length === 0
            ? 'Configured to match nothing: no mail is read as a job alert digest.'
            : 'A custom list, saved for your account.'}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="add-alert-sender" className="sr-only">
          Add an alert sender address
        </Label>
        <Input
          id="add-alert-sender"
          className="w-72"
          placeholder="alerts@example.com"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button
          type="button"
          disabled={props.saving || !looksLikeAddress(draft)}
          onClick={() => {
            props.onAdd(draft.trim().toLowerCase());
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>

      {props.senders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No senders configured.</p>
      ) : (
        <ul className="grid gap-1">
          {props.senders.map((address) => (
            <li key={address} className="flex flex-wrap items-center gap-2 text-sm">
              <code className="font-mono">{address}</code>
              <IconButton
                type="button"
                variant="ghost"
                label={`Remove ${address}`}
                disabled={props.saving}
                onClick={() => props.onRemove(address)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {props.usingDefaults ? null : (
        <Button
          type="button"
          variant="outline"
          disabled={props.saving}
          onClick={props.onResetToDefaults}
        >
          Reset to defaults ({props.defaults.join(', ')})
        </Button>
      )}
    </section>
  );
}
