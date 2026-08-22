import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Masternova',
  description: 'Learn from expert-led video courses.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">{children}</body>
    </html>
  );
}
