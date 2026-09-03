import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { mailConfig } from '../../config/configuration';
import { NotificationService } from './notification.service';
import { MAIL_PROVIDER } from './mail/mail-provider.interface';
import { SmtpMailProvider } from './mail/smtp.mail-provider';
import { ResendMailProvider } from './mail/resend.mail-provider';
import { TemplateRegistry } from './templates/template.registry';
import type { AnyEmailTemplate } from './templates/email-template';
import { VerifyEmailTemplate } from './templates/verify-email.template';
import { WelcomeTemplate } from './templates/welcome.template';
import { PasswordResetTemplate } from './templates/password-reset.template';
import { PasswordChangedTemplate } from './templates/password-changed.template';
import { SecurityAlertTemplate } from './templates/security-alert.template';
import { OrderReceiptTemplate } from './templates/order-receipt.template';
import { OrderRefundedTemplate } from './templates/order-refunded.template';
import { OrderExpiredTemplate } from './templates/order-expired.template';
import {
  SendOrderReceiptHandler,
  SendRefundConfirmationHandler,
  SendCheckoutRecoveryHandler,
} from './handlers/commerce-notification.handlers';
import { EMAIL_DELIVERY_REPOSITORY } from './repositories/email-delivery.repository.interface';
import { PrismaEmailDeliveryRepository } from './repositories/email-delivery.repository';
import { AUDIENCE_REPOSITORY } from './repositories/audience.repository.interface';
import { PrismaAudienceRepository } from './repositories/audience.repository';
import { IDENTITY_NOTIFICATION_HANDLERS } from './handlers/identity-notification.handlers';

/** Adding a template is one line here and zero edits anywhere else (CLAUDE.md §1 O). */
const TEMPLATES = [
  VerifyEmailTemplate,
  WelcomeTemplate,
  PasswordResetTemplate,
  PasswordChangedTemplate,
  SecurityAlertTemplate,
  OrderReceiptTemplate,
  OrderRefundedTemplate,
  OrderExpiredTemplate,
];

/**
 * The `notification` bounded context, send side.
 *
 * It knows how to turn a domain event into a rendered, deduplicated, consent-checked
 * email. It does not know what an order or a course is — every handler reads a payload
 * that arrived on the event, and nothing here queries another context's tables.
 *
 * It imports nothing from `outbox-relay` either: handlers are marked `@EventHandler()`
 * and discovered. The kernel and this module are wired together by the fact that both
 * exist, which is the only coupling either of them can survive long-term.
 */
@Module({
  providers: [
    NotificationService,
    ...TEMPLATES,
    ...IDENTITY_NOTIFICATION_HANDLERS,
    SendOrderReceiptHandler,
    SendRefundConfirmationHandler,
    SendCheckoutRecoveryHandler,

    {
      provide: TemplateRegistry,
      useFactory: (...templates: AnyEmailTemplate[]) => new TemplateRegistry(templates),
      inject: TEMPLATES,
    },

    /**
     * The single `switch` over implementations in the whole module, and it lives in the
     * composition root where a switch over implementations belongs. Inside a service it
     * would be the design smell CLAUDE.md §1 O names: a new provider must be a new class,
     * not a new `case` in `NotificationService`.
     */
    {
      provide: MAIL_PROVIDER,
      useFactory: (
        config: ConfigType<typeof mailConfig>,
        smtp: SmtpMailProvider,
        resend: ResendMailProvider,
      ) => (config.provider === 'resend' ? resend : smtp),
      inject: [mailConfig.KEY, SmtpMailProvider, ResendMailProvider],
    },
    SmtpMailProvider,
    ResendMailProvider,

    { provide: EMAIL_DELIVERY_REPOSITORY, useClass: PrismaEmailDeliveryRepository },
    { provide: AUDIENCE_REPOSITORY, useClass: PrismaAudienceRepository },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
