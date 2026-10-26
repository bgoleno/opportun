/** The OAuth flow returns to BASE_URL's origin and session cookies do not cross hosts,
 *  so a connect started while browsing any other address always ends unauthorized.
 *  Returns the origin the browser must be on, or null when it already is. */
export function requiredOrigin(redirectUri: string | undefined): string | null {
  if (redirectUri === undefined) return null;
  const origin = new URL(redirectUri).origin;
  return window.location.origin === origin ? null : origin;
}

export function OriginWarning({ origin, action }: { origin: string; action: string }) {
  return (
    <p
      className="rounded-md bg-warning px-3 py-2 text-xs text-warning-foreground"
      data-testid="google-origin-warning"
    >
      Google is connected once, from a browser on the machine running Opportun: {action} from there,
      not from this device. Its sign-in returns to{' '}
      <a className="underline" href={`${origin}/settings/integrations`}>
        {origin}
      </a>
      , and the login session does not carry across addresses, so no other browser can finish it.
    </p>
  );
}
