import { Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { addToCartSchema, type AddToCartInput } from '@masternova/shared';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { CourseNotPurchasableException } from '../../common/exceptions';
import { CartService, type CartView } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The cart. Thin by design: parse → delegate → return (CLAUDE.md §4).
 *
 * There is no `PUT /cart/items/:id` with a quantity. A course cannot be bought twice, so
 * quantity is meaningless — modelling it would be an affordance for a state the domain
 * does not have.
 */
@Controller('cart')
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  view(@Req() request: FastifyRequest, @Query('coupon') couponCode?: string): Promise<CartView> {
    return this.cart.view(request.userId as string, couponCode);
  }

  @Post('items')
  async add(
    @Req() request: FastifyRequest,
    @ZodBody(addToCartSchema) body: AddToCartInput,
  ): Promise<CartView> {
    const course = await this.prisma.course.findUnique({
      where: { id: body.courseId },
      select: {
        id: true,
        title: true,
        status: true,
        priceMinor: true,
        priceSetAt: true,
        currency: true,
        instructorId: true,
      },
    });

    // A course that does not exist and one that is not published are the same answer here,
    // for the same reason as everywhere else: this endpoint is not an oracle for course ids.
    if (!course) throw new CourseNotPurchasableException(body.courseId, 'COURSE_NOT_FOUND');

    return this.cart.add(request.userId as string, course);
  }

  @Delete('items/:courseId')
  remove(@Req() request: FastifyRequest, @Param('courseId') courseId: string): Promise<CartView> {
    return this.cart.remove(request.userId as string, courseId);
  }
}
