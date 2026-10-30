// "Continue with ..." links on the login page, one per provider an admin configured.
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { oauthProvidersQuery, oauthStartHref, providerLabel } from '@/lib/oauth';

export function OAuthButtons() {
  const providers = useQuery(oauthProvidersQuery);
  const list = providers.data ?? [];
  if (list.length === 0) return null;
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or continue with
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-2">
        {list.map((p) => (
          <Button key={p} asChild variant="outline" className="w-full">
            {/* A full navigation: the server redirects to the provider. */}
            <a href={oauthStartHref(p)}>Continue with {providerLabel(p)}</a>
          </Button>
        ))}
      </div>
    </div>
  );
}
