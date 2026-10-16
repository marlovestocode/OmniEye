import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'OmniEye',
  description:
    'Point a camera at the night sky. The footage becomes a registered window into a 3D celestial sphere — and the app shows you exactly how much of what it draws is actually evidence.',
};

export const viewport: Viewport = {
  themeColor: '#04060c',
  // The scene is the interface; pinch-zooming the page would fight the field of
  // view control rather than complement it.
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Lets the scene run edge to edge under the notch and home indicator; the
  // chrome then keeps clear of them with env(safe-area-inset-*).
  viewportFit: 'cover',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
