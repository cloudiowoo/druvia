import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Druvia Admin',
  description: 'Druvia Platform Administration',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
