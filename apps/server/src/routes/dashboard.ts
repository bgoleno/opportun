// Dashboard aggregates (FR-U1 data).
import { NextStepSchema, OPPORTUNITY_STAGES } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { dashboard } from '../repos/activities';
import { TimelineItemSchema } from './activities';

const DashboardSchema = z.object({
  stageCounts: z.record(z.enum(OPPORTUNITY_STAGES), z.number().int().nonnegative()),
  dueNextSteps: z.array(
    NextStepSchema.extend({ opportunityTitle: z.string(), companyName: z.string() }),
  ),
  recentActivity: z.array(TimelineItemSchema),
  needsTriage: z.object({ communications: z.number().int().nonnegative() }),
});

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get('/dashboard', { schema: { response: { 200: DashboardSchema } } }, async (req) =>
    dashboard(app.db, app.requireUser(req)),
  );
}
