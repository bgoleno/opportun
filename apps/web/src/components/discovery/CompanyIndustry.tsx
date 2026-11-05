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

function industryLine(c: CompanyView): string {
  const title = c.naicsCode == null ? undefined : naicsTitle(c.naicsCode);
  if (title !== undefined) {
    return `Industry: ${title}${c.industrySource === 'user' ? ' (set by you)' : ''}`;
  }
  return c.industryAt == null ? 'Industry: not tagged yet' : 'Industry: could not be placed';
}

export function CompanyIndustry({ company: c }: { company: CompanyView }) {
  const set = useSetCompanyIndustry();
  const [code, setCode] = useState('');
  const id = useId();
  return (
    <details className="text-sm">
      <summary className="cursor-pointer [overflow-wrap:anywhere]">{industryLine(c)}</summary>
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
    </details>
  );
}
