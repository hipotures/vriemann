// A fake AudioContext that records every call (used by test_audio.js and smoke_app.js)
class Param { constructor(v = 0) { this.value = v; this.calls = []; }
  setValueAtTime(v, tm) { this.calls.push(['set', v, tm]); return this; } exponentialRampToValueAtTime(v, tm) { this.calls.push(['exp', v, tm]); return this; }
  linearRampToValueAtTime(v, tm) { this.calls.push(['lin', v, tm]); return this; } setTargetAtTime(v, tm, tau) { this.calls.push(['target', v, tm, tau]); return this; }
  cancelScheduledValues(tm) { this.calls.push(['cancel', tm]); return this; } }
class Node { constructor(kind) { this.kind = kind; this.out = []; this.started = null; this.stopped = null; }
  connect(d) { this.out.push(d); return d; } disconnect() {} start(tm) { this.started = tm === undefined ? 0 : tm; } stop(tm) { this.stopped = tm; } }
class FakeCtx {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000; this.destination = new Node('dest'); this.nodes = []; this.resumed = 0;
    this.listener = { positionX: new Param(), positionY: new Param(), positionZ: new Param(), forwardX: new Param(), forwardY: new Param(), forwardZ: new Param(), upX: new Param(), upY: new Param(), upZ: new Param() }; }
  mk(kind, params) { const n = new Node(kind); for (const [k, v] of Object.entries(params || {})) n[k] = new Param(v); this.nodes.push(n); return n; }
  createGain() { return this.mk('gain', { gain: 1 }); }
  createOscillator() { return this.mk('osc', { frequency: 440, detune: 0 }); }
  createBiquadFilter() { return this.mk('biquad', { frequency: 350, Q: 1 }); }
  createDynamicsCompressor() { return this.mk('comp', { threshold: -24, ratio: 12 }); }
  createConvolver() { return this.mk('conv'); }
  createPanner() { return this.mk('panner', { positionX: 0, positionY: 0, positionZ: 0 }); }
  createBuffer(ch, n) { return { getChannelData: () => new Float32Array(n) }; }
  resume() { this.resumed++; if (this.allowResume !== false) { this.state = 'running'; if (this.onstatechange) this.onstatechange(); } return Promise.resolve(); }
  of(kind) { return this.nodes.filter((n) => n.kind === kind); }
}
module.exports = { Param, Node, FakeCtx };
