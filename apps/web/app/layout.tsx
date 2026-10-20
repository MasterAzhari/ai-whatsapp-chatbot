import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'MasterBot', robots: { index: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ms">
      <body>{children}</body>
    </html>
  );
}
