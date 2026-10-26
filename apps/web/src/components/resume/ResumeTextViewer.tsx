// The document itself, read-only (issue #321). Rendered only when the resume has no external
// URL (ResumeWorkspace decides that), which is not just a UI convenience: for local_file that
// is exactly the case where readText is lossless, since the stored content already is plain
// text, whereas a Google Doc or Reactive Resume document already has a full-fidelity viewer of
// its own (the "Open in ___" link). The condition is a fidelity guarantee, not a fallback.
//
// Rendered as one whitespace-pre-wrap block rather than parsed: readText's own contract is
// "plain text, one line per paragraph" with no markdown anywhere in it (local_file does no
// transformation in either direction, write or read), so parsing would gain nothing and would
// actively corrupt real content -- "C++ (3*)" or "#1 performer" read as markup, not prose.
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { errorMessage } from '@/lib/api';
import { useResumeText } from './api';

export interface ResumeTextViewerViewProps {
  /** undefined while the stored text is still loading. */
  text: string | undefined;
  error: unknown;
}

export function ResumeTextViewerView({ text, error }: ResumeTextViewerViewProps) {
  const [open, setOpen] = useState(true);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Document</CardTitle>
        <CardDescription>The resume's own text, as it stands now.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <FormError message={errorMessage(error)} /> : null}
        {text === undefined ? (
          error ? null : (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )
        ) : (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="-ml-2 w-fit justify-start gap-1.5">
                <ChevronDown
                  aria-hidden="true"
                  className={
                    open ? 'size-4 transition-transform' : 'size-4 -rotate-90 transition-transform'
                  }
                />
                {open ? 'Hide document' : 'Show document'}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="max-w-[65ch] text-sm whitespace-pre-wrap">{text}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

export function ResumeTextViewer({ resumeId }: { resumeId: string }) {
  const query = useResumeText(resumeId);
  return <ResumeTextViewerView text={query.data} error={query.error} />;
}
