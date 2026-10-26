// Per-role-target discovery prompt (FR-D4, FR-D6, FR-U6): the prompt ranking uses for one role
// target, its pending refinement proposal (diff, Accept, Discard), the discovery.rank versions it
// can use (activate links one to this role target only; reset goes back to the default), a diff
// of any two versions, and an editor whose save creates a new version linked to this role target.
// Built from the AI settings prompt editor pieces (VersionDiff, placeholder check).
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { usePromptVersions, type PromptVersion } from '@/components/ai/api';
import { variablesOf, VersionDiff } from '@/components/ai/promptEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/opportunities';
import { useRoleTargets } from '@/routes/settings/-api';
import {
  useAcceptRoleTargetProposal,
  useDiscardRoleTargetProposal,
  useEditRoleTargetPrompt,
  useLinkRoleTargetPrompt,
  useRoleTargetPrompt,
} from './api';

const TASK = 'discovery.rank';

export function DiscoveryPrompts(props: {
  roleTargetId: string | undefined;
  onRoleTargetChange: (id: string) => void;
}) {
  const targets = useRoleTargets();
  const items = targets.data?.items ?? [];
  // Without a choice in the URL, the first role target.
  const selected = props.roleTargetId ?? items[0]?.id;

  return (
    <div className="grid gap-6">
      <div className="grid max-w-sm gap-1.5">
        <Label htmlFor="discovery-prompt-target">Role target</Label>
        <Select
          id="discovery-prompt-target"
          value={selected ?? ''}
          disabled={items.length === 0}
          onChange={(e) => props.onRoleTargetChange(e.currentTarget.value)}
        >
          {items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      {targets.isPending ? (
        <p className="text-sm text-muted-foreground">Loading role targets...</p>
      ) : targets.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load role targets.
        </p>
      ) : selected === undefined ? (
        <p className="text-sm text-muted-foreground">
          Add a role target in Settings first. Each one can have its own discovery prompt.
        </p>
      ) : (
        <RoleTargetPrompt key={selected} roleTargetId={selected} />
      )}
    </div>
  );
}

function RoleTargetPrompt({ roleTargetId }: { roleTargetId: string }) {
  const current = useRoleTargetPrompt(roleTargetId);
  const versions = usePromptVersions(TASK);
  const edit = useEditRoleTargetPrompt(roleTargetId);
  const link = useLinkRoleTargetPrompt(roleTargetId);
  const [draft, setDraft] = useState<string | null>(null);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);

  if (current.isPending || versions.isPending) {
    return <p className="text-sm text-muted-foreground">Loading the discovery prompt...</p>;
  }
  if (current.isError || versions.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the discovery prompt.
      </p>
    );
  }

  const { prompt, linked, proposal } = current.data;
  // Proposals are reviewed in their own card, never activated from the version list.
  const list = versions.data.filter((v) => !v.proposed);
  if (!list.some((v) => v.id === prompt.id)) list.unshift(prompt);
  const byId = new Map(list.map((v) => [v.id, v]));
  const before = byId.get(fromId ?? '') ?? list.find((v) => v.isSystem) ?? list.at(-1);
  const after = byId.get(toId ?? '') ?? prompt;

  const text = draft ?? prompt.body;
  const draftVars = new Set(variablesOf(text));
  const dropped = variablesOf(prompt.body).filter((v) => !draftVars.has(v));
  const dirty = draft !== null && draft.trim() !== '' && draft !== prompt.body;

  const save = () => {
    if (!dirty) return;
    edit.mutate(text, {
      onSuccess: () => {
        setDraft(null);
        toast({ title: 'Saved and in use for this role target', variant: 'success' });
      },
    });
  };

  return (
    <div className="grid gap-6">
      {proposal !== null ? (
        <ProposalCard roleTargetId={roleTargetId} current={prompt} proposal={proposal} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>In use</CardTitle>
          <CardDescription>
            {linked
              ? `This role target uses its own version, v${prompt.version}.`
              : `This role target uses your default discovery prompt, v${prompt.version}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <section aria-labelledby="discovery-versions" className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="discovery-versions" className="text-sm font-semibold">
                Versions
              </h3>
              <Button
                variant="outline"
                size="sm"
                disabled={!linked || link.isPending}
                onClick={() =>
                  link.mutate(null, {
                    onSuccess: () => toast({ title: 'Back to your default prompt' }),
                  })
                }
              >
                Reset to default
              </Button>
            </div>
            <Table aria-label="Discovery prompt versions">
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
                      {v.isSystem ? 'Default' : 'Yours'}
                      {v.isActive ? ' (your default)' : ''}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(v.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {v.id === prompt.id ? (
                        <Badge variant="success">In use</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Use v${v.version} for this role target`}
                          disabled={link.isPending}
                          onClick={() => link.mutate(v.id)}
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

          {before !== undefined && list.length > 1 ? (
            <section aria-labelledby="discovery-diff" className="grid gap-3">
              <h3 id="discovery-diff" className="text-sm font-semibold">
                Compare versions
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="discovery-from">Compare</Label>
                  <Select
                    id="discovery-from"
                    value={before.id}
                    onChange={(e) => setFromId(e.currentTarget.value)}
                  >
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version} {v.isSystem ? '(default)' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="discovery-to">With</Label>
                  <Select
                    id="discovery-to"
                    value={after.id}
                    onChange={(e) => setToId(e.currentTarget.value)}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Edit</CardTitle>
          <CardDescription>
            Saving creates a new version from the one in use and uses it for this role target only.
            Your other role targets and your default stay as they are. Text in double braces is
            filled in when ranking runs; keep those placeholders.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Label htmlFor="discovery-body">Prompt text</Label>
          <Textarea
            id="discovery-body"
            className="min-h-64 font-mono text-xs"
            spellCheck={false}
            value={text}
            onChange={(e) => setDraft(e.currentTarget.value)}
            aria-describedby={dropped.length > 0 ? 'discovery-dropped' : undefined}
          />
          {dropped.length > 0 ? (
            <p id="discovery-dropped" role="status" className="text-sm text-destructive">
              This draft no longer uses: {dropped.map((v) => `{{${v}}}`).join(', ')}. Ranking will
              not see that input.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={save} disabled={!dirty || edit.isPending}>
              {edit.isPending ? 'Saving...' : 'Save as new version'}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={draft === null}>
              Discard changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProposalCard(props: {
  roleTargetId: string;
  current: PromptVersion;
  proposal: PromptVersion;
}) {
  const accept = useAcceptRoleTargetProposal(props.roleTargetId);
  const discard = useDiscardRoleTargetProposal(props.roleTargetId);
  const { proposal } = props;
  const busy = accept.isPending || discard.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden="true" />
          Proposed refinement
        </CardTitle>
        <CardDescription>
          From your recent dismissals for this role target, a revised discovery prompt is suggested.
          It is not in use until you accept it, and then only for this role target.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {proposal.proposalSummary ? (
          <p className="text-sm">
            <span className="font-medium">What changed: </span>
            {proposal.proposalSummary}
          </p>
        ) : null}
        <VersionDiff before={props.current} after={proposal} />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              accept.mutate(proposal.id, {
                onSuccess: () =>
                  toast({
                    title: 'Refinement accepted',
                    description: `Version ${proposal.version} now ranks results for this role target.`,
                    variant: 'success',
                  }),
              })
            }
          >
            Accept
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              discard.mutate(proposal.id, {
                onSuccess: () => toast({ title: 'Proposal discarded' }),
              })
            }
          >
            Discard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
