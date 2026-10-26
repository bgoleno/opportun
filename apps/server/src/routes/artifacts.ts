// Extension artifacts (FR-C5; design D1, D10, D11, D15, D16, D21, D22). The browser extension
// is built into the image, so installing it needs no checkout and no toolchain: the running
// server hands it over as a download. The zip is assembled per request rather than served as a
// static file because it carries one extra file naming the address this server was reached on,
// which is what leaves the token as the only thing a user ever pastes into the extension.
//
// Nothing here compiles or fetches anything: it reads files the image already holds and zips
// them. The device token is deliberately NOT written into the archive, because a zip in a
// Downloads folder, possibly synced to a cloud drive, is the wrong place for a bearer secret.
import { join } from 'node:path';
import { strFromU8, zipSync } from 'fflate';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { isOperatorFile, readOperatorBytes, readOperatorTree } from '../lib/storage';
import { requireUser } from '../repos/base';

/** Browser targets, as a list so a third one is additive rather than a refactor (D11). */
/**
 * `folder` is the directory the archive wraps its files in, or undefined for a flat archive.
 * Chrome installs an unpacked folder and the setup steps name it, so its download has to
 * contain one: without it, `unzip` on Linux empties the files into the download directory and
 * "choose that folder" points at whatever else is sitting there. Firefox reads the zip itself
 * in about:debugging and needs manifest.json at the root, so it stays flat.
 */
export const EXTENSION_TARGETS = [
  { id: 'chrome', label: 'Chrome, Edge, Brave', folder: 'opportun-chrome' },
  { id: 'firefox', label: 'Firefox', folder: undefined },
] as const;

export type ExtensionTargetId = (typeof EXTENSION_TARGETS)[number]['id'];

/** Shown instead of a download when the artifacts were never built (D15). */
export const BUILD_COMMAND = 'pnpm --filter @opportun/extension build';

/** The one file added to every download: this server's address and nothing else (D10). */
export const SERVER_FILE = 'opportun-server.json';

/** No target id is anywhere near this long; the allowlist below is the real gate. */
const TargetParams = z.object({ target: z.string().max(64) });

/**
 * A ceiling on what one download may be. The directory is operator-configured, and both
 * targets are about 32 KB, so this is only here to make a mis-set ARTIFACTS_DIR fail visibly
 * rather than read a whole disk into memory.
 */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

const ListResponse = z.object({
  targets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      filename: z.string(),
      available: z.boolean(),
      // #118: the same version_name chrome://extensions/about:debugging show for an installed
      // copy, so the setup dialog can show it next to the download for a direct comparison.
      // null when there's no built manifest to read it from, or no version_name in it.
      buildStamp: z.string().nullable(),
    }),
  ),
  buildCommand: z.string(),
  /** The address the download will carry, so the dialog can show it before anyone installs. */
  baseUrl: z.string(),
});

/**
 * The base URL the client reached this server on (D21). Configuration cannot answer this: one
 * install is reached at localhost on its own machine, at <machine>.local from a phone and at a
 * LAN address from another computer (ADR-14), and OPPORTUN_BASE_URL names only one of them. A
 * pre-filled address that is wrong for the browser doing the download is worse than an empty
 * field, because the dialog promises it is right. Any path prefix comes from the configured
 * base URL, since a request cannot carry one (D22).
 */
export function requestBaseUrl(req: FastifyRequest, configuredBaseUrl: string): string {
  const prefix = new URL(configuredBaseUrl).pathname.replace(/\/+$/, '');
  // Fastify 5: `host` keeps the port, `hostname` drops it. Both honor trustProxy.
  return `${req.protocol}://${req.host}${prefix}`;
}

const targetDir = (artifactsDir: string, id: ExtensionTargetId): string => join(artifactsDir, id);

/** A target is available when its directory holds a manifest. */
const isAvailable = (artifactsDir: string, id: ExtensionTargetId): boolean =>
  isOperatorFile(join(targetDir(artifactsDir, id), 'manifest.json'));

/** The extension's own version, so the file names what it is; absent when unreadable. */
function version(manifest: Uint8Array | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(strFromU8(manifest));
    const v = (raw as { version?: unknown }).version;
    return typeof v === 'string' && /^[\w.-]{1,32}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The exact string chrome://extensions and Firefox's about:debugging/about:addons show in
 * place of `version` for this same manifest (#92: a content hash, a commit when one could be
 * determined, and a build time). Handed back here too (#118) so the setup dialog can show it
 * next to the download: comparing this to what an already-installed copy's card shows is a
 * glance at two strings instead of rebuilding and diffing bytes by hand, which is what #79
 * cost. No filename-safe constraint here, unlike `version`: this is for display, not a path
 * segment.
 */
function buildStamp(manifest: Uint8Array | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(strFromU8(manifest));
    const v = (raw as { version_name?: unknown }).version_name;
    return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
  } catch {
    return undefined;
  }
}

function filename(id: ExtensionTargetId, manifest?: Uint8Array): string {
  const v = version(manifest);
  return v === undefined ? `opportun-${id}.zip` : `opportun-${id}-${v}.zip`;
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const artifactsDir = app.config.artifactsDir;

  api.get('/artifacts/extension', { schema: { response: { 200: ListResponse } } }, async (req) => {
    requireUser(req);
    return {
      targets: EXTENSION_TARGETS.map((t) => {
        const manifest =
          artifactsDir === undefined
            ? undefined
            : readOperatorBytes(join(targetDir(artifactsDir, t.id), 'manifest.json'));
        return {
          id: t.id,
          label: t.label,
          filename: filename(t.id, manifest),
          available: artifactsDir !== undefined && isAvailable(artifactsDir, t.id),
          buildStamp: buildStamp(manifest) ?? null,
        };
      }),
      buildCommand: BUILD_COMMAND,
      baseUrl: requestBaseUrl(req, app.config.baseUrl),
    };
  });

  api.get(
    '/artifacts/extension/:target',
    { schema: { params: TargetParams } },
    async (req, reply) => {
      requireUser(req);
      // The id must be one this build knows. Anything else never reaches the filesystem, which is
      // what makes a traversal attempt an ordinary 404 rather than something to sanitize.
      const target = EXTENSION_TARGETS.find((t) => t.id === req.params.target);
      if (
        target === undefined ||
        artifactsDir === undefined ||
        !isAvailable(artifactsDir, target.id)
      ) {
        throw notFound();
      }
      let tree: Record<string, Uint8Array>;
      try {
        tree = readOperatorTree(targetDir(artifactsDir, target.id), MAX_ARTIFACT_BYTES);
      } catch (err) {
        req.log.error({ err, target: target.id }, 'refusing to build an oversized artifact');
        throw notFound();
      }
      tree[SERVER_FILE] = new Uint8Array(
        Buffer.from(
          `${JSON.stringify({ baseUrl: requestBaseUrl(req, app.config.baseUrl) }, null, 2)}\n`,
          'utf8',
        ),
      );
      const root = target.folder === undefined ? '' : `${target.folder}/`;
      const files = Object.fromEntries(
        Object.entries(tree).map(([name, bytes]) => [`${root}${name}`, bytes]),
      );
      return (
        reply
          .header('content-type', 'application/zip')
          .header(
            'content-disposition',
            `attachment; filename="${filename(target.id, files['manifest.json'])}"`,
          )
          // The archive is built for this request's address, so it must not be reused for another.
          .header('cache-control', 'no-store')
          .send(Buffer.from(zipSync(files, { level: 6 })))
      );
    },
  );
}
