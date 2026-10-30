import { followUpImages, loadManifest, openingImages, prefetchImage } from './imagery';

/**
 * Start downloading the imagery the opening view needs before the stage exists, so the first frame doesn't
 * wait on a request that only starts after the simulation and the first render. Idempotent, and a no-op on the
 * server. Keep this module free of three.js: the replay page imports it eagerly, while the stage loads lazily.
 *
 * The opening images (ground patches and a small globe) are decoded straight away, off the main thread. The
 * full-resolution globe is only downloaded once they are in, so it never competes with them, and is decoded when
 * the Earth asks for it. The 8K day texture is left to the Earth, which loads it only when the view needs it.
 */
export function prefetchEarthImagery(): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  loadManifest()
    .then(async (m) => {
      await Promise.all(openingImages(m).map((file) => prefetchImage(file, true)));
      await Promise.all(followUpImages(m).map((file) => prefetchImage(file, false)));
    })
    // The Earth retries and reports imagery failures itself.
    .catch(() => {});
}
