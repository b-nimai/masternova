import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The wire format of an unsubscribe link: minted by the worker when it renders an email,
 * verified by the API when someone clicks it.
 *
 * It lives in `@masternova/contracts` because it is literally a contract between two
 * deployables. Implementing it twice — once per app — is how the two quietly disagree
 * about the separator or the encoding, and the failure only shows up as "unsubscribe is
 * broken" in someone's inbox. It is not in `@masternova/shared` because that package is
 * imported by the browser bundle and this needs `node:crypto`.
 *
 * **Stateless by design.** A row per link would mean a table that only ever grows, for a
 * capability whose worst-case abuse is unsubscribing a stranger from course
 * announcements. An HMAC gives the same authenticity with nothing to store, and the whole
 * scheme is revocable by rotating one secret.
 *
 * It deliberately does **not** expire. An unsubscribe link at the bottom of a two-year-old
 * email must still work — that is the entire point of it being there.
 */

const VERSION = 'v1';

export interface UnsubscribeClaims {
  readonly userId: string;
  readonly category: string;
}

export function signUnsubscribeToken(secret: string, claims: UnsubscribeClaims): string {
  const body = encode(`${claims.userId}:${claims.category}`);
  return `${VERSION}.${body}.${sign(secret, body)}`;
}

/** Returns the claims, or `null` for anything malformed, tampered with, or unrecognised. */
export function verifyUnsubscribeToken(secret: string, token: string): UnsubscribeClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [version, body, signature] = parts;
  if (version !== VERSION) return null;
  if (!matches(sign(secret, body), signature)) return null;

  const decoded = decode(body);
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;

  return { userId: decoded.slice(0, separator), category: decoded.slice(separator + 1) };
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`${VERSION}.${body}`).digest('base64url');
}

/**
 * Constant-time comparison. A plain `===` leaks how many leading bytes were right, which
 * is enough to forge a signature one byte at a time given enough attempts.
 */
function matches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');
