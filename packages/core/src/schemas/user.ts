import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/** Public user shape. Credentials (password hash, TOTP secret) never leave the server. */
export const UserSchema = z.object({
  id: IdSchema,
  email: z.email(),
  displayName: z.string().min(1),
  isAdmin: z.boolean(),
  createdAt: TimestampSchema,
});
export type User = z.infer<typeof UserSchema>;
