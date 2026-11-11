// The Resume tab of an opportunity: resumes attached to it, attaching one (existing or new),
// detaching or deleting one, and "Create tailored copy" (#70, #77). A base resume is never
// attached; it is recorded as sent instead, and listed with its sends (#158).
import { Link, useNavigate } from '@tanstack/react-router';
import { FilePlus2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { MainWithRail } from '@/components/MainWithRail';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/opportunities';
import {
  resumeErrorMessage,
  useAttachResume,
  useCreateResume,
  useOpportunitySends,
  useResumes,
  type Resume,
  type ResumeSend,
} from './api';
import {
  ArchivedBadge,
  DeleteResumeButton,
  GoogleConnectHint,
  RegisterDocCard,
  StatusBadge,
} from './ResumeList';
import { RecordSendFields, RemoveSendButton, sentLine } from './ResumeSends';

/** A resume already registered elsewhere in Opportun, with no opportunity of its own yet. */
function AttachExistingCard({ opportunityId }: { opportunityId: string }) {
  const all = useResumes();
  const attach = useAttachResume();
  const [chosen, setChosen] = useState('');
  const unattached = (all.data?.items ?? []).filter((r) => r.opportunityId === null);
  const id = chosen || unattached[0]?.id || '';
  const picked = unattached.find((r) => r.id === id);

  function attachChosen() {
    if (id === '') return;
    attach.mutate(
      { id, opportunityId },
      {
        onSuccess: (r) =>
          toast({ title: 'Resume attached', description: r.title, variant: 'success' }),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attach an existing resume</CardTitle>
        <CardDescription>
          Link a resume already registered in Opportun, from anywhere else it was created. A base
          resume you sent as it is (for example through a job site) is recorded as sent.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {all.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : unattached.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unattached resume to pick from right now.
          </p>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="attach-resume">Resume</Label>
              <Select
                id="attach-resume"
                value={id}
                onChange={(e) => setChosen(e.currentTarget.value)}
              >
                {unattached.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} ({r.kind === 'base' ? 'Base' : 'Tailored'})
                  </option>
                ))}
              </Select>
            </div>
            {picked?.kind === 'base' ? (
              <RecordSendFields key={picked.id} opportunityId={opportunityId} resume={picked} />
            ) : (
              <>
                {attach.error ? (
                  <FormError
                    message={resumeErrorMessage(attach.error) ?? errorMessage(attach.error)}
                  />
                ) : null}
                {/* eslint-disable-next-line opportun/no-stretched-grid-button -- full width by default, not by decision: w-fit or w-full is still to be chosen (https://github.com/bgoleno/opportun/issues/9) */}
                <Button onClick={attachChosen} disabled={attach.isPending}>
                  {attach.isPending ? 'Attaching...' : 'Attach'}
                </Button>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DetachButton({ resume }: { resume: Resume }) {
  const attach = useAttachResume();
  return (
    <IconButton
      variant="ghost"
      label={`Remove ${resume.title} from this opportunity`}
      disabled={attach.isPending}
      onClick={() =>
        attach.mutate(
          { id: resume.id, opportunityId: null },
          {
            onSuccess: () =>
              toast({ title: 'Resume removed from this opportunity', variant: 'success' }),
            onError: (err) =>
              toast({
                title: 'Could not remove the resume',
                description: resumeErrorMessage(err) ?? errorMessage(err),
                variant: 'destructive',
              }),
          },
        )
      }
    >
      <Unlink aria-hidden="true" />
    </IconButton>
  );
}

/** One resume on this tab and its sends for this opportunity (#404, tl's decision 2). */
interface ResumeRowData {
  resumeId: string;
  title: string;
  kind: 'base' | 'tailored';
  /** The resume itself, when it is one this tab has loaded (attached here, or a base). */
  resume: Resume | undefined;
  /** Attached to this opportunity: it can be detached or deleted here. */
  attached: boolean;
  sends: ResumeSend[];
}

/**
 * One entry for each resume attached to this opportunity or sent for it, with its sends inside
 * it (#404): a send is a fact about a resume, not a second document. Attached resumes first, in
 * their own order; then resumes known here only from a send (a base sent as it is), in the order
 * of their sends.
 */
export function resumeRows(
  attached: readonly Resume[],
  sends: readonly ResumeSend[],
  bases: readonly Resume[],
): ResumeRowData[] {
  const rows = attached.map<ResumeRowData>((r) => ({
    resumeId: r.id,
    title: r.title,
    kind: r.kind,
    resume: r,
    attached: true,
    sends: sends.filter((s) => s.resumeId === r.id),
  }));
  for (const s of sends) {
    if (rows.some((row) => row.resumeId === s.resumeId)) continue;
    rows.push({
      resumeId: s.resumeId,
      title: s.resumeTitle,
      kind: s.resumeKind,
      resume: bases.find((b) => b.id === s.resumeId),
      attached: false,
      sends: sends.filter((x) => x.resumeId === s.resumeId),
    });
  }
  return rows;
}

function ResumeRow({ row, opportunityId }: { row: ResumeRowData; opportunityId: string }) {
  const r = row.resume;
  return (
    <li className="grid gap-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/resumes/$id"
            params={{ id: row.resumeId }}
            className="font-medium break-all text-primary underline-offset-4 hover:underline"
          >
            {row.title}
          </Link>
          <Badge variant="secondary">{row.kind === 'base' ? 'Base resume' : 'Tailored'}</Badge>
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          {r === undefined ? null : <StatusBadge status={r.status} />}
          {r === undefined || r.archivedAt === null ? null : <ArchivedBadge />}
          {r === undefined ? null : `Updated ${formatDate(r.updatedAt)}`}
          {row.attached && r !== undefined ? (
            <>
              <DetachButton resume={r} />
              <DeleteResumeButton resume={r} tailoredCount={0} />
            </>
          ) : null}
        </span>
      </div>
      {row.sends.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>{sentLine(s)}</span>
          {s.submissionId === null ? null : (
            <Link
              to="/opportunities/$id/applications/$submissionId"
              params={{ id: opportunityId, submissionId: s.submissionId }}
              className="text-primary underline-offset-4 hover:underline"
            >
              View application
            </Link>
          )}
          <RemoveSendButton opportunityId={opportunityId} send={s} />
        </div>
      ))}
    </li>
  );
}

export function OpportunityResumeTab({ opportunityId }: { opportunityId: string }) {
  const tailored = useResumes({ opportunityId });
  const sends = useOpportunitySends(opportunityId);
  const sendItems = sends.data?.items ?? [];
  const bases = useResumes({ kind: 'base' });
  const create = useCreateResume();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState('');
  const baseItems = bases.data?.items ?? [];
  const rows = resumeRows(tailored.data?.items ?? [], sendItems, baseItems);
  const baseId = chosen || baseItems[0]?.id || '';

  function createCopy() {
    if (baseId === '') return;
    create.mutate(
      { baseResumeId: baseId, opportunityId },
      { onSuccess: (r) => void navigate({ to: '/resumes/$id', params: { id: r.id } }) },
    );
  }

  return (
    <MainWithRail>
      <Card>
        <CardHeader>
          <CardTitle>Resumes for this opportunity</CardTitle>
        </CardHeader>
        <CardContent>
          {tailored.isPending || sends.isPending ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (tailored.data?.items.length ?? 0) === 0 && sendItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No resume for this opportunity yet.</p>
          ) : (
            <>
              <ul className="grid gap-2" aria-label="Resumes for this opportunity">
                {rows.map((row) => (
                  <ResumeRow key={row.resumeId} row={row} opportunityId={opportunityId} />
                ))}
              </ul>
              {sendItems.some((s) => s.submissionId !== null) ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  The file that was sent is kept with the application.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Create tailored copy</CardTitle>
            <CardDescription>
              Copies a base resume next to it (Google Drive or Reactive Resume), named by your
              naming template.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <GoogleConnectHint />
            {bases.isPending ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : baseItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No base resume yet.{' '}
                <Link to="/resumes" className="text-primary underline-offset-4 hover:underline">
                  Register one
                </Link>
                .
              </p>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="tailor-base">Base resume</Label>
                  <Select
                    id="tailor-base"
                    value={baseId}
                    onChange={(e) => setChosen(e.currentTarget.value)}
                  >
                    {baseItems.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                  </Select>
                </div>
                {create.error ? (
                  <FormError
                    message={resumeErrorMessage(create.error) ?? errorMessage(create.error)}
                  />
                ) : null}
                {/* eslint-disable-next-line opportun/no-stretched-grid-button -- full width by default, not by decision: w-fit or w-full is still to be chosen (https://github.com/bgoleno/opportun/issues/9) */}
                <Button onClick={createCopy} disabled={create.isPending}>
                  <FilePlus2 aria-hidden="true" />
                  {create.isPending ? 'Copying...' : 'Create tailored copy'}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
        <AttachExistingCard opportunityId={opportunityId} />
        <RegisterDocCard opportunityId={opportunityId} />
      </div>
    </MainWithRail>
  );
}
