/**
 * The port every email leaves through.
 *
 * The force is Adapter (CLAUDE.md §2): a third-party API is not our domain interface.
 * Nodemailer wants a transport, an envelope and a callback; Resend wants an HTTP POST and
 * hands back a JSON id. Neither shape should reach `NotificationService`, because the day
 * we move from one to the other the pipeline must not notice.
 *
 * This is a genuine seam, not speculative generality — two implementations exist today
 * (SMTP for Mailpit and SES, Resend for the HTTP API) and they are selected by config.
 *
 * **Liskov, concretely (CLAUDE.md §1 L):** every implementation must accept every
 * `OutboundMail` and return a provider message id. No implementation may throw
 * `NotSupportedError` for a field it cannot express — if one ever needs to, this
 * interface is carrying something that does not belong to every provider, and the fix is
 * to split the interface, not to weaken the contract.
 */

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /**
   * Required, never optional. A message with no plaintext alternative renders blank in
   * some clients and is scored as spam by others, and making it optional is how it ends
   * up missing on exactly one template.
   */
  readonly text: string;
  /** `List-Unsubscribe` and friends. Providers that cannot set headers must still accept them. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MailSendResult {
  /**
   * The provider's own id for the message. It is the only thing that later ties an
   * asynchronous bounce webhook back to the `EmailDelivery` row that caused it.
   */
  readonly providerMessageId: string;
}

export interface MailProvider {
  /** Recorded on the delivery row, so the log says which provider actually sent it. */
  readonly name: string;
  send(mail: OutboundMail): Promise<MailSendResult>;
}

/** Distinguishes "the provider refused this" from a bug in the pipeline. */
export class MailDeliveryError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'MailDeliveryError';
  }
}
