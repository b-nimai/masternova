import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { mailConfig } from '../../../config/configuration';
import {
  MailDeliveryError,
  type MailProvider,
  type MailSendResult,
  type OutboundMail,
} from './mail-provider.interface';

/**
 * SMTP adapter. Mailpit locally, Amazon SES in production — the same conversation with
 * different credentials, which is exactly why this is one adapter and not two.
 *
 * Adapts nodemailer's envelope-and-transport shape to {@link MailProvider}. Nothing above
 * this file knows nodemailer exists.
 */
@Injectable()
export class SmtpMailProvider implements MailProvider, OnModuleDestroy {
  readonly name = 'smtp';
  private readonly logger = new Logger(SmtpMailProvider.name);
  private readonly transport: Transporter;

  constructor(@Inject(mailConfig.KEY) private readonly config: ConfigType<typeof mailConfig>) {
    this.transport = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.password }
        : // Mailpit accepts anonymous SMTP. Passing `auth: { user: undefined }` makes
          // nodemailer attempt AUTH and fail, so the credentials are omitted entirely.
          undefined,
    });
  }

  async send(mail: OutboundMail): Promise<MailSendResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.config.from,
        replyTo: this.config.replyTo,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: mail.headers,
      });
      return { providerMessageId: info.messageId };
    } catch (error) {
      // Rethrown as a typed failure so the caller can record it and let the outbox retry.
      // Swallowing it here would mark the delivery SENT and lose the email silently.
      throw new MailDeliveryError(this.name, describe(error), error);
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
    this.logger.log('smtp transport closed');
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
