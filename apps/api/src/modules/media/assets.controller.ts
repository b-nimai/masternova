import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { assetKindSchema, type AssetView } from '@masternova/shared';
import type { AssetKind } from '@masternova/db';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../catalog/actor.request';
import { AssetService } from './asset.service';

/**
 * The instructor's media library. Split from the upload routes because it is the only
 * part of this module with no transfer state — it answers questions about finished
 * assets, and will outlive the upload that produced each one.
 */
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('media/assets')
export class AssetsController {
  constructor(private readonly assets: AssetService) {}

  /** An unparseable `kind` is treated as "no filter" rather than a 400: it is a facet. */
  @Get()
  list(
    @Query('kind') kind: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<AssetView[]> {
    const parsed = assetKindSchema.safeParse(kind);
    return this.assets.list(
      actorOf(request),
      parsed.success ? (parsed.data as AssetKind) : undefined,
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: FastifyRequest): Promise<AssetView> {
    return this.assets.get(id, actorOf(request));
  }
}
