/**
 * Events published by the `identity` context.
 *
 * They live here, not inside the module, because an event is the one thing bounded
 * contexts are allowed to share (CLAUDE.md §4). `notification` reacts to every one of
 * these without importing a line of `identity`, and identity has no idea anyone is
 * listening.
 *
 * **Payloads are self-contained on purpose.** Every field a consumer needs travels on the
 * event — including the recipient's address and name. The alternative, letting the
 * consumer look the user up, re-couples exactly what the event decoupled, and turns one
 * durable message into a message plus a live query against another context's tables.
 */

export const IdentityEvent = {
  UserRegistered: 'identity.user.registered',
  EmailVerificationRequested: 'identity.email.verification_requested',
  EmailVerified: 'identity.email.verified',
  PasswordResetRequested: 'identity.password.reset_requested',
  PasswordChanged: 'identity.password.changed',
  /** A refresh token was replayed. The session is already dead by the time this is read. */
  RefreshReuseDetected: 'identity.session.reuse_detected',
  SessionsRevoked: 'identity.sessions.revoked',
} as const;

export type IdentityEventType = (typeof IdentityEvent)[keyof typeof IdentityEvent];

/** Common shape: who the message is about and how to address them. */
export interface IdentityRecipient {
  readonly email: string;
  readonly name?: string | null;
}

export interface UserRegisteredPayload extends IdentityRecipient {
  /** True for OAuth signups, where the provider already proved the address. */
  readonly verified?: boolean;
}

/**
 * Carries the raw single-use token, which is never stored — only its SHA-256 hash is.
 * The outbox row is therefore briefly sensitive, and that is a deliberate trade: the
 * alternative is a second round trip from the sender back into identity to fetch a
 * secret identity has already thrown away.
 */
export interface VerificationRequestedPayload extends IdentityRecipient {
  readonly token: string;
  readonly expiresAt: string;
}

export type EmailVerifiedPayload = IdentityRecipient;

export interface PasswordChangedPayload extends IdentityRecipient {
  readonly via: 'reset' | 'account';
}

export interface RefreshReuseDetectedPayload extends IdentityRecipient {
  readonly sessionId: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

export interface SessionsRevokedPayload extends IdentityRecipient {
  readonly reason: string;
  readonly count: number;
}
