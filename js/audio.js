// Engine and horn sounds are real recordings (see *_SAMPLE_URL below); tire
// screech/crash/bump are still synthesized with the Web Audio API since
// there's no equivalent sample for those. Everything is built on one shared
// AudioContext, created lazily (autoplay policy requires a user gesture
// first — see resumeAudio()).

const MUTE_KEY = "earthrace.muted";
const ENGINE_SAMPLE_URL = "assets/engine-idle.mp3";
const HORN_SAMPLE_URL = "assets/horn.mp3";

let ctx = null;
let masterGain = null;
let engineBuffer = null, engineSource = null, engineGain = null;
let hornBuffer = null;
let noiseBuffer = null;
let screechSource = null, screechGain = null;
let musicOsc1 = null, musicOsc2 = null, musicFilter = null, musicGain = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";

// The idle loop is a fixed recording, not a synthesized waveform — pitch (and
// with it, the sense of engine load) comes entirely from speeding the
// playback up/down via playbackRate, the same trick as a sped-up sample.
function startEngineSource() {
  if (!engineBuffer || engineSource) return;
  engineSource = ctx.createBufferSource();
  engineSource.buffer = engineBuffer;
  engineSource.loop = true;
  engineSource.connect(engineGain);
  engineSource.start();
}

function loadEngineSample() {
  fetch(ENGINE_SAMPLE_URL)
    .then(res => res.arrayBuffer())
    .then(data => ctx.decodeAudioData(data))
    .then(buf => { engineBuffer = buf; startEngineSource(); })
    .catch(err => console.warn("Couldn't load engine sound sample", err));
}

function loadHornSample() {
  fetch(HORN_SAMPLE_URL)
    .then(res => res.arrayBuffer())
    .then(data => ctx.decodeAudioData(data))
    .then(buf => { hornBuffer = buf; })
    .catch(err => console.warn("Couldn't load horn sound sample", err));
}

function ensureContext() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = muted ? 0 : 1;
  masterGain.connect(ctx.destination);

  engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  engineGain.connect(masterGain);
  loadEngineSample();
  loadHornSample();

  // Ambient pad, not a real music track (no asset for that) — two slightly
  // detuned oscillators through a lowpass whose cutoff opens up with speed,
  // so faster driving reads as more energy without a literal volume ramp.
  musicGain = ctx.createGain();
  musicGain.gain.value = 0;
  musicFilter = ctx.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = 300;
  musicFilter.connect(musicGain).connect(masterGain);
  musicOsc1 = ctx.createOscillator();
  musicOsc1.type = "sawtooth";
  musicOsc1.frequency.value = 110;
  musicOsc2 = ctx.createOscillator();
  musicOsc2.type = "sawtooth";
  musicOsc2.frequency.value = 110 * 1.005; // slight detune for a wider pad
  musicOsc1.connect(musicFilter);
  musicOsc2.connect(musicFilter);
  musicOsc1.start();
  musicOsc2.start();

  const len = ctx.sampleRate * 1;
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  return ctx;
}

// Must be called from directly inside a user-gesture handler (a click), not
// after an intervening await — browsers only honor resume() within the
// activation window of the gesture that triggered it.
export function resumeAudio() {
  ensureContext();
  if (ctx.state === "suspended") ctx.resume();
}

export function isMuted() { return muted; }

export function setMuted(m) {
  muted = m;
  localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  if (masterGain) masterGain.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
}

// speedMs/maxSpeedMs drive the engine pitch (via playback rate, since the
// engine sound is a fixed recording, not a synthesized waveform); throttleMag
// (0..1, how hard the gas is pressed) adds a little extra rasp on top so it
// doesn't sound like pure cruise-control.
export function updateEngine(speedMs, maxSpeedMs, throttleMag) {
  if (!ctx || !engineSource) return;
  const speedFrac = Math.min(1, Math.abs(speedMs) / maxSpeedMs);
  const rate = 0.8 + speedFrac * 1.7 + throttleMag * 0.2;
  engineSource.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.08);
  engineGain.gain.setTargetAtTime(0.1 + speedFrac * 0.16, ctx.currentTime, 0.08);
}

// speedFrac 0..1 (of the current road's max speed) — opens the pad's filter
// and nudges its volume/pitch up with speed. Deliberately subtle: this is
// ambience under the engine/screech, not a lead instrument.
export function updateMusic(speedFrac) {
  if (!ctx) return;
  musicFilter.frequency.setTargetAtTime(250 + speedFrac * 1800, ctx.currentTime, 0.3);
  musicGain.gain.setTargetAtTime(0.03 + speedFrac * 0.05, ctx.currentTime, 0.3);
  const freq = 110 + speedFrac * 40;
  musicOsc1.frequency.setTargetAtTime(freq, ctx.currentTime, 0.3);
  musicOsc2.frequency.setTargetAtTime(freq * 1.005, ctx.currentTime, 0.3);
}

// intensity 0..1 — how hard the car is currently sliding (see drive.js's
// drift-angle calc). Lazily spins up a looping filtered-noise source the
// first time it's needed and just rides its gain up/down after that.
export function updateScreech(intensity) {
  if (!ctx) return;
  if (intensity > 0.05) {
    if (!screechSource) {
      screechSource = ctx.createBufferSource();
      screechSource.buffer = noiseBuffer;
      screechSource.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 2200;
      filter.Q.value = 6;
      screechGain = ctx.createGain();
      screechGain.gain.value = 0;
      screechSource.connect(filter).connect(screechGain).connect(masterGain);
      screechSource.start();
    }
    screechGain.gain.setTargetAtTime(Math.min(0.22, intensity * 0.28), ctx.currentTime, 0.05);
  } else if (screechGain) {
    screechGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
  }
}

function noiseBurst({ duration, startFreq, endFreq, peakGain }) {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(startFreq, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), ctx.currentTime + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peakGain, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  src.connect(filter).connect(gain).connect(masterGain);
  src.start();
  src.stop(ctx.currentTime + duration);
}

export function playCrash() {
  noiseBurst({ duration: 0.6, startFreq: 2200, endFreq: 80, peakGain: 0.6 });
}

export function playBump() {
  noiseBurst({ duration: 0.18, startFreq: 1200, endFreq: 200, peakGain: 0.3 });
}

export function playHorn() {
  if (!ctx || !hornBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = hornBuffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  src.connect(gain).connect(masterGain);
  src.start();
}
