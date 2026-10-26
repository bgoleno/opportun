// Configuration of an MCP discovery source (FR-D1/D2, ADR-7, ADR-12). The user registers the
// server themselves: a command they typed (stdio) or an https URL (streamable HTTP). Opportun
// never suggests or ships a command. `tool` is called with `queryArgs`; `itemsPath` locates the
// result list in the tool output and `mapping` names, per posting field, a dot path into each
// item ("company.name", "links.0.href").
import { z } from 'zod';

const SEGMENT = /^[A-Za-z0-9_$-]{1,100}$/;

/** A dot path: 1 to 16 segments of letters, digits, _, $ or -; numeric segments index arrays. */
export function isMcpPath(path: string): boolean {
  const segments = path.split('.');
  return segments.length <= 16 && segments.every((s) => SEGMENT.test(s));
}
const Path = z.string().max(1700).refine(isMcpPath, { message: 'not a dot path' });

/** https only: the server is reached over the network, so plain http is refused. */
export const HttpsUrl = z
  .url()
  .max(2048)
  .refine((u) => new URL(u).protocol === 'https:', { message: 'MCP server URL must be https' });

export const McpMappingSchema = z
  .object({
    company: Path,
    title: Path,
    descriptionMd: Path.optional(),
    postingUrl: Path.optional(),
    location: Path.optional(),
    externalId: Path.optional(),
  })
  .strict();

const common = {
  tool: z.string().min(1).max(200),
  queryArgs: z
    .record(z.string().min(1).max(100), z.string().max(2000))
    .refine((r) => Object.keys(r).length <= 50, { message: 'at most 50 query arguments' }),
  mapping: McpMappingSchema,
  /** Where the list of results sits in the tool output; empty when the output is the list. */
  itemsPath: z.union([z.literal(''), Path]),
};

export const McpStdioConfig = z
  .object({
    transport: z.literal('stdio'),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(1000)).max(50),
    ...common,
  })
  .strict();

export const McpHttpConfig = z
  .object({ transport: z.literal('http'), url: HttpsUrl, ...common })
  .strict();

export const McpConfigSchema = z.discriminatedUnion('transport', [McpStdioConfig, McpHttpConfig]);
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpMapping = z.infer<typeof McpMappingSchema>;
