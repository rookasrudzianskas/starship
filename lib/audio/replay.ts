'use client';

import { createTrackSample, sampleTrack } from '@/lib/sim/sample';
import { countLit, engineStates } from '@/lib/telemetry';
import { isSkipping, useReplay } from '@/lib/store/replay';
import { soundLevels } from './levels';

interface SoundGraph {
  context: AudioContext;
  master: GainNode;
  rumble: GainNode;
  air: GainNode;
  tone: OscillatorNode;
  sources: AudioScheduledSourceNode[];
}

let graph: SoundGraph | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
const sample = createTrackSample();
const engines = new Uint8Array(40);

function smooth(param: AudioParam, value: number, time: number): void {
  param.cancelAndHoldAtTime(time);
  param.setTargetAtTime(value, time, 0.06);
}

function createGraph(): SoundGraph {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 12;
  limiter.ratio.value = 8;
  master.connect(limiter).connect(context.destination);

  // Two seconds of filtered noise loop in the audio thread; no network assets or per-sample JS work.
  const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = context.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;

  const low = context.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 260;
  const rumble = context.createGain();
  rumble.gain.value = 0;
  noise.connect(low).connect(rumble).connect(master);

  const high = context.createBiquadFilter();
  high.type = 'bandpass';
  high.frequency.value = 1100;
  high.Q.value = 0.45;
  const air = context.createGain();
  air.gain.value = 0;
  noise.connect(high).connect(air).connect(master);

  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.value = 40;
  const toneLevel = context.createGain();
  toneLevel.gain.value = 0.18;
  tone.connect(toneLevel).connect(rumble);
  noise.start();
  tone.start();
  return { context, master, rumble, air, tone, sources: [noise, tone] };
}

function updateSound(): void {
  if (!graph) return;
  const s = useReplay.getState();
  const audible = s.soundEnabled && s.playing && !s.loading && !s.error && s.result && !document.hidden && !isSkipping(s) && s.rate <= 5;
  const now = graph.context.currentTime;
  smooth(graph.master.gain, audible ? 0.8 : 0, now);
  if (!audible || !s.result) return;
  let rumble = 0;
  let air = 0;
  let frequency = 36;
  for (const vehicle of ['booster', 'ship'] as const) {
    if (s.follow !== 'both' && s.follow !== vehicle) continue;
    const track = s.result[vehicle];
    const timeline = vehicle === 'booster' ? s.result.boosterEngines : s.result.shipEngines;
    sampleTrack(track, s.t, sample);
    const levels = soundLevels({
      throttle: sample.throttle,
      lit: countLit(engineStates(timeline, s.t, engines)),
      engines: timeline.slots.length,
      altitude: sample.alt,
      dynamicPressure: sample.q,
      ended: s.t >= track.end || s.t < track.start,
    });
    rumble = Math.max(rumble, levels.rumble);
    air = Math.max(air, levels.air);
    frequency = Math.max(frequency, levels.frequency);
  }
  smooth(graph.rumble.gain, rumble, now);
  smooth(graph.air.gain, air, now);
  smooth(graph.tone.frequency, frequency, now);
}

function disposeSound(): void {
  generation++;
  if (timer !== null) clearInterval(timer);
  timer = null;
  const previous = graph;
  graph = null;
  if (previous) {
    previous.master.gain.cancelScheduledValues(previous.context.currentTime);
    previous.master.gain.value = 0;
    for (const source of previous.sources) source.stop();
    void previous.context.close().catch(() => undefined);
  }
}

/** Called directly from a click or M key so the browser can unlock audio. Sound is opt-in on every visit. */
export function toggleSound(): void {
  if (useReplay.getState().soundEnabled) {
    useReplay.setState({ soundEnabled: false, soundError: null });
    disposeSound();
    return;
  }
  const token = ++generation;
  try {
    graph = createGraph();
    useReplay.setState({ soundEnabled: true, soundError: null });
    void graph.context.resume().then(() => {
      if (generation !== token) return;
      updateSound();
      timer = setInterval(updateSound, 50);
    }).catch(() => {
      if (generation !== token) return;
      disposeSound();
      useReplay.setState({ soundEnabled: false, soundError: 'Sound could not start. Try enabling it again.' });
    });
  } catch {
    disposeSound();
    useReplay.setState({ soundEnabled: false, soundError: 'Sound is unavailable in this browser.' });
  }
}

/** Replay lifetime: navigation and hidden tabs must never leave an engine rumbling in the background. */
export function mountReplaySound(): () => void {
  const onVisibility = () => {
    if (!graph) return;
    updateSound();
    if (document.hidden) void graph.context.suspend().catch(() => undefined);
    else void graph.context.resume().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', onVisibility);
  const unsubscribe = useReplay.subscribe((s, p) => {
    if (s.playing !== p.playing || s.loading !== p.loading || s.result !== p.result || s.follow !== p.follow || s.rate !== p.rate) updateSound();
  });
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    disposeSound();
    useReplay.setState({ soundEnabled: false, soundError: null });
  };
}
