import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Liveness and readiness.
 *
 * Both are `@Public()` because the callers — a container healthcheck, a load-balancer
 * target group, an uptime probe — hold no credentials and never will. Task 1.2 made
 * authentication global and opt-out, which is the right default and which silently turned
 * these two routes into 401s; running the stack is what surfaced it.
 */
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health(): { status: string; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Public()
  @Get('readyz')
  async readyz(): Promise<{ status: string; db: 'up' | 'down' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'up' };
    } catch {
      return { status: 'degraded', db: 'down' };
    }
  }
}
