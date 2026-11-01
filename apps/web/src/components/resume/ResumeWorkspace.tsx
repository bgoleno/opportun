// One resume: its document, status, the tailoring chat and the match report (FR-U4).
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { errorMessage } from '@/lib/api';
import { useMatchReport, useResume, type Resume } from './api';
import { ChatPanel } from './ChatPanel';
import { MatchPanel, MatchScoreHeader } from './MatchPanel';
import { ResumeTextViewer } from './ResumeTextViewer';
import { StatusControl } from './StatusControl';

function BackLink() {
  return (
    <Link
      to="/resumes"
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Resumes
    </Link>
  );
}

export function ResumeWorkspace({ id }: { id: string }) {
  const { data: resume, error, isPending } = useResume(id);

  if (error) {
    return (
      <section className="grid gap-4">
        <BackLink />
        <FormError message={errorMessage(error)} />
      </section>
    );
  }
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return <ResumeWorkspaceLoaded resume={resume} />;
}

/**
 * Split from ResumeWorkspace so useMatchReport is called unconditionally (resume is never
 * null or pending here), not after the early returns above.
 *
 * Issue #304: the score and the report used to share a fixed 22rem column, which gave neither
 * what it needed. A score is a glanceable metric wanting prominence and almost no width, so it
 * moves to the header beside the title and StatusControl, where the eye already lands. The
 * report and its guidance are reading material wanting a comfortable measure, so they move
 * into the main column at full width, above the chat -- which also fixes the column collapsing
 * to one below `lg`: there is only ever one column now, so the report is never pushed behind an
 * arbitrarily long transcript regardless of viewport.
 *
 * Issue #35: from `xl` the tailoring chat is a column of its own on the right (the --container-chat
 * token, docs/design.md section 9), beside the document and the report, its top level with
 * theirs. It is sticky and as tall as the window below the app header, so it stays in view while
 * the other column scrolls, and the conversation scrolls inside it (ChatPanel). Below `xl` the
 * sections stack as before, with the chat capped at 48rem so its composer and Send button do not
 * stretch across the page. In the document the chat still comes after the report.
 */
function ResumeWorkspaceLoaded({ resume }: { resume: Resume }) {
  const matchQuery = useMatchReport(resume.id, resume.opportunityId);
  const matchView = matchQuery.isPending ? undefined : (matchQuery.data ?? null);

  return (
    <section className="grid gap-6">
      <div className="grid gap-3">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight break-all">{resume.title}</h1>
              <Badge variant="secondary">{resume.kind === 'base' ? 'Base' : 'Tailored'}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              {resume.url ? (
                <a
                  href={resume.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  {resume.store === 'reactive_resume'
                    ? 'Open in Reactive Resume'
                    : 'Open in Google Docs'}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              ) : null}
              {resume.opportunityId ? (
                <Link
                  to="/opportunities/$id"
                  params={{ id: resume.opportunityId }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  View opportunity
                </Link>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <MatchScoreHeader view={matchView} />
            <StatusControl resume={resume} />
          </div>
        </div>
      </div>
      {/* Only when there is no external URL (issue #321): for local_file that is a fidelity
          guarantee, not a convenience -- readText on that store is lossless, since the stored
          content already is plain text, so this only ever renders a document it can show in
          full. A Google Doc or Reactive Resume document already has its own full-fidelity
          viewer, the "Open in ___" link just above. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_var(--container-chat)] xl:items-start">
        <div className="grid min-w-0 gap-6">
          {resume.url === null ? <ResumeTextViewer resumeId={resume.id} /> : null}
          <MatchPanel resume={resume} />
        </div>
        {/* top-22 is the app header (h-14) plus the main area's top padding (md:p-8), and the
            height leaves the same 2rem below, so a stuck column sits where the page's content
            starts and ends. */}
        <div className="w-full max-w-3xl xl:sticky xl:top-22 xl:h-[calc(100dvh-7.5rem)] xl:max-w-none">
          <ChatPanel resumeId={resume.id} />
        </div>
      </div>
    </section>
  );
}
