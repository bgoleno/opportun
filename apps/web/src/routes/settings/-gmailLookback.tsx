import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The ingestion-window field, on the Gmail card because that is where the window is stored.
 * `value` null means a hand-edited query, which this cannot safely rewrite.
 *
 * The window is not Gmail's alone (issue #53): one number bounds every channel that hands
 * Opportun a history, including a LinkedIn export, so the copy has to say so here.
 */
export function GmailLookbackField({
  value,
  saving,
  onSave,
}: {
  value: number | null;
  saving: boolean;
  onSave: (days: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : String(value));
  const days = Number(shown);
  const valid = Number.isInteger(days) && days >= 1 && days <= 1095;

  if (value === null && draft === null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="gmail-lookback-custom">
        The sync window is set by a hand-edited gmail_query setting, so it is not editable here.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor="gmail-lookback">How far back to read (days)</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="gmail-lookback"
          inputMode="numeric"
          className="w-24"
          value={shown}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={saving || !valid || days === value}
          onClick={() => {
            onSave(days);
            setDraft(null);
          }}
        >
          Save window
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The first sync reads this far back (1 to 1095 days; default 180). Changing it makes the next
        sync re-read the whole window: widening pulls older mail in, narrowing keeps what is already
        imported.
      </p>
      <p className="text-xs text-muted-foreground">
        This window applies to everything Opportun reads, not only this mailbox. A LinkedIn export
        import leaves out messages older than it, and says how many it left.
      </p>
    </div>
  );
}
