// node tests/test_audio.js  -- the sound engine against a fake AudioContext that records every call
const assert = require('assert');
const L = require('../static/lib.js');
const A = require('../static/audio.js');
let ok = 0; const t = (name, fn) => { fn(); ok++; console.log('ok  ' + name); };

const { FakeCtx } = require('./fake_audio.js');
const fresh = () => { let c; const a = A.create({ ctxFactory: () => (c = new FakeCtx()) }); return { a, ctx: () => c }; };
const mod = (depth = 50, ns = 0, pos = null) => ({ depth, ns, pos });

t('nothing exists and nothing sounds before the user switches sound on (browser autoplay rule)', () => {
  const { a, ctx } = fresh(); assert.strictEqual(ctx(), undefined); assert.strictEqual(a.module(mod()), false); assert.strictEqual(a.packetDone(), false);
  assert.deepStrictEqual(a.state(), { on: false, volume: A.CFG.volume, voices: 0, created: false, running: false, ctxState: 'none' });
});
t('enable builds the graph, starts the bed, resumes the context; master starts at 0 and fades in (no click)', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx();
  assert.strictEqual(c.resumed, 1); assert.strictEqual(c.of('osc').slice(0, 4).filter((o) => o.started !== null).length, 4, 'bed: 3 oscillators + LFO (the chime adds more after them)');
  const master = c.of('gain')[0]; assert.strictEqual(master.gain.value, 0, 'master must start silent');
  const fade = master.gain.calls.filter((x) => x[0] === 'target'); assert(fade.length >= 1 && fade[fade.length - 1][1] > 0 && fade[fade.length - 1][3] > 0, 'master must be raised smoothly (time constant > 0)');
  assert(c.of('comp').length === 1 && c.of('comp')[0].out.includes(c.destination), 'a compressor guards the output');
});
t('volume uses a squared taper; off fades to 0 smoothly; toggling works', () => {
  const { a, ctx } = fresh(); a.enable(); a.setVolume(0.8);
  const master = ctx().of('gain')[0], last = () => master.gain.calls.filter((x) => x[0] === 'target').pop();
  assert(Math.abs(last()[1] - 0.8 * 0.8 * A.CFG.masterMax) < 1e-12); assert(last()[3] > 0);
  assert.strictEqual(a.toggle(), false); assert.strictEqual(last()[1], 0, 'off = fade to 0'); assert(last()[3] > 0, 'fade, not a jump');
  assert.strictEqual(a.toggle(), true); assert(last()[1] > 0); assert.strictEqual(a.setVolume(7), 1); assert.strictEqual(a.setVolume(-1), 0);
});
t('off means silent: no notes, no chord', () => {
  const { a } = fresh(); a.enable(); a.disable(); assert.strictEqual(a.module(mod()), false); assert.strictEqual(a.packetDone(), false);
});
t('thinning: a burst of 200 modules at one instant gives only a handful of notes; sustained rate stays at the limit', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx();
  let n = 0; for (let k = 0; k < 200; k++) n += a.module(mod(k % 200, k)) ? 1 : 0;
  assert(n <= A.CFG.notes.burst, 'burst allowed ' + n + ' notes');
  let total = 0; for (let k = 0; k < 1000; k++) { c.currentTime += 0.01; total += a.module(mod(k % 200, k)) ? 1 : 0; }   // 100 attempts per second for 10 s
  const maxOk = A.CFG.notes.burst + A.CFG.notes.maxPerSec * 10 + 1;
  assert(total <= maxOk, 'too many notes: ' + total + ' > ' + maxOk); assert(total >= A.CFG.notes.maxPerSec * 10 * 0.6, 'thinned too hard: ' + total);
  console.log('     200 modules in 1 instant ->', n, 'notes; 1000 modules in 10 s ->', total, 'notes');
});
t('polyphony cap: never more than maxVoices notes sounding at once', () => {
  const save = { ...A.CFG.notes }; A.CFG.notes.maxPerSec = 1e6; A.CFG.notes.burst = 1e6;
  try { const { a, ctx } = fresh(); a.enable(); let n = 0; for (let k = 0; k < 100; k++) n += a.module(mod(k, k)) ? 1 : 0; assert.strictEqual(n, A.CFG.notes.maxVoices); assert.strictEqual(a.state().voices, A.CFG.notes.maxVoices);
    ctx().currentTime += 10; assert.strictEqual(a.state().voices, 0, 'voices must free up when the notes have faded'); }
  finally { Object.assign(A.CFG.notes, save); }
});
t('click-free envelope: starts silent, soft attack, fades to silence BEFORE the oscillator stops', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx(); const before = c.nodes.length; c.currentTime = 5;
  assert(a.module(mod(30, 1)));
  const added = c.nodes.slice(before), env = added.find((n) => n.kind === 'gain' && n.gain.calls.some((x) => x[0] === 'exp'));
  assert(env, 'no envelope gain found'); const [s, up, down] = env.gain.calls;
  assert.strictEqual(s[0], 'set'); assert(s[1] <= 0.001, 'must start (almost) silent: ' + s[1]); assert(s[2] >= c.currentTime, 'scheduled in the future');
  assert.strictEqual(up[0], 'exp'); assert(up[2] - s[2] >= 0.01, 'attack must be at least 10 ms: ' + (up[2] - s[2])); assert(up[1] > 0.01 && up[1] < 0.5);
  assert.strictEqual(down[0], 'exp'); assert(down[1] <= 0.001, 'must fade to ~0'); assert(down[2] - up[2] >= 0.5, 'release must be long');
  for (const o of added.filter((n) => n.kind === 'osc')) { assert(o.started >= c.currentTime && o.stopped > down[2], 'oscillator must outlive its envelope'); }
  assert(added.some((n) => n.kind === 'biquad' && n.frequency.value <= 3000), 'notes are low-passed (no harsh highs)');
});
t('pitch: always in the pentatonic scale; deeper modules are never higher; detune stays tiny', () => {
  const cfg = A.CFG.notes; const inScale = (m) => cfg.scale.includes(((m - cfg.baseMidi) % 12 + 12) % 12);
  for (let d = 0; d <= 202; d++) for (const ns of [0, 1, 2, 7, 253]) { const m = L.noteMidi(d, 202, ns, cfg); assert(inScale(m), `midi ${m} not in the scale (depth ${d}, ns ${ns})`); assert(m >= cfg.baseMidi && m <= cfg.baseMidi + 12 * cfg.octaves); }
  for (const ns of [0, 1, 2]) { let prev = Infinity; for (let d = 0; d <= 202; d++) { const m = L.noteMidi(d, 202, ns, cfg); assert(m <= prev + 0, 'pitch must not rise with depth'); prev = m; } }
  const { a, ctx } = fresh(); a.enable(); const c = ctx(); for (let k = 0; k < 30; k++) { c.currentTime += 1; const n0 = c.nodes.length; a.module(mod(k * 6, k)); const o = c.nodes.slice(n0).find((n) => n.kind === 'osc');
    const midi = 69 + 12 * Math.log2(o.frequency.value / 440), nearest = Math.round(midi); assert(Math.abs(midi - nearest) <= cfg.detuneCents / 100 + 1e-9, 'detune too large'); assert(inScale(nearest)); }
});
t('space: a module with a position sounds there (HRTF panner), one without is centred', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx(); c.currentTime = 1;
  a.module(mod(10, 0, { x: 3, y: 2, z: -4 })); const p = c.of('panner'); assert.strictEqual(p.length, 1);
  assert.deepStrictEqual([p[0].positionX.value, p[0].positionY.value, p[0].positionZ.value], [3, 2, -4]); assert.strictEqual(p[0].panningModel, 'HRTF');
  c.currentTime = 2; a.module(mod(10, 0, null)); assert.strictEqual(c.of('panner').length, 1, 'no panner without a position');
  a.listener({ x: 1, y: 1.6, z: 2 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
  assert.deepStrictEqual([c.listener.positionX.value, c.listener.positionY.value, c.listener.positionZ.value, c.listener.forwardZ.value, c.listener.upY.value], [1, 1.6, 2, -1, 1]);
});
t('bed follows the machine: more CPU = brighter and louder, more memory = more sub; all inside the configured range', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx(); const lp = c.of('biquad')[0], bedGain = c.of('gain').find((g) => g.out.length && g.out[0].kind === 'gain' && g.out[0] !== c.of('gain')[0]);
  const target = (p) => p.calls.filter((x) => x[0] === 'target').pop();
  a.setLoad(0, 0); const lo = { f: target(lp.frequency)[1] }; a.setLoad(1, 1); const hi = { f: target(lp.frequency)[1] };
  assert(hi.f > lo.f * 3, `cutoff should open with CPU: ${lo.f} -> ${hi.f}`); assert(Math.abs(lo.f - A.CFG.bed.cutoffMin) < 1e-9 && Math.abs(hi.f - A.CFG.bed.cutoffMax) < 1e-9);
  const p0 = L.bedParams(0, 0, A.CFG.bed), p1 = L.bedParams(1, 1, A.CFG.bed); assert(p1.gain > p0.gain * 2 && p1.sub > p0.sub && p1.gain <= A.CFG.bed.gain + 1e-12);
  const mid = L.bedParams(0.5, 0.5, A.CFG.bed); assert(mid.cutoff > p0.cutoff && mid.cutoff < p1.cutoff);
  assert.strictEqual(L.bedParams(5, -3, A.CFG.bed).cutoff, A.CFG.bed.cutoffMax, 'out-of-range input is clamped'); assert(target(lp.frequency)[3] >= 1, 'load changes glide over seconds');
});
t('packet chord: four slow notes, rare so not thinned, long release, no click', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx(); for (let k = 0; k < 50; k++) a.module(mod(k, k));   // exhaust the thinner first
  const n0 = c.nodes.length; assert.strictEqual(a.packetDone(), true); const added = c.nodes.slice(n0);
  assert.strictEqual(added.filter((n) => n.kind === 'osc').length, 8, '4 notes x (fundamental + soft partial)');
  const envs = added.filter((n) => n.kind === 'gain' && n.gain.calls.some((x) => x[0] === 'exp')); assert.strictEqual(envs.length, 4);
  for (const e of envs) { const [s, up, down] = e.gain.calls; assert(s[1] <= 0.001 && up[2] - s[2] >= 0.3 && down[2] - up[2] >= 5, 'chord must swell and fade slowly'); }
  assert(added.filter((n) => n.kind === 'osc').every((o) => o.stopped > c.currentTime + 6), 'chord lasts several seconds');
});
const dbfs = (x) => 20 * Math.log10(x);
t('LEVELS: defaults are clearly audible but never clip (the first version was ~-40 dBFS = inaudible on laptop / headset speakers)', () => {
  const master = L.masterGain(A.CFG.volume, A.CFG.masterMax), n = A.CFG.notes;
  const quietNote = n.gain * 0.7 * master, loudNote = n.gain * 1.0 * master;
  console.log('     default volume', A.CFG.volume, '-> master', master.toFixed(3), '| note', dbfs(quietNote).toFixed(1), '..', dbfs(loudNote).toFixed(1), 'dBFS');
  assert(dbfs(quietNote) > -28, 'quietest note is only ' + dbfs(quietNote).toFixed(1) + ' dBFS - inaudible'); assert(dbfs(loudNote) < -8, 'a single note must leave headroom');
  const bedIdle = L.bedParams(0, 0, A.CFG.bed).gain * 0.6 * master, bedBusy = L.bedParams(1, 1, A.CFG.bed).gain * 0.9 * master;
  console.log('     bed', dbfs(bedIdle).toFixed(1), 'dBFS idle,', dbfs(bedBusy).toFixed(1), 'dBFS busy');
  assert(dbfs(bedIdle) > -46 && dbfs(bedBusy) > -34 && dbfs(bedBusy) < -14, 'bed level out of range'); assert(bedBusy > bedIdle * 2, 'the bed must clearly follow the load');
  const chord = A.CFG.chord.gain * master * 4; assert(dbfs(chord) < -4 && dbfs(chord) > -26, 'chord level ' + dbfs(chord).toFixed(1));
  assert(dbfs(A.CFG.chime.gain * master) > -26, 'the confirmation chime must be audible');
});
t('switching sound on gives feedback: an audible chime; volume changes blip; nothing when off', () => {
  const { a, ctx } = fresh(); a.enable(); const c = ctx(); const peaks = c.of('gain').filter((g) => g.gain.calls.some((x) => x[0] === 'exp')).map((g) => g.gain.calls.find((x) => x[0] === 'exp')[1]);
  assert.strictEqual(peaks.length, 2, 'two chime notes expected right after enable'); assert(peaks.every((p) => p >= A.CFG.chime.gain * 0.6), 'chime peaks: ' + peaks);
  const n0 = c.nodes.length; assert.strictEqual(a.blip(), true); assert(c.nodes.length > n0, 'blip must make a sound'); a.disable(); const n1 = c.nodes.length;
  assert.strictEqual(a.blip(), false); assert.strictEqual(a.chime(), false); assert.strictEqual(c.nodes.length, n1, 'off = silent');
});
t('autoplay: a context the browser leaves suspended is reported as not running and unlock() resumes it on a later gesture', () => {
  let c, states = []; const a = A.create({ ctxFactory: () => { c = new FakeCtx(); c.allowResume = false; return c; }, onState: (s) => states.push(s) });
  a.enable(); assert.strictEqual(a.state().on, true); assert.strictEqual(a.state().running, false, 'must not claim to be running while suspended'); assert.strictEqual(a.state().ctxState, 'suspended');
  const before = c.resumed; a.unlock(); assert.strictEqual(c.resumed, before + 1, 'unlock must retry resume()'); assert.strictEqual(a.state().running, false);
  c.allowResume = true; a.unlock(); assert.strictEqual(a.state().running, true, 'after a real gesture it runs'); const r = c.resumed; a.unlock(); assert.strictEqual(c.resumed, r, 'no needless resume() once running');
  assert(states.includes('running'), 'the UI must be told when the state changes: ' + states);
});
t('helpers: thinner is a proper token bucket; masterGain taper', () => {
  let now = 0; const th = L.makeThinner(2, 1, () => now); assert(th.take()); assert(!th.take()); now = 0.4; assert(!th.take()); now = 0.55; assert(th.take());
  assert.strictEqual(L.masterGain(0.5, 0.5), 0.125); assert.strictEqual(L.masterGain(2, 0.5), 0.5); assert.strictEqual(L.masterGain(-1, 0.5), 0);
});
console.log(ok + ' audio tests passed');
