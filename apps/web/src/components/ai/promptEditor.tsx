// Prompt versions for one AI task: the version list (activate, reset to the system default),
// a side-by-side diff of any two versions, and an editor that saves a new version.
import { diffLines } from 'diff';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  useActivatePrompt,
  useCreatePromptVersion,
  usePromptVersions,
  type PromptVersion,
} from './api';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const VAR_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(VAR_PATTERN)].map((m) => m[1] as string))];
}

// --- diff ----------------------------------------------------------------------

type Change = 'same' | 'removed' | 'added';
interface Cell {
  text: string;
  change: Change;
}
interface DiffRow {
  left: Cell | null;
  right: Cell | null;
}

function linesOf(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Line diff laid out side by side: removals on the left, additions on the right. */
export function sideBySide(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  // Removed lines wait here so a following addition can be paired with them row by row.
  let pending: string[] = [];
  const pair = (removed: string[], added: string[]) => {
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      const l = removed.at(j);
      const r = added.at(j);
      rows.push({
        left: l === undefined ? null : { text: l, change: 'removed' },
        right: r === undefined ? null : { text: r, change: 'added' },
      });
    }
  };
  for (const part of diffLines(before, after)) {
    const lines = linesOf(part.value);
    if (part.removed) {
      pair(pending, []);
      pending = lines;
    } else if (part.added) {
      pair(pending, lines);
      pending = [];
    } else {
      pair(pending, []);
      pending = [];
      for (const line of lines) {
        rows.push({ left: { text: line, change: 'same' }, right: { text: line, change: 'same' } });
      }
    }
  }
  pair(pending, []);
  return rows;
}

function DiffCell({ cell }: { cell: Cell | null }) {
  if (cell === null) return <TableCell className="w-1/2 bg-muted/40" />;
  const text = cell.text === '' ? ' ' : cell.text;
  return (
    <TableCell
      data-change={cell.change}
      className={cn(
        'w-1/2 align-top font-mono text-xs break-words whitespace-pre-wrap',
        cell.change === 'removed' && 'bg-destructive/10',
        cell.change === 'added' && 'bg-success/10',
      )}
    >
      {cell.change === 'removed' ? (
        <del className="no-underline">{text}</del>
      ) : cell.change === 'added' ? (
        <ins className="no-underline">{text}</ins>
      ) : (
        <span>{text}</span>
      )}
    </TableCell>
  );
}

export function VersionDiff({ before, after }: { before: PromptVersion; after: PromptVersion }) {
  const rows = useMemo(() => sideBySide(before.body, after.body), [before.body, after.body]);
  const changed = rows.some((r) => r.left?.change !== 'same' || r.right?.change !== 'same');
  return (
    <div className="max-h-[32rem] overflow-auto rounded-md border">
      <Table aria-label={`Differences between v${before.version} and v${after.version}`}>
        <TableHeader>
          <TableRow>
            <TableHead>Version {before.version}</TableHead>
            <TableHead>Version {after.version}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {changed ? null : (
            <TableRow>
              <TableCell colSpan={2} className="text-sm text-muted-foreground">
                These versions are identical.
              </TableCell>
            </TableRow>
          )}
          {rows.map((r, i) => (
            <TableRow key={i}>
              <DiffCell cell={r.left} />
              <DiffCell cell={r.right} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// --- editor --------------------------------------------------------------------

export function PromptEditor({ taskKey }: { taskKey: string }) {
  const versions = usePromptVersions(taskKey);
  const activate = useActivatePrompt(taskKey);
  const create = useCreatePromptVersion(taskKey);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  if (versions.isPending)
    return <p className="text-sm text-muted-foreground">Loading prompts...</p>;
  if (versions.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load prompt versions.
      </p>
    );
  }

  const list = versions.data;
  const active = list.find((v) => v.isActive);
  const seed = list.find((v) => v.isSystem);
  const byId = new Map(list.map((v) => [v.id, v]));
  // Default comparison: the two newest versions.
  const before = byId.get(fromId ?? '') ?? list[1] ?? list[0];
  const after = byId.get(toId ?? '') ?? list[0];

  const text = draft ?? active?.body ?? '';
  const required = active === undefined ? [] : variablesOf(active.body);
  const draftVars = new Set(variablesOf(text));
  const dropped = required.filter((v) => !draftVars.has(v));
  const dirty = draft !== null && draft.trim() !== '' && draft !== active?.body;

  const save = () => {
    if (!dirty) return;
    create.mutate(text, { onSuccess: () => setDraft(null) });
  };

  return (
    <div className="grid gap-6">
      <section aria-labelledby={`${taskKey}-versions`} className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${taskKey}-versions`} className="text-sm font-semibold">
            Versions
          </h3>
          <Button
            variant="outline"
            size="sm"
            disabled={seed === undefined || seed.isActive || activate.isPending}
            onClick={() => {
              if (seed !== undefined) activate.mutate(seed.id);
            }}
          >
            Reset to default
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Saved</TableHead>
              <TableHead>
                <span className="sr-only">Status</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((v) => (
              <TableRow key={v.id}>
                <TableCell className="font-medium">v{v.version}</TableCell>
                <TableCell className="text-muted-foreground">
                  {v.isSystem ? 'Default' : v.proposed ? 'Proposed' : 'Yours'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {dateFmt.format(v.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  {v.isActive ? (
                    <Badge variant="success">Active</Badge>
                  ) : v.proposed ? (
                    // A proposal is accepted or discarded from its proposal card, never activated.
                    <span className="text-xs text-muted-foreground">Awaiting review</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Activate v${v.version}`}
                      disabled={activate.isPending}
                      onClick={() => activate.mutate(v.id)}
                    >
                      Activate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {before !== undefined && after !== undefined && list.length > 1 ? (
        <section aria-labelledby={`${taskKey}-diff`} className="grid gap-3">
          <h3 id={`${taskKey}-diff`} className="text-sm font-semibold">
            Compare versions
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${taskKey}-from`}>Compare</Label>
              <Select
                id={`${taskKey}-from`}
                value={before.id}
                onChange={(e) => setFromId(e.target.value)}
              >
                {list.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} {v.isSystem ? '(default)' : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${taskKey}-to`}>With</Label>
              <Select
                id={`${taskKey}-to`}
                value={after.id}
                onChange={(e) => setToId(e.target.value)}
              >
                {list.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} {v.isSystem ? '(default)' : ''}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <VersionDiff before={before} after={after} />
        </section>
      ) : null}

      <section aria-labelledby={`${taskKey}-edit`} className="grid gap-3">
        <h3 id={`${taskKey}-edit`} className="text-sm font-semibold">
          Edit
        </h3>
        <p className="text-sm text-muted-foreground">
          Saving creates a new version from the active one. It is used only after you activate it.
          Text in double braces is filled in when the task runs; keep those placeholders.
        </p>
        <Label htmlFor={`${taskKey}-body`}>Prompt text</Label>
        <Textarea
          id={`${taskKey}-body`}
          className="min-h-64 font-mono text-xs"
          spellCheck={false}
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby={dropped.length > 0 ? `${taskKey}-dropped` : undefined}
        />
        {dropped.length > 0 ? (
          <p id={`${taskKey}-dropped`} role="status" className="text-sm text-destructive">
            This draft no longer uses: {dropped.map((v) => `{{${v}}}`).join(', ')}. The task will
            not see that input.
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button onClick={save} disabled={!dirty || create.isPending}>
            {create.isPending ? 'Saving...' : 'Save as new version'}
          </Button>
          <Button variant="ghost" onClick={() => setDraft(null)} disabled={draft === null}>
            Discard changes
          </Button>
        </div>
      </section>
    </div>
  );
}
