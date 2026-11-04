// Discovery companies (FR-D8, FR-D9): the companies in the user's network
// (https://github.com/bgoleno/opportun/issues/216), the suggestion queue, the followed companies
// with their job board detection state, and the companies denied directly or from a suggestion
// (#199).
import { useId, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api';
import {
  useAcceptCompany,
  useCompanySuggestions,
  useDeniedCompanies,
  useDenyCompany,
  useDenyCompanyByName,
  useDenyNetworkCompany,
  useDetectAts,
  useFollowCompany,
  useFollowedCompanies,
  useNetworkCompanies,
  useSetCareersUrl,
  useUndenyCompany,
} from './companiesApi';
import {
  DenyCompanyForm,
  DeniedCompanyRow,
  FollowedCompanyRow,
  SuggestionCard,
} from './CompanyCard';
import { NetworkCompanyRow } from './NetworkCompanyRow';

export function CompaniesManager() {
  const suggestions = useCompanySuggestions();
  const followed = useFollowedCompanies();
  const denied = useDeniedCompanies();
  const accept = useAcceptCompany();
  const deny = useDenyCompany();
  const denyByName = useDenyCompanyByName();
  const undeny = useUndenyCompany();
  const detect = useDetectAts();
  const careers = useSetCareersUrl();
  const [showDenied, setShowDenied] = useState(false);
  const network = useNetworkCompanies(showDenied);
  const follow = useFollowCompany();
  const denyNetwork = useDenyNetworkCompany();
  const showDeniedId = useId();

  return (
    <div className="grid min-w-0 gap-8">
      <section className="grid gap-3" aria-labelledby="deny-company-heading">
        <h2 id="deny-company-heading" className="text-lg font-semibold">
          Deny a company
        </h2>
        <DenyCompanyForm
          busy={denyByName.isPending}
          onDeny={(name) => denyByName.mutateAsync(name)}
        />
      </section>

      <section className="grid gap-3" aria-labelledby="network-companies-heading">
        <h2 id="network-companies-heading" className="text-lg font-semibold">
          In your network
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Companies where someone in your contacts works now, read from your own contacts.
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id={showDeniedId}
            checked={showDenied}
            onCheckedChange={(v) => setShowDenied(v === true)}
          />
          <Label htmlFor={showDeniedId} className="text-sm font-normal">
            Show denied
          </Label>
        </div>
        {network.error ? <FormError message={errorMessage(network.error)} /> : null}
        {network.isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {network.data !== undefined && network.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. Add your contacts' current companies under Network to see them here.
          </p>
        ) : null}
        <ul className="grid gap-3" aria-label="Companies in your network">
          {(network.data?.items ?? []).map((item) => {
            const c = item.company;
            const busy =
              (follow.isPending && follow.variables?.id === c.id) ||
              (denyNetwork.isPending && denyNetwork.variables?.id === c.id) ||
              (undeny.isPending && undeny.variables?.id === c.id);
            return (
              <NetworkCompanyRow
                key={c.id}
                item={item}
                busy={busy}
                onFollow={() => follow.mutate(c)}
                onDeny={() => denyNetwork.mutate(c)}
                onUndeny={() => undeny.mutate(c)}
              />
            );
          })}
        </ul>
      </section>

      <section className="grid gap-3" aria-labelledby="company-suggestions-heading">
        <h2 id="company-suggestions-heading" className="text-lg font-semibold">
          Suggested companies
        </h2>
        {suggestions.error ? <FormError message={errorMessage(suggestions.error)} /> : null}
        {suggestions.isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {suggestions.data !== undefined && suggestions.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No suggestions right now. New ones appear as your pipeline grows.
          </p>
        ) : null}
        <ul className="grid gap-3" aria-label="Suggested companies">
          {(suggestions.data?.items ?? []).map((c) => (
            <SuggestionCard
              key={c.id}
              company={c}
              onAccept={() => accept.mutate(c)}
              onDeny={() => deny.mutate(c)}
            />
          ))}
        </ul>
      </section>

      <section className="grid gap-3" aria-labelledby="followed-companies-heading">
        <h2 id="followed-companies-heading" className="text-lg font-semibold">
          Followed companies
        </h2>
        {followed.error ? <FormError message={errorMessage(followed.error)} /> : null}
        {followed.isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {followed.data !== undefined && followed.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You are not following any companies yet. Follow a suggestion to poll its job board.
          </p>
        ) : null}
        <ul className="grid gap-3" aria-label="Followed companies">
          {(followed.data?.items ?? []).map((c) => (
            <FollowedCompanyRow
              key={c.id}
              company={c}
              detecting={detect.isPending && detect.variables === c.id}
              onDetect={() => detect.mutate(c.id)}
              onSaveCareersUrl={(careersUrl) => careers.mutateAsync({ id: c.id, careersUrl })}
            />
          ))}
        </ul>
      </section>

      <section className="grid gap-3" aria-labelledby="denied-companies-heading">
        <h2 id="denied-companies-heading" className="text-lg font-semibold">
          Denied companies
        </h2>
        {denied.error ? <FormError message={errorMessage(denied.error)} /> : null}
        {denied.isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {denied.data !== undefined && denied.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have not denied any companies.</p>
        ) : null}
        <ul className="grid gap-3" aria-label="Denied companies">
          {(denied.data?.items ?? []).map((c) => (
            <DeniedCompanyRow
              key={c.id}
              company={c}
              busy={undeny.isPending && undeny.variables?.id === c.id}
              onUndeny={() => undeny.mutate(c)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
