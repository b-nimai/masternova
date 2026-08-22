/**
 * Template identifiers, in one place because they are written to `EmailDelivery.template`
 * and are therefore part of the idempotency key. A typo in a handler would not fail to
 * compile if these were bare strings — it would quietly become a *different* key, and the
 * second send of an event would no longer be recognised as a duplicate.
 */
export const TemplateKey = {
  VerifyEmail: 'verify-email',
  Welcome: 'welcome',
  PasswordReset: 'password-reset',
  PasswordChanged: 'password-changed',
  SecurityAlert: 'security-alert',
} as const;

export type TemplateKey = (typeof TemplateKey)[keyof typeof TemplateKey];
