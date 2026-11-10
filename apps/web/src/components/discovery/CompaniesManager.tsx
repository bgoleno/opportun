// Discovery companies (FR-D8, FR-D9): where to look (#219), the Recommended companies list (the
// user's network and the suggestions, https://github.com/bgoleno/opportun/issues/300), the followed
// companies with their job board detection state, and the companies denied directly or from a
// suggestion (#199).
import { FormError } from '@/components/FormError';
import { errorMessage } from '@/lib/api';
import {
  useDeniedCompanies,
  useDenyCompanyByName,
  useDetectAts,
  useFollowedCompanies,
  useSetCareersUrl,
  useUndenyCompany,
} from './companiesApi';
import { DenyCompanyForm, DeniedCompanyRow, FollowedCompanyRow } from './CompanyCard';
import { IndustryProfilePanel } from './IndustryProfilePanel';
import { RecommendedCompanies } from './RecommendedCompanies';

export function CompaniesManager() {
  const followed = useFollowedCompanies();
  const denied = useDeniedCompanies();
  const denyByName = useDenyCompanyByName();
  const undeny = useUndenyCompany();
  const detect = useDetectAts();
  const careers = useSetCareersUrl();

  return (
    <div className="grid min-w-0 gap-8">
      <IndustryProfilePanel />

      <section className="grid gap-3" aria-labelledby="deny-company-heading">
        <h2 id="deny-company-heading" className="text-lg font-semibold">
          Deny a company
        </h2>
        <DenyCompanyForm
          busy={denyByName.isPending}
          onDeny={(name) => denyByName.mutateAsync(name)}
        />
      </section>

      <RecommendedCompanies />

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
