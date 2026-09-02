import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';
import type { PipelineJobType } from '@masternova/contracts';

export const JOB_PROCESSOR_METADATA = 'masternova:job-processor';

/**
 * Marks a provider as the processor for one job type, so the registry can find it.
 *
 * Same force as `@EventHandler()` — CLAUDE.md §1 O, **extend by adding, not editing**.
 * Without it, the registry holds a `switch` over job types and every new stage edits the
 * one file every stage depends on. Task 1.16 adds a transcription processor by writing a
 * class; it does not touch the queue, the registry, or the orchestrator.
 */
export const JobProcessor = (type: PipelineJobType): ClassDecorator =>
  applyDecorators(Injectable(), SetMetadata(JOB_PROCESSOR_METADATA, type));
