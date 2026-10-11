import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServerBanner } from '@/components/ServerBanner';
import './globals.css';

export const metadata: Metadata = {
  title: 'ChainGuard — real-time smart contract security',
  description:
    'Mempool monitoring that scores transactions against a vault, streams alerts and pauses the contract before a drain lands.',
};

export const viewport: Viewport = {
  themeColor: '#080b10',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-emerald-400 focus:px-4 focus:py-2 focus:text-emerald-950"
        >
          Skip to content
        </a>
        <ServerBanner />
        {children}
      </body>
    </html>
  );
}
