import { render } from '@react-email/render';
import type { ReactElement } from 'react';
import type { NotificationCategory } from '@masternova/db';
import { EmailLayout } from './layout';

export interface RenderContext {
  /** Base URL of the web app; every link in a template is built from it. */
  readonly webUrl: string;
  /** Present only for optional categories. */
  readonly unsubscribeUrl?: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Base class for every email — a **Template Method**.
 *
 * The force: rendering an email is a fixed skeleton — pick a subject, build a body, wrap it
 * in the shared chrome, and produce a plaintext alternative — with exactly one step that
 * varies. Leaving that skeleton to each template means the day someone forgets the
 * plaintext part, one email renders blank in a client nobody tested and scores worse with
 * spam filters. Here it is impossible to forget, because subclasses cannot reach `render`.
 *
 * This is inheritance used for a genuine `is-a` with a stable contract, which CLAUDE.md §3
 * says is the only case that earns it. Everything else in the module is composition.
 */
export abstract class EmailTemplate<TPayload> {
  /** Stable. It is written to `EmailDelivery.template` and is part of the idempotency key. */
  abstract readonly key: string;

  /** Decides whether preferences and the unsubscribe footer apply at all. */
  abstract readonly category: NotificationCategory;

  protected abstract subjectFor(payload: TPayload): string;

  /** The inbox preview line. Deliberately abstract: a good one is per-template copy. */
  protected abstract previewFor(payload: TPayload): string;

  protected abstract body(payload: TPayload, ctx: RenderContext): ReactElement;

  /** The skeleton. Final in spirit — no subclass overrides it. */
  async render(payload: TPayload, ctx: RenderContext): Promise<RenderedEmail> {
    const element = EmailLayout({
      preview: this.previewFor(payload),
      webUrl: ctx.webUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
      children: this.body(payload, ctx),
    });

    // Rendered twice from one element rather than hand-writing the text version, so the
    // two can never drift. `plainText` walks the same tree and keeps the URLs.
    const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);

    return { subject: this.subjectFor(payload), html, text };
  }
}

/**
 * The registry stores templates whose payload types differ, and TypeScript has no way to
 * express "some template, whatever its payload" without erasing it. The erasure is
 * contained to this alias and to the registry lookup; every template class itself is fully
 * typed, and the mapping from event to template is checked in `notification-rules.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEmailTemplate = EmailTemplate<any>;
