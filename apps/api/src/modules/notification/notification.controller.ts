import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  updateNotificationPreferenceSchema,
  unsubscribeSchema,
  type NotificationPreferences,
  type UnsubscribeInput,
  type UpdateNotificationPreferenceInput,
} from '@masternova/shared';
import type { NotificationCategory } from '@masternova/db';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { NotificationPreferencesService } from './notification-preferences.service';

/** Thin by design: parse, delegate, map the response (CLAUDE.md §4). */
@Controller('notifications')
export class NotificationController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get('preferences')
  listPreferences(@CurrentUserId() userId: string): Promise<NotificationPreferences> {
    return this.preferences.listFor(userId);
  }

  @Patch('preferences')
  @HttpCode(204)
  async updatePreference(
    @CurrentUserId() userId: string,
    @ZodBody(updateNotificationPreferenceSchema) body: UpdateNotificationPreferenceInput,
  ): Promise<void> {
    await this.preferences.set(userId, body.category as NotificationCategory, body.enabled);
  }

  /**
   * The unsubscribe confirmation page posts here.
   *
   * Public because the person clicking has, by definition, decided not to engage with us —
   * making them sign in first is how an unsubscribe turns into a spam complaint, which
   * costs far more than the theoretical harm of a stranger unsubscribing someone from
   * course announcements.
   */
  @Public()
  @Post('unsubscribe')
  @HttpCode(200)
  unsubscribe(@ZodBody(unsubscribeSchema) body: UnsubscribeInput): Promise<{ category: string }> {
    return this.preferences.unsubscribe(body.token);
  }

  /**
   * RFC 8058 one-click. Mail providers POST here directly with the token in the path and
   * a form body we ignore, so it cannot share a route with the JSON endpoint above.
   *
   * It is a POST, not a GET, because mail clients and corporate link scanners prefetch
   * every `href` in a message. A GET here would unsubscribe people who never clicked.
   */
  @Public()
  @Post('unsubscribe/:token')
  @HttpCode(200)
  async unsubscribeOneClick(@Param('token') token: string): Promise<{ ok: true }> {
    await this.preferences.unsubscribe(token);
    return { ok: true };
  }
}
