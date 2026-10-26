// How a discovery source is named on an opportunity's timeline, shared by the accept route
// and the capture resolve path so one posting folded in from two places reads the same way.
import type { DiscoverySourceKind } from '@opportun/core';

const SOURCE_LABELS = new Map<DiscoverySourceKind, string>([
  ['ats_greenhouse', 'Greenhouse (ats_greenhouse)'],
  ['ats_lever', 'Lever (ats_lever)'],
  ['ats_ashby', 'Ashby (ats_ashby)'],
  ['ats_workday', 'Workday (ats_workday)'],
  ['mcp', 'an MCP source (mcp)'],
  ['alert_email', 'a job alert email (alert_email)'],
  ['manual', 'manual capture (manual)'],
  ['extension', 'the browser extension (extension)'],
]);

export function sourceLabel(kind: DiscoverySourceKind): string {
  return SOURCE_LABELS.get(kind) ?? kind;
}
