// Serves the built SPA (apps/web/dist). Real files are routed at boot; any other GET
// outside /api and /assets falls back to index.html so client routes deep-link. Unknown
// API paths and missing assets keep the JSON 404 so they never come back as HTML.
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { isOperatorFile } from '../lib/storage';

const HASHED_ASSET = /[/\\]assets[/\\]/;

function isApiOrAsset(path: string): boolean {
  return (
    path === '/api' || path.startsWith('/api/') || path === '/assets' || path.startsWith('/assets/')
  );
}

/** True when `webDir` holds a build (index.html present). */
export function hasSpaBuild(webDir: string): boolean {
  return isOperatorFile(join(webDir, 'index.html'));
}

export async function spaRoutes(app: FastifyInstance, opts: { root: string }): Promise<void> {
  await app.register(fastifyStatic, {
    root: opts.root,
    // One route per file found at boot: no filesystem lookups driven by request paths.
    wildcard: false,
    index: false,
    cacheControl: false,
    setHeaders(reply, filePath) {
      reply.header(
        'cache-control',
        HASHED_ASSET.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });

  app.get('/*', async (req, reply) => {
    const q = req.url.indexOf('?');
    const path = q === -1 ? req.url : req.url.slice(0, q);
    if (isApiOrAsset(path)) {
      // The asset routes above are a snapshot of `root` taken at boot, while index.html is read
      // from disk on every request. Rebuild the SPA under a running server and the two disagree:
      // the browser gets fresh HTML naming content-hashed files this process never routed, so
      // every script 404s and the page renders blank. Name that here, because a bare 404 on a
      // hashed filename gives the operator nothing to go on.
      if (path.startsWith('/assets/')) {
        req.log.warn(
          { path },
          'no route for this asset; if the web build was rebuilt while the server was running, restart the server',
        );
      }
      return reply.code(404).send({ error: { code: 'not_found' } });
    }
    return reply.sendFile('index.html');
  });
}
