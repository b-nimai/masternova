import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { PasswordChangedPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Fine, Heading, Paragraph } from './layout';

/**
 * The "this wasn't you?" notice.
 *
 * An account takeover usually starts with a password change, and this email is the only
 * moment the real owner finds out while it is still cheap to fix. It has no call to
 * action on purpose — the useful action is to contact support, not to click something in
 * an email that may itself be part of the attack.
 */
@Injectable()
export class PasswordChangedTemplate extends EmailTemplate<PasswordChangedPayload> {
  readonly key = TemplateKey.PasswordChanged;
  readonly category: NotificationCategory = 'ACCOUNT_SECURITY';

  protected subjectFor(): string {
    return 'Your Masternova password was changed';
  }

  protected previewFor(): string {
    return 'If this was not you, act now — every device has been signed out.';
  }

  protected body(payload: PasswordChangedPayload, ctx: RenderContext): ReactElement {
    return (
      <>
        <Heading>Your password was changed</Heading>
        <Paragraph>
          {payload.via === 'reset'
            ? 'The password on your Masternova account was just reset using an emailed link.'
            : 'The password on your Masternova account was just changed from your account settings.'}{' '}
          Every signed-in device has been signed out.
        </Paragraph>
        <Fine>
          If this was not you, someone has access to your email or your account. Reset your password
          again at {ctx.webUrl}/forgot-password and contact us immediately.
        </Fine>
      </>
    );
  }
}
