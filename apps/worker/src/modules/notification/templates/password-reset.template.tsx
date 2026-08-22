import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { VerificationRequestedPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Button, Fine, Heading, Paragraph } from './layout';
import { formatExpiry } from './verify-email.template';

/**
 * The reset link.
 *
 * Note what it does **not** say: whether an account exists. `requestPasswordReset` answers
 * identically for known and unknown addresses, so this email only ever reaches a real
 * account, and its copy never confirms or denies anything to someone probing addresses.
 */
@Injectable()
export class PasswordResetTemplate extends EmailTemplate<VerificationRequestedPayload> {
  readonly key = TemplateKey.PasswordReset;
  readonly category: NotificationCategory = 'ACCOUNT_SECURITY';

  protected subjectFor(): string {
    return 'Reset your Masternova password';
  }

  protected previewFor(): string {
    return 'A single-use link to set a new password.';
  }

  protected body(payload: VerificationRequestedPayload, ctx: RenderContext): ReactElement {
    const url = `${ctx.webUrl}/reset-password?token=${encodeURIComponent(payload.token)}`;
    return (
      <>
        <Heading>Reset your password</Heading>
        <Paragraph>
          Someone asked to reset the password for this address. Use the link below to set a new one
          — it works once, and only until it expires.
        </Paragraph>
        <Paragraph>
          <Button href={url}>Set a new password</Button>
        </Paragraph>
        <Fine>
          The link expires on {formatExpiry(payload.expiresAt)}. If the button does not work, paste
          this into your browser: {url}
        </Fine>
        <Fine>
          If you did not ask for this, nothing has changed and you can ignore this email. Resetting
          your password signs you out on every device.
        </Fine>
      </>
    );
  }
}
