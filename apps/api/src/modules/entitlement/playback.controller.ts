import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Role } from '@masternova/db';
import { Public } from '../../common/decorators/public.decorator';
import { PlaybackService, type PlaybackGrant, type PlaybackManifest } from './playback.service';

/**
 * Where the three enforcement layers meet.
 *
 * `POST`-less on purpose: both routes are reads, and a player that has to issue a mutation
 * to start watching cannot be a plain `<video>` element behind a CDN.
 */
@Controller('playback')
export class PlaybackController {
  constructor(private readonly playback: PlaybackService) {}

  /**
   * **Layer 1.** The guard inside `PlaybackService.grant` runs the policy chain; only an
   * `ALLOW` gets a token back. This is the one call that requires a session.
   */
  // The body carries a bearer credential and the URL keys only on the lecture id, so any
  // shared cache — a proxy, or the browser's bfcache — could hand one learner's token to
  // the next. `no-store` is the whole fix and it costs nothing.
  @Header('Cache-Control', 'no-store')
  @Get('lectures/:id/grant')
  grant(@Param('id') lectureId: string, @Req() request: FastifyRequest): Promise<PlaybackGrant> {
    return this.playback.grant(
      lectureId,
      { id: request.userId as string, role: request.userRole as Role },
      request.ip,
    );
  }

  /**
   * **Layer 2.** `@Public()` because it deliberately does not use the session: the token
   * *is* the credential, which is the entire reason it exists — a `<video>` element fetching
   * a manifest sends no `Authorization` header and, on a cross-origin CDN, no cookie either.
   *
   * The token is checked before anything else happens, so an unsigned request costs one
   * HMAC and no database read.
   */
  @Public()
  @Header('Cache-Control', 'no-store')
  @Get('manifest')
  manifest(
    @Query('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<PlaybackManifest> {
    return this.playback.manifest(token, request.ip);
  }
}
