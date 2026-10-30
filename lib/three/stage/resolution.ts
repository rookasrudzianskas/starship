/**
 * Adaptive render resolution: steps the pixel ratio down when frames take too long and back up once there is
 * headroom, so a weaker GPU keeps a fluid view at a slightly softer image instead of dropping frames.
 *
 * It measures the GPU time of each drawn frame with EXT_disjoint_timer_query_webgl2 where the browser offers it.
 * Elsewhere it falls back to the interval between consecutive frames during playback, and undoes a step down
 * that didn't make frames faster (the time went somewhere other than drawing pixels).
 */

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** GPU time per frame worth keeping under: three quarters of a 60 Hz frame. */
const GPU_BUDGET_MS = 12.5;
/** Step back up only if the estimated GPU time at the finer resolution stays under this share of the budget. */
const UP_HEADROOM = 0.6;
/** Without GPU timing, playback frames this far apart (under ~48 fps) are too slow. */
const SLOW_INTERVAL_MS = 21;
/** ...and this close together (about 57 fps or better) leave room to try a finer resolution. */
const FAST_INTERVAL_MS = 17.5;
/** Frames per decision. */
const WINDOW = 45;
/** Fractions of the full pixel ratio, coarsest last; never below 0.75 pixels per CSS pixel. */
const STEPS = [1, 0.75, 0.5];
const MIN_RATIO = 0.75;

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

function quantile(a: number[], q: number): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export class ResolutionGovernor {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly pool: WebGLQuery[] = [];
  private timing = false;
  private ratios: number[] = [1];
  private level = 0;
  private gpu: number[] = [];
  private intervals: number[] = [];
  private lastGpuAt = -Infinity;
  private lastFrameAt = -Infinity;
  /** No step up before this time (after a change, and longer after a step that had to be undone). */
  private holdUntil = 0;
  private backoff = 4000;
  /** Interval mode: a step down being checked, with the median interval before it. */
  private trial: number | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  /** The full pixel ratio for the current quality and display; resets the measurements when it changes. */
  setBase(base: number): void {
    const ratios: number[] = [];
    for (const s of STEPS) {
      const r = Math.max(MIN_RATIO, base * s);
      if (!ratios.some((x) => Math.abs(x - r) < 0.01)) ratios.push(r);
    }
    if (ratios.length === this.ratios.length && ratios.every((r, i) => r === this.ratios[i])) return;
    this.ratios = ratios;
    this.level = Math.min(this.level, ratios.length - 1);
    this.reset();
  }

  /** Pixel ratio to render at. */
  get ratio(): number {
    return this.ratios[this.level];
  }

  /** Start over at full resolution (quality change). */
  restart(): void {
    this.level = 0;
    this.backoff = 4000;
    this.reset();
  }

  /** Forget the samples (the scene or the canvas size changed). */
  reset(): void {
    this.gpu.length = 0;
    this.intervals.length = 0;
    this.trial = null;
    this.lastFrameAt = -Infinity;
  }

  /** Call before the first draw call of a frame. */
  begin(): void {
    this.timing = false;
    const ext = this.ext;
    if (!ext || this.pending.length > 8) return;
    // Someone else (a profiler) may be timing the frame already; only one timer can run at a time.
    if (this.gl.getQuery(ext.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.pending.push(q);
    this.timing = true;
  }

  /**
   * Call after the last draw call of a frame. `playing`: the view is redrawn every display frame (so the
   * interval between frames means something). Returns true when the pixel ratio changed.
   */
  end(now: number, playing: boolean): boolean {
    const gl = this.gl;
    const ext = this.ext;
    if (ext && this.timing) gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.timing = false;
    if (ext && this.pending.length > 0) this.collect(ext, now);
    if (playing && now - this.lastFrameAt < 100) this.intervals.push(now - this.lastFrameAt);
    this.lastFrameAt = playing ? now : -Infinity;
    return this.decide(now);
  }

  private collect(ext: TimerQueryExt, now: number): void {
    const gl = this.gl;
    // The query just ended is never ready yet; older ones arrive a frame or two later.
    while (this.pending.length > 1) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      this.pool.push(q);
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        // The timer was disturbed (power state change and the like): throw the in-flight results away.
        this.pool.push(...this.pending.splice(0, this.pending.length - 1));
        break;
      }
      this.gpu.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6);
      this.lastGpuAt = now;
    }
  }

  private decide(now: number): boolean {
    const gpuMode = now - this.lastGpuAt < 2000;
    const samples = gpuMode ? this.gpu : this.intervals;
    if (samples.length < WINDOW) return false;
    const typical = median(samples);
    const high = quantile(samples, 0.9);
    this.gpu.length = 0;
    this.intervals.length = 0;
    const last = this.ratios.length - 1;
    const before = this.level;

    if (gpuMode) {
      this.trial = null;
      if (typical > GPU_BUDGET_MS && this.level < last) {
        this.level++;
        this.holdUntil = now + 4000;
      } else if (this.level > 0 && now >= this.holdUntil) {
        const k = this.ratios[this.level - 1] / this.ratios[this.level];
        if (typical * k * k < UP_HEADROOM * GPU_BUDGET_MS) this.level--;
      }
    } else if (this.trial !== null) {
      if (typical > 0.9 * this.trial) {
        // Coarser pixels didn't speed things up: go back and leave the resolution alone for a while.
        this.level--;
        this.holdUntil = now + 30_000;
      } else this.holdUntil = now + this.backoff;
      this.trial = null;
    } else if (typical > SLOW_INTERVAL_MS && this.level < last) {
      this.level++;
      this.trial = typical;
    } else if (this.level > 0 && now >= this.holdUntil && high < FAST_INTERVAL_MS) {
      this.level--;
      // If this step up turns out too slow, the next one waits twice as long.
      this.backoff = Math.min(120_000, this.backoff * 2);
      this.holdUntil = now + this.backoff;
    }
    if (this.level === before) return false;
    this.reset();
    return true;
  }

  dispose(): void {
    for (const q of [...this.pending, ...this.pool]) this.gl.deleteQuery(q);
    this.pending.length = 0;
    this.pool.length = 0;
  }
}
