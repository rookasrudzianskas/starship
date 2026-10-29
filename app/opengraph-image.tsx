import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'Starship Telemetry: every Starship flight, simulated in 3D';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  // Satori reads woff/ttf but not woff2.
  const [bold, regular] = await Promise.all([
    readFile(join(process.cwd(), 'app/fonts/D-DINExp-Bold.woff')).catch(() => null),
    readFile(join(process.cwd(), 'app/fonts/D-DIN.woff')).catch(() => null),
  ]);
  const fonts = [
    ...(bold ? [{ name: 'DIN Exp', data: bold, weight: 700 as const, style: 'normal' as const }] : []),
    ...(regular ? [{ name: 'DIN', data: regular, weight: 400 as const, style: 'normal' as const }] : []),
  ];
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: 'linear-gradient(180deg, #0b1a2c 0%, #04070c 55%, #000 100%)',
          color: '#fff',
          fontFamily: 'DIN',
        }}
      >
        <div style={{ display: 'flex', fontSize: 22, letterSpacing: 6, textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
          Every flight · simulated
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontFamily: 'DIN Exp', fontSize: 92, letterSpacing: 8, textTransform: 'uppercase', lineHeight: 1 }}>Starship</div>
          <div style={{ fontFamily: 'DIN Exp', fontSize: 92, letterSpacing: 8, textTransform: 'uppercase', lineHeight: 1.1 }}>Telemetry</div>
        </div>
        <div style={{ display: 'flex', gap: 48, fontSize: 26, color: 'rgba(255,255,255,0.75)' }}>
          <span>14 flight tests</span>
          <span>3D replay</span>
          <span>Live telemetry</span>
          <span>Take the controls</span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
