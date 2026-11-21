/* Procedural sound for the proof tower (Web Audio, no files).  Off by default; the browser only allows audio after a
 * click, so nothing can start by itself.  Three layers, all deliberately quiet:
 *   1. bed     - slow low "breathing" drone; brighter with CPU load, deeper with memory use
 *   2. notes   - one soft pentatonic note per module that has just been built, placed where the module is in the tower
 *   3. chord   - a rare gentle chord when one of OUR packets is finished
 * Every number you may want to tune is in CFG.
 */
(function (root) {
  'use strict';
  const L = (typeof module === 'object' && module.exports && typeof require === 'function') ? require('./lib.js') : root.RHLib;

  const CFG = {
    volume: 0.6,                 // default slider position 0..1 (squared before it reaches the speakers)
    masterMax: 1.0,              // master gain at volume = 1.  (0.5 here made everything ~-40 dBFS: inaudible on laptop/headset speakers)
    fadeSec: 0.12,               // fade when switching on/off or changing volume: never a click
    bed: { baseHz: 55, gain: 0.12, cutoffMin: 160, cutoffMax: 1500, lfoHz: 0.06, lfoDepthHz: 70, tau: 1.6 },
    notes: { gain: 0.30, attack: 0.025, decay: 1.8, lowpassHz: 2400, maxPerSec: 4, burst: 3, maxVoices: 10, detuneCents: 6,
             scale: [0, 2, 4, 7, 9], baseMidi: 45, octaves: 3 },
    chord: { gain: 0.20, attack: 0.6, hold: 2.4, release: 3.6, rootMidi: 52, intervals: [0, 7, 12, 16] },
    chime: { midi: 69, gain: 0.30 },   // heard when sound is switched on and when the volume changes, so you know it works
    reverb: { seconds: 2.6, wet: 0.35, power: 3 },
    space: { refDistance: 2, rolloff: 0.6, maxDistance: 40 },
  };

  function create(opts) {
    opts = opts || {};
    const make = opts.ctxFactory || (() => new (root.AudioContext || root.webkitAudioContext)());
    const maxDepth = opts.maxDepth || 202;
    let ctx = null, g = null, thin = null;
    const st = { on: false, volume: CFG.volume, cpu: 0, mem: 0 };
    const onState = opts.onState || (() => {});
    const voiceEnds = [];                                    // end times of the notes currently sounding

    const now = () => (ctx ? ctx.currentTime : 0);
    const activeVoices = () => { const t = now(); while (voiceEnds.length && voiceEnds[0] <= t) voiceEnds.shift(); return voiceEnds.length; };

    function impulse(c) {
      const n = Math.floor(c.sampleRate * CFG.reverb.seconds), b = c.createBuffer(2, n, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, CFG.reverb.power); }
      return b;
    }
    function build() {
      const c = ctx;
      const master = c.createGain(); master.gain.value = 0;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 4;       // safety net
      master.connect(comp); comp.connect(c.destination);
      const bus = c.createGain(), dry = c.createGain(), wet = c.createGain(), conv = c.createConvolver();
      conv.buffer = impulse(c); wet.gain.value = CFG.reverb.wet; dry.gain.value = 1;
      bus.connect(dry); bus.connect(conv); conv.connect(wet); dry.connect(master); wet.connect(master);
      // bed
      const bp = L.bedParams(0, 0, CFG.bed);
      const bedGain = c.createGain(); bedGain.gain.value = 0;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = bp.cutoff; lp.Q.value = 0.7;
      const o1 = c.createOscillator(); o1.type = 'triangle'; o1.frequency.value = CFG.bed.baseHz;
      const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = CFG.bed.baseHz * 1.5; o2.detune.value = 7;
      const sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.value = CFG.bed.baseHz / 2;
      const g1 = c.createGain(), g2 = c.createGain(), gs = c.createGain(); g1.gain.value = 0.6; g2.gain.value = 0.25; gs.gain.value = bp.sub;
      o1.connect(g1); o2.connect(g2); sub.connect(gs); g1.connect(lp); g2.connect(lp); gs.connect(lp); lp.connect(bedGain); bedGain.connect(bus);
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = CFG.bed.lfoHz;
      const lfoAmt = c.createGain(); lfoAmt.gain.value = CFG.bed.lfoDepthHz; lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);
      for (const o of [o1, o2, sub, lfo]) o.start();
      return { master, bus, bedGain, lp, gs };
    }
    function applyLoad() {
      if (!g) return;
      const p = L.bedParams(st.cpu, st.mem, CFG.bed), t = ctx.currentTime;
      g.lp.frequency.setTargetAtTime(p.cutoff, t, CFG.bed.tau);
      g.bedGain.gain.setTargetAtTime(p.gain, t, CFG.bed.tau);
      g.gs.gain.setTargetAtTime(p.sub, t, CFG.bed.tau);
    }
    function applyVolume() {
      if (!g) return;
      g.master.gain.cancelScheduledValues(ctx.currentTime);
      g.master.gain.setTargetAtTime(st.on ? L.masterGain(st.volume, CFG.masterMax) : 0, ctx.currentTime, CFG.fadeSec / 3);
    }
    function enable() {
      if (!ctx) { ctx = make(); g = build(); thin = L.makeThinner(CFG.notes.maxPerSec, CFG.notes.burst, now); ctx.onstatechange = () => onState(ctx.state); }
      unlock();
      st.on = true; applyLoad(); applyVolume(); chime(); onState(ctx.state); return true;
    }
    /** Browsers keep audio suspended until a user gesture; call this from every click / key / controller press (cheap when already running). */
    function unlock() {
      if (!ctx || ctx.state === 'running' || !ctx.resume) return;
      const r = ctx.resume(); if (r && r.then) r.then(() => onState(ctx.state), () => onState(ctx.state));
    }
    /** short two-note confirmation at a fixed, clearly audible level */
    function chime() {
      if (!st.on || !ctx) return false;
      const c = CFG.chime; note(L.midiHz(c.midi), null, c.gain, 0.02, 1.1, 2400, 1); note(L.midiHz(c.midi + 7), null, c.gain * 0.7, 0.02, 1.5, 2400, 1); return true;
    }
    function disable() { st.on = false; applyVolume(); return false; }
    function toggle() { return st.on ? disable() : enable(); }
    function setVolume(v) { st.volume = Math.max(0, Math.min(1, v)); applyVolume(); return st.volume; }
    /** feedback after a volume change: one short note at the new level */
    function blip() { if (!st.on || !ctx) return false; note(L.midiHz(CFG.chime.midi - 5), null, CFG.chime.gain * 0.8, 0.015, 0.45, 2400, 1); return true; }
    function setLoad(cpu, mem) { st.cpu = cpu; st.mem = mem; applyLoad(); }

    /** one soft note; `pos` = world position {x,y,z} or null (centred) */
    function note(hz, pos, peak, attack, decay, lowpassHz, gainBoost) {
      const t = ctx.currentTime + 0.005, end = t + attack + decay + 0.05;
      const o = ctx.createOscillator(), o2 = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = hz; o2.type = 'triangle'; o2.frequency.value = hz * 2;
      const g2 = ctx.createGain(); g2.gain.value = 0.12 * (gainBoost || 1);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);                                         // starts silent ...
      env.gain.exponentialRampToValueAtTime(peak, t + attack);                    // ... soft attack ...
      env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);          // ... long fade, done before the oscillator stops
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lowpassHz;
      o.connect(env); o2.connect(g2); g2.connect(env); env.connect(lp);
      let tail = lp;
      if (pos) {
        const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
        p.refDistance = CFG.space.refDistance; p.rolloffFactor = CFG.space.rolloff; p.maxDistance = CFG.space.maxDistance;
        if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else if (p.setPosition) p.setPosition(pos.x, pos.y, pos.z);
        lp.connect(p); tail = p;
      }
      tail.connect(g.bus);
      o.start(t); o2.start(t); o.stop(end); o2.stop(end);
      return end;
    }
    /** a module has just been built: depth/ns decide the pitch, pos where it sounds */
    function module(m) {
      if (!st.on || !ctx) return false;
      if (!thin.take()) return false;
      if (activeVoices() >= CFG.notes.maxVoices) return false;
      const midi = L.noteMidi(m.depth, maxDepth, m.ns, CFG.notes);
      const cents = (Math.random() * 2 - 1) * CFG.notes.detuneCents;
      const hz = L.midiHz(midi) * Math.pow(2, cents / 1200);
      const vel = 0.7 + 0.3 * Math.random();
      voiceEnds.push(note(hz, m.pos || null, CFG.notes.gain * vel, CFG.notes.attack, CFG.notes.decay, CFG.notes.lowpassHz));
      voiceEnds.sort((a, b) => a - b);
      return true;
    }
    /** one of our packets is done: a gentle, slow chord (rare, so exempt from thinning) */
    function packetDone() {
      if (!st.on || !ctx) return false;
      const c = CFG.chord;
      for (const iv of c.intervals) note(L.midiHz(c.rootMidi + iv), null, c.gain, c.attack, c.hold + c.release, 1800, 1);
      return true;
    }
    /** keep the 3D sound field aligned with the head */
    function listener(pos, fwd, up) {
      if (!ctx) return;
      const l = ctx.listener;
      if (l.positionX) { l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z; l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z; l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z; }
      else if (l.setPosition) { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
    }
    return { enable, disable, toggle, setVolume, setLoad, module, packetDone, chime, blip, unlock, listener,
      state: () => ({ on: st.on, volume: st.volume, voices: ctx ? activeVoices() : 0, created: !!ctx, running: !!ctx && ctx.state === 'running', ctxState: ctx ? ctx.state : 'none' }), CFG };
  }

  const api = { create, CFG };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.RHAudio = api;
})(typeof self !== 'undefined' ? self : this);
