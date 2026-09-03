import { PipelineJob, type NewDomainEvent, type UnitOfWork } from '@masternova/contracts';
import { PipelineEvent } from '@masternova/contracts';
import type { Asset } from '@masternova/db';
import type { IPipelineRepository } from '../repositories/pipeline.repository.interface';
import { PipelineFailureService } from './pipeline-failure.service';

/**
 * A fake Unit of Work, not a mock of Prisma (CLAUDE.md §6). It records what was published so
 * a test can assert the event *and* that it was raised inside the transaction.
 */
function fakeUow(): UnitOfWork & { published: NewDomainEvent[]; committed: boolean } {
  const published: NewDomainEvent[] = [];
  const uow = {
    published,
    committed: false,
    async execute<T>(
      work: (ctx: { executor: unknown; publish: (e: NewDomainEvent) => void }) => Promise<T>,
    ) {
      const result = await work({ executor: TX, publish: (e) => published.push(e) });
      uow.committed = true;
      return result;
    },
  };
  return uow as never;
}

/** A stand-in for the transaction handle, so a test can assert it was actually passed on. */
const TX = Symbol('tx');

const ASSET = { id: 'asset-1', ownerId: 'owner-1' } as Asset;

describe('PipelineFailureService', () => {
  let repo: jest.Mocked<Pick<IPipelineRepository, 'findAsset' | 'setPipeline'>>;

  beforeEach(() => {
    repo = {
      findAsset: jest.fn().mockResolvedValue(ASSET),
      setPipeline: jest.fn().mockResolvedValue(undefined),
    };
  });

  const service = (uow: UnitOfWork) =>
    new PipelineFailureService(repo as unknown as IPipelineRepository, uow);

  /**
   * The point of the whole class. Before it existed nothing ever wrote FAILED, so an asset
   * whose transcode exhausted its attempts sat at RUNNING forever: the wizard's bar stuck,
   * the SSE stream never terminated, and the reconciliation sweeper — which only looks at
   * READY or FAILED — never collected the half-written rungs it left behind.
   */
  it('moves the asset to FAILED and records why', async () => {
    const uow = fakeUow();
    await service(uow).markFailed(PipelineJob.Transcode, { assetId: 'asset-1' }, new Error('boom'));

    expect(repo.setPipeline).toHaveBeenCalledWith('asset-1', 'FAILED', { error: 'boom' }, TX);
  });

  it('publishes the failure in the same transaction as the state change', async () => {
    const uow = fakeUow();
    await service(uow).markFailed(
      PipelineJob.Poster,
      { assetId: 'asset-1' },
      new Error('no frame'),
    );

    expect(uow.published).toEqual([
      {
        type: PipelineEvent.AssetProcessingFailed,
        aggregateType: 'Asset',
        aggregateId: 'asset-1',
        payload: {
          assetId: 'asset-1',
          ownerId: 'owner-1',
          jobType: PipelineJob.Poster,
          reason: 'no frame',
        },
      },
    ]);
    expect(uow.committed).toBe(true);
  });

  /** `pipelineError` is a text column, not a place to put a full ffmpeg stderr dump. */
  it('truncates a runaway reason', async () => {
    const uow = fakeUow();
    await service(uow).markFailed(
      PipelineJob.Transcode,
      { assetId: 'asset-1' },
      new Error('x'.repeat(5_000)),
    );

    const [, , patch] = repo.setPipeline.mock.calls[0];
    expect(patch.error).toHaveLength(500);
  });

  /**
   * The caller is inside a catch block and is about to rethrow the real error. A failure to
   * *record* the failure must not replace it — the original is the one worth surfacing.
   */
  it('never throws when it cannot record the failure', async () => {
    const uow = fakeUow();
    repo.findAsset.mockRejectedValue(new Error('database is gone'));

    await expect(
      service(uow).markFailed(PipelineJob.Probe, { assetId: 'asset-1' }, new Error('boom')),
    ).resolves.toBeUndefined();
  });

  it('does nothing when the asset has since been deleted', async () => {
    const uow = fakeUow();
    repo.findAsset.mockResolvedValue(null);

    await service(uow).markFailed(PipelineJob.Probe, { assetId: 'gone' }, new Error('boom'));

    expect(repo.setPipeline).not.toHaveBeenCalled();
    expect(uow.published).toEqual([]);
  });

  it('does nothing when the payload carries no asset id', async () => {
    const uow = fakeUow();
    await service(uow).markFailed(PipelineJob.Probe, { nope: true }, new Error('boom'));

    expect(repo.findAsset).not.toHaveBeenCalled();
  });
});
