import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { VerificationRequestedPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Button, Fine, Heading, Paragraph } from './layout';

/** Signup → prove the address is real, before it can receive anything else. */
@Injectable()
export class VerifyEmailTemplate extends EmailTemplate<VerificationRequestedPayload> {
  readonly key = TemplateKey.VerifyEmail;
  readonly category: NotificationCategory = 'ACCOUNT_SECURITY';

  protected subjectFor(): string {
    return 'Confirm your email address';
  }

  protected previewFor(): string {
    return 'One click and your Masternova account is ready.';
  }

  protected body(payload: VerificationRequestedPayload, ctx: RenderContext): ReactElement {
    const url = `${ctx.webUrl}/verify-email?token=${encodeURIComponent(payload.token)}`;
    return (
      <>
        <Heading>Confirm your email address</Heading>
        <Paragraph>
          {payload.name ? `Hi ${payload.name}, ` : 'Hi, '}
          welcome to Masternova. Confirm this address and your account is ready to use.
        </Paragraph>
        <Paragraph>
          <Button href={url}>Confirm my email</Button>
        </Paragraph>
        {/* The link is repeated as text because "click the button" fails whenever the
            client blocks the styled anchor, and a user who cannot proceed will not
            write in to tell you. */}
        <Fine>
          The link expires on {formatExpiry(payload.expiresAt)}. If the button does not work, paste
          this into your browser: {url}
        </Fine>
        <Fine>If you did not create a Masternova account, you can ignore this email.</Fine>
      </>
    );
  }
}

/**
 * Rendered in UTC with the zone named, not localised.
 *
 * The worker has no idea what timezone the reader is in, and a bare "expires at 9:14"
 * that is four hours off is worse than an explicit UTC timestamp.
 */
export function formatExpiry(iso: string): string {
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
