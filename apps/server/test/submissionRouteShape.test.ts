// No bulk surface for application submissions (https://github.com/bgoleno/opportun/issues/114
// criterion 3; the assisted-apply design, Part A section 8 item 1, "No bulk surface"). Opportun
// prepares one application at a time, for one opportunity, and never transmits one. This test
// reads every route the app registers and every job kind, and fails on:
// - a submission route that does not name exactly one id;
// - a GET that lists submissions across opportunities (anything but one opportunity's own list);
// - a route that acts on more than one submission or opportunity (batch, bulk, all);
// - a job kind that submits, or acts on submissions in bulk.
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registeredJobKinds } from '../src/jobs/registry';
import { useApi } from './api';

const boot = useApi();

interface Route {
  path: string;
  methods: string[];
}

/**
 * Every route, rebuilt from app.printRoutes()'s tree: each line is a path segment at a depth
 * given by its indentation (4 characters per level), and a line ending in "(METHODS)" is a route
 * whose full path is its ancestors' segments joined with its own.
 */
function registeredRoutes(app: FastifyInstance): Route[] {
  const stack: string[] = [];
  const routes: Route[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const at = line.search(/[├└]── /);
    if (at === -1) continue;
    const depth = at / 4;
    const rest = line.slice(at + 4);
    // "segment (GET, POST)" is a route; a bare "segment" is only a branch of the tree.
    const open = rest.lastIndexOf(' (');
    const isRoute = open !== -1 && rest.endsWith(')');
    const segment = isRoute ? rest.slice(0, open) : rest;
    stack.length = depth;
    stack.push(segment);
    if (isRoute) {
      const methods = rest
        .slice(open + 2, -1)
        .split(',')
        .map((s) => s.trim());
      routes.push({ path: stack.join(''), methods });
    }
  }
  return routes;
}

const isSubmissionRoute = (path: string) => /submission/i.test(path);

/** `/opportunities/:id/submissions`, `/submissions/:id`, or `/submissions/:id/<action>`. */
function allowedShape(path: string): boolean {
  if (path === '/api/v1/opportunities/:id/submissions') return true;
  const base = '/api/v1/submissions/:id';
  if (!path.startsWith(base)) return false;
  const tail = path.slice(base.length);
  // One action, its words lowercase and joined by hyphens (unlink-confirmation, #119).
  return tail === '' || (tail.startsWith('/') && /^[a-z]+(-[a-z]+)*$/.test(tail.slice(1)));
}
const idParams = (path: string) => (path.match(/:[A-Za-z]+/g) ?? []).length;

describe('the submission surface acts on one opportunity at a time', () => {
  it('the route reader finds known routes exactly (so the rules below see every route)', async () => {
    const { app } = await boot({ submissions: true });
    const routes = registeredRoutes(app);
    const find = (path: string) => routes.find((r) => r.path === path);
    expect(find('/api/v1/activities/:id')?.methods).toEqual(
      expect.arrayContaining(['GET', 'PATCH', 'DELETE']),
    );
    expect(find('/api/v1/opportunities/:id/submissions')?.methods).toEqual(
      expect.arrayContaining(['GET', 'POST']),
    );
    expect(find('/api/v1/submissions/:id')?.methods).toEqual(
      expect.arrayContaining(['GET', 'PATCH']),
    );
    expect(find('/api/v1/submissions/:id/cancel')?.methods).toEqual(['POST']);
    expect(routes.length).toBeGreaterThan(100);
  });

  it('every submission route names exactly one id, and has one of the allowed shapes', async () => {
    const { app } = await boot({ submissions: true });
    const submissionRoutes = registeredRoutes(app).filter((r) => isSubmissionRoute(r.path));
    expect(submissionRoutes.length).toBeGreaterThan(0);
    for (const r of submissionRoutes) {
      expect(idParams(r.path), r.path).toBe(1);
      // One opportunity's own list and create, or one submission and its actions.
      expect(allowedShape(r.path), r.path).toBe(true);
    }
  });

  it('no route lists submissions across opportunities', async () => {
    const { app } = await boot({ submissions: true });
    const lists = registeredRoutes(app).filter(
      (r) =>
        r.methods.includes('GET') && isSubmissionRoute(r.path) && /submissions\/?$/.test(r.path),
    );
    expect(lists.map((r) => r.path)).toEqual(['/api/v1/opportunities/:id/submissions']);
  });

  it('no route anywhere is a batch, bulk or all-at-once action on submissions or applications', async () => {
    const { app } = await boot({ submissions: true });
    const bulk = registeredRoutes(app).filter((r) =>
      /(submission|apply|application).*(batch|bulk|all\b|many)|(batch|bulk).*(submission|apply|application)/i.test(
        r.path,
      ),
    );
    expect(bulk).toEqual([]);
  });

  it('no job kind submits an application, or acts on submissions in bulk', () => {
    const kinds = registeredJobKinds();
    expect(kinds.length).toBeGreaterThan(5);
    // "submit" names a transmission; "submission" (a record) is allowed only for one-id jobs.
    expect(kinds.filter((k) => /submit(?!ssion)/i.test(k))).toEqual([]);
    expect(
      kinds.filter((k) => /(submission|apply|application)/i.test(k) && /(batch|bulk|all)/i.test(k)),
    ).toEqual([]);
  });
});
