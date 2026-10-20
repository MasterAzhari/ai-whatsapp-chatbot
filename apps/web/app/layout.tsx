import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'MasterBot',
  robots: { index: false },
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'MasterBot', statusBarStyle: 'default' as const },
};

export const viewport = { themeColor: '#127c56' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ms">
      <body>{children}</body>
    </html>
  );
}
