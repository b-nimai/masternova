import { Inject, Injectable } from '@nestjs/common';
import type { Asset, AssetKind } from '@masternova/db';
import type { AssetView } from '@masternova/shared';
import { AssetNotFoundException } from '../../common/exceptions';
import type { Actor } from '../catalog/actor';
import { MEDIA_REPOSITORY, type IMediaRepository } from './repositories/media.repository.interface';

/** BigInt has no JSON representation — every size crosses the wire as a decimal string. */
export function toAssetView(asset: Asset): AssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    status: asset.status,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes.toString(),
    originalFilename: asset.originalFilename,
    durationSeconds: asset.durationSeconds,
    createdAt: asset.createdAt.toISOString(),
  };
}

/**
 * Reads an instructor's own media. Small on purpose — the interesting work in this module
 * is the transfer, and this is the part that just answers questions about the result.
 *
 * **What it does not do: hand out a URL to watch the video.** That decision depends on
 * purchases and refund windows and belongs to the entitlement engine (task 1.8), which
 * issues a short-lived playback token. A `getDownloadUrl` here would be the seam the whole
 * three-layer enforcement story is designed to prevent.
 */
@Injectable()
export class AssetService {
  constructor(@Inject(MEDIA_REPOSITORY) private readonly media: IMediaRepository) {}

  async get(assetId: string, actor: Actor): Promise<AssetView> {
    const asset = await this.media.findAsset(assetId);
    // "Not yours" and "does not exist" are the same answer: distinguishing them turns this
    // into an oracle for probing whether an id is a real asset.
    if (!asset || (asset.ownerId !== actor.id && actor.role !== 'ADMIN')) {
      throw new AssetNotFoundException();
    }
    return toAssetView(asset);
  }

  async list(actor: Actor, kind?: AssetKind, limit = 50): Promise<AssetView[]> {
    const assets = await this.media.listAssets(actor.id, kind, limit);
    return assets.map(toAssetView);
  }
}
