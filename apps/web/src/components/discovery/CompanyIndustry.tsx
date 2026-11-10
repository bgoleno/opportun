// A candidate company's industry (https://github.com/bgoleno/opportun/issues/220): the NAICS tag the
// model gave it, and a way to correct it, which then stands. A company name is third-party text, so
// it is only ever a React text node or an attribute value.
import { naicsTitle } from '@opportun/core';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useSetCompanyIndustry, type CompanyView } from './companiesApi';
import { NAICS_BY_TITLE } from './IndustryProfilePanel';
import { TIER_WORDS, type Fit } from './recommended';

function industryLine(c: CompanyView, fit?: Fit): string {
  const title = c.naicsCode == null ? undefined : naicsTitle(c.naicsCode);
  if (title !== undefined) {
    // How the tag stands against the confirmed profile (#300): the tier and the profile row's
    // reason, or "other industries" for a tag outside it; and whether the user set it.
    const notes: string[] = [];
    if (fit?.kind === 'tier') notes.push(TIER_WORDS[fit.tier]);
    if (fit?.kind === 'other') notes.push('other industries');
    if (c.industrySource === 'user') notes.push('set by you');
    const reason = fit?.kind === 'tier' && fit.row.reason ? `: ${fit.row.reason}` : '';
    return `Industry: ${title}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}${reason}`;
  }
  if (c.industryAt != null) return 'Industry: could not be placed';
  // Only a candidate gets a tag, so do not promise one to a company that was followed or denied.
  return c.status === 'followed' || c.status === 'denied'
    ? 'Industry: not set'
    : 'Industry: not tagged yet';
}

export function CompanyIndustry({ company: c, fit }: { company: CompanyView; fit?: Fit }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="text-sm" open={open}>
      <summary
        className="cursor-pointer [overflow-wrap:anywhere]"
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        {industryLine(c, fit)}
      </summary>
      {/* Only once open: closed, 308 options on each of hundreds of rows froze the tab (tl). */}
      {open ? <IndustryForm company={c} /> : null}
    </details>
  );
}

function IndustryForm({ company: c }: { company: CompanyView }) {
  const set = useSetCompanyIndustry();
  const [code, setCode] = useState('');
  const id = useId();
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        set.mutate({ id: c.id, code }, { onSuccess: () => setCode('') });
      }}
    >
      <div className="grid min-w-0 flex-1 basis-56 gap-1">
        <Label htmlFor={id}>Correct the industry</Label>
        <Select
          id={id}
          aria-label={`Industry of ${c.name}`}
          value={code}
          className="w-full min-w-0"
          onChange={(e) => setCode(e.currentTarget.value)}
        >
          <option value="">Choose an industry</option>
          {NAICS_BY_TITLE.filter((g) => g.code !== c.naicsCode).map((g) => (
            <option key={g.code} value={g.code}>
              {g.title} ({g.code})
            </option>
          ))}
        </Select>
      </div>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        aria-label={`Save industry of ${c.name}`}
        disabled={code === '' || set.isPending}
      >
        Save
      </Button>
    </form>
  );
}
