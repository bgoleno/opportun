// The version and commit that is running, under the Settings sections
// (https://github.com/bgoleno/opportun/issues/480). The server reads them from the build; a build
// without a version says it is a development build rather than show a made-up number.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BuildInfo {
  version: string | null;
  commit: string | null;
}

/** "Version 0.3.1 (d4d97b6)", "Development build (d4d97b6)" or "Development build". */
export function buildLabel(info: BuildInfo): string {
  const name = info.version === null ? 'Development build' : `Version ${info.version}`;
  return info.commit === null ? name : `${name} (${info.commit})`;
}

/** Nothing until the server has answered, so a slow answer never shows a wrong label first. */
export function BuildVersionText({ info }: { info: BuildInfo | undefined }) {
  if (info === undefined) return null;
  return <p className="px-3 pt-4 text-xs text-muted-foreground">{buildLabel(info)}</p>;
}

export function BuildVersion() {
  const build = useQuery({
    queryKey: ['settings', 'build'],
    queryFn: () => api<BuildInfo>('/settings/build'),
    // It cannot change while this server runs.
    staleTime: Infinity,
  });
  return <BuildVersionText info={build.data} />;
}
