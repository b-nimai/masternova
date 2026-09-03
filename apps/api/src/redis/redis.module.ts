import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig } from '../config/configuration';
import { REDIS_CLIENT } from './redis.constants';

/**
 * One Redis connection for the whole API process.
 *
 * **Global, and a single client.** ioredis multiplexes commands over one TCP connection, so
 * a second client buys nothing but a second file descriptor and a second thing to notice
 * when Redis restarts. It is `@Global` because the alternative is threading a `RedisModule`
 * import through every feature module that ever caches anything — which is the shape that
 * makes people give up and construct their own client instead.
 *
 * The BullMQ `Queue` in `PipelineStatusService` keeps its own connection deliberately:
 * BullMQ requires `maxRetriesPerRequest: null` and takes ownership of the client's lifecycle,
 * and sharing one would let a queue setting change how the cache behaves.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) => {
        const logger = new Logger('Redis');

        const client = new Redis({
          host: config.host,
          port: config.port,
          // Fail a command rather than queue it forever when Redis is unreachable. Every
          // caller here treats Redis as optional and falls through to Postgres, so a fast
          // failure is strictly better than a request that hangs waiting for a reconnect.
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          lazyConnect: true,
        });

        // Without a listener this throws: ioredis emits connection failures as an
        // EventEmitter 'error', and an unhandled one takes the process down over a blip
        // it would have recovered from on its own.
        client.on('error', (error: Error) => {
          logger.warn(`redis connection error: ${error.message}`);
        });

        // `lazyConnect` plus an unawaited connect: the process must boot and serve health
        // checks even when Redis is down, because everything that uses it degrades to the
        // database rather than failing.
        void client.connect().catch((error: Error) => {
          logger.warn(`redis unavailable at boot: ${error.message}`);
        });

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /**
   * `quit` rather than `disconnect`: it lets in-flight commands finish before the socket
   * closes. It also has to actually happen — an open ioredis client keeps the event loop
   * alive, which is how an integration suite ends up hanging after its last assertion.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
