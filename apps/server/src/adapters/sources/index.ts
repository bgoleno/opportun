// The shipped discovery source adapters. Importing this module registers each one as a
// built-in (C-2: only these ATS APIs and the user's own MCP servers are ever contacted).
import { registerBuiltinSource, type SourceKind } from '../discoverySource';
import { SITE_MODULES } from '../../sites';
import './workday';
import './mcp';

// A site with a board listing is the discovery source of its kind (#769).
for (const { identity, api } of SITE_MODULES) {
  if (identity.sourceKind === undefined || api?.listBoard === undefined) continue;
  registerBuiltinSource({ kind: identity.sourceKind as SourceKind, fetchPostings: api.listBoard });
}
