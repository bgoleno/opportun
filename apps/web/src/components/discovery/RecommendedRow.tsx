// One row of the Recommended companies list (https://github.com/bgoleno/opportun/issues/300, slice
// b of #222; mockup A's row, from #216's network row and the suggestion card). The name, the source
// badges (in your network, AI suggested, or both), the follow state and the board state are always
// shown; a suggestion says why; a tagged company says its industry against the confirmed profile;
// the contacts' names only behind the "You know N people" disclosure, so a glance at the list does
// not put everyone's name on screen. Every field is a React text node: a company name, a rationale
// and a contact's name are third-party or model text.
import { Check, Sparkles, Undo2, Users, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { NetworkCompany } from './companiesApi';
import { AtsStatusChip } from './CompanyCard';
import { CompanyIndustry } from './CompanyIndustry';
import type { Fit, Recommended } from './recommended';

const STRENGTH_LABELS = new Map([
  [3, 'Close'],
  [2, 'Know well'],
  [1, 'Acquaintance'],
]);

/** "You know 1 person here" or "You know 6 people here". */
export function knowLine(count: number): string {
  return `You know ${count} ${count === 1 ? 'person' : 'people'} here`;
}

/** "(2 close, 4 others)", "(1 close)", or "" when nobody here is close. */
export function closeSplit(contacts: NetworkCompany['contacts']): string {
  const close = contacts.filter((p) => p.strength === 3).length;
  if (close === 0) return '';
  const others = contacts.length - close;
  return others === 0
    ? `(${close} close)`
    : `(${close} close, ${others} other${others === 1 ? '' : 's'})`;
}

export function RecommendedRow(props: {
  item: Recommended;
  fit: Fit;
  busy?: boolean;
  onFollow: () => void;
  onDeny: () => void;
  onUndeny: () => void;
}) {
  const { company: c, contacts, sources } = props.item;
  const nameId = `recommended-company-${c.id}`;
  const split = closeSplit(contacts);
  return (
    <li
      aria-labelledby={nameId}
      className="grid min-w-0 gap-2 rounded-xl border bg-card p-4"
      data-company-id={c.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          id={nameId}
          data-company-name
          className="min-w-0 font-medium [overflow-wrap:anywhere]"
        >
          {c.name}
        </span>
        {c.status === 'followed' ? (
          <Badge>
            <Check aria-hidden="true" />
            Following
          </Badge>
        ) : null}
        {c.status === 'denied' ? <Badge variant="outline">Denied</Badge> : null}
        {c.domain ? (
          <span className="text-sm [overflow-wrap:anywhere] text-muted-foreground">{c.domain}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sources.network ? (
          <Badge variant="secondary">
            <Users aria-hidden="true" />
            In your network
          </Badge>
        ) : null}
        {sources.suggested ? (
          <Badge variant="secondary">
            <Sparkles aria-hidden="true" />
            AI suggested
          </Badge>
        ) : null}
        <AtsStatusChip company={c} />
      </div>
      {sources.suggested && c.suggestionRationale ? (
        <p className="text-sm [overflow-wrap:anywhere]">
          <span className="text-muted-foreground">Why: </span>
          {c.suggestionRationale}
        </p>
      ) : null}
      {props.item.contactCount > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer">
            <span className="font-medium">{knowLine(props.item.contactCount)}</span>
            {split !== '' ? <span className="text-muted-foreground"> {split}</span> : null}
          </summary>
          <ul className="mt-1 grid gap-0.5 pl-4" aria-label={`People you know at ${c.name}`}>
            {contacts.map((p) => (
              <li key={p.id} className="[overflow-wrap:anywhere]">
                {p.name}
                {p.strength !== null && STRENGTH_LABELS.has(p.strength) ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · {STRENGTH_LABELS.get(p.strength)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <CompanyIndustry company={c} fit={props.fit} />
      {c.status === 'denied' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={props.busy}
            onClick={props.onUndeny}
            aria-label={`Undo denying ${c.name}`}
          >
            <Undo2 aria-hidden="true" />
            Undo
          </Button>
        </div>
      ) : c.status === 'followed' ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={props.busy}
            onClick={props.onFollow}
            aria-label={`Follow ${c.name}`}
          >
            <Check aria-hidden="true" />
            Follow
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={props.busy}
            onClick={props.onDeny}
            aria-label={`Deny ${c.name}`}
          >
            <X aria-hidden="true" />
            Deny
          </Button>
        </div>
      )}
    </li>
  );
}
