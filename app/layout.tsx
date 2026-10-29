import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// D-DIN by Datto, SIL Open Font License (app/fonts/OFL.txt).
const din = localFont({
  src: [
    { path: './fonts/D-DIN.woff2', weight: '400', style: 'normal' },
    { path: './fonts/D-DIN-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-din',
  display: 'swap',
});

const dinExpanded = localFont({
  src: [{ path: './fonts/D-DINExp-Bold.woff2', weight: '700', style: 'normal' }],
  variable: '--font-din-exp',
  display: 'swap',
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Starship Telemetry · Every flight, simulated',
    template: '%s · Starship Telemetry',
  },
  description:
    'Every Starship flight test rebuilt as a physics simulation: replay each launch in 3D with live telemetry, compare flights, and take the controls yourself.',
  applicationName: 'Starship Telemetry',
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${din.variable} ${dinExpanded.variable}`}>
      <body>{children}</body>
    </html>
  );
}
