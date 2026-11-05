// Where to look (https://github.com/bgoleno/opportun/issues/219, #190 N4a): the user's industry
// profile, as a collapsible panel on the Companies tab. Suggest industries makes one AI call; the
// user confirms, removes or adds rows, and only confirmed rows count. A reason is the model's text,
// so it renders as plain text.
import { NAICS_2022_INDUSTRY_GROUPS, NAICS_TIERS, type NaicsTier } from '@opportun/core';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { resumeErrorMessage } from '@/components/resume/api';
import { ApiError, errorMessage } from '@/lib/api';
import {
  useAddIndustry,
  useConfirmIndustry,
  useIndustryProfile,
  useRemoveIndustry,
  useSuggestIndustries,
  type IndustryRow,
} from './companiesApi';

const TIER_LABELS = new Map<NaicsTier, string>([
  ['core', 'Core'],
  ['similar', 'Similar'],
  ['adjacent', 'Adjacent'],
]);

const SOURCE_LABELS = new Map<string, string>([
  ['resume', 'From your resume'],
  ['target', 'From your role targets'],
  ['user', 'Added by you'],
]);

/** By title: nobody looks an industry up by its code. */
const BY_TITLE = [...NAICS_2022_INDUSTRY_GROUPS].sort((x, y) => x.title.localeCompare(y.title));

const KEY_FIX = 'Add a working key in Settings > AI, then try again.';

/** Why the AI call did not work, and what to do. A problem with the key will not pass with time. */
function aiFailure(reason: unknown, keyHint: unknown): string {
  const hint = typeof keyHint === 'string' && keyHint !== '' ? keyHint : null;
  if (reason === 'key_rejected') {
    return `The AI provider rejected your key${hint === null ? '' : `: ${hint}`}. ${KEY_FIX}`;
  }
  if (hint !== null) return `The AI provider could not be used: ${hint}. ${KEY_FIX}`;
  switch (reason) {
    case 'no_key':
      return 'AI is not set up. Add a key in Settings > AI, then try again.';
    case 'budget_exceeded':
      return "Today's AI budget is spent, so nothing was sent. Try again on the next budget day, or raise the discovery budget in Settings > AI.";
    case 'invalid_output':
      return "The AI's answer could not be used, so nothing changed. Try again.";
    case 'provider_error':
      return 'The AI provider was unavailable, so nothing changed. Try again later.';
    case 'no_prompt':
      return 'The prompt for this is missing, so nothing was sent. Whoever runs this Opportun needs to check it is fully updated.';
    default:
      return 'The AI call could not be made, so nothing changed. Try again later.';
  }
}

/** What failed, in the user's words, and what to do. The server's codes never reach the page. */
function suggestError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return 'Could not reach the server. Check your connection, then try again.';
  }
  switch (err.code) {
    case 'no_profile_input':
      return 'Add a base resume or a role target first: there is nothing to read yet.';
    case 'resume_unreadable': {
      // The store's code picks the fix, in the words the Resumes pages already use for it.
      const fix = resumeErrorMessage(new ApiError(err.status, String(err.details.reason)));
      return `Could not read your base resume, "${String(err.details.title)}". ${
        fix ?? 'Check that it still opens under Resumes, then try again.'
      }`;
    }
    case 'ai_unavailable':
      return aiFailure(err.details.reason, err.details.keyHint);
    // Already in plain words, and about the session rather than this call.
    case 'csrf':
    case 'rate_limited':
    case 'unauthorized':
      return errorMessage(err);
    default:
      return 'Something went wrong on the server. Try again, and if it keeps happening, whoever runs this Opportun can check its log.';
  }
}

function IndustryChip({ row }: { row: IndustryRow }) {
  const confirm = useConfirmIndustry();
  const remove = useRemoveIndustry();
  const busy = confirm.isPending || remove.isPending;
  return (
    <li className="grid min-w-0 gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium [overflow-wrap:anywhere]">{row.title}</span>
        <Badge variant={row.confirmed ? 'success' : 'outline'}>
          {row.confirmed ? 'Confirmed' : 'Not counted yet'}
        </Badge>
      </div>
      {row.reason === null ? null : (
        <p className="text-sm [overflow-wrap:anywhere]">{row.reason}</p>
      )}
      <p className="text-xs text-muted-foreground">{SOURCE_LABELS.get(row.source) ?? row.source}</p>
      <div className="flex flex-wrap gap-2">
        {row.confirmed ? null : (
          <Button
            size="sm"
            aria-label={`Confirm ${row.title}`}
            disabled={busy}
            onClick={() => confirm.mutate(row.code)}
          >
            Confirm
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-label={`Remove ${row.title}`}
          disabled={busy}
          onClick={() => remove.mutate(row.code)}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

function AddIndustry({ taken }: { taken: ReadonlySet<string> }) {
  const add = useAddIndustry();
  const [code, setCode] = useState('');
  const [tier, setTier] = useState<NaicsTier>('core');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ code, tier }, { onSuccess: () => setCode('') });
      }}
    >
      <div className="grid min-w-0 flex-1 basis-56 gap-1">
        <Label htmlFor="industry-add-code">Industry</Label>
        <Select
          id="industry-add-code"
          value={code}
          className="w-full min-w-0"
          onChange={(e) => setCode(e.currentTarget.value)}
        >
          <option value="">Choose an industry</option>
          {BY_TITLE.filter((g) => !taken.has(g.code)).map((g) => (
            <option key={g.code} value={g.code}>
              {g.title} ({g.code})
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="industry-add-tier">Tier</Label>
        <Select
          id="industry-add-tier"
          value={tier}
          onChange={(e) => setTier(e.currentTarget.value as NaicsTier)}
        >
          {NAICS_TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS.get(t)}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={code === '' || add.isPending}>
        Add
      </Button>
    </form>
  );
}

export function IndustryProfilePanel() {
  const profile = useIndustryProfile();
  const suggest = useSuggestIndustries();
  const rows = profile.data?.items ?? [];
  const confirmed = rows.filter((r) => r.confirmed).length;
  return (
    <details className="min-w-0 rounded-md border p-3" aria-label="Where to look">
      <summary className="cursor-pointer">
        <span className="text-lg font-semibold">Where to look</span>{' '}
        {profile.data === undefined ? null : (
          <span className="text-sm text-muted-foreground">
            {confirmed} confirmed, {rows.length - confirmed} to review
          </span>
        )}
      </summary>
      <div className="mt-3 grid min-w-0 gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          The industries to look for companies in. Suggest industries sends your base resume and
          your role targets' title families, industries and keywords to your AI provider, in one
          call that counts against your discovery budget. Only the ones you confirm count.
        </p>
        <div>
          <Button
            disabled={suggest.isPending}
            onClick={() =>
              suggest.mutate(undefined, {
                onSuccess: ({ suggested }) =>
                  toast({
                    title:
                      suggested === 0
                        ? 'No new industries came back'
                        : `${suggested} ${suggested === 1 ? 'industry' : 'industries'} to review`,
                    variant: suggested === 0 ? 'default' : 'success',
                  }),
              })
            }
          >
            {suggest.isPending ? 'Suggesting...' : 'Suggest industries'}
          </Button>
        </div>
        {suggest.error ? (
          // The message can hold a resume's title, which can be one long unbroken filename.
          <FormError className="[overflow-wrap:anywhere]" message={suggestError(suggest.error)} />
        ) : null}
        {profile.error ? <FormError message={errorMessage(profile.error)} /> : null}
        {NAICS_TIERS.map((tier) => {
          const inTier = rows.filter((r) => r.tier === tier);
          if (inTier.length === 0) return null;
          const name = TIER_LABELS.get(tier);
          return (
            <section key={tier} className="grid min-w-0 gap-2">
              <h3 className="text-sm font-semibold">{name}</h3>
              <ul className="grid min-w-0 gap-2" aria-label={`${name} industries`}>
                {inTier.map((r) => (
                  <IndustryChip key={r.code} row={r} />
                ))}
              </ul>
            </section>
          );
        })}
        <AddIndustry taken={new Set(rows.map((r) => r.code))} />
      </div>
    </details>
  );
}
