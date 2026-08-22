import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { mailConfig } from '../../../config/configuration';
import {
  MailDeliveryError,
  type MailProvider,
  type MailSendResult,
  type OutboundMail,
} from './mail-provider.interface';

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend adapter — the production path when SMTP is not wanted.
 *
 * It exists to make {@link MailProvider} a real seam rather than an interface with one
 * implementation (CLAUDE.md §3). The two providers differ in every way that matters
 * outside the port: one holds a pooled TCP connection and returns a Message-ID, the other
 * is a stateless HTTPS call returning a JSON id. Both satisfy the same contract.
 *
 * `fetch` rather than the vendor SDK: this is one POST, and an SDK would put a
 * dependency-shaped hole in the exact place the adapter exists to protect.
 */
@Injectable()
export class ResendMailProvider implements MailProvider {
  readonly name = 'resend';

  constructor(@Inject(mailConfig.KEY) private readonly config: ConfigType<typeof mailConfig>) {}

  async send(mail: OutboundMail): Promise<MailSendResult> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.resend.apiKey ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.from,
        reply_to: this.config.replyTo,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: mail.headers,
      }),
    }).catch((error: unknown) => {
      throw new MailDeliveryError(this.name, 'request failed', error);
    });

    if (!response.ok) {
      // Both 4xx and 5xx are thrown. A 4xx will exhaust the outbox retries and park the
      // message as DEAD, which is the correct outcome — a malformed send is a bug to fix,
      // not a transient failure, and the dead letter is the evidence for fixing it.
      throw new MailDeliveryError(
        this.name,
        `HTTP ${response.status}: ${await safeBody(response)}`,
      );
    }

    const body = (await response.json()) as { id?: string };
    if (!body.id) {
      throw new MailDeliveryError(this.name, 'accepted the message but returned no id');
    }
    return { providerMessageId: body.id };
  }
}

async function safeBody(response: Response): Promise<string> {
  return response
    .text()
    .then((text) => text.slice(0, 300))
    .catch(() => '<unreadable body>');
}
