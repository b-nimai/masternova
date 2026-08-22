import { z } from 'zod';

/**
 * The single source of truth for request/response shapes across api, worker and web
 * (CLAUDE.md §4). Never duplicate a DTO per app.
 *
 * Schemas are added here by the module that owns them, in bounded-context blocks.
 * Phase 0 carries only identity; catalog, media, commerce and the rest arrive with
 * their modules in Phase 1.
 */

/* ----------------------------- identity ----------------------------- */

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(80).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const roleSchema = z.enum(['LEARNER', 'INSTRUCTOR', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: roleSchema,
  avatarUrl: z.string().url().nullable(),
  emailVerified: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;
