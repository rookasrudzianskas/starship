/**
 * Module worker: makes procedural texture pixels off the main thread (see prefetchGenerated in
 * procedural.ts). Request `{ key, job }`, response `{ key, pixels }` with every buffer transferred.
 */
import { pixelBuffers, runPixelJob, type PixelJob, type PixelResult } from './pixels';

/** The parts of the dedicated-worker global scope we use (avoids pulling in the webworker lib types). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<{ key: string; job: PixelJob }>) => void) | null;
  postMessage(message: { key: string; pixels: PixelResult }, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const pixels = runPixelJob(e.data.job);
  scope.postMessage({ key: e.data.key, pixels }, pixelBuffers(pixels));
};
