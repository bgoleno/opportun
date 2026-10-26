import { useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/opportunities';
import { resumeErrorMessage, useDriveSearch, type DriveSearchHit } from './api';

/** How long to wait, after the last keystroke, before searching (issue #136). */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search the caller's Drive for a Google Doc by name and pick one, instead of pasting a link.
 * An empty query shows recently modified documents, the common case for attaching a resume
 * someone was just editing.
 */
export function DriveSearchModal(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (hit: DriveSearchHit) => void;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);
  // Reset on close, so reopening starts from recent documents rather than the last search.
  useEffect(() => {
    if (!props.open) {
      setQ('');
      setDebouncedQ('');
    }
  }, [props.open]);

  const results = useDriveSearch(debouncedQ, { enabled: props.open });
  const files = results.data?.pages.flatMap((p) => p.files) ?? [];

  function pick(hit: DriveSearchHit) {
    props.onPick(hit);
    props.onOpenChange(false);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Search Google Drive</DialogTitle>
          <DialogDescription>
            Find a document by name, or leave it blank for your most recently modified ones.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="drive-search-q">Search</Label>
          <Input
            id="drive-search-q"
            value={q}
            autoComplete="off"
            autoFocus
            placeholder="Document name"
            onChange={(e) => setQ(e.currentTarget.value)}
          />
        </div>
        <ul className="grid max-h-80 gap-1 overflow-y-auto" aria-label="Matching documents">
          {results.isPending ? (
            <li className="text-sm text-muted-foreground">Searching...</li>
          ) : results.isError ? (
            <li>
              <FormError
                message={resumeErrorMessage(results.error) ?? errorMessage(results.error)}
              />
            </li>
          ) : files.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              {debouncedQ === '' ? 'No documents found.' : 'No documents match that name.'}
            </li>
          ) : (
            files.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => pick(f)}
                  className="grid w-full gap-0.5 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium">{f.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.folderName !== null ? `${f.folderName} · ` : ''}
                    Edited {formatDate(new Date(f.modifiedTime).getTime())}
                  </span>
                </button>
              </li>
            ))
          )}
          {results.hasNextPage ? (
            <li>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={results.isFetchingNextPage}
                onClick={() => void results.fetchNextPage()}
              >
                {results.isFetchingNextPage ? 'Loading...' : 'Load more'}
              </Button>
            </li>
          ) : null}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
