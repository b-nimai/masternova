import type { CourseStatus } from '@masternova/db';
import { COURSE_LIFECYCLE, allowedFrom, transitionFrom } from './course-lifecycle';

const ALL: CourseStatus[] = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED'];

/**
 * The state machine is data, so these tests read the edge list rather than driving a
 * service. That is deliberate: the claim being made is "no illegal transition is
 * expressible", and the cheapest honest proof is to enumerate every pair.
 */
describe('course lifecycle', () => {
  const legal: [CourseStatus, CourseStatus][] = [
    ['DRAFT', 'IN_REVIEW'],
    ['DRAFT', 'ARCHIVED'],
    ['IN_REVIEW', 'PUBLISHED'],
    ['IN_REVIEW', 'DRAFT'],
    ['IN_REVIEW', 'ARCHIVED'],
    ['PUBLISHED', 'DRAFT'],
    ['PUBLISHED', 'ARCHIVED'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(transitionFrom(from, to)).toBeDefined();
  });

  /** Every pair not in the list above, including every self-transition. */
  it('allows nothing else', () => {
    const illegal = ALL.flatMap((from) => ALL.map((to) => [from, to] as const)).filter(
      ([from, to]) => !legal.some(([a, b]) => a === from && b === to),
    );

    for (const [from, to] of illegal) {
      expect(transitionFrom(from, to)).toBeUndefined();
    }
  });

  it('makes ARCHIVED terminal', () => {
    expect(allowedFrom('ARCHIVED')).toEqual([]);
  });

  /** A draft cannot skip review. If this ever passes, IN_REVIEW has become decorative. */
  it('has no path from DRAFT straight to PUBLISHED', () => {
    expect(transitionFrom('DRAFT', 'PUBLISHED')).toBeUndefined();
  });

  it('gates both edges that can lead to a published course', () => {
    expect(transitionFrom('DRAFT', 'IN_REVIEW')?.requiresPublishGate).toBe(true);
    expect(transitionFrom('IN_REVIEW', 'PUBLISHED')?.requiresPublishGate).toBe(true);
  });

  it('lets a course come back down without re-passing the gate', () => {
    expect(transitionFrom('PUBLISHED', 'DRAFT')?.requiresPublishGate).toBe(false);
    expect(transitionFrom('IN_REVIEW', 'DRAFT')?.requiresPublishGate).toBe(false);
    expect(transitionFrom('PUBLISHED', 'ARCHIVED')?.requiresPublishGate).toBe(false);
  });

  it('reserves approval for a reviewer, and only approval', () => {
    expect(transitionFrom('IN_REVIEW', 'PUBLISHED')?.requiresRole).toBe('ADMIN');

    const others = ALL.flatMap((from) => COURSE_LIFECYCLE[from].transitions).filter(
      (edge) => !(edge.to === 'PUBLISHED'),
    );
    expect(others.every((edge) => edge.requiresRole === undefined)).toBe(true);
  });

  /** Two edges landing on DRAFT must not emit the same event — see the controller. */
  it('gives withdraw and unpublish distinct events', () => {
    expect(transitionFrom('IN_REVIEW', 'DRAFT')?.event).toBe('catalog.course.withdrawn');
    expect(transitionFrom('PUBLISHED', 'DRAFT')?.event).toBe('catalog.course.unpublished');
  });

  it('exposes the outgoing edges the wizard renders as buttons', () => {
    expect(allowedFrom('DRAFT')).toEqual(['IN_REVIEW', 'ARCHIVED']);
    expect(allowedFrom('IN_REVIEW')).toEqual(['PUBLISHED', 'DRAFT', 'ARCHIVED']);
  });
});
