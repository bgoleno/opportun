import { createFileRoute } from '@tanstack/react-router';
import { TelemetrySettings } from '@/components/telemetry/TelemetrySettings';

/**
 * Settings > Telemetry (FR-T2, https://github.com/bgoleno/opportun/issues/342): the Collect
 * switch and the export card. Every signed-in user sees whether each is on; the server sends the
 * destination and the controls' state to admins only, and refuses anyone else's changes.
 */
export const Route = createFileRoute('/settings/telemetry')({
  component: TelemetryRoute,
});

function TelemetryRoute() {
  const { user } = Route.useRouteContext();
  if (user === null) return null;
  return <TelemetrySettings isAdmin={user.isAdmin} />;
}
