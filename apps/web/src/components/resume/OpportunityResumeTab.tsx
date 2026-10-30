// The Resume tab of an opportunity: resumes attached to it, attaching one (existing or new),
// detaching or deleting one, and "Create tailored copy" (#70, #77).
import { Link, useNavigate } from '@tanstack/react-router';
import { FilePlus2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
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
  useResumes,
  type Resume,
} from './api';
import {
  ArchivedBadge,
  DeleteResumeButton,
  GoogleConnectHint,
  RegisterDocCard,
  StatusBadge,
} from './ResumeList';

/** A resume already registered elsewhere in Opportun, with no opportunity of its own yet. */
function AttachExistingCard({ opportunityId }: { opportunityId: string }) {
  const all = useResumes();
  const attach = useAttachResume();
  const [chosen, setChosen] = useState('');
  const unattached = (all.data?.items ?? []).filter((r) => r.opportunityId === null);
  const id = chosen || unattached[0]?.id || '';

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
          Link a resume already registered in Opportun, from anywhere else it was created.
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
            {attach.error ? (
              <FormError message={resumeErrorMessage(attach.error) ?? errorMessage(attach.error)} />
            ) : null}
            {/* eslint-disable-next-line opportun/no-stretched-grid-button -- full width by default, not by decision: w-fit or w-full is still to be chosen (https://github.com/bgoleno/opportun/issues/9) */}
            <Button onClick={attachChosen} disabled={attach.isPending}>
              {attach.isPending ? 'Attaching...' : 'Attach'}
            </Button>
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

export function OpportunityResumeTab({ opportunityId }: { opportunityId: string }) {
  const tailored = useResumes({ opportunityId });
  const bases = useResumes({ kind: 'base' });
  const create = useCreateResume();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState('');
  const baseItems = bases.data?.items ?? [];
  const baseId = chosen || baseItems[0]?.id || '';

  function createCopy() {
    if (baseId === '') return;
    create.mutate(
      { baseResumeId: baseId, opportunityId },
      { onSuccess: (r) => void navigate({ to: '/resumes/$id', params: { id: r.id } }) },
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader>
          <CardTitle>Resumes for this opportunity</CardTitle>
        </CardHeader>
        <CardContent>
          {tailored.isPending ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (tailored.data?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No tailored resume yet.</p>
          ) : (
            <ul className="grid gap-2">
              {tailored.data?.items.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <Link
                    to="/resumes/$id"
                    params={{ id: r.id }}
                    className="font-medium break-all text-primary underline-offset-4 hover:underline"
                  >
                    {r.title}
                  </Link>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <StatusBadge status={r.status} />
                    {r.archivedAt === null ? null : <ArchivedBadge />}
                    {formatDate(r.updatedAt)}
                    <DetachButton resume={r} />
                    <DeleteResumeButton resume={r} tailoredCount={0} />
                  </span>
                </li>
              ))}
            </ul>
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
    </div>
  );
}
