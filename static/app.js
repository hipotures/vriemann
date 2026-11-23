/* VRiemann – 3D / VR viewer of the RH proof replay.  A-Frame shell + one THREE.Points cloud + canvas panels. */
(function () {
  'use strict';
  const showErr = (m) => { const el = document.getElementById('loading'); if (el) { el.style.color = '#ff8a8a'; el.textContent = 'error: ' + m; } };
  window.addEventListener('error', (e) => showErr(e.message));
  window.addEventListener('unhandledrejection', (e) => showErr(String(e.reason && e.reason.message || e.reason)));
  const L = window.RHLib;
  const THREE = AFRAME.THREE;

  // ------------------------------------------------------------------ state
  const S = {
    layout: 'tower', builtNow: new Set(), links: 'fibers', layoutTarget: 'tower', layouts: {}, layoutLoading: false, layoutError: '', morph: null, glow: 1, fov: 80, bringPrev: null, glowAuto: false, frameMs: 0, slowMs: 0, yawTarget: null, ys: { v: 0 }, decls: [], hoverSat: -1, hand: 'right', scale: 0.08, grab: null, uiHidden: false, followTarget: -1, fs: { v: 0 }, nodeDist: { right: null, left: null }, lastNodeDist: null,
    n: 0, meta: null, pos: null, depth: null, ns: null, pk: null, ids: null, names: null, nameIdx: null,
    csr: null, st: null, stF: null, hiF: null,
    view: 'tower', color: 0, hideOpen: false, closureOn: true, closureOnly: false, follow: false, followStill: false, mini: false,
    sel: -1, selPk: -1, hover: -1, hoverPk: -1, hoverBtn: null, ancestors: 0, impCur: 0, conCur: 0,
    live: new Map(), dirtyState: false, lastUpload: 0, focus: 10, focusTarget: null,
    ax: { lx: 0, ly: 0, rx: 0, ry: 0 }, keys: { up: false, down: false },
    status: null, logLines: [], packetLines: [], pkStats: null,
    src: { name: '', tok: null, scroll: 0, loading: false, error: '', red: null, bytes: 0, lines: 0 },
  };
  // ------------------------------------------------------------------ sound (procedural, off until the user switches it on)
  let sound = null;
  const loadVolume = () => { try { const v = parseFloat(localStorage.getItem('rh.volume')); return v >= 0 && v <= 1 ? v : null; } catch (e) { return null; } };
  const saveVolume = (v) => { try { localStorage.setItem('rh.volume', String(v)); } catch (e) { /* private window */ } };
  // ------------------------------------------------------------------ glow: 0 off, 1 halo on built/active dots, 2 also a faint halo on open ones
  const GLOW = { strength: 0.22, open: 0.08, scale: 2.4, pk: 0.8 };
  const loadLinks = () => { try { const v = localStorage.getItem('rh.links'); return v === 'tubes' || v === 'fibers' ? v : null; } catch (e) { return null; } };
  const loadGlow = () => { try { const v = parseInt(localStorage.getItem('rh.glow'), 10); return v >= 0 && v <= 2 ? v : null; } catch (e) { return null; } };
  function applyGlow() {
    if (!ptsHalo) return;
    const on = S.glow > 0;
    ptsHalo.visible = on && S.view === 'tower'; pkHalo.visible = on && S.view === 'packets';
    ptsHalo.material.uniforms.uGlow.value = GLOW.strength; ptsHalo.material.uniforms.uGlowOpen.value = S.glow === 2 ? GLOW.open : 0;
    pkHalo.material.uniforms.uGlow.value = GLOW.pk;
  }
  function cycleGlow() {
    S.glowAuto = false; S.glow = (S.glow + 1) % 3; try { localStorage.setItem('rh.glow', String(S.glow)); } catch (e) { /* private window */ }
    applyGlow(); if (panels.menu) panels.menu.dirty = true;
  }
  // ------------------------------------------------------------------ layouts: the tower (rings) or an N-fold helix; positions morph smoothly between them
  const LAYOUTS = ['tower', 'helix2', 'helix4', 'helix8', 'spine'], LAYOUT_LABEL = { tower: 'tower', helix2: 'helix ×2', helix4: 'helix ×4', helix8: 'helix ×8', spine: 'spine' }, MORPH_SEC = 1.6;
  async function ensureLayout(name) {
    if (S.layouts[name]) return S.layouts[name];
    let a, sp;
    try {
      [a, sp] = await Promise.all([bget('/data/pos_' + name + '.f32'), name === 'spine' && !spine ? Promise.all([jget('/data/spine.json'), bget('/data/spine.bin')]) : null]);
    } catch (e) {
      if (name === 'spine') { S.spineMissing = true; throw new Error('no spine data – run build_spine.py (' + (e.message || e) + ')'); }   // L skips it from now on
      throw e;
    }
    a = new Float32Array(a);
    if (a.length !== S.n * 3) throw new Error('layout ' + name + ' has the wrong size');
    if (sp) buildSpine(sp[0], new Uint8Array(sp[1]));
    return (S.layouts[name] = a);
  }
  function recomputePacketCentroids() {
    const np = S.meta.packets, sum = new Float64Array(np * 3), cnt = new Uint32Array(np);
    for (let i = 0; i < S.n; i++) { const p = S.pk[i]; sum[3 * p] += S.pos[3 * i]; sum[3 * p + 1] += S.pos[3 * i + 1]; sum[3 * p + 2] += S.pos[3 * i + 2]; cnt[p]++; }
    for (let p = 0; p < np; p++) { const c = Math.max(1, cnt[p]); S.pkPos[3 * p] = sum[3 * p] / c; S.pkPos[3 * p + 1] = sum[3 * p + 1] / c; S.pkPos[3 * p + 2] = sum[3 * p + 2] / c; }
    pkPts.geometry.attributes.position.needsUpdate = true;
  }
  async function setLayout(name) {
    if (!LAYOUTS.includes(name) || S.layoutLoading) return;
    if (name === S.layout && !S.morph) { S.layoutTarget = name; return; }
    S.layoutTarget = name; S.layoutLoading = true; S.layoutError = ''; if (panels.menu) panels.menu.dirty = true;
    try {
      const to = await ensureLayout(name);
      S.morph = { from: S.pos.slice(), to, t: 0, name };           // from the positions as drawn right now, so an interrupted morph does not jump
      hideLinks(); hoverMark.visible = false;
    } catch (e) { S.layoutError = String(e.message || e); S.layoutTarget = S.layout; }
    S.layoutLoading = false; if (panels.menu) panels.menu.dirty = true;
  }
  function cycleLayout() {
    const list = LAYOUTS.filter((x) => !(x === 'spine' && S.spineMissing));       // the spine needs build_spine.py (and the Lean volume) once
    setLayout(list[(list.indexOf(S.layoutTarget) + 1) % list.length]);
  }

  // ------------------------------------------------------------------ the spine layout: the proof as a lightning tree (build_spine.py)
  // trunk = a chain of declarations from riemannHypothesis down, each named in the proof of the previous one; branches = lemmas each step
  // names (sampled, up to 4 levels); dust = modules the tree never reaches (dimmed).  The modules themselves move like in any other layout
  // (a module sits on its first node); on top of them one additive ribbon mesh draws the tree, with a flash running down it now and then.
  const SPINE = { halo: 3.0, minPx: 1.6, flashSec: 14, labelH: 0.13, labelEvery: 6, labelsLv1: 10 };
  let spine = null;
  const SPINE_V = `
    attribute vec3 aTan; attribute float aSide, aT, aG, aW, aLv;
    uniform float uWorldScale, uMinPx, uHalo;
    varying float vSide, vT, vG, vLv;
    void main(){
      vec4 mv = modelViewMatrix*vec4(position, 1.);
      vec3 tv = normalize(mat3(modelViewMatrix)*aTan);
      vec3 sv = cross(tv, normalize(mv.xyz)); float sl = length(sv); sv = sl > 1e-4 ? sv/sl : vec3(1., 0., 0.);   // across, facing the eye
      float w = max(aW*uHalo*uWorldScale, uMinPx*max(-mv.z, .05)/(projectionMatrix[1][1]*500.));
      mv.xyz += sv*aSide*w;
      vSide = aSide; vT = aT; vG = aG; vLv = aLv;
      gl_Position = projectionMatrix*mv;
    }`;
  // a wide violet haze, a pink body and a thin white-hot core (the trunk's core is the brightest), all additive: where branches cross
  // they add up to white, like the poster.  A flash runs down the whole tree every SPINE.flashSec seconds; the trunk flickers a little.
  const SPINE_F = `
    uniform float uTime, uAlpha, uFlashSec;
    varying float vSide, vT, vG, vLv;
    void main(){
      float s2 = vSide*vSide, trunk = 1. - step(.5, vLv);
      float core = exp(-s2*45.), body = exp(-s2*9.), haze = exp(-s2*2.2);
      float x = fract(uTime/uFlashSec)*1.6 - .3, flash = exp(-pow((vG - x)*10., 2.));
      float flick = mix(1., .82 + .18*sin(uTime*23. + vG*97.), trunk);
      float tip = trunk > .5 ? 1. : 1. - .5*vT;
      float ends = smoothstep(0., .04, vT) + trunk;                                // branches grow out of the trunk, no blob at the joint
      vec3 col = vec3(.50, .26, .92)*haze*.30 + vec3(1., .36, 1.)*body*(.45 + .25*trunk) + vec3(1., .92, 1.)*core*(.30 + .95*trunk);
      col *= tip*flick*(1. + 1.6*flash)*min(ends, 1.);
      gl_FragColor = vec4(col, uAlpha);
    }`;
  function buildSpine(js, r) {
    if (r.length !== S.n) throw new Error('spine.bin has the wrong size');
    const b = L.buildSpine(js.nodes), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3)); g.setAttribute('aTan', new THREE.BufferAttribute(b.tan, 3));
    for (const [k, a] of [['aSide', b.side], ['aT', b.t], ['aG', b.g], ['aW', b.w], ['aLv', b.lv]]) g.setAttribute(k, new THREE.BufferAttribute(a, 1));
    g.setIndex(new THREE.BufferAttribute(b.index, 1));
    const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: SPINE_V, fragmentShader: SPINE_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uWorldScale: { value: 1 }, uMinPx: { value: SPINE.minPx }, uHalo: { value: SPINE.halo }, uFlashSec: { value: SPINE.flashSec } } }));
    mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.visible = false; world.add(mesh);
    // labels: the root, every few trunk steps, and a few first-level branches; sprites (they face the viewer, in VR too)
    const labels = new THREE.Group(); labels.visible = false; world.add(labels);
    const T = b.trunkSteps, pick = [];
    for (let k = 0; k < T; k++) if (k < 2 || k % SPINE.labelEvery === 0 || k === T - 1) pick.push(k);
    const lv1 = js.nodes.map((nd, k) => k).filter((k) => js.nodes[k].lv === 1);
    for (let j = 0; j < SPINE.labelsLv1 && lv1.length; j++) pick.push(lv1[Math.floor((j + 0.5) * lv1.length / SPINE.labelsLv1)]);
    const mkLabel = (text, color, h, lines) => {
      lines = lines || [text]; const cv = document.createElement('canvas'), fs = 40, pad = 8, cx = cv.getContext('2d');
      cx.font = `${fs}px ${MONO}`; const tw = Math.max(...lines.map((l) => cx.measureText(l).width));
      cv.width = Math.ceil(tw + 2 * pad); cv.height = lines.length * (fs + 8) + 2 * pad;
      cx.font = `${fs}px ${MONO}`; cx.fillStyle = color; cx.textBaseline = 'top'; lines.forEach((l, i) => cx.fillText(l, pad, pad + i * (fs + 8)));
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }));
      const k = h / (fs + 8); sp.scale.set(k * cv.width, k * cv.height, 1); sp.center.set(0, 0.5);     // h = height of one line
      sp.userData.text = lines.join('\n'); return sp;
    };
    for (const k of pick) {
      const nd = js.nodes[k], sp = mkLabel(nd.n, nd.lv === 0 ? '#ffe6ff' : '#d9b8ff', SPINE.labelH * (nd.lv === 0 ? 1 : 0.8));
      sp.position.set(nd.p[0] + 0.12, nd.p[1], nd.p[2]); sp.userData.node = k; labels.add(sp);
    }
    if (T) {
      const top = js.nodes[0].p, leg = mkLabel('', '#b9a3d9', SPINE.labelH * 0.7, [`trunk = ${T}-step proof spine from ${js.nodes[0].n}`, 'branches = sampled lemmas each step names', 'dust = modules never reached']);
      leg.position.set(top[0] + 0.12, top[1] + 1.2, top[2]); leg.userData.legend = true; labels.add(leg);
    }
    const sa = pts.geometry.attributes.aSpine; for (let i = 0; i < r.length; i++) sa.array[i] = r[i]; sa.needsUpdate = true;
    spine = { mesh, labels, steps: T, nodes: js.nodes.length, reached: r.reduce((a, x) => a + x, 0), root: js.root };
    return spine;
  }
  /** how much of the spine is shown: 1 in the spine layout, 0 elsewhere, cross-fading with the morph; only in the tower view */
  function spineAmount() {
    const m = S.morph; let a = S.layout === 'spine' ? 1 : 0;
    if (m) { const e = m.t * m.t * (3 - 2 * m.t); a = m.name === 'spine' ? Math.max(a * (1 - e), e) : a * (1 - e); }
    return S.view === 'tower' ? a : 0;
  }
  function spineTick(t) {
    const a = spineAmount();
    ptsMat.uniforms.uSpine.value = spine ? a : 0;
    for (const m of rulers) m.visible = !S.uiHidden && a < 0.5;                     // "depth 25" means nothing in the spine
    if (!spine) return;
    const u = spine.mesh.material.uniforms; u.uAlpha.value = a; u.uTime.value = t / 1000; u.uWorldScale.value = world.scale.x;
    spine.mesh.visible = a > 0.002; spine.labels.visible = a > 0.002 && !S.uiHidden;
    for (const sp of spine.labels.children) sp.material.opacity = a * (sp.userData.legend ? 0.8 : 0.95);
  }
  function morphTick(dt) {
    const m = S.morph; if (!m) return;
    m.t = Math.min(1, m.t + dt / MORPH_SEC); const e = m.t * m.t * (3 - 2 * m.t), P = S.pos, A = m.from, B = m.to;
    for (let k = 0; k < P.length; k++) P[k] = A[k] + (B[k] - A[k]) * e;
    pts.geometry.attributes.position.needsUpdate = true; syncSolidCenters();
    if (m.t >= 1) {
      P.set(B); S.layout = m.name; S.morph = null; recomputePacketCentroids();
      if (S.sel >= 0) select(S.sel, true);                              // lines and markers again, at the new positions
      if (panels.menu) panels.menu.dirty = true;
    }
  }
  function toggleSound() { if (!sound) return; sound.toggle(); panels.menu.dirty = true; }
  function nudgeVolume(d) { if (!sound) return; const v = sound.setVolume(Math.round((sound.state().volume + d) * 10) / 10); saveVolume(v); sound.blip(); panels.menu.dirty = true; }
  const unlockSound = () => { if (sound) sound.unlock(); };
  function soundModule(i) {
    if (!sound || !sound.state().on) return;
    world.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]).applyMatrix4(world.matrixWorld);
    sound.module({ depth: S.depth[i], ns: S.ns[i], pos: { x: p.x, y: p.y, z: p.z } });
  }
  function soundLoad(sys) { if (sound && sys && sys.memTotalGB) sound.setLoad(sys.cpu / 100, sys.memUsedGB / sys.memTotalGB); }
  /** a DONE line we have not seen before = one of our packets has just been finished (the first status only seeds the set) */
  function soundPacketLines(lines) {
    const done = (lines || []).filter((l) => /\bDONE\b/.test(l));
    if (!S.doneSeen) { S.doneSeen = new Set(done); return; }
    let fresh = false; for (const l of done) if (!S.doneSeen.has(l)) { S.doneSeen.add(l); fresh = true; }
    if (fresh && sound) sound.packetDone();
  }
  const NODE_COLORS = { open: '#4d5566', assigned: '#598cff', done: '#40d973', ours: '#ffd133', live: '#ff6619' };
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ data loading
  const jget = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const bget = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); });

  async function loadAll() {
    const set = (t) => { const el = $('loading'); if (el) el.textContent = t; };
    const TOTAL = 9; let done = 0;
    const get = async (u, kind) => {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 90000);
      set(`loading data ${done}/${TOTAL} … ${u}`);
      try {
        const r = await fetch(u, { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = kind === 'json' ? await r.json() : kind === 'text' ? await r.text() : await r.arrayBuffer();
        done++; set(`loading data ${done}/${TOTAL} …`);
        return body;
      } catch (e) {
        throw new Error(u + ': ' + (e.name === 'AbortError' ? 'timeout after 90 s' : e.message) + (e instanceof SyntaxError ? ' (got a non-JSON page – login/redirect from the proxy?)' : ''));
      } finally { clearTimeout(to); }
    };
    const [meta, pos, depth, ns, pk, edges, pc, names, st] = await Promise.all([
      get('/data/meta.json', 'json'), get('/data/pos.f32'), get('/data/depth.u8'), get('/data/ns.u8'), get('/data/packet.u16'),
      get('/data/edges.u32'), get('/data/packet_centroid.f32'), get('/data/names.txt.gz', 'text'), get('/api/state'),
    ]);
    S.meta = meta; S.n = meta.modules;
    S.pos = new Float32Array(pos); S.depth = new Uint8Array(depth); S.ns = new Uint8Array(ns); S.pk = new Uint16Array(pk);
    S.pkPos = new Float32Array(pc);
    set('indexing…');
    const lines = names.split('\n');
    S.ids = new Array(S.n); S.names = new Array(S.n); S.nameIdx = new Map();
    for (let i = 0; i < S.n; i++) { const t = lines[i].indexOf('\t'); S.ids[i] = lines[i].slice(0, t); S.names[i] = lines[i].slice(t + 1); S.nameIdx.set(S.names[i], i); }
    S.csr = L.buildCSR(S.n, new Uint32Array(edges));
    S.st = new Uint8Array(st);
    S.focus = 100 * meta.yStep; S.layouts.tower = S.pos.slice();
    return true;
  }

  // ------------------------------------------------------------------ shaders
  const VERT = `
    uniform float uSize, uTime, uMode, uHideOpen, uHiOn, uScale, uHiA, uHiS, uHiOnly, uSpine;
    attribute float aState, aNs, aDepth, aHi, aSolid, aSpine;
    varying vec3 vCol; varying float vA;
    vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
    void main(){
      if (aSolid > .5) { gl_Position = vec4(2.,2.,2.,1.); gl_PointSize = 0.; vCol = vec3(0.); vA = 0.; return; }   // drawn as a real 3D bubble (SOLID) instead
      vec4 mv = modelViewMatrix*vec4(position,1.);
      float st = aState, size = uSize*uScale, a = 1.; vec3 col;
      if (uMode < .5) {
        if (st < .5)      { col = vec3(.42,.47,.58); a = .65; }
        else if (st < 1.5){ col = vec3(.35,.55,1.);  a = .85; }
        else if (st < 2.5){ col = vec3(.25,.85,.45); a = .90; }
        else if (st < 3.5){ col = vec3(1.,.82,.20);  a = 1.;  size *= 1.35; }
        else { float p=.5+.5*sin(uTime*9.); col = mix(vec3(1.,.40,.10),vec3(1.),p); size *= 2.4+1.6*p; a = 1.; }
      } else if (uMode < 1.5) {
        col = hsv2rgb(vec3(fract(aNs*.61803),.65,.95)); a = st < .5 ? .7 : .95;
        if (st > 3.5) { col = vec3(1.); size *= 2.5; }
      } else {
        col = .5+.5*cos(6.28318*(vec3(aDepth)+vec3(0.,.33,.67))); a = st < .5 ? .7 : .95;
        if (st > 3.5) { col = vec3(1.); size *= 2.5; }
      }
      if (uSpine > 0.) {                                            // spine layout: reached modules glow violet, the rest is faint dust
        if (aSpine > .5) { col = mix(col, vec3(1.,.55,1.), .6*uSpine); }
        else { col = mix(col, vec3(.30,.27,.42), uSpine); a *= 1. - .6*uSpine; size *= 1. - .35*uSpine; }
      }
      if (aHi > .5) {
        if (aHi < 1.5) col = vec3(0.,1.,1.); else if (aHi < 2.5) col = vec3(1.,.3,.9); else { col = vec3(1.); size *= 3.; }
        if (aHi < 1.5) { a = uHiA; size *= 1.7*uHiS; } else { a = 1.; size *= 1.7; }   // ancestry is dimmed when it is huge; consumers/selection stay full
      } else if (uHiOn > .5) {
        if (uHiOnly > .5) { gl_Position = vec4(2.,2.,2.,1.); gl_PointSize = 0.; vCol = col; vA = 0.; return; }   // Closure: only -> everything else disappears
        a *= .22;
      }
      if (uHideOpen > .5 && st < .5 && aHi < .5) { gl_Position = vec4(2.,2.,2.,1.); gl_PointSize = 0.; vCol = col; vA = 0.; return; }
      gl_Position = projectionMatrix*mv;
      gl_PointSize = clamp(size*projectionMatrix[1][1]*500./max(-mv.z,.05), 2.2, 26.);
      vCol = col; vA = a;
    }`;
  // each point sprite is shaded as a sphere: normal from the position inside the sprite, one light from the upper left
  const FRAG = `
    varying vec3 vCol; varying float vA;
    void main(){
      vec2 p = (gl_PointCoord - .5)*2.;
      float r2 = dot(p, p); if (r2 > 1.) discard;
      float z = sqrt(1. - r2);
      vec3 n = vec3(p.x, -p.y, z);                                 // gl_PointCoord.y grows downwards
      vec3 Ld = normalize(vec3(-.45, .6, .65));
      float diff = max(dot(n, Ld), 0.);
      float spec = pow(max(dot(reflect(-Ld, n), vec3(0., 0., 1.)), 0.), 22.)*.45;
      float rim = pow(1. - z, 2.)*.25;
      vec3 c = vCol*(.30 + .90*diff + rim) + vec3(spec);
      float edge = 1. - smoothstep(.80, 1., r2);
      float alpha = vA*edge;
      gl_FragColor = vec4(c, alpha);
    }`;
  window.__fragSrc = FRAG;   // exposed only so the smoke test can check the shader text
  const PK_VERT = `
    uniform float uScale;
    attribute float aFrac, aOursFrac, aSz;
    varying vec3 vCol;
    void main(){
      vec4 mv = modelViewMatrix*vec4(position,1.);
      vec3 grey = vec3(.32,.36,.46), green = vec3(.25,.85,.45), gold = vec3(1.,.82,.2);
      vCol = mix(grey, green, aFrac); vCol = mix(vCol, gold, clamp(aOursFrac*1.5,0.,1.));
      gl_Position = projectionMatrix*mv;
      gl_PointSize = clamp(.16*aSz*uScale*projectionMatrix[1][1]*500./max(-mv.z,.05), 3., 60.);
    }`;
  const PK_FRAG = `
    varying vec3 vCol;
    void main(){ vec2 d = gl_PointCoord-.5; float r = dot(d,d); if (r > .25) discard; gl_FragColor = vec4(vCol*(1.-1.2*r), .92); }`;

  /** same colour logic as the dots, but bigger, soft (gaussian) and additive; open dots only get a halo on the "all" level */
  function derive(src, pairs) { let o = src; for (const [a, b] of pairs) { if (!o.includes(a)) throw new Error('shader derivation failed: ' + a.slice(0, 50)); o = o.replace(a, b); } return o; }
  const HALO_VERT = derive(VERT, [
    ['uniform float uSize, uTime, uMode, uHideOpen, uHiOn, uScale, uHiA, uHiS, uHiOnly, uSpine;', 'uniform float uSize, uTime, uMode, uHideOpen, uHiOn, uScale, uHiA, uHiS, uHiOnly, uSpine, uGlow, uGlowOpen, uHaloScale;'],
    ['if (uHideOpen > .5 && st < .5 && aHi < .5) {', 'if ((uHideOpen > .5 || uGlowOpen <= 0.) && st < .5 && aHi < .5) {'],
    ['size*projectionMatrix[1][1]*500./max(-mv.z,.05), 2.2, 26.)', 'size*uHaloScale*projectionMatrix[1][1]*500./max(-mv.z,.05), 4., 28.)'],
    ['vCol = col; vA = a;\n    }', 'vCol = col; vA = a*((st < .5 && aHi < .5) ? uGlowOpen : uGlow);\n    }'],
  ]);
  const HALO_FRAG = `varying vec3 vCol; varying float vA;
    void main(){ vec2 d = gl_PointCoord-.5; float r2 = dot(d,d)*4.; if (r2 > 1.) discard; float gk = exp(-r2*5.); gl_FragColor = vec4(vCol, vA*gk); }`;
  const PK_HALO_VERT = derive(PK_VERT, [
    ['attribute float aFrac, aOursFrac, aSz;', 'attribute float aFrac, aOursFrac, aSz; uniform float uGlow;'],
    ['gl_PointSize = clamp(.16*aSz*uScale*projectionMatrix[1][1]*500./max(-mv.z,.05), 3., 60.);', 'gl_PointSize = clamp(.16*aSz*2.8*uScale*projectionMatrix[1][1]*500./max(-mv.z,.05), 8., 120.);'],
  ]);
  const PK_HALO_FRAG = `uniform float uGlow; varying vec3 vCol;
    void main(){ vec2 d = gl_PointCoord-.5; float r2 = dot(d,d)*4.; if (r2 > 1.) discard; float gk = exp(-r2*5.); gl_FragColor = vec4(vCol, .55*uGlow*gk); }`;

  // ------------------------------------------------------------------ 3D bubbles: the connected (imports / consumers) and compiling modules
  // are real instanced ellipsoids, not sprites: they have depth, can be cut by a controller, and wobble in all three axes like soap bubbles.
  // Up to SOLID.max of them (live ones first, then the connected nearest to the selection); the rest stay plain dots.
  const SOLID = { max: 4000, segs: 24, rings: 16, minPx: 1.1, wobble: 0.22, tempo: 1.0, liveSize: 0.45 };   // liveSize: compiling bubbles (G) relative to the old pulsing dot; 0.45 = never bigger than ~1.1x an import bubble      // tempo: 1 = shape periods ~5-16 s, compiling beat ~2-3.5 s
  const SOLID_V = `
    attribute vec3 aCenter; attribute float aKind, aSeed;
    uniform float uTime, uSize, uScale, uWorldScale, uHiA, uHiS, uMinPx, uWobble, uTempo, uLiveSize;
    varying vec3 vN, vV, vCol; varying float vA, vSeed;
    void main(){
      float h = aSeed, h2 = fract(h*13.37), h3 = fract(h*71.11);                              // independent per-bubble randoms
      // each axis its own tempo (period ~5..16 s at uTempo 1), phase and depth: neighbours never breathe in step
      float T = uTime*uTempo;
      vec3 fq = .4 + .85*fract(h*vec3(3.17, 5.71, 9.13));
      vec3 ax = 1. + uWobble*(.5 + h2)*sin(T*fq + 6.2832*fract(h*vec3(1., 17.3, 29.9)));
      ax /= pow(ax.x*ax.y*ax.z, 1./3.);                                                    // volume kept: squeezed one way, bulging another
      float a1 = T*(.10 + .15*h) + 6.2832*h, a2 = T*(.07 + .12*fract(h*7.)) + 3.*h;           // slow tumble
      mat3 Ry = mat3(cos(a1), 0., -sin(a1), 0., 1., 0., sin(a1), 0., cos(a1));
      mat3 Rx = mat3(1., 0., 0., 0., cos(a2), sin(a2), 0., -sin(a2), cos(a2));
      mat3 R = Ry*Rx;
      vec3 e = R*(position*ax), nl = R*(normal/ax);                                       // ellipsoid normal = n / axes
      vec3 col; float s, a = 1.;
      if (aKind < 1.5) { col = vec3(0., 1., 1.); s = 1.7*uHiS; a = uHiA; }
      else if (aKind < 2.5) { col = vec3(1., .3, .9); s = 1.7; }
      else { float p = .5 + .5*sin(T*(1.8 + 1.3*h3) + 6.2832*h2); col = mix(vec3(1., .40, .10), vec3(1.), p); s = uLiveSize*(2.4 + 1.6*p); }   // compiling: own beat each, ~2-3.5 s
      s *= 1.1 + .10*sin(T*(.45 + .6*h3) + 6.2832*h2);                                         // slow breath, ~6-14 s
      vec4 c = modelViewMatrix*vec4(aCenter, 1.);
      float r = max(.5*uSize*uScale*s, uMinPx*max(-c.z, .05)/(projectionMatrix[1][1]*500.));   // same size as the dot it replaces, never below ~2 px
      mat3 mvr = mat3(modelViewMatrix)/max(uWorldScale, 1e-4);                             // rotation only: the radius is already in view units
      vec4 mv = vec4(c.xyz + mvr*e*r, 1.);
      vN = normalize(mvr*nl); vV = normalize(-mv.xyz); vCol = col; vA = a; vSeed = h;
      gl_Position = projectionMatrix*mv;
    }`;
  const SOLID_F = `
    varying vec3 vN, vV, vCol; varying float vA, vSeed;
    void main(){
      vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
      float ndv = abs(dot(n, normalize(vV)));
      vec3 Ld = normalize(vec3(-.45, .6, .65));
      float diff = max(dot(n, Ld), 0.);
      float spec = pow(max(dot(reflect(-Ld, n), normalize(vV)), 0.), 22.)*.45;
      float rk = pow(1. - ndv, 1.6);                                                       // thin film: see-through middle, bright rim
      vec3 irid = .5 + .5*cos(6.2832*(vec3(0., .33, .67) + ndv*1.3 + vSeed));
      vec3 c = mix(vCol, irid, .30*rk)*(.55 + .60*diff) + vCol*rk*.9 + vec3(spec)*1.4;
      gl_FragColor = vec4(c, clamp(vA*(.30 + .70*rk) + spec*.5, 0., 1.));
    }`;

  // ------------------------------------------------------------------ canvas panels
  const MONO = '"DejaVu Sans Mono","Noto Sans Mono",Menlo,Consolas,monospace';
  const SRC_FONT = '"Iosevka Fixed VR",' + MONO;        // narrow code font for the source panel (vendored woff2, loaded in index.html)
  const SANS = 'system-ui,"Segoe UI",Roboto,sans-serif';
  const panels = {};
  const PANEL_RENDER_ORDER = 100;
  class Panel {
    constructor(name, wM, hM, pw, ph, paint) {
      this.name = name; this.pw = pw; this.ph = ph; this.paint = paint; this.buttons = []; this.dirty = true;
      this.canvas = document.createElement('canvas'); this.canvas.width = pw; this.canvas.height = ph;
      this.ctx = this.canvas.getContext('2d');
      this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 4;
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM),
        new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthTest: false, depthWrite: false }));
      // UI is drawn LAST and on top, like a HUD.  Without this the order relative to the 175k-dot cloud was decided by comparing object centres,
      // so it flipped as you moved: sometimes dots were painted over a panel, sometimes not.
      this.mesh.renderOrder = PANEL_RENDER_ORDER;
      this.mesh.userData.panel = this;
      panels[name] = this;
    }
    redraw() {
      this.dirty = false; this.buttons = [];
      const c = this.ctx; c.clearRect(0, 0, this.pw, this.ph);
      c.fillStyle = 'rgba(10,14,24,.93)'; roundRect(c, 0, 0, this.pw, this.ph, 28); c.fill();
      c.strokeStyle = 'rgba(120,150,210,.45)'; c.lineWidth = 3; roundRect(c, 1.5, 1.5, this.pw - 3, this.ph - 3, 28); c.stroke();
      this.paint(c, this);
      this.tex.needsUpdate = true;
    }
    button(c, x, y, w, h, label, fn, active) {
      const hov = S.hoverBtn && S.hoverBtn.panel === this && S.hoverBtn.label === label;
      c.fillStyle = active ? 'rgba(60,130,255,.85)' : hov ? 'rgba(90,110,160,.9)' : 'rgba(40,50,75,.9)';
      roundRect(c, x, y, w, h, 14); c.fill();
      c.strokeStyle = hov ? '#fff' : 'rgba(150,170,220,.5)'; c.lineWidth = hov ? 3 : 1.5; roundRect(c, x, y, w, h, 14); c.stroke();
      c.fillStyle = '#e8eefc'; c.font = `600 ${Math.min(30, h * .42)}px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, x + w / 2, y + h / 2 + 1);
      this.buttons.push({ x, y, w, h, label, fn, panel: this });
    }
    hit(u, v) {
      const px = u * this.pw, py = (1 - v) * this.ph;
      for (const b of this.buttons) if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b;
      return null;
    }
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function text(c, s, x, y, o) {
    o = o || {};
    c.font = `${o.weight || 400} ${o.size || 26}px ${o.font || SANS}`; c.fillStyle = o.color || '#cbd5e1';
    c.textAlign = o.align || 'left'; c.textBaseline = o.base || 'alphabetic'; c.fillText(s, x, y);
  }
  const fitLeft = (c, s, w) => { if (c.measureText(s).width <= w) return s; while (s.length > 4 && c.measureText('…' + s).width > w) s = s.slice(1); return '…' + s; };
  /** shrink a dotted module name to width w: abbreviate leading components to their initial, keep the distinctive tail */
  const abbrev = (c, name, w) => { const k = name.split('.'); for (let i = 0; i < k.length - 2 && c.measureText(k.join('.')).width > w; i++) k[i] = k[i][0]; return fitLeft(c, k.join('.'), w); };
  const fit = (c, s, w) => { if (c.measureText(s).width <= w) return s; while (s.length > 4 && c.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; };

  // ---- menu panel
  function paintMenu(c, p) {
    const st = S.status, cnt = st ? st.counts : { open: 0, assigned: 0, done: 0, ours: 0 };
    text(c, 'Alpöge RH replay', 40, 68, { size: 46, weight: 700, color: '#fff' });
    text(c, `${L.fmt(S.n)} modules · ${L.fmt(S.meta.edges)} imports · ${S.meta.packets} packets`, 40, 108, { size: 24, color: '#93a4c3' });
    // progress bar
    const bx = 40, by = 134, bw = 820, bh = 34, tot = S.n || 1;
    c.fillStyle = '#1b2233'; roundRect(c, bx, by, bw, bh, 10); c.fill();
    let x = bx;
    for (const [v, col] of [[cnt.done, '#40d973'], [cnt.ours, '#ffd133'], [cnt.assigned, '#598cff']]) {
      const w = bw * v / tot; c.fillStyle = col; c.fillRect(x, by, Math.max(w, v ? 2 : 0), bh); x += w;
    }
    text(c, `built ${L.fmt(cnt.done + cnt.ours)} (${L.pct(cnt.done + cnt.ours, tot)}) · by us ${L.fmt(cnt.ours)}`, 40, 206, { size: 26, color: '#e8eefc' });
    const ph = phaseOf(st);
    c.fillStyle = PHASE_COLOR[ph.kind] || '#6b7280'; c.beginPath(); c.arc(52, 240, 10, 0, 7); c.fill();
    c.font = `22px ${MONO}`; text(c, fit(c, ph.text, 790), 74, 248, { size: 22, font: MONO, color: ph.kind === 'stopped' ? '#ff8a8a' : '#aab6d3' });

    let y = 290;
    text(c, 'VIEW', 40, y, { size: 20, color: '#7283a6', weight: 700 });
    p.button(c, 40, y + 12, 260, 64, 'Modules', () => setView('tower'), S.view === 'tower');
    p.button(c, 320, y + 12, 260, 64, 'Packets', () => setView('packets'), S.view === 'packets');
    p.button(c, 600, y + 12, 260, 64, S.layoutLoading ? 'Layout: loading…' : S.layoutError ? 'Layout: failed' : 'Layout: ' + LAYOUT_LABEL[S.layoutTarget], cycleLayout, S.layoutTarget !== 'tower');
    y += 110;
    text(c, 'COLOR', 40, y, { size: 20, color: '#7283a6', weight: 700 });
    ['State', 'Namespace', 'Depth'].forEach((l, i) => p.button(c, 40 + i * 280, y + 12, 260, 64, l, () => setColor(i), S.color === i));
    y += 110;
    text(c, 'OPTIONS', 40, y, { size: 20, color: '#7283a6', weight: 700 });
    p.button(c, 40, y + 12, 260, 64, 'Hide open', () => { S.hideOpen = !S.hideOpen; applyUniforms(); p.dirty = true; }, S.hideOpen);
    p.button(c, 320, y + 12, 260, 64, S.closureOn ? (S.closureOnly ? 'Closure: only' : 'Closure: dim') : 'Closure: off', cycleClosure, S.closureOn);
    p.button(c, 600, y + 12, 260, 64, !S.follow ? 'Follow live' : S.followStill ? 'Follow: in place' : 'Follow: camera', toggleFollow, S.follow);
    y += 90;
    p.button(c, 40, y + 12, 260, 64, S.mini ? 'Inside' : 'Miniature', toggleMini, S.mini);
    p.button(c, 320, y + 12, 260, 64, 'Recenter', recenter, false);
    p.button(c, 600, y + 12, 260, 64, 'Main.lean', () => { const i = S.nameIdx.get('Main'); if (i != null) { stopFollow(); jumpTo(i); } }, false);
    p.button(c, 40, y + 90, 190, 64, 'Size −', () => scaleMini(1 / 1.3), false);
    p.button(c, 250, y + 90, 190, 64, 'Size +', () => scaleMini(1.3), false);
    p.button(c, 460, y + 90, 190, 64, S.bringPrev ? 'Back' : 'Bring to me', bringToMe, !!S.bringPrev);
    p.button(c, 670, y + 90, 190, 64, S.links === 'tubes' ? 'Links: tubes' : 'Links: fibres', cycleLinks, S.links === 'tubes');
    const snd = sound ? sound.state() : { on: false, volume: 0 };
    const blocked = snd.on && !snd.running;
    p.button(c, 40, y + 168, 190, 64, !snd.on ? 'Sound: off' : blocked ? 'Sound: tap' : 'Sound: on', blocked ? unlockSound : toggleSound, snd.on);
    p.button(c, 250, y + 168, 190, 64, 'Vol −', () => nudgeVolume(-0.1), false);
    p.button(c, 460, y + 168, 190, 64, 'Vol +', () => nudgeVolume(0.1), false);
    p.button(c, 670, y + 168, 190, 64, ['Glow: off', 'Glow: on', 'Glow: all'][S.glow], cycleGlow, S.glow > 0);
    p.button(c, 40, y + 246, 190, 64, S.debug ? 'Debug: on' : 'Debug: off', toggleDebug, !!S.debug);
    y += 78;
    const vr = inVR();                                                    // in the headset there is no keyboard: no help lines, only warnings
    if (vr) {
      if (blocked) text(c, `Sound is BLOCKED by the browser (audio ${snd.ctxState}): pull the trigger once`, 40, y + 266, { size: 20, color: '#ffb454' });
      if (S.glowAuto) text(c, 'Glow lowered automatically: the frame rate was too low', 40, y + (blocked ? 292 : 266), { size: 20, color: '#ffb454' });
    } else {
    text(c, 'Hide open: hide dots that are not built yet', 40, y + 266, { size: 20, color: '#7f8fb3' });
    text(c, 'Closure (C): off / dim the rest / only = hide everything but the selection + its imports', 40, y + 292, { size: 20, color: '#7f8fb3' });
    text(c, 'Miniature: grip / pinch-drag moves it · stick ▲▼ = size', 40, y + 318, { size: 20, color: '#7f8fb3' });
    text(c, blocked ? `Sound is BLOCKED by the browser (audio ${snd.ctxState}): press any key / trigger / click once` : `Sound (N): bed follows CPU/RAM, a note per built module, a chord per packet · volume ${Math.round(snd.volume * 100)}%`, 40, y + 344, { size: 20, color: blocked ? '#ffb454' : '#7f8fb3' });
    text(c, S.glowAuto ? 'Glow lowered automatically: the frame rate was too low (G to raise)' : 'Glow (G): soft halo on built / active dots · "all" adds a faint one to open dots', 40, y + 370, { size: 20, color: S.glowAuto ? '#ffb454' : '#7f8fb3' });
    }
    y += vr ? 272 + (blocked ? 26 : 0) + (S.glowAuto ? 26 : 0) : 426;
    // legend
    if (S.debug) {
      text(c, 'DEBUG LABELS (I)', 40, y, { size: 20, color: '#7283a6', weight: 700 });
      DEBUG_KINDS.forEach(([l, what, col], k) => {
        const cx = 40 + (k % 2) * 420, cy = y + 30 + Math.floor(k / 2) * 30;
        text(c, l, cx, cy, { size: 22, color: col, weight: 700, font: MONO }); c.font = `18px ${SANS}`; text(c, fit(c, what, 380), cx + 26, cy, { size: 18, color: '#cbd5e1' });
      });
    } else if (S.color === 1) {
      text(c, 'NAMESPACES (largest)', 40, y, { size: 20, color: '#7283a6', weight: 700 });
      S.meta.namespaces.slice(0, 6).forEach((n, i) => {
        const [r, g, b] = L.nsColor(i); c.fillStyle = `rgb(${r},${g},${b})`; c.beginPath(); c.arc(54, y + 30 + i * 34, 9, 0, 7); c.fill();
        text(c, fit(c, n, 780), 76, y + 38 + i * 34, { size: 22, color: '#cbd5e1' });
      });
    } else if (S.color === 2) {
      text(c, 'DEPTH: blue/violet … orange (0 → 202), a module imports only shallower ones', 40, y, { size: 22, color: '#93a4c3' });
    } else {
      text(c, 'LEGEND', 40, y, { size: 20, color: '#7283a6', weight: 700 });
      [['open', NODE_COLORS.open, cnt.open], ['assigned to a volunteer', NODE_COLORS.assigned, cnt.assigned],
       ['built (others)', NODE_COLORS.done, cnt.done], ['built by us', NODE_COLORS.ours, cnt.ours], ['building now (pulses)', NODE_COLORS.live, null]]
        .forEach(([l, col, v], i) => {
          c.fillStyle = col; c.beginPath(); c.arc(54, y + 30 + i * 34, 9, 0, 7); c.fill();
          text(c, l + (v != null ? '   ' + L.fmt(v) : ''), 76, y + 38 + i * 34, { size: 22 });
        });
    }
  }

  // what the loop is doing (server decides from the process list, the loop log and the receipts)
  const PHASE_LABEL = { building: 'building', finishing: 'verifying & uploading', starting: 'starting build', 'waiting-grant': 'waiting for grant', claiming: 'claiming', between: 'next packet', booting: 'starting', backoff: 'retrying', stopped: 'STOPPED', idle: 'idle' };
  const PHASE_COLOR = { building: '#ff6619', finishing: '#4fb0ff', starting: '#4fb0ff', 'waiting-grant': '#ffb454', claiming: '#ffb454', between: '#7be495', booting: '#4fb0ff', backoff: '#ffb454', stopped: '#ff5c5c', idle: '#6b7280' };
  const phaseOf = (st) => (st && st.phase) || { kind: st && st.running ? 'building' : 'idle', text: st && st.running ? 'building' : 'idle' };

  // ---- connection tubes: every connection of the selected module (up to RIB.max, i.e. all of them for ~99.8% of modules) is a real
  //      3D tube (lit, opaque, occluding each other) along a bowed arc, with a bright bulge running along it in the direction information
  //      flows (imports -> the module, the module -> its consumers).  Tubes start on the core's surface and are thin there, so a module
  //      with many connections does not fill its own centre.  Only hubs beyond RIB.max keep the remainder as faint hair lines.
  const RIB = { max: 192, segs: 16, sides: 6, width: 0.010, start: 0.22, minPx: 1.4, speed: 0.22, freq: 1.0 };
  const RIB_V = `
    attribute vec3 aNrm; attribute float aT, aDir, aPhase, aKind;
    uniform float uWidth, uMinPx, uWorldScale, uTime, uSpeed, uFreq;
    varying vec3 vN, vView; varying float vT, vDir, vPhase, vKind;
    void main(){
      vec4 mv = modelViewMatrix*vec4(position, 1.);
      vec3 n = normalize(normalMatrix*aNrm);
      float x = fract(aT*uFreq - aDir*uTime*uSpeed + aPhase), pulse = exp(-pow((x - .5)*6., 2.));
      float taper = mix(.3, 1., smoothstep(0., .25, aT));                                                             // thin where it leaves the core
      float w = max(uWidth*uWorldScale*taper, uMinPx*max(-mv.z, .05)/(projectionMatrix[1][1]*500.));                 // never thinner than ~1.4 px
      mv.xyz += n*w*(1. + .8*pulse);                                                                                  // the pulse is a bulge travelling along
      vN = n; vView = -mv.xyz; vT = aT; vDir = aDir; vPhase = aPhase; vKind = aKind;
      gl_Position = projectionMatrix*mv;
    }`;
  const RIB_F = `
    uniform float uTime, uSpeed, uFreq;
    varying vec3 vN, vView; varying float vT, vDir, vPhase, vKind;
    void main(){
      vec3 n = normalize(vN), V = normalize(vView), Ld = normalize(vec3(-.35, .75, .55)), H = normalize(Ld + V);
      float diff = max(dot(n, Ld), 0.), spec = pow(max(dot(n, H), 0.), 32.), facing = max(dot(n, V), 0.), rim = pow(1. - facing, 2.5);
      vec3 base = vKind < .5 ? vec3(0., .92, 1.) : vec3(1., .35, .90);        // imports cyan, consumers magenta (as before)
      float x = fract(vT*uFreq - vDir*uTime*uSpeed + vPhase), pulse = exp(-pow((x - .5)*6., 2.));
      float fade = mix(1., .5, vT);                                            // brighter at the module, darker towards the far end
      vec3 col = base*(.18 + .82*diff)*fade + vec3(.55*spec) + base*.35*rim + (base*1.3 + vec3(.5))*pulse*(.35 + .65*facing);
      gl_FragColor = vec4(col, 1.);
    }`;

  // ---- connection fibres (the default style, K switches to the tubes above): faint additive light-guides along cubic arcs that leave the core
  //      radially, with comets (bright head + short tail) running the way knowledge flows.  Imports (cyan): dense, fast comets flowing INTO
  //      the core, each arrival makes a ripple on the core's membrane.  Consumers (magenta): thin, dim, dashed threads with a rare slow wave
  //      going OUT.  Additive blending: where many overlap they add up to a glowing trunk instead of a solid wall; the Gaussian profile across the
  //      camera-facing ribbon means no hard (aliased) edge.  Fibres fade at both ends (they "dock" on the membrane) and with camera distance.
  const FIB = { segs: 32, width: 0.030, minPx: 2.5, speed: 0.30, freq: 2.0, conSpeed: 0.10, docks: 16 };
  const FIB_V = `
    attribute vec3 aTan; attribute float aSide, aT, aDir, aPhase, aKind;
    uniform float uWidth, uMinPx, uWorldScale;
    varying float vSide, vT, vDir, vPhase, vKind, vFar;
    void main(){
      vec4 mv = modelViewMatrix*vec4(position, 1.);
      vec3 tv = normalize(mat3(modelViewMatrix)*aTan);
      vec3 sv = cross(tv, normalize(mv.xyz)); float sl = length(sv); sv = sl > 1e-4 ? sv/sl : vec3(1., 0., 0.);   // across the fibre, facing the eye
      float w = max(uWidth*uWorldScale*(aKind > .5 ? .5 : 1.), uMinPx*max(-mv.z, .05)/(projectionMatrix[1][1]*500.));
      mv.xyz += sv*aSide*w;
      vSide = aSide; vT = aT; vDir = aDir; vPhase = aPhase; vKind = aKind; vFar = smoothstep(6., 30., -mv.z/max(uWorldScale, .01));
      gl_Position = projectionMatrix*mv;
    }`;
  const FIB_F = `
    uniform float uTime, uSpeed, uFreq, uConSpeed;
    varying float vSide, vT, vDir, vPhase, vKind, vFar;
    void main(){
      float s2 = vSide*vSide;
      float core = exp(-s2*14.), halo = exp(-s2*3.)*.45, edge = 1. - smoothstep(.75, 1., abs(vSide));
      float ends = smoothstep(0., .06, vT)*(1. - smoothstep(.94, 1., vT));
      float f = vDir < 0. ? 1. - vT : vT;                                     // position along the flow (0 = where it comes from)
      float spd = .75 + .5*fract(vPhase*7.31);                               // every fibre has its own pace (no wallpaper sync)
      vec3 col; float I;
      if (vKind < .5) {
        vec3 base = vec3(0., .92, 1.);
        float h = fract(uTime*uSpeed*spd + vPhase), d = fract((h - f)*uFreq)/uFreq;       // distance behind the nearest comet head
        float head = exp(-d*90.), tail = exp(-d*10.)*.6;
        I = .10 + 1.8*head + tail;
        col = mix(base, vec3(1.), head*core)*I;
      } else {
        vec3 base = vec3(1., .35, .90);
        float x = fract(vT*22. - uTime*.35), dash = smoothstep(.15, .3, x)*(1. - smoothstep(.6, .75, x));
        float h = fract(uTime*uConSpeed*spd + vPhase), d = fract(h - f), wave = exp(-d*30.);
        I = .14*dash + .9*wave;
        col = mix(base, vec3(1.), wave*core*.6)*I;
      }
      gl_FragColor = vec4(col*(core + halo)*edge*ends*(1. - .7*vFar), 1.);
    }`;

  // ---- info panel
  function paintInfo(c, p) {
    let y = 54;
    if (S.view === 'packets' && S.selPk >= 0 || (S.selPk >= 0 && S.sel < 0)) {
      const k = S.selPk, ps = S.pkStats;
      text(c, 'Packet P' + String(k + 1).padStart(4, '0'), 40, y, { size: 38, weight: 700, color: '#fff' });
      if (ps) {
        text(c, `${ps.tot[k]} modules: open ${ps.open[k]} · assigned ${ps.assigned[k]} · built ${ps.done[k]} · by us ${ps.ours[k]}`, 40, y + 48, { size: 26 });
        text(c, 'highlighted white in the tower', 40, y + 84, { size: 22, color: '#93a4c3' });
      }
      p.button(c, 40, 360, 400, 70, 'Show in tower', () => { setView('tower'); const m = firstOfPacket(k); if (m >= 0) S.focusTarget = S.depth[m] * S.meta.yStep; }, false);
      p.button(c, 460, 360, 400, 70, 'Clear', () => clearSel(), false);
    } else if (S.sel >= 0) {
      const i = S.sel, s = S.st[i];
      const parts = S.names[i].split('.'); let line = '', ly = y;
      c.font = `700 30px ${SANS}`;
      for (const part of parts) { const t = line ? line + '.' + part : part; if (c.measureText(t).width > 820 && line) { text(c, line + '.', 40, ly, { size: 30, weight: 700, color: '#fff' }); line = part; ly += 38; } else line = t; }
      text(c, line, 40, ly, { size: 30, weight: 700, color: '#fff' });
      ly += 52;
      text(c, `${S.ids[i]} · depth ${S.depth[i]} · packet P${String(S.pk[i] + 1).padStart(4, '0')} · ${['open', 'assigned', 'built (others)', 'built by us'][s] || '?'}`, 40, ly, { size: 24, color: '#aab6d3' });
      ly += 42;
      const ni = S.csr.impStart[i + 1] - S.csr.impStart[i], nc = S.csr.conStart[i + 1] - S.csr.conStart[i];
      text(c, `imports ${ni} · imported by ${nc} · whole ancestry ${L.fmt(S.ancestors)} modules`, 40, ly, { size: 24 });
      p.button(c, 40, 340, 270, 64, '◀ an import', () => stepNeighbor(-1), false);
      p.button(c, 330, 340, 270, 64, 'a consumer ▶', () => stepNeighbor(1), false);
      p.button(c, 620, 340, 240, 64, 'Clear', () => clearSel(), false);
    } else {
      text(c, 'Nothing selected', 40, y, { size: 36, weight: 700, color: '#fff' });
      text(c, 'Point at a dot and pull the trigger (or click).', 40, y + 50, { size: 24, color: '#93a4c3' });
      text(c, 'Its whole import ancestry lights up cyan,', 40, y + 86, { size: 24, color: '#93a4c3' });
      text(c, 'direct consumers magenta, and its Lean source opens.', 40, y + 118, { size: 24, color: '#93a4c3' });
    }
    const dh = S.hoverSat >= 0 && S.decls[S.hoverSat];
    const h = dh ? `◆ ${dh.kind} ${dh.name || '(anonymous)'} · ${dh.lines} lines — click to jump` : S.view === 'tower' ? (S.hover >= 0 ? S.names[S.hover] : '') : (S.hoverPk >= 0 ? 'P' + String(S.hoverPk + 1).padStart(4, '0') : '');
    c.font = `22px ${MONO}`; text(c, fitLeft(c, h ? '→ ' + h : '', 830), 40, 446, { size: 22, font: MONO, color: '#ffd133' });
  }

  // ---- source panel
  const SRC_COL = { c: '#6b7a99', s: '#e6b673', k: '#82aaff', r: '#ff5c5c', n: '#c3e88d', x: '#d6deeb' };
  const LINE_H = 34, SRC_TOP = 100, SRC_LEFT = 100;
  // repaint the source panel once the code font has arrived (the first paint may have used the fallback)
  if (document.fonts && document.fonts.load) document.fonts.load('28px "Iosevka Fixed VR"').then(() => { if (S.src) S.src.rows = null; if (panels.source) panels.source.dirty = true; }).catch(() => {});
  function srcVisible() { return Math.floor((panels.source.ph - SRC_TOP - 20) / LINE_H); }
  function srcRows(cols) {
    const s = S.src; if (!s.tok) return [];
    if (!s.rows || s.rowsCols !== cols) { s.rows = L.wrapTokens(s.tok, cols); s.rowsCols = cols; }
    return s.rows;
  }
  function paintSource(c, p) {
    const s = S.src;
    c.font = `700 28px ${SANS}`; text(c, fitLeft(c, s.name || 'Lean source', 1060), 36, 48, { size: 28, weight: 700, color: '#fff' });
    if (s.loading) return text(c, 'loading…', 36, 90, { size: 24 });
    if (s.error) return text(c, s.error, 36, 90, { size: 24, color: '#ff8a8a' });
    if (!s.tok) return text(c, 'Select a module to read its Lean source.', 36, 90, { size: 24, color: '#93a4c3' });
    const red = s.red;
    text(c, `${s.lines} lines · ${(s.bytes / 1024).toFixed(1)} kB · ` + (red.sorry + red.axiom ? `sorry ${red.sorry} · axiom ${red.axiom}` : 'no sorry / axiom'), 36, 78,
      { size: 22, color: red.sorry + red.axiom ? '#ff5c5c' : '#7be495' });
    c.font = `28px ${SRC_FONT}`; const cw = c.measureText('M').width, vis = srcVisible();
    s.cols = Math.max(20, Math.floor((p.pw - SRC_LEFT - 120) / cw));
    const rows = srcRows(s.cols);
    s.scroll = Math.min(s.scroll, Math.max(0, rows.length - vis));
    for (let r = 0; r < vis; r++) {
      const row = rows[s.scroll + r]; if (!row) break;
      const y = SRC_TOP + r * LINE_H + 26;
      if (s.hl && row.li >= s.hl.from && row.li <= s.hl.to) { c.fillStyle = row.li === s.hl.from ? 'rgba(80,140,255,.30)' : 'rgba(80,140,255,.13)'; c.fillRect(SRC_LEFT - 8, y - 22, p.pw - SRC_LEFT - 100, LINE_H); }
      if (row.n) { c.fillStyle = '#4a5673'; c.font = `22px ${SRC_FONT}`; c.textAlign = 'right'; c.fillText(String(row.n), SRC_LEFT - 12, y); }
      c.font = `28px ${SRC_FONT}`; c.textAlign = 'left';
      let col = 0;
      for (const [t, ty] of row.toks) {
        c.fillStyle = SRC_COL[ty];
        if (/^[\x20-\x7e]*$/.test(t)) { c.fillText(t, SRC_LEFT + col * cw, y); col += t.length; continue; }
        for (const ch of t) { c.fillText(ch, SRC_LEFT + col * cw, y); col++; }   // one cell per character: a fallback glyph (e.g. 𝓞) cannot shift the rest of the row
      }
    }
    // scrollbar + buttons
    const bx = p.pw - 90;
    p.button(c, bx, 100, 70, 70, '▲', () => scrollSrc(-vis + 2), false);
    p.button(c, bx, 180, 70, 70, '▼', () => scrollSrc(vis - 2), false);
    p.button(c, bx, 260, 70, 60, 'Top', () => scrollSrc(-1e9), false);
    const trackH = p.ph - 400, th = Math.max(30, trackH * vis / Math.max(rows.length, vis));
    c.fillStyle = '#1b2233'; c.fillRect(bx + 28, 340, 14, trackH);
    c.fillStyle = '#598cff'; c.fillRect(bx + 28, 340 + (trackH - th) * (s.scroll / Math.max(1, rows.length - vis)), 14, th);
  }
  function scrollSrc(d) {
    const s = S.src; if (!s.tok) return;
    s.scroll = Math.max(0, Math.min(Math.max(0, srcRows(s.cols || 70).length - srcVisible()), Math.round(s.scroll + d)));
    panels.source.dirty = true;
  }
  async function loadSource(i) {
    const s = S.src; s.name = S.names[i]; s.loading = true; s.error = ''; s.tok = null; s.rows = null; s.scroll = 0; s.hl = null; S.decls = []; if (core && core.target === 1) { core.decls = S.decls; coreSetDecls(core); core.heart.material.uniforms.uHasCode.value = 0; } panels.source.dirty = true;
    try {
      const r = await fetch('/api/src?i=' + i);
      if (S.sel !== i) return;
      if (!r.ok) throw new Error(r.status === 404 ? 'source file not found in the volume' : 'HTTP ' + r.status);
      const txt = await r.text();
      s.tok = L.tokenize(txt); s.red = L.countRed(s.tok); s.bytes = txt.length; s.lines = s.tok.length; s.hl = null;
      S.decls = L.declarations(s.tok); if (core && core.target === 1 && core.i === i) { core.decls = S.decls; coreSetDecls(core); paintCode(core, s.tok); }
    } catch (e) { s.error = String(e.message || e); }
    s.loading = false; panels.source.dirty = true;
  }

  // ---- live log panel
  function paintLog(c, p) {
    const st = S.status, ph = phaseOf(st);
    text(c, 'Live build', 36, 56, { size: 36, weight: 700, color: '#fff' });
    c.fillStyle = PHASE_COLOR[ph.kind] || '#6b7280'; c.beginPath(); c.arc(260, 44, 11, 0, 7); c.fill();
    const sy = (st && st.sys) || null;
    if (sy && sy.cpus) {   // CPU and RAM bars: proof that something is really being computed
      const bar = (x, label, frac, txt, col) => {
        text(c, label, x, 52, { size: 22, color: '#7f8fb3', weight: 700 });
        c.fillStyle = '#1b2233'; roundRect(c, x + 62, 34, 140, 22, 8); c.fill();
        c.fillStyle = col; roundRect(c, x + 62, 34, Math.max(6, 140 * Math.min(1, frac)), 22, 8); c.fill();
        text(c, txt, x + 214, 52, { size: 22, color: '#cbd5e1', font: MONO });
      };
      bar(540, 'CPU', sy.cpu / 100, `${Math.round(sy.cpu)}%`, sy.cpu > 60 ? '#ff9a4d' : '#4fb0ff');
      bar(880, 'RAM', sy.memUsedGB / sy.memTotalGB, `${Math.round(sy.memUsedGB)}/${Math.round(sy.memTotalGB)}G`, '#7be495');
      text(c, `lean ×${sy.lean}`, 1364, 52, { size: 22, color: sy.lean ? '#ffc58f' : '#6b7280', font: MONO, align: 'right' });
    }
    const comp = (st && st.compiling) || [];
    const label = ph.kind === 'building' && comp.length ? 'compiling' : PHASE_LABEL[ph.kind] || ph.kind;
    text(c, label, 282, 52, { size: 22, color: ph.kind === 'stopped' ? '#ff8a8a' : '#aab6d3', weight: ph.kind === 'stopped' ? 700 : 400 });
    c.font = `24px ${MONO}`;
    // modules being compiled right now (a heavy one can be silent for minutes) – pinned above the finished ones
    comp.slice(0, 2).forEach((m, i) => {
      const t = `${Math.floor(m.secs / 60)}m${String(m.secs % 60).padStart(2, '0')}s  `;
      c.font = `24px ${MONO}`; const pw = c.measureText('⏳ ' + t).width;
      text(c, '⏳ ' + t, 36, 100 + i * 33, { size: 24, font: MONO, color: '#ff9a4d' });
      text(c, abbrev(c, m.name, 1330 - pw), 36 + pw, 100 + i * 33, { size: 24, font: MONO, color: '#ffc58f' });
    });
    const detail = ph.kind !== 'building';
    if (detail) text(c, ph.text, 36, 100, { size: 24, font: MONO, color: PHASE_COLOR[ph.kind] || '#aab6d3' });
    const yOff = Math.min(2, comp.length) * 33 + (detail ? 33 : 0);
    const lines = S.logLines.slice(-(14 - Math.min(2, comp.length) - (detail ? 1 : 0)));
    lines.forEach((l, i) => {
      const y = 104 + yOff + i * 33;
      if (l.name) {   // fixed prefix (counter + time), then the module name with its distinctive TAIL kept
        text(c, l.pre, 36, y, { size: 24, font: MONO, color: '#4f9d6b' });
        const pw = c.measureText(l.pre).width; c.font = `24px ${MONO}`;
        text(c, abbrev(c, l.name, 1330 - pw), 36 + pw, y, { size: 24, font: MONO, color: l.color });
      } else text(c, fitLeft(c, l.text, 1330), 36, y, { size: 24, font: MONO, color: l.color });
    });
    let y = 104 + 14 * 33 + 24;
    text(c, 'LOOP', 36, y, { size: 20, color: '#7283a6', weight: 700 });
    (S.packetLines.length ? S.packetLines : (st ? st.packetLog : [])).slice(-3).forEach((l, i) => text(c, fitLeft(c, l.replace(/\s*comment=\S+/, ''), 1330), 36, y + 30 + i * 33, { size: 24, font: MONO, color: '#aab6d3' }));
    y += 30 + 3 * 33 + 20;
    text(c, 'OUR RECEIPTS', 36, y, { size: 20, color: '#7283a6', weight: 700 });
    (st ? st.receipts.slice(-4) : []).forEach((r, i) => text(c, `${r.ended.slice(11, 16)} UTC · ${r.modules} module${r.modules === 1 ? '' : 's'}`, 36, y + 30 + i * 33, { size: 24, font: MONO, color: '#7be495' }));
  }


  // ------------------------------------------------------------------ the selected module: a living sphere
  // surface  = solid, flowing bands + one "comet" per direct import; speed follows the CPU use of the lean process compiling it
  // core     = glows/pulses, grows with that process' memory
  // no text label: that information lives in the Live build panel; here it is just the picture
  // satellites = the file's declarations (theorem/lemma/def/instance/axiom), size = length; click one to jump to it in the source
  const DECL_COLOR = { theorem: 0x4fb0ff, lemma: 0x7be4ff, def: 0xffb454, instance: 0xc792ea, structure: 0xff6b9a, class: 0xff6b9a, inductive: 0xff6b9a, abbrev: 0xffd133, axiom: 0xff3b3b };
  const SHELL_V = `varying vec3 vPos; varying vec3 vNw; varying vec3 vVw;
    void main(){ vPos = normalize(position); vec4 wp = modelMatrix*vec4(position,1.); vNw = normalize(mat3(modelMatrix)*normal);
      vVw = cameraPosition - wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`;
  const SHELL_F = `uniform float uTime, uEnergy, uSpeed, uStreaks, uAlpha; uniform vec3 uColor;
    uniform vec3 uDock[16]; uniform float uDockPh[16]; uniform float uDockN, uDockT, uDockSpd, uDockFreq;
    varying vec3 vPos; varying vec3 vNw; varying vec3 vVw;
    void main(){
      vec3 n = normalize(vPos);
      float fres = pow(1. - abs(dot(normalize(vNw), normalize(vVw))), 2.2);
      float lat = n.y*6. + sin(n.x*5. + uTime*uSpeed)*.6 + sin(n.z*4. - uTime*uSpeed*.7)*.6;
      float bands = .5 + .5*sin(lat*3. - uTime*uSpeed*2.);
      float streak = 0.;
      for (int k = 0; k < 12; k++) {
        if (float(k) >= uStreaks) break;
        float a = float(k)*2.399963;
        vec3 axis = normalize(vec3(sin(a*1.7), cos(a), sin(a*.9 + 1.)));
        vec3 e1 = normalize(cross(axis, vec3(.3, 1., .2))); vec3 e2 = cross(axis, e1);
        float ph = uTime*uSpeed*(.6 + .1*float(k)) + a;
        vec3 head = e1*cos(ph) + e2*sin(ph);
        vec3 tail = e1*cos(ph - .5) + e2*sin(ph - .5);
        float onCircle = abs(dot(n, axis));
        float ring = 1. - smoothstep(0., .07, onCircle);   // (edge0 < edge1: reversed edges are undefined in GLSL)
        streak += ring*(exp(-acos(clamp(dot(n, head), -1., 1.))*9.) + .5*exp(-acos(clamp(dot(n, tail), -1., 1.))*5.));
      }
      float rip = 0.;                                                       // ripples where import fibres dock (comet arrivals)
      for (int k = 0; k < 16; k++) {
        if (float(k) >= uDockN) break;
        float ang = acos(clamp(dot(n, uDock[k]), -1., 1.)), ph = uDockPh[k];
        float age = fract(fract(uDockT*uDockSpd*(.75 + .5*fract(ph*7.31)) + ph)*uDockFreq);
        rip += exp(-pow((ang - .12 - age*.8)*16., 2.))*(1. - age)*(1. - age) + exp(-ang*14.)*exp(-age*9.);
      }
      vec3 col = uColor*(.30 + .35*bands) + vec3(1.)*streak + uColor*fres*1.3 + vec3(.55, .95, 1.)*rip;
      float alpha = .16 + .55*fres + .30*bands*uEnergy + streak*.9 + rip*.8;
      gl_FragColor = vec4(col, clamp(alpha, 0., .95)*uAlpha);
    }`;
  // core: translucent lit sphere with swirling plasma cells (cheap sin-noise), Fresnel rim, and a smaller nucleus inside it for parallax
  const HEART_V = `varying vec3 vPos; varying vec3 vNw; varying vec3 vVw; varying vec2 vUv;
    void main(){ vPos = normalize(position); vUv = uv; vec4 wp = modelMatrix*vec4(position,1.); vNw = normalize(mat3(modelMatrix)*normal);
      vVw = cameraPosition - wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`;
  const HEART_F = `uniform float uTime, uEnergy, uAlpha, uPhase, uHasCode; uniform vec3 uColor; uniform sampler2D uCode;
    varying vec3 vPos; varying vec3 vNw; varying vec3 vVw; varying vec2 vUv;
    float n3(vec3 p){ return sin(p.x*3.1 + uTime*.9)*sin(p.y*2.7 - uTime*.7)*sin(p.z*3.4 + uTime*.5); }
    void main(){
      vec3 n = normalize(vNw), v = normalize(vVw);
      vec3 q = vPos*2.2 + uPhase;
      float f = n3(q) + .5*n3(q*2.1 + 3.) + .25*n3(q*4.3 + 7.);
      float cell = clamp(.5 + .6*f, 0., 1.);
      vec3 L = normalize(vec3(-.45, .6, .65));
      float diff = max(dot(n, L), 0.);
      float fres = pow(1. - max(dot(n, v), 0.), 2.5);
      vec3 hot = mix(uColor, vec3(1.), .55);
      vec3 col = mix(uColor*.40, hot, cell)*(.45 + .75*diff) + hot*fres*.9 + hot*uEnergy*.30*cell;
      // the module's own source code drifting along the surface in latitude bands: every band has its own direction and a very slow speed
      float band = floor(vUv.y*18.);
      float h = fract(sin(band*91.7 + 3.1)*437.5);
      float dir = h > .5 ? 1. : -1.;
      float u = vUv.x + dir*(.004 + .010*h)*(1. + 2.*uEnergy)*uTime + h*3.;
      float g = texture2D(uCode, vec2(u, vUv.y)).a*uHasCode*sin(3.14159*vUv.y);
      col += hot*g*(.65 + .55*uEnergy);
      float aa = max(uAlpha*(.55 + .35*cell + .5*fres), g*.9*uAlpha);
      gl_FragColor = vec4(col, clamp(aa, 0., 1.));
    }`;
  const NO_CODE = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); NO_CODE.needsUpdate = true;
  const makeHeartMat = (phase) => new THREE.ShaderMaterial({ vertexShader: HEART_V, fragmentShader: HEART_F, transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uEnergy: { value: 0.1 }, uAlpha: { value: 0 }, uPhase: { value: phase }, uColor: { value: new THREE.Color(0xdfe9ff) }, uCode: { value: NO_CODE }, uHasCode: { value: 0 } } });
  // Declarations as small creatures, one instanced mesh, the shape comes from the shader (kind -> silhouette), each one breathes (morphs) and turns slowly:
  //   theorem = cut gem (faceted) | lemma = slim shard | def = soft blob | instance = planet with a ring band | structure/class/inductive = octahedral crystal
  //   abbrev = small pearl | axiom = red urchin that pulses (the one thing you should notice)
  const KIND_IDX = { theorem: 0, lemma: 1, def: 2, instance: 3, structure: 4, class: 4, inductive: 4, abbrev: 5, axiom: 6 };
  const SAT_V = `
    attribute float aKind, aSeed; attribute vec3 aCol;
    uniform float uTime;
    varying vec3 vCol; varying vec3 vN; varying vec3 vP; varying vec3 vObj; varying float vKind; varying float vSeed;
    void main(){
      vec3 n = normalize(position);
      float t = uTime*.9 + aSeed*6.2832;
      float k = aKind;
      float blob = .09*sin(t + n.x*3.1)*sin(t*.8 + n.y*2.7) + .06*sin(t*1.3 + n.z*3.7);
      float oct = abs(n.x) + abs(n.y) + abs(n.z);
      float r = 1.; vec3 sc = vec3(1.);
      if (k < .5)       { r = mix(1., .88/oct, .55) + blob*.3; }
      else if (k < 1.5) { r = mix(1., .88/oct, .55) + blob*.3; sc = vec3(.8, 1.55, .8); }
      else if (k < 2.5) { r = 1. + blob*1.7; }
      else if (k < 3.5) { r = 1. + blob*.7; }
      else if (k < 4.5) { r = .90/oct + blob*.15; }
      else if (k < 5.5) { r = .8 + blob*1.1; }
      else { float sp = max(0., sin(n.x*6.5 + t)*sin(n.y*6.5 - t*.7)*sin(n.z*6.5 + t*.4)); r = .75 + .75*sp + blob*.5; }
      vec3 p = n*r*sc;
      float a = t*.6, ca = cos(a), sa = sin(a);
      p.xz = vec2(ca*p.x + sa*p.z, -sa*p.x + ca*p.z);
      vec3 nn = normalize(vec3(ca*n.x + sa*n.z, n.y, -sa*n.x + ca*n.z));
      vec4 mv = modelViewMatrix*instanceMatrix*vec4(p*.014, 1.);
      vN = normalize(mat3(modelViewMatrix)*mat3(instanceMatrix)*nn);
      vP = mv.xyz; vCol = aCol; vObj = n; vKind = k; vSeed = aSeed;
      gl_Position = projectionMatrix*mv;
    }`;
  const SAT_F = `
    uniform float uTime, uAlpha;
    varying vec3 vCol; varying vec3 vN; varying vec3 vP; varying vec3 vObj; varying float vKind; varying float vSeed;
    void main(){
      float k = vKind;
      bool facet = (k < 1.5) || (k > 3.5 && k < 4.5);
      vec3 N = normalize(vN);
      if (facet) { vec3 fn = normalize(cross(dFdx(vP), dFdy(vP))); if (dot(fn, -vP) < 0.) fn = -fn; N = fn; }
      vec3 L = normalize(vec3(-.45, .6, .65));
      float diff = max(dot(N, L), 0.);
      float spec = pow(max(dot(reflect(-L, N), vec3(0., 0., 1.)), 0.), facet ? 40. : 26.)*.6;
      float rim = pow(1. - max(N.z, 0.), 2.5);
      vec3 c = vCol*(.26 + .90*diff) + vCol*rim*.75 + vec3(spec);
      if (k > 2.5 && k < 3.5) { float band = 1. - smoothstep(0., .13, abs(vObj.y)); c = mix(c, vec3(1., .97, .9)*(.55 + .6*diff), band*.7); }
      if (k > 5.5) c += vCol*(.35 + .35*sin(uTime*3. + vSeed*20.));
      gl_FragColor = vec4(c, uAlpha);
    }`;
  const CORE_R = 0.2, MAX_SATS = 160, HEART_W = 1.0;
  let core = null;
  function makeCore() {
    const group = new THREE.Group(); group.visible = false;
    const shellMat = new THREE.ShaderMaterial({
      vertexShader: SHELL_V, fragmentShader: SHELL_F, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uEnergy: { value: 0.12 }, uSpeed: { value: 0.3 }, uStreaks: { value: 3 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0x40d973) },
        uDock: { value: Array.from({ length: 16 }, () => new THREE.Vector3(0, 1, 0)) }, uDockPh: { value: new Float32Array(16) }, uDockN: { value: 0 }, uDockT: { value: 0 }, uDockSpd: { value: FIB.speed }, uDockFreq: { value: FIB.freq } },
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(CORE_R, 48, 32), shellMat);
    const heart = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), makeHeartMat(0));
    const nucleus = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), makeHeartMat(5.3));
    const sg = new THREE.IcosahedronGeometry(1, 2);
    sg.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array(MAX_SATS), 1)); sg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(MAX_SATS), 1));
    sg.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(MAX_SATS * 3), 3));
    const sats = new THREE.InstancedMesh(sg, new THREE.ShaderMaterial({ vertexShader: SAT_V, fragmentShader: SAT_F, transparent: true, depthWrite: true, uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } } }), MAX_SATS);
    sats.instanceMatrix.setUsage(THREE.DynamicDrawUsage); sats.frustumCulled = false; sats.count = 0;
    group.add(shell, heart, nucleus, sats);
    return { group, shell, shellMat, heart, nucleus, sats, orbit: [], satPos: [], tele: null, t: 0, i: -1, fade: 0, target: 0, decls: [] };
  }
  const STATE_COLOR = [0x6f7d99, 0x598cff, 0x40d973, 0xffd133];
  // ---- Main: the final theorem. A landmark that is always visible at the top of the tower (golden star, three turning rings, a corona,
  //      and above it the CRITICAL LINE: a thin line with the first 30 zeros of zeta at heights proportional to their imaginary parts.
  //      Like the sequenced approach lights of a runway / an obstruction light for passing mathematicians, a blink runs up the line, faster and
  //      faster (height ~ time^2, and the zeros get denser upwards), each zero flashing with a short horizontal flare as it is passed);
  //      when Main is selected its core becomes a crowned, larger, golden version of the normal one.
  const GOLD = 0xffd36b, GOLD_HOT = 0xffeeb8, BEACON_H = 14, CROWN_SCALE = 2.2;
  const ZERO = { y0: 0.9, span: 13.0, sweep: 4.0, cycle: 6.0, decay: 0.30 };   // first zero 0.9 m above Main, last one 13 m higher; one run up every 6 s
  let beacon = null, mainIdx = -1;
  function makeBeacon() {
    const group = new THREE.Group(); group.visible = false;
    const coreMat = makeHeartMat(2.1); coreMat.uniforms.uColor.value.setHex(GOLD); coreMat.uniforms.uEnergy.value = 0.85; coreMat.uniforms.uAlpha.value = 0.95;
    const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 28, 20), coreMat);
    const ringMat = (hex) => new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const rings = [[0.34, GOLD], [0.46, GOLD_HOT], [0.60, 0xffb347]].map(([r, hex], k) => { const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 8, 120), ringMat(hex)); m.rotation.set(k * 1.1, k * 0.7, 0); return m; });
    // the critical line itself: thin, warm, fading out at the top
    const beamMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: 'uniform float uTime; varying float vY; void main(){ float a = .55*(1. - smoothstep(.85, 1., vY)); gl_FragColor = vec4(1., .55, .22, a); }' });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, BEACON_H, 8, 1, true), beamMat); beam.position.y = ZERO.y0 + BEACON_H / 2 - 0.4;
    // the zeros: one camera-facing quad each; the blink and its horizontal flare are computed in the shader from the time
    const H = L.zeroHeights(L.ZETA_ZEROS), nz = H.length, zp = new Float32Array(nz * 4 * 3), zc = new Float32Array(nz * 4 * 2), zh = new Float32Array(nz * 4), zi = [];
    H.forEach((h, k) => { for (let q = 0; q < 4; q++) { const v = 4 * k + q; zp[3 * v + 1] = ZERO.y0 + h * ZERO.span; zc[2 * v] = q & 1 ? 1 : -1; zc[2 * v + 1] = q & 2 ? 1 : -1; zh[v] = h; } zi.push(4 * k, 4 * k + 1, 4 * k + 2, 4 * k + 1, 4 * k + 3, 4 * k + 2); });
    const zg = new THREE.BufferGeometry(); zg.setAttribute('position', new THREE.BufferAttribute(zp, 3)); zg.setAttribute('aCorner', new THREE.BufferAttribute(zc, 2)); zg.setAttribute('aH', new THREE.BufferAttribute(zh, 1)); zg.setIndex(zi);
    const zeroMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uSweep: { value: ZERO.sweep }, uCycle: { value: ZERO.cycle }, uDecay: { value: ZERO.decay }, uWS: { value: 1 } },
      vertexShader: `attribute vec2 aCorner; attribute float aH; uniform float uTime, uSweep, uCycle, uDecay, uWS; varying vec2 vC; varying float vF;
        void main(){
          float tau = mod(uTime, uCycle), dt = tau - uSweep*sqrt(aH);
          vF = dt >= 0. ? exp(-dt/uDecay) : 0.;                                   // same formula as zeroFlash() in lib.js
          vec2 ext = vec2(mix(.10, 1.0, vF), .10);                                 // the quad is only wide while it flashes
          vC = aCorner*ext;
          vec4 mv = modelViewMatrix*vec4(position, 1.); mv.xy += vC*uWS;
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: `varying vec2 vC; varying float vF;
        void main(){
          float r = length(vC)/(.032*(1. + .6*vF)), dot = exp(-r*r*1.4);
          float flare = exp(-abs(vC.y)/.007)*exp(-abs(vC.x)/.30)*vF;              // horizontal streak, only during the blink
          vec3 col = vec3(1., .94, .84)*dot*(.35 + 1.9*vF) + vec3(1., .86, .66)*flare*1.3;
          gl_FragColor = vec4(col, 1.);
        }` });
    const zeros = new THREE.Mesh(zg, zeroMat); zeros.frustumCulled = false;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d'), gr = x.createRadialGradient(64, 64, 2, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,238,184,.95)'); gr.addColorStop(0.25, 'rgba(255,200,90,.35)'); gr.addColorStop(1, 'rgba(255,170,60,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const ct = new THREE.CanvasTexture(cv); ct.colorSpace = THREE.SRGBColorSpace;
    const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: ct, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })); corona.scale.set(1.5, 1.5, 1);
    group.add(coreMesh, ...rings, beam, zeros, corona);
    return { group, coreMesh, coreMat, rings, beam, beamMat, zeros, zeroMat, corona };
  }
  function beaconTick(t, dt) {
    if (!beacon) return;
    const T = t / 1000; beacon.group.visible = S.view === 'tower'; beacon.group.position.set(S.pos[3 * mainIdx], S.pos[3 * mainIdx + 1], S.pos[3 * mainIdx + 2]);
    beacon.rings.forEach((m, k) => { m.rotation.x += dt * (0.25 + 0.1 * k); m.rotation.y += dt * (0.18 - 0.06 * k); });
    beacon.coreMat.uniforms.uTime.value = T; beacon.beamMat.uniforms.uTime.value = T; beacon.zeroMat.uniforms.uTime.value = T; beacon.zeroMat.uniforms.uWS.value = world ? world.scale.x : 1;
    const sel = core && core.target === 1 && core.i === mainIdx;
    beacon.coreMesh.visible = !sel;                                         // when Main is selected its crowned core takes this place
    beacon.corona.scale.setScalar(1.5 * (1 + 0.07 * Math.sin(T * 1.3)) * (sel ? 1.6 : 1));
  }
  // the new module appears in FADE_SEC; the one we leave lingers OUT_SEC, fading and collapsing into its centre, so the camera can follow
  // the hand-over arc (LINK_SEC long, its bright point travelling for LINK_RUN) from the old module to the new one
  // every jump leaves its own arc that fades slowly (LINK_SEC), so quick jumps leave a fading web of the path; at most LINK_N arcs at once
  const FADE_SEC = 0.4, OUT_SEC = 1.2, LINK_SEC = 6.0, LINK_RUN = 1.1, LINK_N = 16;
  const cores = [];                          // two slots: one fades in while the other fades out
  const links = []; let link = null;                                         // link = the most recent arc
  function makeLinkOne() {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
    const L = { t: 99, a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
    L.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    L.dot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    for (const o of [L.line, L.dot]) { o.frustumCulled = false; o.visible = false; }
    return L;
  }
  function makeLink() {
    for (let k = 0; k < LINK_N; k++) links.push(makeLinkOne());
    link = links[0]; return links.flatMap((L) => [L.line, L.dot]);
  }
  const bez = (a, c, b, q, out) => out.set((1 - q) * (1 - q) * a.x + 2 * (1 - q) * q * c.x + q * q * b.x, (1 - q) * (1 - q) * a.y + 2 * (1 - q) * q * c.y + q * q * b.y, (1 - q) * (1 - q) * a.z + 2 * (1 - q) * q * c.z + q * q * b.z);
  /** a soft arc from the module we leave to the one we arrive at, bowed away from the tower axis so it hugs the wall; reuses the oldest arc */
  function startLink(a, b) {
    const dist = a.distanceTo(b); if (dist < 0.05) return;
    const L = links.reduce((m, x) => (x.t > m.t ? x : m), links[0]);
    L.a.copy(a); L.b.copy(b); L.c.copy(a).add(b).multiplyScalar(0.5);
    const out = new THREE.Vector3(L.c.x, 0, L.c.z); if (out.lengthSq() > 1e-9) out.normalize(); else out.set(1, 0, 0);
    L.c.addScaledVector(out, Math.min(1.5, 0.25 * dist));
    const pos = L.line.geometry.attributes.position, v = new THREE.Vector3();
    for (let k = 0; k <= 24; k++) { bez(L.a, L.c, L.b, k / 24, v); pos.setXYZ(k, v.x, v.y, v.z); } pos.needsUpdate = true;
    L.t = 0; link = L;
  }
  function linkTick(dt) {
    for (const L of links) {
      if (L.t >= LINK_SEC || S.view !== 'tower') { L.line.visible = L.dot.visible = false; if (L.t < LINK_SEC) L.t = LINK_SEC; continue; }
      L.t += dt; const u = Math.min(1, L.t / LINK_SEC), run = Math.min(1, L.t / LINK_RUN), e = run * run * (3 - 2 * run);
      L.line.visible = true; L.line.material.opacity = 0.45 * Math.pow(1 - u, 1.5);           // slow fade: the path stays readable for a few seconds
      const dotEnd = LINK_RUN + 0.4; L.dot.visible = L.t < dotEnd; bez(L.a, L.c, L.b, e, L.dot.position);
      L.dot.material.opacity = 0.9 * Math.min(1, (dotEnd - L.t) / 0.4);                      // the point arrives, then fades in 0.4 s
    }
  }
  function coreShow(i) {
    if (core && core.target === 1 && core.i === i) { core.decls = S.decls; coreSetDecls(core); coreTelemetry(); return; }   // same module again (closure toggled ...)
    const old = core && core.target === 1 && core.i >= 0 ? core : null;
    const c = cores.find((x) => x !== old) || cores[0];                     // the other slot: idle, or still finishing an older fade-out
    c.fade = Math.min(c.fade, 0.25);                                        // if it was still visible, shrink it so re-use is not a visible pop
    c.i = i; c.target = 1; c.group.position.set(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]);
    c.shellMat.uniforms.uStreaks.value = i === mainIdx ? 12 : Math.max(1, Math.min(12, S.csr.impStart[i + 1] - S.csr.impStart[i]));
    c.tele = null; c.decls = S.decls; c.group.visible = S.view === 'tower' && c.fade > 0.002;
    if (old) { old.target = 0; if (old.fade > 0.15 && S.view === 'tower') startLink(old.group.position, c.group.position); }
    c.heart.material.uniforms.uHasCode.value = 0;                           // the previous module's code must not ride along
    core = c; coreSetDecls(c); coreTelemetry();
    if (S.src.tok && S.src.name === S.names[i]) paintCode(c, S.src.tok);   // its source may already be loaded
  }
  const CODE_ROWS = 18, CODE_W = 2048, CODE_H = 576;
  const CODE_SKIP = /^(--|\/-|\*\/|import\b|open\b|namespace\b|section\b|end\b|universe\b|variable\b|set_option\b|noncomputable section)/;
  /** the module's own lines worth showing (statements and proofs, not boilerplate) */
  function codeLines(tok) {
    const out = [];
    for (const toks of tok) { const t = toks.map((x) => x[0]).join('').trim(); if (t && !CODE_SKIP.test(t)) { out.push(t); if (out.length >= 80) break; } }
    return out;
  }
  /** paint the module's source onto the core's texture (one canvas per slot; the texture repeats horizontally and the shader scrolls it) */
  function paintCode(c, tok) {
    const u = c.heart.material.uniforms, lines = tok ? codeLines(tok) : [];
    if (!lines.length) { u.uHasCode.value = 0; return; }
    if (!c.codeCv) { c.codeCv = document.createElement('canvas'); c.codeCv.width = CODE_W; c.codeCv.height = CODE_H; c.codeTex = new THREE.CanvasTexture(c.codeCv); c.codeTex.wrapS = THREE.RepeatWrapping; }
    const x = c.codeCv.getContext('2d'); x.clearRect(0, 0, CODE_W, CODE_H);
    x.font = `600 ${Math.round(CODE_H / CODE_ROWS * 0.74)}px ${MONO}`; x.fillStyle = '#fff'; x.textBaseline = 'middle';
    for (let r = 0; r < CODE_ROWS; r++) {
      const base = lines[(r * 7 + 3) % lines.length]; let line = '';
      while (x.measureText(line).width < CODE_W && line.length < 400) line += base + '    ·    ';
      x.fillText(line, 0, (r + 0.5) * CODE_H / CODE_ROWS);
    }
    c.codeTex.needsUpdate = true; u.uCode.value = c.codeTex; u.uHasCode.value = 1;
  }
  function coreHide() { for (const c of cores) c.target = 0; }                // fades out, no pop
  /** orbit parameters (deterministic per declaration) and instance colours */
  function coreSetDecls(c) {
    c = c || core; if (!c) return;
    const D = c.decls || []; const n = Math.min(D.length, MAX_SATS);
    c.orbit.length = 0; c.satPos.length = 0;
    for (let k = 0; k < n; k++) {
      const h1 = ((k * 2654435761) >>> 0) / 4294967296, h2 = ((k * 40503 + 17) * 2246822519 >>> 0) / 4294967296;
      c.orbit.push({ r: CORE_R * (1.45 + 1.0 * h1), ph: 6.2832 * h2, om: (0.25 + 0.5 * h1) * (k % 2 ? 1 : -1), inc: (h2 - 0.5) * 2.4, tilt: h1 * 6.2832,
        s: 0.7 + 1.3 * Math.min(1, Math.log2(1 + D[k].lines) / Math.log2(90)) });
      c.satPos.push(new THREE.Vector3());
      const hex = DECL_COLOR[D[k].kind] || 0xffffff, ga = c.sats.geometry.attributes;   // raw sRGB like every other shader here (no colour-space conversion)
      ga.aKind.array[k] = KIND_IDX[D[k].kind] !== undefined ? KIND_IDX[D[k].kind] : 2; ga.aSeed.array[k] = h2;
      ga.aCol.array[3 * k] = ((hex >> 16) & 255) / 255; ga.aCol.array[3 * k + 1] = ((hex >> 8) & 255) / 255; ga.aCol.array[3 * k + 2] = (hex & 255) / 255;
    }
    c.sats.count = n; for (const a of ['aKind', 'aSeed', 'aCol']) c.sats.geometry.attributes[a].needsUpdate = true;
  }
  /** what the lean process compiling a shown module is doing right now (null: not being compiled) */
  function coreTelemetry() {
    const comp = (S.status && S.status.compiling) || [];
    for (const c of cores) c.tele = c.i >= 0 ? comp.find((m) => m.i === c.i) || null : null;
  }
  const _m4 = new THREE.Matrix4(), _q0 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  function coreTick(t, dt) {
    const T = t / 1000;
    for (const c of cores) {
      const step = dt / (c.target > c.fade ? FADE_SEC : OUT_SEC); c.fade += Math.max(-step, Math.min(step, c.target - c.fade));
      const vis = S.view === 'tower' && c.fade > 0.002 && c.i >= 0; c.group.visible = vis;
      if (c.i >= 0) c.group.position.set(S.pos[3 * c.i], S.pos[3 * c.i + 1], S.pos[3 * c.i + 2]);      // follows a layout morph
      if (!vis) { if (c.target === 0 && c.fade <= 0.002) c.i = c === core ? c.i : -1; continue; }
      const e = c.fade * c.fade * (3 - 2 * c.fade), tele = c.tele, energy = tele ? Math.min(1, (tele.cpu || 0) / 120) : 0.12;
      const u = c.shellMat.uniforms; u.uTime.value = T; u.uAlpha.value = e; u.uEnergy.value += (energy - u.uEnergy.value) * 0.1; u.uSpeed.value = 0.3 + 1.8 * u.uEnergy.value;
      const st = tele ? 4 : S.st[c.i];
      const crown = c.i === mainIdx; c.group.scale.setScalar((crown ? CROWN_SCALE : 1) * (c.target === 0 ? 0.15 + 0.85 * e : 1));   // leaving: collapses inwards
      u.uColor.value.setHex(crown ? GOLD : tele ? 0xff8a3d : STATE_COLOR[st] || STATE_COLOR[0]);
      const r = tele ? 0.035 + 0.06 * Math.min(1, (tele.rssMB || 0) / 8192) : 0.03;
      c.heart.scale.setScalar(r * (1 + 0.18 * Math.sin(T * HEART_W * (1 + 3.5 * u.uEnergy.value))));   // pulse: faster with CPU (half the old rate, so the code stays readable)
      const hot = crown ? GOLD_HOT : tele ? 0xffd7a8 : STATE_COLOR[st] || 0xdfe9ff;
      for (const m of [c.heart, c.nucleus]) { const hu = m.material.uniforms; hu.uTime.value = T; hu.uEnergy.value = u.uEnergy.value; hu.uAlpha.value = 0.85 * e; hu.uColor.value.setHex(hot); }
      // nucleus = estimated progress of compiling this module (Lean reports none, so: elapsed / expected time from the server);
      // it grows from a seed to full size, a built module has a full one, and the moment the module finishes it flashes once.
      const built = !tele && S.builtNow.has(c.i);
      const pr = L.nucleusProgress(tele, built ? 3 : st, (performance.now() - (S.statusAt || 0)) / 1000);
      if (c.lastTele && !tele && c.i === c.lastI && (built || st === 2 || st === 3)) c.flash = 1;
      c.lastTele = !!tele; c.lastI = c.i; c.flash = Math.max(0, (c.flash || 0) - dt / 0.9); c.progress = pr;
      const over = tele && pr >= 1 ? 1 + 0.12 * Math.sin(T * 1.6) : 1;                         // past the estimate: a slow breath ("still at it")
      c.nucleus.scale.setScalar(c.heart.scale.x * 0.5 * (0.18 + 0.82 * pr) * over * (1 + 0.9 * c.flash)); c.nucleus.material.uniforms.uAlpha.value = 0.95 * e;
      c.nucleus.material.uniforms.uEnergy.value = Math.min(1, u.uEnergy.value + c.flash);
      c.sats.material.uniforms.uAlpha.value = e; c.sats.material.uniforms.uTime.value = T;
      for (let k = 0; k < c.orbit.length; k++) {
        const o = c.orbit[k], a = o.ph + T * o.om * (0.6 + u.uEnergy.value);
        _p.set(o.r * Math.cos(a), o.r * Math.sin(a) * Math.sin(o.inc), o.r * Math.sin(a) * Math.cos(o.inc));
        _p.applyEuler(_e.set(0, o.tilt, 0)); c.satPos[k].copy(_p);
        const hov = c === core && k === S.hoverSat ? 2.2 : 1;
        _m4.compose(_p, _q0, _s.setScalar(o.s * hov)); c.sats.setMatrixAt(k, _m4);
      }
      c.sats.instanceMatrix.needsUpdate = true;
    }
    linkTick(dt);
  }
  /** nearest declaration satellite to a world-space ray, {k, dist} or null */
  function coreSatPick(o, d) {
    const c = core; if (!c || c.target !== 1 || !c.group.visible || c.fade < 0.5 || !c.orbit.length) return null;
    c.group.updateWorldMatrix(true, false);
    const ray = new THREE.Ray(o, d), wp = new THREE.Vector3(), sc = c.group.getWorldScale(new THREE.Vector3()).x;
    let best = null, bd = Infinity;
    for (let k = 0; k < c.orbit.length; k++) {
      wp.copy(c.satPos[k]).applyMatrix4(c.group.matrixWorld);
      const t = wp.clone().sub(o).dot(d); if (t < 0.05) continue;
      const dist2 = ray.distanceSqToPoint(wp), lim = Math.max(0.03 * sc * c.orbit[k].s, 0.018 * t);
      if (dist2 < lim * lim && dist2 < bd) { bd = dist2; best = { k, dist: t }; }
    }
    return best;
  }
  function jumpToDecl(k) {
    const d = S.decls[k], s = S.src; if (!d || !s.tok) return;
    const rows = srcRows(s.cols || 70), r = rows.findIndex((x) => x.li === d.line);
    s.hl = { from: d.line, to: d.line + d.lines - 1 };
    if (r >= 0) s.scroll = Math.max(0, Math.min(Math.max(0, rows.length - srcVisible()), r - 1));
    panels.source.dirty = true;
  }

  // ------------------------------------------------------------------ scene objects
  const rulers = [];
  let rulerInward = null;
  let ptsHalo = null, pkHalo = null;
  let world, panelsEl, camEl, ptsMat, pts, pkPts, pkMat, hoverMark, selMark, lines, linePos, lineCol, ribbons, fibers;
  let solids = null, solidList = [];
  /** re-pick the 3D bubbles (selection, live set or view changed); the sprite of each picked module is hidden via aSolid */
  function rebuildSolids() {
    if (!solids) return; S.solidsDirty = false;
    for (const e of solidList) S.solidF[e.i] = 0;
    const live = []; for (const [i] of S.live) if (S.stF[i] > 3.5) live.push(i);
    solidList = S.view === 'tower' ? L.pickSolids(S.hiF, S.pos, S.sel, live, SOLID.max) : [];
    const g = solids.geometry, kind = g.attributes.aKind.array, seed = g.attributes.aSeed.array;
    solidList.forEach((e, n) => { S.solidF[e.i] = 1; kind[n] = e.kind; seed[n] = ((e.i * 2654435761) >>> 0) / 4294967296; });
    syncSolidCenters(); g.instanceCount = solidList.length;
    g.attributes.aKind.needsUpdate = g.attributes.aSeed.needsUpdate = true; pts.geometry.attributes.aSolid.needsUpdate = true;
  }
  function syncSolidCenters() {
    const c = solids.geometry.attributes.aCenter, a = c.array, P = S.pos;
    solidList.forEach((e, n) => { a[3 * n] = P[3 * e.i]; a[3 * n + 1] = P[3 * e.i + 1]; a[3 * n + 2] = P[3 * e.i + 2]; });
    c.needsUpdate = true;
  }
  // ------------------------------------------------------------------ debug: one-letter labels on the active objects (never on the passive dots)
  // so an object can be named in a bug report ("object E looks flat"). Toggled with the Debug button or the I key; the legend is in the menu.
  const DEBUG_KINDS = [
    ['A', 'core membrane (outer shell, docking ripples)', '#ffb27a'], ['B', 'code sphere (Lean code on it)', '#ffd7a8'], ['C', 'nucleus (compile progress)', '#fff1c9'],
    ['D', 'declaration satellite (orbits the core)', '#4fb0ff'], ['E', 'import bubble (cyan)', '#00ffff'], ['F', 'consumer bubble (magenta)', '#ff4de6'],
    ['G', 'compiling / just built bubble', '#ff8a3d'], ['H', 'import fibre / tube', '#00d0d0'], ['I', 'consumer fibre / tube', '#d040c0'],
    ['J', 'hair line (links beyond 192)', '#8fa3c8'], ['K', 'hand-over arc (selection change)', '#9fd8ff'], ['L', 'Main landmark (star, rings)', '#ffd36b'],
    ['M', 'zeta zero on the critical line', '#fff0d0'], ['N', 'hover marker', '#ffd133'],
  ];
  const DEBUG = { bubbles: 24, sats: 10, imp: 6, con: 4, hair: 3, zeros: 3, size: 0.02 };      // size: label height at the default 80° view; kept constant on screen when zooming
  let dbgGroup = null; const dbgMats = {}, dbgPool = [];
  function dbgMat(letter) {
    if (dbgMats[letter]) return dbgMats[letter];
    const col = (DEBUG_KINDS.find((k) => k[0] === letter) || [0, 0, '#fff'])[2], cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const x = cv.getContext('2d');
    if (x) { x.fillStyle = 'rgba(6,10,20,.82)'; roundRect(x, 4, 4, 56, 56, 12); x.fill(); x.strokeStyle = col; x.lineWidth = 4; roundRect(x, 4, 4, 56, 56, 12); x.stroke();
      x.fillStyle = col; x.font = `bold 40px ${SANS}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(letter, 32, 35); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    return (dbgMats[letter] = new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false }));
  }
  /** label size: the same on screen in the miniature (world scale) and while zooming (a narrower view would magnify it) */
  const dbgScale = () => DEBUG.size * Math.tan((S.fov || 80) * Math.PI / 360) / Math.tan(40 * Math.PI / 180) / Math.max(world.scale.x, 1e-4);
  // really in the headset: A-Frame also sets 'vr-mode' for its desktop fullscreen fallback, where the mouse must keep working and no beams belong
  const inVR = () => { const sc = document.querySelector('a-scene'), xr = sc && sc.renderer && sc.renderer.xr; return !!(xr && xr.isPresenting); };
  function toggleDebug() { S.debug = !S.debug; S.dbgPick = 0; if (dbgGroup) dbgGroup.visible = S.debug; if (panels.menu) panels.menu.dirty = true; }
  /** the labels of this frame: [{ letter, p: Vector3 in world-local coordinates }] */
  function debugLabels() {
    const out = [], V = (x, y, z) => new THREE.Vector3(x, y, z), add = (letter, p) => out.push({ letter, p });
    if (S.view !== 'tower') return out;
    const c = core;
    if (c && c.group.visible && c.target === 1) {
      const g = c.group.position, s = c.group.scale.x;
      add('A', V(g.x + CORE_R * s, g.y + 0.35 * CORE_R * s, g.z)); add('B', V(g.x, g.y + c.heart.scale.x * s * 1.2, g.z)); add('C', V(g.x - 0.6 * c.heart.scale.x * s, g.y, g.z));
      for (let k = 0; k < Math.min(DEBUG.sats, c.orbit.length); k++) add('D', c.satPos[k].clone().multiplyScalar(s).add(g));
    }
    // bubbles: the ones nearest to the viewer (re-picked a few times per second)
    const now = performance.now();
    if (!S.dbgPick || now - S.dbgPick > 300) {
      S.dbgPick = now; const cam = camEl.object3D.getWorldPosition(new THREE.Vector3()); world.worldToLocal(cam); const P = S.pos;
      S.dbgNear = solidList.map((e) => ({ e, d: (P[3 * e.i] - cam.x) ** 2 + (P[3 * e.i + 1] - cam.y) ** 2 + (P[3 * e.i + 2] - cam.z) ** 2 })).sort((a, b) => a.d - b.d).slice(0, DEBUG.bubbles).map((x) => x.e);
    }
    for (const e of S.dbgNear || []) if (solidList.includes(e)) add(e.kind === 1 ? 'E' : e.kind === 2 ? 'F' : 'G', V(S.pos[3 * e.i], S.pos[3 * e.i + 1], S.pos[3 * e.i + 2]));
    // connections: the middle of a few fibres / tubes of each kind, and of the first hair lines
    const tubes = S.links === 'tubes', geo = tubes ? ribbons.geometry : fibers.geometry, per = tubes ? (RIB.segs + 1) * RIB.sides : (FIB.segs + 1) * 2;
    const mid = tubes ? (RIB.segs / 2) * RIB.sides : (FIB.segs / 2) * 2, pa = geo.attributes.position.array; let ni = 0, nc = 0;
    if (geo.drawRange.count > 0) (S.nearKinds || []).forEach((kind, k) => {
      if (kind === 0 ? ni++ >= DEBUG.imp : nc++ >= DEBUG.con) return; const v = k * per + mid; add(kind === 0 ? 'H' : 'I', V(pa[3 * v], pa[3 * v + 1], pa[3 * v + 2]));
    });
    for (let k = 0; k < Math.min(DEBUG.hair, lines.geometry.drawRange.count / 2); k++) { const o = k * 6; add('J', V((linePos[o] + linePos[o + 3]) / 2, (linePos[o + 1] + linePos[o + 4]) / 2, (linePos[o + 2] + linePos[o + 5]) / 2)); }
    for (const Lk of links) if (Lk.line.visible) add('K', Lk.dot.visible ? Lk.dot.position.clone() : Lk.line.geometry.attributes.position.array.slice(36, 39).reduce((v, x, q) => (v.setComponent(q, x), v), new THREE.Vector3()));
    if (beacon && beacon.group.visible) {
      const b = beacon.group.position; add('L', V(b.x + 0.25, b.y + 0.25, b.z));
      L.zeroHeights(L.ZETA_ZEROS).slice(0, DEBUG.zeros).forEach((h) => add('M', V(b.x + 0.06, b.y + ZERO.y0 + h * ZERO.span, b.z)));
    }
    if (hoverMark.visible) add('N', hoverMark.position.clone().add(V(0.1, 0.1, 0)));
    return out;
  }
  function debugTick() {
    if (!S.debug || !dbgGroup) return;
    const labels = debugLabels();
    while (dbgPool.length < labels.length) { const sp = new THREE.Sprite(dbgMat('A')); sp.center.set(-0.15, -0.15); sp.renderOrder = 999; sp.frustumCulled = false; dbgPool.push(sp); dbgGroup.add(sp); }
    dbgPool.forEach((sp, k) => {
      const l = labels[k]; sp.visible = !!l; if (!l) return;
      sp.material = dbgMat(l.letter); sp.userData.letter = l.letter; sp.position.copy(l.p); const k2 = dbgScale(); sp.scale.set(k2, k2, 1);
    });
  }
  const hideLinks = () => { lines.geometry.setDrawRange(0, 0); ribbons.geometry.setDrawRange(0, 0); fibers.geometry.setDrawRange(0, 0); for (const c of cores) c.shellMat.uniforms.uDockN.value = 0; };
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
  const raycaster = new THREE.Raycaster();

  function buildScene() {
    world = $('world').object3D; panelsEl = $('panels'); camEl = $('cam');
    const n = S.n, yStep = S.meta.yStep, maxD = S.meta.maxDepth;
    S.stF = new Float32Array(n); S.hiF = new Float32Array(n);
    for (let i = 0; i < n; i++) S.stF[i] = S.st[i];
    const nsF = new Float32Array(n), dF = new Float32Array(n);
    for (let i = 0; i < n; i++) { nsF[i] = S.ns[i]; dF[i] = S.depth[i] / maxD; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(S.pos, 3));
    g.setAttribute('aState', new THREE.BufferAttribute(S.stF, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aNs', new THREE.BufferAttribute(nsF, 1));
    g.setAttribute('aDepth', new THREE.BufferAttribute(dF, 1));
    g.setAttribute('aHi', new THREE.BufferAttribute(S.hiF, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSpine', new THREE.BufferAttribute(new Float32Array(n), 1));   // 1 = reached by the spine tree (filled when that layout is first loaded)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, maxD * yStep / 2, 0), 60);
    ptsMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: 0.03 }, uTime: { value: 0 }, uMode: { value: 0 }, uHideOpen: { value: 0 }, uHiOn: { value: 0 }, uScale: { value: 1 }, uHiA: { value: 1 }, uHiS: { value: 1 }, uHiOnly: { value: 0 }, uSpine: { value: 0 } },
    });
    pts = new THREE.Points(g, ptsMat); pts.frustumCulled = false; world.add(pts);
    // halo: the SAME geometry (no extra buffers) and the SAME uniform objects, drawn bigger/softer/additive on top
    const haloMat = new THREE.ShaderMaterial({ vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...ptsMat.uniforms, uGlow: { value: GLOW.strength }, uGlowOpen: { value: 0 }, uHaloScale: { value: GLOW.scale } } });
    ptsHalo = new THREE.Points(g, haloMat); ptsHalo.frustumCulled = false; ptsHalo.renderOrder = 2; world.add(ptsHalo);
    // 3D bubbles (instanced ellipsoids) for the connected / compiling modules
    S.solidF = new Float32Array(n);
    g.setAttribute('aSolid', new THREE.BufferAttribute(S.solidF, 1).setUsage(THREE.DynamicDrawUsage));
    // a smooth indexed UV sphere (24x16: ~425 vertices); an 80-face icosahedron showed a polygonal outline up close
    const ball = new THREE.SphereGeometry(1, SOLID.segs, SOLID.rings), sg = new THREE.InstancedBufferGeometry();
    sg.setIndex(ball.index); sg.setAttribute('position', ball.attributes.position); sg.setAttribute('normal', ball.attributes.normal);
    for (const [name, size] of [['aCenter', 3], ['aKind', 1], ['aSeed', 1]]) sg.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(SOLID.max * size), size).setUsage(THREE.DynamicDrawUsage));
    sg.instanceCount = 0;
    const pu = ptsMat.uniforms;
    solids = new THREE.Mesh(sg, new THREE.ShaderMaterial({ vertexShader: SOLID_V, fragmentShader: SOLID_F, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: pu.uTime, uSize: pu.uSize, uScale: pu.uScale, uHiA: pu.uHiA, uHiS: pu.uHiS, uWorldScale: { value: 1 }, uMinPx: { value: SOLID.minPx }, uWobble: { value: SOLID.wobble }, uTempo: { value: SOLID.tempo }, uLiveSize: { value: SOLID.liveSize } } }));
    solids.frustumCulled = false; solids.renderOrder = 1; world.add(solids);
    dbgGroup = new THREE.Group(); dbgGroup.visible = !!S.debug; world.add(dbgGroup);

    // packets cloud
    const np = S.meta.packets;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(S.pkPos, 3));
    S.pkFrac = new Float32Array(np); S.pkOurs = new Float32Array(np); S.pkSz = new Float32Array(np);
    pg.setAttribute('aFrac', new THREE.BufferAttribute(S.pkFrac, 1).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aOursFrac', new THREE.BufferAttribute(S.pkOurs, 1).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSz', new THREE.BufferAttribute(S.pkSz, 1).setUsage(THREE.DynamicDrawUsage));
    pg.boundingSphere = g.boundingSphere;
    pkMat = new THREE.ShaderMaterial({ vertexShader: PK_VERT, fragmentShader: PK_FRAG, transparent: true, depthWrite: false, uniforms: { uScale: { value: 1 } } });
    pkPts = new THREE.Points(pg, pkMat); pkPts.frustumCulled = false; pkPts.visible = false; world.add(pkPts);
    const pkHaloMat = new THREE.ShaderMaterial({ vertexShader: PK_HALO_VERT, fragmentShader: PK_HALO_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: pkMat.uniforms.uScale, uGlow: { value: GLOW.pk } } });
    pkHalo = new THREE.Points(pg, pkHaloMat); pkHalo.frustumCulled = false; pkHalo.visible = false; pkHalo.renderOrder = 2; world.add(pkHalo);
    { const v = loadGlow(); if (v !== null) S.glow = v; } applyGlow();

    // markers + neighbour lines
    cores.push(makeCore(), makeCore()); for (const c of cores) world.add(c.group); core = cores[0];
    for (const o of makeLink()) world.add(o);
    mainIdx = S.nameIdx.has('Main') ? S.nameIdx.get('Main') : -1;
    if (mainIdx >= 0) { beacon = makeBeacon(); beacon.group.position.set(S.pos[3 * mainIdx], S.pos[3 * mainIdx + 1], S.pos[3 * mainIdx + 2]); world.add(beacon.group); }
    if (window.RHAudio) { sound = window.RHAudio.create({ maxDepth: S.meta.maxDepth, onState: () => { if (panels.menu) panels.menu.dirty = true; } }); const v = loadVolume(); if (v !== null) sound.setVolume(v); }
    hoverMark = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd133, wireframe: true })); hoverMark.visible = false; world.add(hoverMark);
    selMark = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true })); selMark.visible = false; world.add(selMark);
    const MAXL = 800;
    linePos = new Float32Array(MAXL * 6); lineCol = new Float32Array(MAXL * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .8, depthWrite: false }));
    lines.frustumCulled = false; world.add(lines);
    lines.material.opacity = 0.30;                       // the hair lines are only the haze behind the ribbons now
    const MAXV = RIB.max * (RIB.segs + 1) * RIB.sides, MAXI = RIB.max * RIB.segs * RIB.sides * 6, rg = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['aNrm', 3], ['aT', 1], ['aDir', 1], ['aPhase', 1], ['aKind', 1]]) rg.setAttribute(name, new THREE.BufferAttribute(new Float32Array(MAXV * size), size).setUsage(THREE.DynamicDrawUsage));
    rg.setIndex(new THREE.BufferAttribute(new Uint32Array(MAXI), 1).setUsage(THREE.DynamicDrawUsage)); rg.setDrawRange(0, 0);
    ribbons = new THREE.Mesh(rg, new THREE.ShaderMaterial({ vertexShader: RIB_V, fragmentShader: RIB_F, side: THREE.FrontSide,      // opaque + depth: tubes hide each other = 3D
      uniforms: { uTime: { value: 0 }, uWidth: { value: RIB.width }, uMinPx: { value: RIB.minPx }, uWorldScale: { value: 1 }, uSpeed: { value: RIB.speed }, uFreq: { value: RIB.freq } } }));
    ribbons.frustumCulled = false; ribbons.renderOrder = 1; world.add(ribbons);
    const FV = RIB.max * (FIB.segs + 1) * 2, FI = RIB.max * FIB.segs * 6, fg = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['aTan', 3], ['aSide', 1], ['aT', 1], ['aDir', 1], ['aPhase', 1], ['aKind', 1]]) fg.setAttribute(name, new THREE.BufferAttribute(new Float32Array(FV * size), size).setUsage(THREE.DynamicDrawUsage));
    fg.setIndex(new THREE.BufferAttribute(new Uint32Array(FI), 1).setUsage(THREE.DynamicDrawUsage)); fg.setDrawRange(0, 0);
    fibers = new THREE.Mesh(fg, new THREE.ShaderMaterial({ vertexShader: FIB_V, fragmentShader: FIB_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uWidth: { value: FIB.width }, uMinPx: { value: FIB.minPx }, uWorldScale: { value: 1 }, uSpeed: { value: FIB.speed }, uFreq: { value: FIB.freq }, uConSpeed: { value: FIB.conSpeed } } }));
    fibers.frustumCulled = false; fibers.renderOrder = 2; world.add(fibers);
    { const v = loadLinks(); if (v) S.links = v; }

    // depth rulers (re-oriented in updateRulers() depending on which side of the ring the viewer is)
    for (let d = 0; d <= maxD; d += 25) for (let a = 0; a < 4; a++) {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
      const cx = cv.getContext('2d'); cx.fillStyle = 'rgba(8,12,22,.7)'; cx.fillRect(0, 0, 256, 64);
      cx.fillStyle = '#9fb3dd'; cx.font = `bold 34px ${SANS}`; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText('depth ' + d, 128, 34);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.2), new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, toneMapped: false }));
      const ang = a * Math.PI / 2, r = 4.3;
      m.position.set(r * Math.cos(ang), d * yStep, r * Math.sin(ang)); m.userData.ang = ang; rulers.push(m); world.add(m);
    }

    // panels
    // panels on a gentle arc around the viewer, each turned to face them (deg: 0 = straight ahead, + = to the right)
    const mk = (name, w, h, pw, ph, paint, deg, y, rx, R) => {
      const p = new Panel(name, w, h, pw, ph, paint), t = deg * Math.PI / 180; R = R || 1.8;
      p.mesh.position.set(R * Math.sin(t), y, -R * Math.cos(t)); p.mesh.rotation.set(rx || 0, -t, 0, 'YXZ');
      panelsEl.object3D.add(p.mesh); return p;
    };
    mk('menu', 0.62, 0.962, 900, 1390, paintMenu, -38, 1.4);      // 1390 px: room for the Debug row and its legend
    mk('log', 1.5, 1.007, 1400, 940, paintLog, 0, 1.5);        // centre and the widest: it is the part that moves
    mk('source', 1.2, 0.883, 1400, 1030, paintSource, 45, 1.45);
    mk('info', 0.8, 0.41, 900, 460, paintInfo, 0, 0.72, -0.4, 1.6);
    syncSourcePanel();
    applyState(S.st); applyUniforms();
    for (const k in panels) panels[k].dirty = true;
  }

  /** the source panel only exists while a module is selected (an empty giant panel was just noise) */
  function syncSourcePanel() { if (panels.source) panels.source.mesh.visible = S.sel >= 0; }
  /** dim/shrink the highlighted ancestry when it is huge (only meaningful with Closure on: otherwise only direct imports are lit) */
  function applyHiScale() {
    const hs = S.closureOn && S.sel >= 0 ? L.hiScale(S.ancestors) : { a: 1, s: 1 };
    ptsMat.uniforms.uHiA.value = hs.a; ptsMat.uniforms.uHiS.value = hs.s;
  }
  function applyUniforms() {
    applyHiScale();
    ptsMat.uniforms.uMode.value = S.color; ptsMat.uniforms.uHideOpen.value = S.hideOpen ? 1 : 0;
    const hiOn = (S.closureOn && S.sel >= 0 || S.selPk >= 0);
    ptsMat.uniforms.uHiOn.value = hiOn ? 1 : 0;
    ptsMat.uniforms.uHiOnly.value = hiOn && S.closureOnly ? 1 : 0;      // 'only' needs something selected, or everything would vanish
  }
  function setView(v) {
    S.view = v; pts.visible = solids.visible = v === 'tower'; pkPts.visible = v === 'packets'; applyGlow(); rebuildSolids();
    S.hover = -1; S.hoverPk = -1; hoverMark.visible = false; lines.visible = ribbons.visible = fibers.visible = v === 'tower';
    panels.menu.dirty = panels.info.dirty = true;
  }
  function setColor(m) { S.color = m; applyUniforms(); panels.menu.dirty = true; }
  function toggleMini() {
    S.mini = !S.mini; panels.menu.dirty = true; S.grab = null; S.yawTarget = null; S.bringPrev = null; applyWorldTransform();
  }
  function applyWorldTransform() {
    if (S.mini) { world.scale.setScalar(S.scale); if (!S.miniPlaced) { world.position.set(0, 0.75, -1.6); S.miniPlaced = true; } }
    else { world.scale.setScalar(1); world.position.y = 1.6 - S.focus; world.position.x = 0; world.position.z = 0; S.miniPlaced = false; }
    applyScaleUniforms(); updateRulers(true);
  }
  /** dots must not vanish when the model is small: size scale follows the model scale up to 1 */
  function applyScaleUniforms() {
    const ps = S.mini ? Math.min(1, 3.75 * S.scale) : 1;
    ptsMat.uniforms.uScale.value = ps; pkMat.uniforms.uScale.value = ps;
  }
  function scaleMini(f) {
    if (!S.mini) { S.mini = true; panels.menu.dirty = true; world.position.set(0, 0.75, -1.6); S.miniPlaced = true; }
    S.scale = Math.max(0.03, Math.min(0.6, S.scale * f)); world.scale.setScalar(S.scale); applyScaleUniforms();
  }
  /**
   * Put the tower around your head, so the dots surround you at close range ("head inside the points").
   * The tower axis goes through the head, at the height of the selected module (or the current focus).
   */
  function bringToMe() {
    if (S.bringPrev) {   // second press: put everything back exactly as it was
      const p = S.bringPrev; S.bringPrev = null;
      S.mini = p.mini; S.scale = p.scale; world.position.copy(p.pos); world.rotation.y = p.rotY; S.miniPlaced = p.placed; S.grab = null; S.yawTarget = null;
      applyWorldTransform(); panels.menu.dirty = true; return;
    }
    S.bringPrev = { mini: S.mini, scale: S.scale, pos: world.position.clone(), rotY: world.rotation.y, placed: S.miniPlaced };
    panels.menu.dirty = true;    // the button turns into "Back" even when the miniature was already on
    if (!S.mini) { S.mini = true; panels.menu.dirty = true; world.scale.setScalar(S.scale); }
    const head = camEl.object3D.getWorldPosition(new THREE.Vector3());
    const level = (S.sel >= 0 ? S.depth[S.sel] * S.meta.yStep : S.focus);
    world.position.set(head.x, head.y - level * S.scale, head.z); S.miniPlaced = true;
    applyScaleUniforms(); updateRulers(true);
  }
  /** Clean view for recording: panels, the hint text and A-Frame's VR button all go away. */
  /** the pointer left the window / the window lost focus: nothing is hovered any more (the marker used to stay where it was last) */
  function clearHover() {
    S.hover = -1; S.hoverPk = -1; S.hoverSat = -1; S.overPanel = null; if (hoverMark) hoverMark.visible = false;
    if (S.hoverBtn) { S.hoverBtn.panel.dirty = true; S.hoverBtn = null; }
    if (panels.info) panels.info.dirty = true;
  }
  function toggleUI() {
    S.uiHidden = !S.uiHidden; if (S.uiHidden && hoverMark) hoverMark.visible = false;
    panelsEl.object3D.visible = !S.uiHidden;
    for (const m of rulers) m.visible = !S.uiHidden;      // the "depth 25" labels are UI too (spineTick hides them in the spine layout)
    const hud = $('hud'); if (hud) hud.style.display = S.uiHidden ? 'none' : '';
    const vrb = document.querySelector('.a-enter-vr'); if (vrb) vrb.style.display = S.uiHidden ? 'none' : '';
  }
  /** A plane's front faces +Z.  Normal pointing to the axis when the camera is inside the ring, away from it outside. */
  function updateRulers(force) {
    if (!rulers.length || !camEl) return;
    world.updateWorldMatrix(true, false);
    const head = camEl.object3D.getWorldPosition(new THREE.Vector3()).applyMatrix4(tmpM.copy(world.matrixWorld).invert());
    const inward = Math.hypot(head.x, head.z) < 4.3;
    if (!force && inward === rulerInward) return;
    rulerInward = inward;
    for (const m of rulers) { const a = m.userData.ang, k = inward ? -1 : 1; m.rotation.set(0, Math.atan2(k * Math.cos(a), k * Math.sin(a)), 0); }
  }
  function recenter() {
    // NB: camEl.object3D is a plain Object3D in A-Frame (the real camera is its child), so getWorldDirection()
    // would return +Z, i.e. behind the viewer.  Use the orientation explicitly: forward is -Z.
    const cam = camEl.object3D; cam.getWorldPosition(tmpV); cam.getWorldQuaternion(tmpQ);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ);
    panelsEl.object3D.position.set(tmpV.x, 0, tmpV.z);
    panelsEl.object3D.rotation.y = Math.atan2(-dir.x, -dir.z);
  }

  // ------------------------------------------------------------------ state updates
  function applyState(buf) {
    S.st = buf;
    const now = performance.now();
    for (let i = 0; i < S.n; i++) S.stF[i] = buf[i];
    for (const [i, until] of S.live) { if (until > now) S.stF[i] = 4; else S.live.delete(i); }
    pts.geometry.attributes.aState.needsUpdate = true;
    S.pkStats = L.packetStats(S.n, S.pk, buf, S.meta.packets);
    const ps = S.pkStats;
    for (let k = 0; k < S.meta.packets; k++) {
      const t = ps.tot[k] || 1;
      S.pkFrac[k] = (ps.done[k] + ps.ours[k]) / t; S.pkOurs[k] = ps.ours[k] / t; S.pkSz[k] = 0.7 + 0.8 * ((ps.open[k] + ps.assigned[k]) / t);
    }
    for (const a of ['aFrac', 'aOursFrac', 'aSz']) pkPts.geometry.attributes[a].needsUpdate = true;
    for (const k in panels) panels[k].dirty = true;
  }
  async function pollStatus() {
    try {
      S.status = await jget('/api/status'); S.statusAt = performance.now(); soundLoad(S.status.sys);
      for (const m of S.status.compiling || []) { if (!S.live.has(m.i)) S.solidsDirty = true; S.live.set(m.i, performance.now() + 12000); S.stF[m.i] = 4; S.dirtyState = true; }
      coreTelemetry(); followStep(S.status.compiling);
      panels.log.dirty = true; panels.menu.dirty = true;
    } catch (e) { /* server restarting */ }
  }
  async function pollState() {
    try {
      const [b, st] = await Promise.all([bget('/api/state'), jget('/api/status')]);
      applyState(new Uint8Array(b)); S.status = st; panels.menu.dirty = panels.log.dirty = true;
    } catch (e) { /* server restarting */ }
  }
  function liveBuilt(i) {
    S.live.set(i, performance.now() + 9000); S.stF[i] = 4; S.dirtyState = true; S.solidsDirty = true;
    S.builtNow.add(i);                                       // built in this session (the state poll catches up within 8 s)
  }
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.k === 'built') {
        S.logLines.push({ pre: `✔ ${ev.n}/${ev.N}  ${ev.s.toFixed(1)}s  `, name: ev.name, color: '#7be495' });
        if (!ev.old) { liveBuilt(ev.i); soundModule(ev.i); }
      } else if (ev.k === 'line') {
        // the Lean linter chatter (Note:/warning:) is noise here; keep only real problems
        if (/error|✖|failed|sorry|declaration uses/i.test(ev.text) && !/linter/i.test(ev.text)) S.logLines.push({ text: ev.text, color: '#ff6b6b' });
      } else if (ev.k === 'status') { S.packetLines = ev.lines; soundPacketLines(ev.lines); }
      if (S.logLines.length > 200) S.logLines.splice(0, 100);
      panels.log.dirty = true;
    };
  }

  // ------------------------------------------------------------------ selection
  let pendingDocks = [];
  function setDocks(c, docks) {
    if (!c) return; const u = c.shellMat.uniforms;
    docks.forEach((x, k) => { u.uDock.value[k].set(x.d[0], x.d[1], x.d[2]); u.uDockPh.value[k] = x.ph; });
    u.uDockN.value = docks.length;
  }
  function cycleLinks() {
    S.links = S.links === 'tubes' ? 'fibers' : 'tubes';
    try { localStorage.setItem('rh.links', S.links); } catch (e) { /* private window */ }
    if (S.sel >= 0 && S.morph == null) select(S.sel, true);
    panels.menu.dirty = true;
  }
  function firstOfPacket(k) { for (let i = 0; i < S.n; i++) if (S.pk[i] === k) return i; return -1; }
  function clearSel() {
    S.sel = -1; S.selPk = -1; S.hiF.fill(0); pts.geometry.attributes.aHi.needsUpdate = true;
    selMark.visible = false; coreHide(); hideLinks(); applyUniforms(); rebuildSolids();
    S.src.tok = null; S.src.hl = null; S.decls = []; S.hoverSat = -1; S.src.name = ''; S.src.error = ''; S.src.loading = false;
    panels.info.dirty = panels.source.dirty = true; syncSourcePanel();
  }
  function select(i, keepSrc) {
    S.sel = i; S.selPk = -1; S.hiF.fill(0); S.impCur = 0; S.conCur = 0;
    const c = S.csr;
    if (S.closureOn) {
      const { mark, count } = L.closureImports(c, i); S.ancestors = count;
      for (let k = 0; k < S.n; k++) if (mark[k] === 1) S.hiF[k] = 1;
    } else {
      S.ancestors = L.closureImports(c, i).count;
      for (let k = c.impStart[i]; k < c.impStart[i + 1]; k++) S.hiF[c.impList[k]] = 1;
    }
    const nb = [], P = S.pos, ax = P[3 * i], ay = P[3 * i + 1], az = P[3 * i + 2];
    for (let k = c.impStart[i]; k < c.impStart[i + 1]; k++) { const j = c.impList[k]; nb.push({ j, kind: 0, d: Math.hypot(P[3 * j] - ax, P[3 * j + 1] - ay, P[3 * j + 2] - az) }); }
    for (let k = c.conStart[i]; k < c.conStart[i + 1]; k++) { const j = c.conList[k]; S.hiF[j] = 2; nb.push({ j, kind: 1, d: Math.hypot(P[3 * j] - ax, P[3 * j + 1] - ay, P[3 * j + 2] - az) }); }
    nb.sort((u, v) => u.d - v.d);
    // the nearest RIB.max become fibres (or tubes, K) ...
    const start = RIB.start * (i === mainIdx ? CROWN_SCALE : 1), near = nb.slice(0, RIB.max).map((e) => ({ a: [ax, ay, az], b: [P[3 * e.j], P[3 * e.j + 1], P[3 * e.j + 2]], kind: e.kind, phase: ((e.j * 2654435761) >>> 0) / 4294967296 }));
    S.nearKinds = near.map((e) => e.kind);
    for (const c of cores) c.shellMat.uniforms.uDockN.value = 0;
    ribbons.geometry.setDrawRange(0, 0); fibers.geometry.setDrawRange(0, 0);
    if (S.links === 'tubes') {
      const R = L.buildTubes(near, RIB.segs, RIB.sides, start);
      const ra = ribbons.geometry.attributes; ra.position.array.set(R.pos); ra.aNrm.array.set(R.nrm); ra.aT.array.set(R.t); ra.aDir.array.set(R.dir); ra.aPhase.array.set(R.phase); ra.aKind.array.set(R.kind);
      ribbons.geometry.index.array.set(R.index); for (const k in ra) ra[k].needsUpdate = true; ribbons.geometry.index.needsUpdate = true; ribbons.geometry.setDrawRange(0, R.indexCount);
    } else {
      const F = L.buildFibers(near, FIB.segs, start);
      const fa = fibers.geometry.attributes; fa.position.array.set(F.pos); fa.aTan.array.set(F.tan); fa.aSide.array.set(F.side); fa.aT.array.set(F.t); fa.aDir.array.set(F.dir); fa.aPhase.array.set(F.phase); fa.aKind.array.set(F.kind);
      fibers.geometry.index.array.set(F.index); for (const k in fa) fa[k].needsUpdate = true; fibers.geometry.index.needsUpdate = true; fibers.geometry.setDrawRange(0, F.indexCount);
      pendingDocks = near.map((e, k) => ({ d: F.dock[k], ph: e.phase, kind: e.kind })).filter((x) => x.kind === 0).slice(0, FIB.docks);
    }
    // ... the rest is faint hair
    let nl = 0;
    for (const e of nb.slice(RIB.max)) {
      if (nl >= 800) break; const j = e.j, [r, g, b] = e.kind === 0 ? [0, 1, 1] : [1, .3, .9];
      linePos.set([ax, ay, az, P[3 * j], P[3 * j + 1], P[3 * j + 2]], nl * 6); lineCol.set([r, g, b, r, g, b], nl * 6); nl++;
    }
    S.hiF[i] = 3;
    lines.geometry.attributes.position.needsUpdate = true; lines.geometry.attributes.color.needsUpdate = true; lines.geometry.setDrawRange(0, nl * 2);
    pts.geometry.attributes.aHi.needsUpdate = true;
    selMark.visible = false; coreShow(i); setDocks(core, S.links === 'fibers' ? pendingDocks : []);
    applyUniforms(); rebuildSolids(); panels.info.dirty = true; syncSourcePanel();
    if (!keepSrc) loadSource(i);
  }
  function selectPacket(k) {
    S.selPk = k; S.sel = -1; S.hiF.fill(0);
    for (let i = 0; i < S.n; i++) if (S.pk[i] === k) S.hiF[i] = 3;
    pts.geometry.attributes.aHi.needsUpdate = true; hideLinks(); selMark.visible = false; coreHide(); rebuildSolids();
    applyUniforms(); panels.info.dirty = true; syncSourcePanel();
  }
  /** Desktop zoom (field of view); in VR the headset decides. */
  // zoom = magnification 1/tan(fov/2).  Limits: 2x further in and 2x further out than the old 20..100 degrees.
  const fovFor = (fov, k) => 2 * Math.atan(Math.tan(fov * Math.PI / 360) * k) * 180 / Math.PI;
  const FOV_MIN = fovFor(20, 0.5), FOV_MAX = fovFor(100, 2), ZOOM_STEP = 1.12;
  /** k < 1 zooms in, k > 1 out (same ratio at every zoom level, so the steps feel even) */
  function zoomBy(k) { setFov(fovFor(S.fov, k)); }
  function setFov(v) {
    S.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, v));
    if (camEl && camEl.setAttribute) camEl.setAttribute('camera', 'fov', S.fov);
  }
  /** Closure: off (everything normal) -> dim (rest at 22%) -> only (rest hidden completely) -> off */
  function cycleClosure() {
    if (!S.closureOn) { S.closureOn = true; S.closureOnly = false; }
    else if (!S.closureOnly) S.closureOnly = true;
    else { S.closureOn = false; S.closureOnly = false; }
    if (S.sel >= 0) select(S.sel, true); else applyUniforms();
    if (panels.menu) panels.menu.dirty = true;
  }
  /** Follow live cycles: off -> camera (jump + turn to each new module) -> in place (the scene stays still, only the selection
   *  moves to each new module: its core, links and code appear where it is) -> off */
  function toggleFollow() {
    if (!S.follow) { S.follow = true; S.followStill = false; }
    else if (!S.followStill) S.followStill = true;
    else { S.follow = false; S.followStill = false; }
    S.followTarget = -1; panels.menu.dirty = true;
    if (S.follow) { followStep(S.status && S.status.compiling); pollStatus(); }
  }
  function stopFollow() { if (S.follow) { S.follow = false; S.followStill = false; S.followTarget = -1; panels.menu.dirty = true; } }
  /** Follow live: show the module Lean has been compiling the longest (heavy = interesting; a fast one would flicker). */
  function followStep(comp) {
    if (!S.follow || !comp || !comp.length) return;
    const t = comp.slice().sort((a, b) => b.secs - a.secs)[0];
    if (t.i === S.followTarget) return;
    S.followTarget = t.i;
    if (S.followStill) { if (S.view === 'tower') select(t.i); } else jumpTo(t.i);
  }
  /**
   * Turn the tower (about its own axis) so module i ends up straight ahead.  Inside the tower "ahead" is where the
   * camera looks; in the miniature it is the side facing the viewer.  Angles use the convention a rotation of the
   * world by t about Y turns the direction angle atan2(-x, -z) by +t.
   */
  function faceModule(i) {
    const lx = S.pos[3 * i], lz = S.pos[3 * i + 2], alpha = Math.atan2(-lx, -lz);
    const head = camEl.object3D.getWorldPosition(new THREE.Vector3());
    let psi;
    if (S.mini) psi = Math.atan2(-(head.x - world.position.x), -(head.z - world.position.z));      // module on the viewer's side of the model
    else { const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camEl.object3D.getWorldQuaternion(new THREE.Quaternion())); psi = Math.atan2(-f.x, -f.z); }
    S.yawTarget = alpha !== alpha || psi !== psi ? null : psi - alpha;
  }
  function jumpTo(i) { if (S.view !== 'tower') setView('tower'); select(i); S.focusTarget = S.depth[i] * S.meta.yStep; faceModule(i); }
  function stepNeighbor(dir) {
    if (S.sel < 0) return; stopFollow(); const c = S.csr, i = S.sel;
    if (dir < 0) { const m = c.impStart[i + 1] - c.impStart[i]; if (m) { const j = c.impList[c.impStart[i] + (S.impCur++ % m)]; jumpTo(j); } }
    else { const m = c.conStart[i + 1] - c.conStart[i]; if (m) { const j = c.conList[c.conStart[i] + (S.conCur++ % m)]; jumpTo(j); } }
  }

  // ------------------------------------------------------------------ pointing
  function pickInWorld(o, d) {
    world.updateMatrixWorld(true);
    tmpM.copy(world.matrixWorld).invert();
    const lo = o.clone().applyMatrix4(tmpM), ld = d.clone().transformDirection(tmpM);
    if (S.view === 'tower') return { node: L.pickPoint(S.pos, S.n, lo, ld, S.st, S.hideOpen, 0.02), pk: -1 };
    return { node: -1, pk: L.pickPoint(S.pkPos, S.meta.packets, lo, ld, null, false, 0.05) };
  }
  function panelHit(o, d) {
    if (!panelsEl.object3D.visible) return null;
    panelsEl.object3D.updateMatrixWorld(true);
    raycaster.set(o, d); raycaster.far = 12;
    const hit = raycaster.intersectObjects(Object.values(panels).filter((p) => p.mesh.visible).map((p) => p.mesh), false)[0];
    if (!hit) return null;
    const p = hit.object.userData.panel;
    return { panel: p, btn: p.hit(hit.uv.x, hit.uv.y), dist: hit.distance };
  }
  /** Returns what the ray points at; with click=true also performs the action. */
  function interact(o, d, click) {
    const ph = panelHit(o, d);
    if (ph) {
      const prev = S.hoverBtn; S.hoverBtn = ph.btn;
      if (prev !== S.hoverBtn) { (prev ? prev.panel : ph.panel).dirty = true; ph.panel.dirty = true; }
      if (click && ph.btn) { ph.btn.fn(); ph.panel.dirty = true; }
      S.overPanel = ph.panel; S.lastNodeDist = null; return ph.btn ? 'button' : 'panel';
    }
    if (S.hoverBtn) { S.hoverBtn.panel.dirty = true; S.hoverBtn = null; }
    S.overPanel = null; S.lastNodeDist = null;
    if (S.view === 'tower' && S.sel >= 0) {
      const sat = coreSatPick(o, d);
      if (sat) {
        if (S.hoverSat !== sat.k) { S.hoverSat = sat.k; panels.info.dirty = true; }
        hoverMark.visible = false; S.lastNodeDist = sat.dist;
        if (click) { stopFollow(); jumpToDecl(sat.k); }
        return 'node';
      }
      if (S.hoverSat !== -1) { S.hoverSat = -1; panels.info.dirty = true; }
    }
    const r = pickInWorld(o, d);
    if (S.view === 'tower') {
      if (r.node !== S.hover) { S.hover = r.node; panels.info.dirty = true; }
      hoverMark.visible = r.node >= 0 && !S.uiHidden;
      if (r.node >= 0) { hoverMark.position.set(S.pos[3 * r.node], S.pos[3 * r.node + 1], S.pos[3 * r.node + 2]); S.lastNodeDist = tmpV.copy(hoverMark.position).applyMatrix4(world.matrixWorld).distanceTo(o); }
      if (click && r.node >= 0) { stopFollow(); select(r.node); }
      return r.node >= 0 ? 'node' : 'none';
    } else {
      if (r.pk !== S.hoverPk) { S.hoverPk = r.pk; panels.info.dirty = true; }
      hoverMark.visible = r.pk >= 0 && !S.uiHidden;
      if (r.pk >= 0) { hoverMark.position.set(S.pkPos[3 * r.pk], S.pkPos[3 * r.pk + 1], S.pkPos[3 * r.pk + 2]); S.lastNodeDist = tmpV.copy(hoverMark.position).applyMatrix4(world.matrixWorld).distanceTo(o); }
      if (click && r.pk >= 0) selectPacket(r.pk);
      return r.pk >= 0 ? 'node' : 'none';
    }
  }
  /**
   * The ray of a controller = exactly the one A-Frame draws as the laser.  laser-controls copies the device's
   * target-ray origin/direction (tilted/offset against the controller's -Z axis) into the entity's `raycaster`
   * component, so aiming along plain -Z lands noticeably off the visible beam.
   */
  function rayOf(el) {
    el.object3D.updateWorldMatrix(true, false);
    const rc = el.components && el.components.raycaster && el.components.raycaster.data;
    const lo = rc && rc.origin ? new THREE.Vector3(rc.origin.x, rc.origin.y, rc.origin.z) : new THREE.Vector3();
    const ld = rc && rc.direction ? new THREE.Vector3(rc.direction.x, rc.direction.y, rc.direction.z) : new THREE.Vector3(0, 0, -1);
    return { o: lo.applyMatrix4(el.object3D.matrixWorld), d: ld.transformDirection(el.object3D.matrixWorld) };
  }
  /**
   * Hand tracking: no controller, so aim like the system menus do - along the line from the shoulder through the
   * index fingertip.  The ray starts at the fingertip (same line), which is also where the visible beam starts.
   */
  function handRay(el) {
    const c = el.components && el.components['hand-tracking-controls'];
    if (!c || !c.hasPoses || el.object3D.visible === false || !c.indexTipPosition || c.indexTipPosition.lengthSq() === 0) return null;
    const head = camEl.object3D.getWorldPosition(new THREE.Vector3()), q = camEl.object3D.getWorldQuaternion(new THREE.Quaternion());
    const shoulder = new THREE.Vector3(el.id === 'rh' ? 0.17 : -0.17, -0.2, 0).applyQuaternion(q).add(head);
    const tip = c.indexTipPosition.clone();
    return { o: tip, d: tip.clone().sub(shoulder).normalize() };
  }
  const PTR = [['right', 'rc', 'ctrl'], ['left', 'lc', 'ctrl'], ['rhand', 'rh', 'hand'], ['lhand', 'lh', 'hand']];
  /** Everything currently able to point: connected controllers and tracked hands. */
  function pointers() {
    const out = [];
    for (const [id, elId, kind] of PTR) {
      const el = $(elId); if (!el) continue;
      let ray;
      if (kind === 'ctrl') {
        const tc = el.components && el.components['tracked-controls'];
        const connected = tc ? !!tc.controller : !!(el.components && el.components.raycaster);
        if (!connected) continue;
        ray = rayOf(el);
      } else ray = handRay(el);
      if (ray) out.push({ id, el, kind, ray });
    }
    return out;
  }
  const ptrById = (id) => pointers().find((p) => p.id === id);
  /** Hover: a pointer aimed at a panel wins, otherwise the one used last aims into the tower. */
  function hoverVR() {
    const ps = pointers(); S.nodeDist = {};
    if (!ps.length) return;
    for (const p of ps) if (panelHit(p.ray.o, p.ray.d)) { interact(p.ray.o, p.ray.d, false); return; }
    const use = ps.find((p) => p.id === S.hand) || ps[0];
    interact(use.ray.o, use.ray.d, false);
    S.nodeDist[use.id] = S.lastNodeDist;
  }

  // ------------------------------------------------------------------ laser beams
  // A-Frame clips its laser to the first *registered* object it hits (objects added with plain .add() are invisible to it,
  // the controller's own model is not), so it either pierced my panels or stopped 5 cm from the hand.  Draw our own beam
  // that ends exactly where our own picking lands.
  const beams = {};
  function makeBeam(parent) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    line.frustumCulled = false; line.renderOrder = 999; dot.renderOrder = 999;
    const grp = new THREE.Group(); grp.add(line, dot); grp.visible = false; parent.add(grp);
    return { grp, line, dot };
  }
  const BEAM_COLOR = { button: 0x40e0ff, panel: 0xdfe6f5, node: 0xffd133, none: 0x7f8fb3 };
  function beamTick(scene) {
    const vr = inVR();
    const live = {};
    if (vr) for (const p of pointers()) live[p.id] = p;
    for (const [id] of PTR) {
      if (!beams[id]) beams[id] = makeBeam(scene.object3D);
      const b = beams[id], p = live[id];
      b.grp.visible = !!p && !S.uiHidden;
      if (!p) continue;
      if (p.kind === 'ctrl') { const ln = p.el.getObject3D && p.el.getObject3D('line'); if (ln) ln.visible = false; }   // hide A-Frame's own (mis-clipped) line
      const r = p.ray, ph = panelHit(r.o, r.d);
      let len = 2.5, kind = 'none';
      if (ph) { len = ph.dist; kind = ph.btn ? 'button' : 'panel'; }
      else if (S.nodeDist[id] != null) { len = S.nodeDist[id]; kind = 'node'; }
      const pos = b.line.geometry.attributes.position;
      pos.setXYZ(0, r.o.x, r.o.y, r.o.z); pos.setXYZ(1, r.o.x + r.d.x * len, r.o.y + r.d.y * len, r.o.z + r.d.z * len); pos.needsUpdate = true;
      b.dot.position.set(r.o.x + r.d.x * len, r.o.y + r.d.y * len, r.o.z + r.d.z * len);
      b.dot.visible = kind !== 'none';
      b.line.material.color.setHex(BEAM_COLOR[kind]); b.dot.material.color.setHex(BEAM_COLOR[kind]);
      b.line.material.opacity = kind === 'none' ? 0.45 : 0.95;
    }
  }

  // ------------------------------------------------------------------ grabbing the miniature (grip on a controller, pinch on empty space with a hand)
  function grabPose(src) {
    const p = ptrById(src); if (!p) return null;
    let pos, f;
    if (p.kind === 'ctrl') {
      p.el.object3D.updateWorldMatrix(true, false);
      pos = p.el.object3D.getWorldPosition(new THREE.Vector3());
      f = new THREE.Vector3(0, 0, -1).applyQuaternion(p.el.object3D.getWorldQuaternion(new THREE.Quaternion()));
    } else { pos = p.ray.o.clone(); f = pos.clone().sub(camEl.object3D.getWorldPosition(new THREE.Vector3())); }
    return { pos, yaw: Math.atan2(-f.x, -f.z) };
  }
  function startGrab(src) {
    if (!S.mini) return false;
    const g = grabPose(src); if (!g) return false;
    S.yawTarget = null; S.grab = { src, p0: g.pos, y0: g.yaw, w0: world.position.clone(), r0: world.rotation.y }; S.miniPlaced = true;
    return true;
  }
  function endGrab(src) { if (S.grab && (!src || S.grab.src === src)) S.grab = null; }
  function grabTick() {
    if (!S.grab) return;
    const g = grabPose(S.grab.src); if (!g) { S.grab = null; return; }
    world.position.copy(S.grab.w0).add(g.pos.sub(S.grab.p0));
    world.rotation.y = S.grab.r0 + (g.yaw - S.grab.y0);
  }

  function wireInput(scene) {
    for (const ev of ['enter-vr', 'exit-vr']) scene.addEventListener(ev, () => { if (panels.menu) panels.menu.dirty = true; });   // the menu differs in the headset
    const rc = $('rc'), lc = $('lc');
    for (const el of [rc, lc]) {
      const side = el === rc ? 'right' : 'left';
      el.addEventListener('triggerdown', () => { unlockSound(); S.hand = side; const r = rayOf(el); interact(r.o, r.d, true); });
      el.addEventListener('gripdown', () => { S.hand = side; startGrab(side); });
      el.addEventListener('gripup', () => endGrab(side));
      el.addEventListener('abuttondown', recenter);
      el.addEventListener('bbuttondown', () => { toggleMini(); });
      el.addEventListener('xbuttondown', toggleFollow);
      el.addEventListener('ybuttondown', toggleUI);
    }
    rc.addEventListener('thumbstickmoved', (e) => { S.hand = 'right'; S.ax.rx = e.detail.x; S.ax.ry = e.detail.y; });
    lc.addEventListener('thumbstickmoved', (e) => { S.hand = 'left'; S.ax.lx = e.detail.x; S.ax.ly = e.detail.y; });

    // tracked hands: pinch = click on whatever the shoulder->fingertip ray hits; pinch on empty space grabs the miniature
    for (const [id, elId] of [['rhand', 'rh'], ['lhand', 'lh']]) {
      const el = $(elId); if (!el) continue;
      el.addEventListener('pinchstarted', () => {
        unlockSound(); S.hand = id; const p = ptrById(id); if (!p) return;
        const kind = interact(p.ray.o, p.ray.d, true);
        if (kind === 'none' || kind === 'panel') startGrab(id);
      });
      el.addEventListener('pinchended', () => endGrab(id));
    }
    // desktop mouse
    const cv = scene.canvas || scene.renderer.domElement;
    let down = null;
    const ndc = (e) => { const r = cv.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    const mouseRay = (e) => { raycaster.setFromCamera(ndc(e), scene.camera); return { o: raycaster.ray.origin.clone(), d: raycaster.ray.direction.clone() }; };
    cv.addEventListener('mousedown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    cv.addEventListener('mouseleave', clearHover);
    if (document.documentElement) document.documentElement.addEventListener('mouseleave', clearHover);
    window.addEventListener('blur', clearHover);
    cv.addEventListener('mouseup', (e) => {
      if (!down || inVR()) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if (moved < 5) { const r = mouseRay(e); interact(r.o, r.d, true); }
    });
    let lastMove = 0;
    cv.addEventListener('mousemove', (e) => {
      const t = performance.now(); if (t - lastMove < 80 || e.buttons || inVR()) return; lastMove = t;
      const r = mouseRay(e); interact(r.o, r.d, false);
    });
    cv.addEventListener('wheel', (e) => {
      if (e.shiftKey) { zoomBy(Math.sign(e.deltaY || e.deltaX) > 0 ? ZOOM_STEP : 1 / ZOOM_STEP); return; }      // Shift + wheel = zoom
      if (S.overPanel === panels.source) scrollSrc(Math.sign(e.deltaY) * 6);
      else if (S.mini) scaleMini(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      else { S.focusTarget = null; S.focus = clampFocus(S.focus - Math.sign(e.deltaY) * 0.6); }
    }, { passive: true });
    for (const ev of ['pointerdown', 'mousedown', 'touchstart']) window.addEventListener(ev, unlockSound);
    window.addEventListener('keydown', (e) => {
      unlockSound();
      if (e.code === 'KeyE') S.keys.up = true;
      if (e.code === 'KeyQ') S.keys.down = true;
      if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomBy(1 / ZOOM_STEP);          // zoom in
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomBy(ZOOM_STEP);     // zoom out
      if (e.repeat) return;                                   // toggles must not flicker while a key is held
      if (e.code === 'Digit0' || e.code === 'Numpad0') setFov(80);
      if (e.code === 'KeyM' || e.code === 'KeyB') toggleMini();       // tower <-> miniature   (VR: B)
      if (e.code === 'KeyH' || e.code === 'KeyY') toggleUI();         // hide / show all UI    (VR: Y)
      if (e.code === 'KeyL') cycleLayout();                           // tower -> helix x2 -> x4 -> x8
      if (e.code === 'KeyC') cycleClosure();                          // closure off / dim / only
      if (e.code === 'KeyK') cycleLinks();                            // connection style: fibres / tubes
      if (e.code === 'KeyG') cycleGlow();                             // glow off / on / all
      if (e.code === 'KeyN') toggleSound();                           // sound on / off
      if (e.code === 'KeyI') toggleDebug();                           // debug: one-letter labels on the active objects
      if (e.code === 'KeyX') toggleFollow();                          // follow live           (VR: X)
      if (e.code === 'KeyR') recenter();                              // panels in front of me (VR: A; on a keyboard A is "move left")
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'KeyE') S.keys.up = false; if (e.code === 'KeyQ') S.keys.down = false; });
    scene.addEventListener('enter-vr', () => setTimeout(recenter, 600));
  }
  const clampFocus = (f) => Math.max(0, Math.min(S.meta.maxDepth * S.meta.yStep, f));

  // ------------------------------------------------------------------ frame loop
  let lastHoverT = 0, lastPoll = 0, lastStatus = 0, lastRuler = 0, lastListener = 0;
  function tick(t, dtMs) {
    if (!pts) return;
    const dt = Math.min(dtMs, 100) / 1000;
    ptsMat.uniforms.uTime.value = t / 1000;
    // elevator
    let up = (S.keys.up ? 1 : 0) - (S.keys.down ? 1 : 0) - S.ax.ly;
    if (Math.abs(S.ax.ly) < 0.15) up = (S.keys.up ? 1 : 0) - (S.keys.down ? 1 : 0);
    if (!S.mini) {
      if (Math.abs(up) > 0.15) { S.focusTarget = null; S.fs.v = 0; if (S.follow && !S.followStill) { S.follow = false; panels.menu.dirty = true; } S.focus = clampFocus(S.focus + up * 4 * dt); }
      else if (S.focusTarget != null) {
        // eases in AND out (spring with a speed limit): no abrupt start, no snap at the end, max 4 m/s ≈ 40 depth levels/s
        S.focus = L.smoothDamp(S.focus, S.focusTarget, S.fs, 1.1, 4, dt);
        if (Math.abs(S.focusTarget - S.focus) < 0.005 && Math.abs(S.fs.v) < 0.02) { S.focus = S.focusTarget; S.focusTarget = null; S.fs.v = 0; }
      }
      world.position.y = 1.6 - S.focus;
    }
    if (Math.abs(S.ax.rx) > 0.2 && !S.grab) { world.rotation.y -= S.ax.rx * 1.2 * dt; S.yawTarget = null; S.ys.v = 0; }
    else if (S.yawTarget != null && !S.grab) {   // turn the tower to the followed module: same ease-in/out as the elevator, max ~100 deg/s
      const diff = L.wrapPi(S.yawTarget - world.rotation.y);
      world.rotation.y += L.smoothDamp(0, diff, S.ys, 0.9, 1.8, dt);
      if (Math.abs(diff) < 0.002 && Math.abs(S.ys.v) < 0.01) { world.rotation.y += diff; S.yawTarget = null; S.ys.v = 0; }   // += the wrapped rest: no 2*PI jump
    }
    if (S.mini && Math.abs(S.ax.ry) > 0.25 && S.overPanel !== panels.source) scaleMini(Math.exp(-S.ax.ry * dt * 0.9));
    if (Math.abs(S.ax.ry) > 0.25 && S.overPanel === panels.source) { S.scrollAcc = (S.scrollAcc || 0) + S.ax.ry * 25 * dt; if (Math.abs(S.scrollAcc) >= 1) { scrollSrc(Math.trunc(S.scrollAcc)); S.scrollAcc -= Math.trunc(S.scrollAcc); } }
    // live flashes expire / upload batching
    if (S.live.size && t - S.lastUpload > 250) {
      const now = performance.now();
      for (const [i, until] of S.live) if (until <= now) { S.live.delete(i); S.stF[i] = 3; S.dirtyState = true; S.solidsDirty = true; }
    }
    if (S.solidsDirty && t - (S.lastSolids || 0) > 250) { S.lastSolids = t; rebuildSolids(); }
    solids.material.uniforms.uWorldScale.value = world.scale.x;
    if (S.dirtyState && t - S.lastUpload > 250) { pts.geometry.attributes.aState.needsUpdate = true; S.dirtyState = false; S.lastUpload = t; }
    // VR hover from the right controller
    if (t - lastHoverT > 120 && !S.hoverSuspended) {
      lastHoverT = t;
      const scene = document.querySelector('a-scene');
      if (inVR()) hoverVR();
    }
    if (t - lastPoll > 8000) { lastPoll = t; pollState(); }
    if (t - lastStatus > 3000) { lastStatus = t; pollStatus(); }
    if (t - lastRuler > 250) { lastRuler = t; updateRulers(false); }
    if (sound && t - lastListener > 60) {
      lastListener = t; const cam = camEl.object3D, q = cam.getWorldQuaternion(new THREE.Quaternion()), pos = cam.getWorldPosition(new THREE.Vector3());
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q), u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      sound.listener(pos, f, u);
    }
    ribbons.material.uniforms.uTime.value = t / 1000; ribbons.material.uniforms.uWorldScale.value = world.scale.x;
    fibers.material.uniforms.uTime.value = t / 1000; fibers.material.uniforms.uWorldScale.value = world.scale.x; for (const c of cores) c.shellMat.uniforms.uDockT.value = t / 1000;
    morphTick(dt); spineTick(t); grabTick(); coreTick(t, dt); beaconTick(t, dt); debugTick();
    // adaptive quality: in VR, if frames stay slow (< ~42 fps) for 3 s, take the glow down one level (the saved choice is untouched; G raises it again)
    if (dtMs > 0 && dtMs < 500) {
      S.frameMs = S.frameMs ? S.frameMs * 0.9 + dtMs * 0.1 : dtMs;
      if (S.frameMs > 24 && S.glow > 0 && inVR()) { S.slowMs += dtMs; if (S.slowMs > 3000) { S.glow--; S.glowAuto = true; S.slowMs = 0; S.frameMs = 0; applyGlow(); panels.menu.dirty = true; } }
      else S.slowMs = 0;
    }
    beamTick(document.querySelector('a-scene'));
    for (const k in panels) if (panels[k].dirty) panels[k].redraw();
  }

  // ------------------------------------------------------------------ boot
  AFRAME.registerComponent('rh-tick', { tick: function (t, dt) { tick(t, dt); } });
  async function boot() {
    try { await loadAll(); } catch (e) { const el = $('loading'); if (el) el.textContent = 'failed to load: ' + e.message; throw e; }
    const scene = document.querySelector('a-scene');
    if (!scene.hasLoaded) await new Promise((r) => scene.addEventListener('loaded', r, { once: true }));
    buildScene(); wireInput(scene); applyWorldTransform(); recenter(); connectEvents(); pollState();
    const el = $('loading'); if (el) el.remove();
    window.RH = { get link() { return link; }, links: () => links, FOV_MIN, FOV_MAX, FADE_SEC, OUT_SEC, LINK_SEC, toggleDebug, debugLabels, DEBUG_KINDS, dbgGroup: () => dbgGroup, solids: () => solids, solidList: () => solidList, SOLID,ribbons: () => ribbons, fibers: () => fibers, FIB, cycleLinks, RIB, hoverMark: () => hoverMark, clearHover, setLayout, cycleLayout, spine: () => spine, spineAmount, SPINE, layoutState: () => ({ layout: S.layout, target: S.layoutTarget, morph: S.morph }), beacon: () => beacon, mainIdx: () => mainIdx, codeLines, paintCode, unlockSound, cycleClosure, halo: () => ({ ptsHalo, pkHalo, pts, ptsMat }), cycleGlow, cores: () => cores, sound: () => sound, soundLoad, soundPacketLines, soundModule, setFov, faceModule, toggleFollow, coreTelemetry, core: () => core, coreSatPick, jumpToDecl, coreTick, S, startGrab, endGrab, scaleMini, bringToMe, updateRulers, rulers, toggleUI, select, jumpTo, followStep, stopFollow, setView, setColor, toggleMini, recenter, panels };   // handy from the console
  }
  boot();
})();
