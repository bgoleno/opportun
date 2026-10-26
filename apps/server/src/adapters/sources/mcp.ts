// MCP discovery source (FR-D1/D2, ADR-7, ADR-12). Calls the configured tool on the user's own MCP
// server and maps each result item to a posting through the configured dot paths. The output is
// untrusted: every mapped string is capped here (a hostile server can return megabytes), and the
// engine sanitizes the postings afterwards like any other source's. Items without a company or a
// title are counted and skipped.
import type { NormalizedPosting } from '@opportun/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { callMcpTool, type McpServerConfig } from '../../lib/mcpClient';
import { registerBuiltinSource, SourceConfigError, type DiscoverySource } from '../discoverySource';
import { McpConfigSchema, type McpConfig, type McpMapping } from './mcpConfig';

/** Mapping-level caps, applied before the engine's own (schema-sized) truncation. */
export const MCP_FIELD_CAPS = {
  company: 1_000,
  title: 1_000,
  descriptionMd: 100_000,
  postingUrl: 4_000,
  location: 1_000,
  externalId: 1_000,
} as const;
/** Items read from one tool result at most. */
export const MCP_MAX_ITEMS = 1_000;

/** The value at a dot path ("a.b.0.c"); own properties only, so no prototype walking. */
export function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(segment)) return undefined;
      cur = cur.at(Number(segment));
    } else if (typeof cur === 'object' && cur !== null && Object.hasOwn(cur, segment)) {
      // eslint-disable-next-line security/detect-object-injection -- own property, read only
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cur;
}

function capped(value: unknown, max: number): string | null {
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' && Number.isFinite(value)) s = String(value);
  else return null;
  s = s.trim();
  if (s.length === 0) return null;
  // Keep a surrogate pair whole at the cut.
  if (s.length > max) s = s.slice(0, /[\uD800-\uDBFF]/.test(s.charAt(max - 1)) ? max - 1 : max);
  return s;
}

/** One item as a posting, or null when it has no usable company or title. */
export function mapMcpItem(item: unknown, mapping: McpMapping): NormalizedPosting | null {
  const field = (key: keyof McpMapping): string | null => {
    // eslint-disable-next-line security/detect-object-injection -- key is a mapping field name
    const path = mapping[key];
    // eslint-disable-next-line security/detect-object-injection -- same fixed key
    return path === undefined ? null : capped(valueAt(item, path), MCP_FIELD_CAPS[key]);
  };
  const company = field('company');
  const title = field('title');
  if (company === null || title === null) return null;
  return {
    company,
    title,
    descriptionMd: field('descriptionMd'),
    postingUrl: field('postingUrl'),
    location: field('location'),
    externalId: field('externalId'),
  };
}

/** The tool's data: structured content when given, else the JSON in its text content. */
export function toolData(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('MCP tool output is not JSON');
  }
}

function serverOf(config: McpConfig): McpServerConfig {
  return config.transport === 'stdio'
    ? { transport: 'stdio', command: config.command, args: config.args }
    : { transport: 'http', url: config.url };
}

export const mcpSource: DiscoverySource = {
  kind: 'mcp',
  async *fetchPostings(sctx, rawConfig) {
    const parsed = McpConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw new SourceConfigError('invalid MCP source config');
    const config = parsed.data;
    const result = await callMcpTool(serverOf(config), config.tool, config.queryArgs);
    if (result.isError === true) {
      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join(' ')
        .slice(0, 200);
      throw new Error(`MCP tool ${config.tool} failed: ${text}`);
    }
    const data = toolData(result);
    const items = config.itemsPath === '' ? data : valueAt(data, config.itemsPath);
    if (!Array.isArray(items)) {
      throw new SourceConfigError(`MCP itemsPath "${config.itemsPath}" is not a list`);
    }
    let skipped = 0;
    for (const item of items.slice(0, MCP_MAX_ITEMS)) {
      const posting = mapMcpItem(item, config.mapping);
      if (posting === null) {
        skipped += 1;
        continue;
      }
      yield { posting, nextCursor: null };
    }
    if (skipped > 0 || items.length > MCP_MAX_ITEMS) {
      sctx.log.info(
        { tool: config.tool, skipped, truncated: Math.max(0, items.length - MCP_MAX_ITEMS) },
        'MCP items skipped',
      );
    }
  },
};

registerBuiltinSource(mcpSource);
