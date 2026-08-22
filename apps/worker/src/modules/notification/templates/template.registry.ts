import { Injectable } from '@nestjs/common';
import type { AnyEmailTemplate } from './email-template';

/**
 * Resolves a template from the key carried on a send request.
 *
 * Same force as Factory Method (CLAUDE.md §2): choose an implementation from a
 * discriminator. It is a lookup rather than a `switch`, so adding a template is one entry
 * in the module's provider list and zero edits here — which is the difference between
 * CLAUDE.md §1 O being true and being claimed.
 */
@Injectable()
export class TemplateRegistry {
  private readonly byKey = new Map<string, AnyEmailTemplate>();

  constructor(templates: AnyEmailTemplate[]) {
    for (const template of templates) {
      if (this.byKey.has(template.key)) {
        // Two templates sharing a key would collide in the idempotency constraint and
        // silently suppress each other's mail. Failing at boot is the cheap version.
        throw new Error(`duplicate email template key: ${template.key}`);
      }
      this.byKey.set(template.key, template);
    }
  }

  get(key: string): AnyEmailTemplate {
    const template = this.byKey.get(key);
    if (!template) {
      throw new Error(`no email template registered for key: ${key}`);
    }
    return template;
  }

  get keys(): string[] {
    return [...this.byKey.keys()];
  }
}
