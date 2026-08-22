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

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
export type SessionSummary = z.infer<typeof sessionSchema>;

/* --------------------------- notification --------------------------- */

/**
 * Kept in step with the `NotificationCategory` Prisma enum by hand, and deliberately so:
 * `@masternova/shared` is imported by the browser bundle and must not depend on
 * `@masternova/db`, which drags in the Prisma client. The list is short, changes rarely,
 * and a drift is caught by the API's own Zod parse rather than reaching the database.
 */
export const notificationCategorySchema = z.enum([
  'ACCOUNT_SECURITY',
  'PURCHASE',
  'COURSE_ACTIVITY',
  'ENGAGEMENT',
  'PRODUCT_NEWS',
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/** The categories a user may switch off. The rest are part of a transaction they asked for. */
export const OPTIONAL_NOTIFICATION_CATEGORIES = [
  'COURSE_ACTIVITY',
  'ENGAGEMENT',
  'PRODUCT_NEWS',
] as const satisfies readonly NotificationCategory[];

export const optionalNotificationCategorySchema = z.enum(OPTIONAL_NOTIFICATION_CATEGORIES);

/** Absent means subscribed, so the response is always the complete list, never a sparse map. */
export const notificationPreferencesSchema = z.object({
  preferences: z.array(
    z.object({
      category: optionalNotificationCategorySchema,
      enabled: z.boolean(),
      /** False for the mandatory categories, which are not returned at all. */
      editable: z.literal(true),
    }),
  ),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferenceSchema = z.object({
  category: optionalNotificationCategorySchema,
  enabled: z.boolean(),
});
export type UpdateNotificationPreferenceInput = z.infer<typeof updateNotificationPreferenceSchema>;

/**
 * One-click unsubscribe. A POST, not a GET, because mail clients and corporate scanners
 * prefetch links — a GET that unsubscribes is a GET that unsubscribes people who never
 * clicked. RFC 8058 says the same thing, which is why `List-Unsubscribe-Post` exists.
 */
export const unsubscribeSchema = z.object({
  token: z.string().min(1),
});
export type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;
