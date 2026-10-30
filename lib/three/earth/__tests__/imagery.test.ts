import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EarthManifest } from '../imagery';

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public/earth/manifest.json'), 'utf8')) as EarthManifest;

/** Stand-in for a decoded image: only close() matters here. */
class FakeBitmap {
  closed = false;
  close() {
    this.closed = true;
  }
}

let fetches: string[];

beforeEach(() => {
  vi.resetModules();
  fetches = [];
  vi.stubGlobal('ImageBitmap', FakeBitmap);
  vi.stubGlobal('createImageBitmap', async () => new FakeBitmap());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetches.push(url);
      return url.endsWith('manifest.json') ? Response.json(manifest) : new Response(new Uint8Array(16));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('imagery selection', () => {
  it('opens with the ground patches and the small globe, then the full-resolution globe', async () => {
    const { dayImage, followUpImages, openingImages } = await import('../imagery');
    expect(dayImage(manifest, 'preview').file).toBe('day-2k.jpg');
    expect(dayImage(manifest, 'low').file).toBe('day-4k.jpg');
    expect(dayImage(manifest, 'high').file).toBe('day-8k.jpg');
    expect(openingImages(manifest)).toEqual(['patch-pad.jpg', 'patch-mid.jpg', 'patch-wide.jpg', 'patch-water.png', 'day-2k.jpg']);
    // The 8K is only ever loaded on demand.
    expect(followUpImages(manifest)).toEqual(['day-4k.jpg', 'water-4k.png', 'night-4k.jpg']);
  });

  it('falls back to the 4K without a preview or an 8K', async () => {
    const { dayImage, followUpImages, openingImages } = await import('../imagery');
    const m: EarthManifest = { ...manifest, globe: { ...manifest.globe, day: manifest.globe.day.filter((d) => d.quality === 'low') } };
    expect(dayImage(m, 'preview').file).toBe('day-4k.jpg');
    expect(dayImage(m, 'high').file).toBe('day-4k.jpg');
    expect(openingImages(m)).toContain('day-4k.jpg');
    expect(followUpImages(m)).toEqual(['water-4k.png', 'night-4k.jpg']);
  });
});

describe('prefetch', () => {
  it('hands each prefetched image to the Earth once, without downloading it again', async () => {
    const { loadImage, prefetchImage } = await import('../imagery');
    await prefetchImage('patch-pad.jpg', true);
    expect(fetches).toEqual(['/earth/patch-pad.jpg']);
    const first = await loadImage('patch-pad.jpg');
    expect(first).toBeInstanceOf(FakeBitmap);
    expect(fetches).toHaveLength(1);
    // The Earth closes what it uploads, so a second Earth gets its own download and decode.
    await loadImage('patch-pad.jpg');
    expect(fetches).toHaveLength(2);
  });

  it('is idempotent, and does not fetch what an Earth is already downloading', async () => {
    const { loadImage, prefetchImage } = await import('../imagery');
    await Promise.all([prefetchImage('day-2k.jpg', true), prefetchImage('day-2k.jpg', true)]);
    expect(fetches).toHaveLength(1);
    const own = loadImage('night-4k.jpg');
    await prefetchImage('night-4k.jpg', false);
    await own;
    expect(fetches.filter((f) => f.endsWith('night-4k.jpg'))).toHaveLength(1);
  });

  it('releases decoded images no Earth has taken', async () => {
    vi.useFakeTimers();
    const decoded: FakeBitmap[] = [];
    vi.stubGlobal('createImageBitmap', async () => {
      const b = new FakeBitmap();
      decoded.push(b);
      return b;
    });
    const { loadImage, prefetchImage } = await import('../imagery');
    await prefetchImage('patch-mid.jpg', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(decoded[0].closed).toBe(true);
    // Dropped from the cache: the Earth downloads it afresh.
    await loadImage('patch-mid.jpg');
    expect(fetches).toHaveLength(2);
  });

  it('prefetches the opening images first, then downloads the full-resolution globe without decoding it', async () => {
    let decodes = 0;
    vi.stubGlobal('createImageBitmap', async () => {
      decodes++;
      return new FakeBitmap();
    });
    const { prefetchEarthImagery } = await import('../prefetch');
    vi.stubGlobal('window', {});
    prefetchEarthImagery();
    prefetchEarthImagery();
    await vi.waitFor(() => expect(fetches).toHaveLength(9));
    expect(fetches.slice(0, 6)).toEqual([
      '/earth/manifest.json',
      '/earth/patch-pad.jpg',
      '/earth/patch-mid.jpg',
      '/earth/patch-wide.jpg',
      '/earth/patch-water.png',
      '/earth/day-2k.jpg',
    ]);
    expect(fetches.slice(6).sort()).toEqual(['/earth/day-4k.jpg', '/earth/night-4k.jpg', '/earth/water-4k.png']);
    expect(fetches.some((f) => f.endsWith('day-8k.jpg'))).toBe(false);
    expect(decodes).toBe(5);
  });

  it('does nothing on the server', async () => {
    const { prefetchEarthImagery } = await import('../prefetch');
    vi.stubGlobal('window', undefined);
    prefetchEarthImagery();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetches).toEqual([]);
  });
});
