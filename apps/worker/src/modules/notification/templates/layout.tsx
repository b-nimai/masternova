import type { ReactElement, ReactNode } from 'react';

/**
 * The one email chrome every template is wrapped in.
 *
 * Written as inline-styled tables rather than a stylesheet because email clients are not
 * browsers: Outlook renders through Word, Gmail strips `<style>` on forwarded messages,
 * and flexbox is unavailable in most of the field. Tables and inline styles are the
 * lowest common denominator that actually arrives looking the same.
 *
 * The Figma email designs land here, once, instead of being pasted per template.
 */

const BRAND = '#4f46e5';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const CANVAS = '#f3f4f6';
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export interface LayoutProps {
  /** The inbox preview line. Without it, clients show the first words of the body. */
  readonly preview: string;
  readonly children: ReactNode;
  /** Absent for mandatory categories — there is nothing honest to unsubscribe from. */
  readonly unsubscribeUrl?: string;
  readonly webUrl: string;
}

export function EmailLayout({
  preview,
  children,
  unsubscribeUrl,
  webUrl,
}: LayoutProps): ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>{preview}</title>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: CANVAS, fontFamily: FONT }}>
        {/* Hidden preview text: read by the inbox list, never rendered in the message. */}
        <div
          style={{
            display: 'none',
            overflow: 'hidden',
            lineHeight: '1px',
            opacity: 0,
            maxHeight: 0,
            maxWidth: 0,
          }}
        >
          {preview}
        </div>

        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{ backgroundColor: CANVAS, padding: '32px 12px' }}
        >
          <tbody>
            <tr>
              <td align="center">
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{ maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }}
                >
                  <tbody>
                    <tr>
                      <td style={{ padding: '28px 32px 8px' }}>
                        <a
                          href={webUrl}
                          style={{
                            color: BRAND,
                            fontSize: '18px',
                            fontWeight: 700,
                            letterSpacing: '-0.01em',
                            textDecoration: 'none',
                          }}
                        >
                          Masternova
                        </a>
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{
                          padding: '8px 32px 28px',
                          color: INK,
                          fontSize: '15px',
                          lineHeight: '24px',
                        }}
                      >
                        {children}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: '0 32px' }}>
                        <div style={{ borderTop: `1px solid ${LINE}` }} />
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{
                          padding: '18px 32px 26px',
                          color: MUTED,
                          fontSize: '12px',
                          lineHeight: '18px',
                        }}
                      >
                        <div>Masternova — learn from people who have shipped it.</div>
                        {unsubscribeUrl ? (
                          <div style={{ marginTop: '6px' }}>
                            <a href={unsubscribeUrl} style={{ color: MUTED }}>
                              Unsubscribe from these emails
                            </a>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

/** A primary call-to-action. One per email — two buttons is a decision the reader has to make. */
export function Button({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a
      href={href}
      style={{
        display: 'inline-block',
        padding: '11px 20px',
        backgroundColor: BRAND,
        color: '#ffffff',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  );
}

export function Heading({ children }: { children: ReactNode }): ReactElement {
  return (
    <h1 style={{ margin: '0 0 12px', color: INK, fontSize: '20px', lineHeight: '28px' }}>
      {children}
    </h1>
  );
}

export function Paragraph({ children }: { children: ReactNode }): ReactElement {
  return <p style={{ margin: '0 0 14px' }}>{children}</p>;
}

/** For the "if this wasn't you" line and link fallbacks — present but visually quieter. */
export function Fine({ children }: { children: ReactNode }): ReactElement {
  return (
    <p style={{ margin: '14px 0 0', color: MUTED, fontSize: '12px', lineHeight: '18px' }}>
      {children}
    </p>
  );
}
