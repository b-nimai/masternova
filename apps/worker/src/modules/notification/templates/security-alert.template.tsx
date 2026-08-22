import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { RefreshReuseDetectedPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Button, Fine, Heading, Paragraph } from './layout';

/**
 * Sent when a refresh token is replayed.
 *
 * This is the half of reuse detection that is easy to skip and pointless to skip. Killing
 * the session protects the account; telling the owner is the only part that gives them a
 * fact they can act on — that a credential of theirs has been copied.
 *
 * The copy avoids blaming the user and avoids technical vocabulary. "Your refresh token
 * was replayed" means nothing to a learner; "we signed you out because a sign-in
 * credential was used twice" does.
 */
@Injectable()
export class SecurityAlertTemplate extends EmailTemplate<RefreshReuseDetectedPayload> {
  readonly key = TemplateKey.SecurityAlert;
  readonly category: NotificationCategory = 'ACCOUNT_SECURITY';

  protected subjectFor(): string {
    return 'We signed you out to protect your account';
  }

  protected previewFor(): string {
    return 'A sign-in credential for your account was used twice.';
  }

  protected body(payload: RefreshReuseDetectedPayload, ctx: RenderContext): ReactElement {
    return (
      <>
        <Heading>We signed you out to protect your account</Heading>
        <Paragraph>
          A sign-in credential for your Masternova account was used twice, which normally means it
          has been copied. We could not tell which device was yours, so we ended the session on all
          of them.
        </Paragraph>
        <Paragraph>
          {describeDevice(payload)} Nothing on your account has been changed, and no payment details
          were exposed.
        </Paragraph>
        <Paragraph>
          <Button href={`${ctx.webUrl}/login`}>Sign in again</Button>
        </Paragraph>
        <Fine>
          If you did not sign in recently, change your password now — that also ends every session
          again.
        </Fine>
      </>
    );
  }
}

/** Best-effort, and labelled as such: a user agent is client-supplied and trivially forged. */
function describeDevice(payload: RefreshReuseDetectedPayload): string {
  const parts = [payload.userAgent, payload.ip].filter(Boolean);
  return parts.length > 0 ? `The session was last seen from ${parts.join(' · ')}.` : '';
}
