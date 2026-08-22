import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { EmailVerifiedPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Button, Heading, Paragraph } from './layout';

/**
 * Sent once the address is proven.
 *
 * Categorised `PRODUCT_NEWS`, not `ACCOUNT_SECURITY`, and that is the honest call: it is
 * onboarding, not part of a transaction the user asked for. It therefore carries a real
 * unsubscribe link, and someone who never wants marketing from us can say so at the first
 * possible moment.
 */
@Injectable()
export class WelcomeTemplate extends EmailTemplate<EmailVerifiedPayload> {
  readonly key = TemplateKey.Welcome;
  readonly category: NotificationCategory = 'PRODUCT_NEWS';

  protected subjectFor(): string {
    return 'You are in — here is where to start';
  }

  protected previewFor(): string {
    return 'Your email is confirmed. Pick a track and start with lesson one.';
  }

  protected body(payload: EmailVerifiedPayload, ctx: RenderContext): ReactElement {
    return (
      <>
        <Heading>{payload.name ? `Welcome, ${payload.name}` : 'Welcome to Masternova'}</Heading>
        <Paragraph>
          Your email is confirmed. Everything on the platform is taught by people who have shipped
          the thing they are teaching, so pick the track closest to the job you want and start with
          lesson one.
        </Paragraph>
        <Paragraph>
          <Button href={`${ctx.webUrl}/courses`}>Browse courses</Button>
        </Paragraph>
      </>
    );
  }
}
