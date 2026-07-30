// Original, fully procedural sound design (oscillators + synthesized noise) — nothing sampled or
// extracted from any film. Evokes a mechanical hydraulic/servo suit-up without reproducing one.
let ctx: AudioContext | null = null;

export const ensureAudioContext = (): AudioContext => {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
};

const noiseBuffer = (context: AudioContext, duration: number): AudioBuffer => {
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * duration)), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
};

const playHydraulicHiss = (delaySec = 0) => {
  const context = ensureAudioContext();
  const start = context.currentTime + delaySec, duration = 0.35;
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context, duration);
  const filter = context.createBiquadFilter();
  filter.type = "bandpass"; filter.Q.value = 0.8;
  filter.frequency.setValueAtTime(2200, start); filter.frequency.exponentialRampToValueAtTime(750, start + duration);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start); gain.gain.linearRampToValueAtTime(0.32, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  source.connect(filter).connect(gain).connect(context.destination);
  source.start(start); source.stop(start + duration);
};

const playServoSweep = (rising: boolean, delaySec = 0) => {
  const context = ensureAudioContext();
  const start = context.currentTime + delaySec, duration = 0.4;
  const osc = context.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(rising ? 90 : 420, start);
  osc.frequency.exponentialRampToValueAtTime(rising ? 420 : 70, start + duration);
  const filter = context.createBiquadFilter();
  filter.type = "lowpass"; filter.frequency.value = 1200; filter.Q.value = 4;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.2, start + 0.05); gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(filter).connect(gain).connect(context.destination);
  osc.start(start); osc.stop(start + duration);
};

const playMetalClank = (delaySec = 0) => {
  const context = ensureAudioContext();
  const start = context.currentTime + delaySec, duration = 0.12;
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context, duration);
  const filter = context.createBiquadFilter();
  filter.type = "bandpass"; filter.frequency.value = 2600; filter.Q.value = 6;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.45, start); gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  source.connect(filter).connect(gain).connect(context.destination);
  source.start(start); source.stop(start + duration);
};

export const playSuitUpSequence = () => {
  playHydraulicHiss(0); playMetalClank(0.12); playMetalClank(0.28); playServoSweep(true, 0.05); playMetalClank(0.55); playHydraulicHiss(0.7);
};

export const playPowerDownSequence = () => {
  playServoSweep(false, 0); playHydraulicHiss(0.1); playMetalClank(0.4);
};

export const playProjectileZap = () => {
  const context = ensureAudioContext();
  const start = context.currentTime, duration = 0.12;
  const osc = context.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(900, start); osc.frequency.exponentialRampToValueAtTime(220, start + duration);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.14, start); gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain).connect(context.destination);
  osc.start(start); osc.stop(start + duration);
};
