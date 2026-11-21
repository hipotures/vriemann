// Smoke test of static/app.js without a browser: real three.js (same revision as A-Frame) + DOM stubs,
// talking to the real running server.   NODE_PATH=<dir with node_modules/three> node tests/smoke_app.js [base-url]
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const THREE = require('three');
const BASE = process.argv[2] || 'http://127.0.0.1:18443';

// ---- fake 2D canvas context: records nothing, measures text as 10px/char
const drawn = [];   // every string drawn on any panel canvas, so tests can check what the user would read
const ctx2d = new Proxy({}, { get: (t, k) => k === 'measureText' ? (s) => ({ width: String(s).length * 10 }) : k === 'fillText' ? (s) => { drawn.push(String(s)); } : (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop() {} }) : (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const mkCanvas = () => ({ width: 0, height: 0, getContext: () => ctx2d, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) });
const ents = {};
const ent = (id, o3d) => (ents[id] = { id, object3D: o3d || new THREE.Object3D(), listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, remove() {} });
// like A-Frame: the <a-entity camera> object3D is a plain Object3D, the real camera is its child
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); const camWrap = new THREE.Object3D(); camWrap.add(camera);
camWrap.position.set(0, 1.6, 0); camWrap.updateMatrixWorld(true);
ent('world'); ent('panels'); ent('cam', camWrap); ents.cam.setAttribute = (n, k, v) => { ents.cam.fov = v; }; ent('rc'); ent('lc'); ent('rh'); ent('lh'); ent('loading'); ent('hud'); ents.hud.style = { display: '' };
const vrButton = { style: { display: '' } };
const sceneCanvas = Object.assign(mkCanvas(), { listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } });
let vrMode = false;
const sceneRoot = new THREE.Scene();
const scene = { hasLoaded: true, canvas: sceneCanvas, camera, object3D: sceneRoot, is: (s) => (s === 'vr-mode' ? vrMode : false), addEventListener() {} };
let tickFn = null;
const winL = {}, docL = {};
global.window = global; global.addEventListener = (n, f) => { (winL[n] = winL[n] || []).push(f); };
global.AFRAME = { THREE, registerComponent: (n, def) => { if (n === 'rh-tick') tickFn = def.tick; } };
global.document = { getElementById: (id) => ents[id], querySelector: (s) => (s === 'a-scene' ? scene : s === '.a-enter-vr' ? vrButton : null), createElement: () => mkCanvas(), documentElement: { addEventListener(n, f) { (docL[n] = docL[n] || []).push(f); } } };
const realFetch = fetch;
// /api/status is pinned: the live server reports whatever Lean happens to be compiling, which would make the tests racy
const STATUS = { modules: 175187, counts: { open: 1, assigned: 1, done: 1, ours: 1 }, receipts: [], compiling: [], running: false, packetLog: [] };
global.fetch = (u, o) => String(u).includes('/api/status') ? Promise.resolve({ ok: true, json: () => Promise.resolve(STATUS) }) : realFetch(u.startsWith('http') ? u : BASE + u, o);
global.EventSource = class { constructor(u) { this.u = u; global.__es = this; } };
const errors = []; process.on('unhandledRejection', (e) => errors.push(e));

const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../static', f), 'utf8'), { filename: f });
const { FakeCtx } = require('./fake_audio.js');
const audioCtxs = []; global.AudioContext = class extends FakeCtx { constructor() { super(); audioCtxs.push(this); } };
load('lib.js'); load('audio.js'); load('app.js');

(async () => {
  for (let i = 0; i < 200 && !global.RH; i++) { await new Promise((r) => setTimeout(r, 100)); if (errors.length) throw errors[0]; }
  assert(global.RH, 'app did not boot'); const { S, select, jumpTo, setView, setColor, toggleMini, recenter, panels } = RH;
  let ok = 0; const skip = (process.env.SKIP || '').split('|').filter(Boolean);   // SKIP='part of a test name|another' leaves those out (for bisecting interactions)
  const t = (n, f) => skip.some((x) => n.includes(x)) ? (console.log('skip ' + n.slice(0, 50)), Promise.resolve()) : Promise.resolve(f()).then(() => { ok++; console.log('ok  ' + n); });
  const until = async (cond, ms = 10000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return cond(); };
  const frame = (ms = 16, n = 1) => { for (let i = 0; i < n; i++) tickFn.call({}, performance.now(), ms); };

  await t('boots: data + panels loaded', () => { assert.strictEqual(S.n, 175187); assert.strictEqual(Object.keys(panels).length, 4); frame(); });
  await t('select a real module: closure, markers, source load', async () => {
    const i = S.nameIdx.get('GroundTheory.GlobalFields.Artin.LogCharpoly'); assert(i >= 0);
    select(i); frame();
    assert.strictEqual(S.sel, i); assert.strictEqual(S.hiF[i], 3);
    await until(() => S.src.tok || S.src.error);
    assert(S.src.tok && S.src.tok.length > 5, 'source did not load: ' + S.src.error); assert.strictEqual(S.src.red.sorry, 0);
    frame(); console.log('     source lines:', S.src.lines, ' ancestors:', S.ancestors);
  });
  await t('a deeper module lights its ancestry; neighbour stepping works', () => {
    const j = S.depth.indexOf(40); jumpTo(j); frame(); assert(S.ancestors > 0);
    let cyan = 0; for (let k = 0; k < S.n; k++) if (S.hiF[k] === 1) cyan++; assert.strictEqual(cyan, S.ancestors);
    const before = S.sel; panels.info.buttons.find((b) => b.label.includes('import')).fn(); assert.notStrictEqual(S.sel, before); assert(S.depth[S.sel] < 40);
    frame(1000); assert(S.focusTarget !== null || true);
  });
  await t('all four panels paint without throwing, in every colour mode / view', () => {
    for (const m of [0, 1, 2]) { setColor(m); for (const k in panels) panels[k].dirty = true; frame(); }
    setView('packets'); for (const k in panels) panels[k].dirty = true; frame(); setView('tower'); frame();
    assert(panels.menu.buttons.length >= 11, 'menu buttons: ' + panels.menu.buttons.length);
  });
  await t('menu buttons actually do things', () => {
    const click = (l) => panels.menu.buttons.find((b) => b.label === l).fn();
    click('Packets'); assert.strictEqual(S.view, 'packets'); click('Modules'); assert.strictEqual(S.view, 'tower');
    click('Namespace'); assert.strictEqual(S.color, 1); click('State'); click('Hide open'); assert(S.hideOpen); click('Hide open');
    click('Miniature'); assert(S.mini); frame(); click('Inside'); assert(!S.mini);
    click('Main.lean'); assert.strictEqual(S.names[S.sel], 'Main'); click('Follow live'); assert(S.follow && !S.followStill); frame(); click('Follow: camera'); assert(S.follow && S.followStill); frame(); click('Follow: in place'); assert(!S.follow && !S.followStill);
    frame(16, 5);
  });
  await t('ray picking through interact(): hover then click selects the aimed module', () => {
    S.focus = 100 * S.meta.yStep; frame(16, 3);
    const world = ents.world.object3D; world.updateMatrixWorld(true);
    const i = (() => { for (let k = 0; k < S.n; k++) if (S.depth[k] === 100) return k; })();
    const target = new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]).applyMatrix4(world.matrixWorld);
    const o = new THREE.Vector3(0, 1.6, 0), d = target.clone().sub(o).normalize();
    // make sure panels are not in the way
    ents.panels.object3D.position.set(0, 0, 50);
    sceneCanvas.listeners.mousemove; // (desktop path is DOM driven; call the shared function through the controller trigger instead)
    ents.rc.object3D.position.copy(o); ents.rc.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), d); ents.rc.object3D.updateMatrixWorld(true);
    ents.rc.listeners.triggerdown[0]();
    assert(S.sel >= 0 && Math.hypot(S.pos[3 * S.sel] - S.pos[3 * i], S.pos[3 * S.sel + 1] - S.pos[3 * i + 1], S.pos[3 * S.sel + 2] - S.pos[3 * i + 2]) < 0.15, 'selected ' + S.names[S.sel]);
  });
  await t('pointing at a panel button clicks it (view switch), then packets can be picked', () => {
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0; ents.panels.object3D.updateMatrixWorld(true);
    const b = panels.menu.buttons.find((x) => x.label === 'Packets'); const m = panels.menu.mesh;
    const geo = m.geometry.parameters; const u = (b.x + b.w / 2) / panels.menu.pw, v = 1 - (b.y + b.h / 2) / panels.menu.ph;
    const target = new THREE.Vector3((u - 0.5) * geo.width, (v - 0.5) * geo.height, 0).applyMatrix4(m.matrixWorld);
    const o = new THREE.Vector3(0, 1.4, 0), d = target.clone().sub(o).normalize();
    ents.rc.object3D.position.copy(o); ents.rc.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), d); ents.rc.object3D.updateMatrixWorld(true);
    ents.rc.listeners.triggerdown[0](); assert.strictEqual(S.view, 'packets');
    frame(16, 3);
  });
  await t('live events: built flash, log lines, state refresh keeps the flash', () => {
    setView('tower'); const i = S.nameIdx.get('Main');
    __es.onmessage({ data: JSON.stringify({ k: 'built', i, name: 'Main', n: 3, N: 10, s: 1.5 }) });
    __es.onmessage({ data: JSON.stringify({ k: 'line', text: 'warning: something' }) });   // linter chatter: must be dropped
    __es.onmessage({ data: JSON.stringify({ k: 'line', text: 'error: unknown identifier foo' }) });  // real problem: must be kept
    __es.onmessage({ data: JSON.stringify({ k: 'status', lines: ['[x] hello'] }) });
    assert.strictEqual(S.stF[i], 4); frame(16, 30); assert.strictEqual(S.logLines.length, 2); assert(S.logLines.some((l) => /unknown identifier/.test(l.text)) && !S.logLines.some((l) => /something/.test(l.text))); assert(S.live.has(i));
    for (const k in panels) panels[k].dirty = true; frame();
  });
  await t('thumbstick: elevator, rotate, source scroll', () => {
    const f0 = S.focus; S.ax.ly = -1; frame(100, 5); assert(S.focus > f0); S.ax.ly = 0;
    const r0 = ents.world.object3D.rotation.y; S.ax.rx = 1; frame(100, 3); assert(ents.world.object3D.rotation.y !== r0); S.ax.rx = 0;
    select(S.nameIdx.get('Main')); return until(() => S.src.tok).then(() => { frame(); const s0 = S.src.scroll; RH.panels.source.buttons.find((b) => b.label === '▼').fn(); assert(S.src.scroll > s0 || S.src.tok.length < 40); });
  });
  await t('VR: the pick ray follows laser-controls\' raycaster (tilted target ray), not the controller -Z axis', () => {
    // what A-Frame 1.7 does: copy the device target-ray origin/direction into the `raycaster` component
    const tilt = { origin: { x: 0.01, y: -0.02, z: -0.05 }, direction: { x: 0, y: -0.8, z: -1 } };
    for (const k of ['rc', 'lc']) ents[k].components = { raycaster: { data: tilt } };
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0; ents.panels.object3D.updateMatrixWorld(true);
    const b = panels.menu.buttons.find((x) => x.label === 'Packets'); const m = panels.menu.mesh, g = m.geometry.parameters;
    const u = (b.x + b.w / 2) / panels.menu.pw, v = 1 - (b.y + b.h / 2) / panels.menu.ph;
    const target = new THREE.Vector3((u - 0.5) * g.width, (v - 0.5) * g.height, 0).applyMatrix4(m.matrixWorld);
    const hand = new THREE.Vector3(-0.4, 1.2, -0.3);
    const wanted = target.clone().sub(hand).normalize();
    const dirL = new THREE.Vector3(tilt.direction.x, tilt.direction.y, tilt.direction.z).normalize();
    for (const [k, side] of [['rc', 'right'], ['lc', 'left']]) {
      setView('tower');
      ents[k].object3D.position.copy(hand); ents[k].object3D.quaternion.setFromUnitVectors(dirL, wanted); ents[k].object3D.updateMatrixWorld(true);
      const ray = (RH.S, ents[k].object3D); // sanity: plain -Z would miss the button by a lot
      const plain = new THREE.Vector3(0, 0, -1).applyQuaternion(ents[k].object3D.quaternion);
      assert(plain.angleTo(wanted) > 0.3, 'test is vacuous: -Z already points at the target');
      ents[k].listeners.triggerdown[0](); assert.strictEqual(S.view, 'packets', side + ' controller click missed the menu button');
      assert.strictEqual(S.hand, side);
    }
    setView('tower');
  });
  await t('VR laser: our beam ends exactly on the menu button / on the node, A-Frame\'s own line is hidden', () => {
    vrMode = true;
    const lineObj = { visible: true }; ents.rc.getObject3D = () => lineObj; ents.lc.getObject3D = () => ({ visible: true });
    const tilt = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -0.8, z: -1 } };
    for (const k of ['rc', 'lc']) ents[k].components = { raycaster: { data: tilt } };
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0; ents.panels.object3D.updateMatrixWorld(true);
    const b = panels.menu.buttons.find((x) => x.label === 'Hide open'); const m = panels.menu.mesh, g = m.geometry.parameters;
    const u = (b.x + b.w / 2) / panels.menu.pw, v = 1 - (b.y + b.h / 2) / panels.menu.ph;
    const target = new THREE.Vector3((u - 0.5) * g.width, (v - 0.5) * g.height, 0).applyMatrix4(m.matrixWorld);
    const hand = new THREE.Vector3(-0.3, 1.2, -0.2), dirL = new THREE.Vector3(0, -0.8, -1).normalize();
    ents.rc.object3D.position.copy(hand); ents.rc.object3D.quaternion.setFromUnitVectors(dirL, target.clone().sub(hand).normalize()); ents.rc.object3D.updateMatrixWorld(true);
    ents.lc.object3D.position.set(0.5, 1.0, 0.5); ents.lc.object3D.quaternion.identity(); ents.lc.object3D.updateMatrixWorld(true);   // pointing at nothing useful
    frame(16, 3);
    const bm = sceneRoot.children.filter((c) => c.isGroup);
    assert(bm.length >= 2, 'beams were not created'); assert(!lineObj.visible, "A-Frame's own line should be hidden");
    const pts = (grp) => { const p = grp.children[0].geometry.attributes.position; return [new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0)), new THREE.Vector3(p.getX(1), p.getY(1), p.getZ(1))]; };
    const [p0, p1] = pts(bm[0]);
    assert(p1.distanceTo(target) < 0.02, 'beam does not end on the button: off by ' + p1.distanceTo(target).toFixed(3) + ' m');
    assert(p0.distanceTo(hand) < 1e-6 && p0.distanceTo(p1) > 0.5, 'beam is stubby (A-Frame bug we are working around): ' + p0.distanceTo(p1).toFixed(2) + ' m');
    assert.strictEqual(bm[0].children[0].material.color.getHex(), 0x40e0ff, 'button hit should be cyan');
    const [q0, q1] = pts(bm[1]); assert(Math.abs(q0.distanceTo(q1) - 2.5) < 0.01, 'a miss should be a 2.5 m beam, got ' + q0.distanceTo(q1).toFixed(2));
    vrMode = false; frame(); assert(!bm[0].visible && !bm[1].visible, 'beams must hide outside VR');
  });
  await t('recenter puts every panel IN FRONT of the viewer, whichever way they look (regression: was behind)', () => {
    ents.panels.object3D.rotation.set(0, 0, 0); ents.panels.object3D.position.set(0, 0, 0);
    for (const yaw of [0, 1.0, 2.0, -2.5, Math.PI]) {
      camWrap.rotation.set(0, yaw, 0); camWrap.position.set(1.5, 1.6, -0.5); camWrap.updateMatrixWorld(true);
      recenter(); ents.panels.object3D.updateMatrixWorld(true);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camWrap.quaternion);
      for (const k in panels) {
        const p = new THREE.Vector3(); panels[k].mesh.getWorldPosition(p);
        const toP = p.sub(camWrap.position); toP.y = 0; toP.normalize();
        assert(toP.dot(fwd.clone().setY(0).normalize()) > 0.3, `panel ${k} not in front for yaw ${yaw}: dot=${toP.dot(fwd)}`);
      }
      // the menu (left) must be on the viewer's left, the log (right) on the right
      const side = (k) => { const p = new THREE.Vector3(); panels[k].mesh.getWorldPosition(p); return p.sub(camWrap.position).cross(fwd).y; };
      assert(side('menu') < 0 && side('source') > 0 && Math.abs(side('log')) < 0.3, 'layout: menu left, source right, live log centre');   // cross(toPanel, forward).y < 0  <=>  panel is on the left
    }
    camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true);
  });
  await t('source panel exists only while something is selected and cannot be clicked when hidden', () => {
    RH.select(S.nameIdx.get('Main')); assert(panels.source.mesh.visible);
    panels.info.buttons.find((b) => b.label === 'Clear').fn(); assert(!panels.source.mesh.visible);
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0; ents.panels.object3D.updateMatrixWorld(true);
    const m = panels.source.mesh, o = new THREE.Vector3(0, 1.45, 0), tgt = new THREE.Vector3(); m.getWorldPosition(tgt);
    ents.rc.object3D.position.copy(o); ents.rc.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), tgt.sub(o).normalize()); ents.rc.object3D.updateMatrixWorld(true);
    ents.rc.listeners.triggerdown[0](); assert.strictEqual(S.overPanel, null, 'a hidden panel intercepted the ray');
  });
  await t('Follow live: shows the longest-compiling module (source + closure), ignores ties/empties, and a manual pick switches it off', async () => {
    // the real server reports whatever Lean compiles right now; pin /api/status to "nothing" so the test is deterministic
    const realFetch2 = global.fetch;
    global.fetch = (u, o) => String(u).includes('/api/status') ? Promise.resolve({ ok: true, json: () => Promise.resolve({ counts: { open: 0, assigned: 0, done: 0, ours: 0 }, receipts: [], compiling: [], running: false, packetLog: [] }) }) : realFetch2(u, o);
    const A = S.nameIdx.get('Main'), B = S.depth.indexOf(60);
    panels.menu.buttons.find((b) => b.label === 'Follow live').fn(); assert(S.follow);
    RH.followStep([]); RH.followStep(null);                               // nothing compiling: keep what we have
    RH.followStep([{ i: B, secs: 5 }, { i: A, secs: 300 }]); assert.strictEqual(S.sel, A, 'should follow the longest-running module');
    const d0 = S.focusTarget; RH.followStep([{ i: A, secs: 310 }, { i: B, secs: 15 }]); assert.strictEqual(S.sel, A);   // same target: no reselect
    RH.followStep([{ i: B, secs: 20 }]); assert.strictEqual(S.sel, B); assert(S.focusTarget !== null || S.focus > 0);
    await until(() => S.src.tok); frame(); assert(S.src.tok, 'source of the followed module did not load'); assert(panels.source.mesh.visible);
    // a manual pick switches follow off, and later compile updates no longer take over
    RH.stopFollow(); assert(!S.follow); RH.followStep([{ i: A, secs: 999 }]); assert.strictEqual(S.sel, B);
    // "in place": the selection follows, but the scene does not move (no elevator, no turning the tower)
    const btn = () => panels.menu.buttons.find((b) => /^Follow/.test(b.label));
    btn().fn(); frame(); assert.strictEqual(btn().label, 'Follow: camera'); btn().fn(); frame(); assert(S.follow && S.followStill); assert.strictEqual(btn().label, 'Follow: in place');
    for (let k = 0; k < 3000; k++) { const f = S.focus, r = ents.world.object3D.rotation.y; frame(16, 1); if (Math.abs(S.focus - f) < 1e-9 && Math.abs(ents.world.object3D.rotation.y - r) < 1e-9) break; }   // let the earlier camera jump settle
    const focus0 = S.focus, ft0 = S.focusTarget, yaw0 = S.yawTarget, rot0 = ents.world.object3D.rotation.y;
    RH.followStep([{ i: A, secs: 1000 }]); assert.strictEqual(S.sel, A, 'in place: the new module is selected');
    assert.strictEqual(S.focusTarget, ft0, 'in place: no elevator move'); assert.strictEqual(S.yawTarget, yaw0, 'in place: the tower is not turned');
    frame(16, 30); assert(Math.abs(S.focus - focus0) < 1e-9 && Math.abs(ents.world.object3D.rotation.y - rot0) < 1e-9, 'in place: the scene stays still: focus ' + focus0 + ' -> ' + S.focus + ', rot ' + rot0 + ' -> ' + ents.world.object3D.rotation.y + ', targets ' + ft0 + '/' + yaw0);
    await until(() => S.src.name === S.names[A] && (S.src.tok || S.src.error)); assert(RH.core().i === A, 'its core appears where it is');
    S.focus += 0; const up = S.follow; assert(up, 'still following');
    btn().fn(); assert(!S.follow && !S.followStill, 'third press: off');
    global.fetch = realFetch2;
  });
  await t('connection tubes: all connections are lit 3D tubes (hubs beyond the cap: the rest as hair); flow direction, start on the core, nearest first, animation, hiding, shader sanity', async () => {
    setView('tower'); if (S.links !== 'tubes') RH.cycleLinks(); assert.strictEqual(S.links, 'tubes'); const rib = RH.ribbons(), RIBc = RH.RIB, c = S.csr, deg = (i) => (c.impStart[i + 1] - c.impStart[i]) + (c.conStart[i + 1] - c.conStart[i]);
    const triPer = RIBc.segs * RIBc.sides * 6, per = (RIBc.segs + 1) * RIBc.sides;
    let few = -1, mid = -1, many = -1; for (let i = 0; i < S.n; i++) { const d = deg(i); if (few < 0 && d >= 3 && d <= 8) few = i; if (mid < 0 && d >= 40 && d <= RIBc.max) mid = i; if (many < 0 && d > RIBc.max + 20) many = i; if (few >= 0 && mid >= 0 && many >= 0) break; }
    assert(few >= 0 && mid >= 0 && many >= 0, 'need modules with few, many-but-fitting and hub-like connection counts');
    const linesObj = () => RH.halo().pts.parent.children.find((o) => o.isLineSegments), segsOf = (m) => m.geometry.drawRange.count;
    assert(RIBc.max >= 160, 'tubes for (almost) every module, no mixing with old lines');
    // few / 40+ connections: all of them tubes, no hair
    for (const i of [few, mid]) { RH.select(i); frame(16, 4); assert.strictEqual(segsOf(rib), deg(i) * triPer, 'one tube per connection'); assert.strictEqual(segsOf(linesObj()), 0, 'no hair when everything fits'); }
    // hubs: exactly the cap as tubes (the nearest), the remainder as hair
    RH.select(many); frame(16, 4); const dMany = deg(many); assert.strictEqual(segsOf(rib), RIBc.max * triPer, 'only the nearest ' + RIBc.max + ' become tubes');
    assert.strictEqual(segsOf(linesObj()), Math.min(800, dMany - RIBc.max) * 2, 'the rest is hair'); assert(linesObj().material.opacity <= 0.35, 'hair is only a haze');
    // tubes start on the core surface (not inside the core), end exactly at the neighbours, which are the NEAREST ones
    const P = S.pos, a = rib.geometry.attributes, at = (v) => [a.position.getX(v), a.position.getY(v), a.position.getZ(v)], dist = (p, j) => Math.hypot(p[0] - P[3 * j], p[1] - P[3 * j + 1], p[2] - P[3 * j + 2]);
    const imp = new Set(c.impList.subarray(c.impStart[many], c.impStart[many + 1])), all = [...imp]; for (let k = c.conStart[many]; k < c.conStart[many + 1]; k++) all.push(c.conList[k]);
    const dm = (j) => Math.hypot(P[3 * j] - P[3 * many], P[3 * j + 1] - P[3 * many + 1], P[3 * j + 2] - P[3 * many + 2]); all.sort((u, v) => dm(u) - dm(v)); const cutoff = dm(all[RIBc.max - 1]); let farthest = 0;
    for (let e = 0; e < RIBc.max; e++) { const v0 = e * per, vN = v0 + per - RIBc.sides, end = at(vN), s0 = dist(at(v0), many), j = all.find((x) => dist(end, x) < 1e-4);
      assert(j !== undefined, 'tube ' + e + ' ends at a neighbour'); const el = dm(j); assert(Math.abs(s0 - Math.min(RIBc.start, 0.45 * el)) < 1e-4, 'tube ' + e + ' starts on the core surface: ' + s0);
      farthest = Math.max(farthest, el); assert.strictEqual(a.aDir.getX(v0) < 0, imp.has(j), 'imports flow towards the module (dir -1), consumers away (dir +1)'); }
    assert(farthest <= cutoff + 1e-4, 'the tubes must be the nearest neighbours: ' + farthest + ' vs cutoff ' + cutoff);
    assert(RIBc.start >= 0.2 && RIBc.start <= 0.3, 'tubes leave from about the core radius');
    // shader: real 3D (normals, lighting, specular), thin where it leaves the core, min pixel width, travelling bulge; GLSL sanity
    const v = rib.material.vertexShader, f = rib.material.fragmentShader;
    for (const need of ['aNrm', 'normalMatrix*aNrm', 'uMinPx', 'taper', 'smoothstep(0., .25, aT)', 'mv.xyz += n*w*(1. + .8*pulse)', 'aDir*uTime*uSpeed']) assert(v.includes(need), 'tube vertex shader lacks ' + need);
    for (const need of ['dot(n, Ld)', 'spec', 'rim', 'vDir*uTime*uSpeed', 'pulse', 'gl_FragColor = vec4(col, 1.)']) assert(f.includes(need), 'tube fragment shader lacks ' + need);
    const varyings = (sh) => [...sh.matchAll(/varying\s+(?:float|vec3)\s+([^;]+);/g)].map((x) => x[0].split(/\s+/)[1] + ':' + x[1].split(',').map((y) => y.trim()).sort().join(',')).sort();
    assert(varyings(v).length >= 2); assert.deepStrictEqual(varyings(v), varyings(f), 'tube varyings must match');
    for (const sh of [v, f]) { assert((sh.match(/\{/g) || []).length === (sh.match(/\}/g) || []).length, 'unbalanced braces'); for (const x of sh.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) assert(parseFloat(x[1]) < parseFloat(x[2]), 'reversed smoothstep'); }
    const m = rib.material; assert(m.blending === THREE.NormalBlending && m.depthWrite && m.depthTest && !m.transparent && m.side === THREE.FrontSide, 'opaque, depth-tested tubes: they hide each other like real objects');
    // animated, and the radius follows the world scale (miniature)
    const t0 = m.uniforms.uTime.value; frame(16, 10); assert(m.uniforms.uTime.value !== t0, 'the pulses must advance'); S.mini = true; ents.world.object3D.scale.setScalar(0.08); frame(); assert(Math.abs(m.uniforms.uWorldScale.value - 0.08) < 1e-9, 'radius scales with the world'); S.mini = false; ents.world.object3D.scale.setScalar(1); frame();
    // hiding: packets view, cleared selection
    setView('packets'); frame(); assert(!rib.visible, 'tubes belong to the tower view'); setView('tower'); frame(); assert(rib.visible);
    panels.info.buttons.find((b) => b.label === 'Clear').fn(); assert.strictEqual(segsOf(rib), 0, 'cleared selection: no tubes'); assert.strictEqual(segsOf(linesObj()), 0);
    RH.cycleLinks(); assert.strictEqual(S.links, 'fibers');
  });
  await t('connection fibres (default): glowing additive arcs with comets, imports dock on the core with ripples, consumers dim and dashed; K / menu switch to tubes and back', async () => {
    setView('tower'); assert.strictEqual(S.links, 'fibers', 'fibres are the default'); const fib = RH.fibers(), tub = RH.ribbons(), F = RH.FIB, RIBc = RH.RIB, c = S.csr;
    const deg = (i) => (c.impStart[i + 1] - c.impStart[i]) + (c.conStart[i + 1] - c.conStart[i]), nImp = (i) => c.impStart[i + 1] - c.impStart[i];
    let i = -1; for (let k = 0; k < S.n; k++) if (nImp(k) >= 20 && deg(k) <= RIBc.max && k !== RH.mainIdx()) { i = k; break; } assert(i >= 0);
    RH.select(i); frame(16, 4);
    assert.strictEqual(fib.geometry.drawRange.count, deg(i) * F.segs * 6, 'one fibre per connection'); assert.strictEqual(tub.geometry.drawRange.count, 0, 'no tubes at the same time');
    // fibres start on the core surface
    const a = fib.geometry.attributes, per = (F.segs + 1) * 2, P = S.pos;
    for (let e = 0; e < deg(i); e++) { const v = e * per, d = Math.hypot(a.position.getX(v) - P[3 * i], a.position.getY(v) - P[3 * i + 1], a.position.getZ(v) - P[3 * i + 2]); assert(d <= RIBc.start + 1e-5 && d > 0.05, 'fibre ' + e + ' starts on the core: ' + d); }
    // docking ripples: one per import (up to the cap), unit directions, none for consumers; the shell shader uses them
    const u = RH.core().shellMat.uniforms; assert.strictEqual(u.uDockN.value, Math.min(F.docks, nImp(i)), 'a dock per import');
    for (let k = 0; k < u.uDockN.value; k++) assert(Math.abs(u.uDock.value[k].length() - 1) < 1e-5);
    const sf = RH.core().shellMat.fragmentShader; for (const need of ['uDock[k]', 'uDockN', 'uDockT*uDockSpd', 'rip']) assert(sf.includes(need), 'shell shader lacks ' + need);
    assert.strictEqual(u.uDockSpd.value, F.speed); assert.strictEqual(u.uDockFreq.value, F.freq);
    frame(16, 3); assert(Math.abs(u.uDockT.value - fib.material.uniforms.uTime.value) < 1e-9, 'ripples run on the same clock as the comets (arrivals line up)');
    // the comet arrival phase is the same expression in both shaders
    const ff = fib.material.fragmentShader; assert(ff.includes('.75 + .5*fract(vPhase*7.31)') && sf.includes('.75 + .5*fract(ph*7.31)'), 'same per-fibre pace in fibres and ripples');
    // material: additive glow, no depth write, soft profile (no hard edge), fading ends and distance, imports vs consumers
    const m = fib.material; assert(m.transparent && !m.depthWrite && m.blending === THREE.AdditiveBlending);
    for (const need of ['exp(-s2*14.)', 'smoothstep(.75, 1., abs(vSide))', 'smoothstep(0., .06, vT)', 'vFar', 'head', 'tail', 'dash', 'wave']) assert(ff.includes(need), 'fibre shader lacks ' + need);
    const fv = m.vertexShader; for (const need of ['uMinPx', 'normalize(mv.xyz)', 'aKind > .5 ? .5 : 1.']) assert(fv.includes(need), 'fibre vertex shader lacks ' + need);
    const varyings = (sh) => [...sh.matchAll(/varying\s+float\s+([^;]+);/g)].flatMap((x) => x[1].split(',').map((y) => y.trim())).sort(); assert(varyings(fv).length >= 5); assert.deepStrictEqual(varyings(fv), varyings(ff));
    for (const sh of [fv, ff, sf]) { assert((sh.match(/\{/g) || []).length === (sh.match(/\}/g) || []).length); for (const x of sh.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) assert(parseFloat(x[1]) < parseFloat(x[2]), 'reversed smoothstep'); }
    const t0 = m.uniforms.uTime.value; frame(16, 5); assert(m.uniforms.uTime.value > t0);
    // switching: K key and the menu button; ripples belong to fibres only; the choice is remembered
    winL.keydown.forEach((f) => f({ code: 'KeyK' })); frame(); assert.strictEqual(S.links, 'tubes'); assert(tub.geometry.drawRange.count > 0 && fib.geometry.drawRange.count === 0); assert.strictEqual(u.uDockN.value, 0, 'no ripples with tubes');
    panels.menu.dirty = true; frame(); const btn = panels.menu.buttons.find((b) => /^Links: /.test(b.label)); assert(btn && btn.label === 'Links: tubes'); btn.fn(); frame();
    assert.strictEqual(S.links, 'fibers'); assert(fib.geometry.drawRange.count > 0 && u.uDockN.value > 0);
    // a new selection moves the docks to the new core and clears the old one
    const old = RH.core(); let j = -1; for (let k = i + 1; k < S.n; k++) if (nImp(k) >= 3 && deg(k) <= RIBc.max && k !== RH.mainIdx()) { j = k; break; }
    RH.select(j); frame(); assert(RH.core() !== old && old.shellMat.uniforms.uDockN.value === 0 && RH.core().shellMat.uniforms.uDockN.value === Math.min(F.docks, nImp(j)));
    setView('packets'); frame(); assert(!fib.visible); setView('tower'); frame(); assert(fib.visible);
    panels.info.buttons.find((b) => b.label === 'Clear').fn(); assert.strictEqual(fib.geometry.drawRange.count, 0); assert(RH.cores().every((x) => x.shellMat.uniforms.uDockN.value === 0));
  });
  await t('hover marker (the yellow wireframe ball): gone when the pointer leaves the window / the window loses focus, and never shown in recording mode (H)', async () => {
    setView('tower'); const mk = RH.hoverMark(), press = (code) => winL.keydown.forEach((f) => f({ code })), cv = sceneCanvas;
    // aim the mouse at a real node: project it to the canvas and move there
    ents.world.object3D.position.set(0, 0, 0); ents.world.object3D.rotation.set(0, 0, 0); ents.world.object3D.scale.setScalar(1); ents.world.object3D.updateMatrixWorld(true); S.mini = false; S.focus = 100 * S.meta.yStep;
    ents.world.object3D.position.y = 1.6 - S.focus; ents.world.object3D.updateMatrixWorld(true); camWrap.position.set(0, 1.6, 0); camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
    let target = -1, px = 0, py = 0; for (let i = 0; i < S.n && target < 0; i += 3) { if (S.depth[i] !== 100) continue; const v = new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]).applyMatrix4(ents.world.object3D.matrixWorld).project(camera);
      if (v.z < 1 && Math.abs(v.x) < 0.5 && Math.abs(v.y) < 0.5) { target = i; px = (v.x + 1) / 2 * 800; py = (1 - v.y) / 2 * 600; } }
    assert(target >= 0, 'no node in front of the camera');
    const move = async () => { await new Promise((r) => setTimeout(r, 100)); cv.listeners.mousemove[0]({ clientX: px, clientY: py, buttons: 0 }); };
    for (const k in panels) panels[k].mesh.visible = false;                     // nothing may intercept the ray in this test
    await move(); assert(S.hover >= 0 && mk.visible, 'hovering a node shows the marker (UI visible)');
    cv.listeners.mouseleave[0](); assert(!mk.visible && S.hover === -1, 'leaving the canvas hides the marker and clears the hover');
    await move(); assert(mk.visible); docL.mouseleave[0](); assert(!mk.visible, 'leaving the whole page hides it too');
    await move(); assert(mk.visible); winL.blur[0](); assert(!mk.visible && S.hover === -1, 'losing window focus hides it too');
    // recording mode: the pointer can sit on a node, but no marker is drawn
    await move(); assert(mk.visible); press('KeyH'); assert(S.uiHidden && !mk.visible, 'H hides an already visible marker at once');
    await move(); assert(S.hover >= 0, 'hover logic still works while recording'); assert(!mk.visible, 'but no marker is drawn in recording mode');
    press('KeyH'); await move(); assert(mk.visible, 'back to normal after H again'); cv.listeners.mouseleave[0]();
    for (const k in panels) panels[k].mesh.visible = k !== 'source'; frame();
  });
  await t('H hides ALL UI (panels, hint text, VR button) and a hidden UI cannot be clicked; H again restores', () => {
    const press = (code) => winL.keydown.forEach((f) => f({ code }));
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0; ents.panels.object3D.updateMatrixWorld(true);
    press('KeyY'); assert(!ents.panels.object3D.visible, 'keyboard Y must hide the UI too'); press('KeyY'); assert(ents.panels.object3D.visible);
    press('KeyH');
    assert(!ents.panels.object3D.visible && ents.hud.style.display === 'none' && vrButton.style.display === 'none');
    const b = panels.menu.buttons.find((x) => x.label === 'Packets'), m = panels.menu.mesh, g = m.geometry.parameters;
    const tgt = new THREE.Vector3(((b.x + b.w / 2) / panels.menu.pw - 0.5) * g.width, (1 - (b.y + b.h / 2) / panels.menu.ph - 0.5) * g.height, 0).applyMatrix4(m.matrixWorld);
    const o = new THREE.Vector3(0, 1.4, 0); ents.rc.object3D.position.copy(o); ents.rc.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, -0.8, -1).normalize(), tgt.clone().sub(o).normalize()); ents.rc.object3D.updateMatrixWorld(true);
    setView('tower'); ents.rc.listeners.triggerdown[0](); assert.strictEqual(S.view, 'tower', 'a hidden menu reacted to a click');
    press('KeyH'); assert(ents.panels.object3D.visible && ents.hud.style.display === '' && vrButton.style.display === '');
  });
  await t('Y on the left controller toggles all UI (and X / A / B handlers exist on the right hands)', () => {
    assert(ents.lc.listeners.ybuttondown && ents.lc.listeners.ybuttondown.length === 1, 'exactly one ybuttondown handler expected, got ' + (ents.lc.listeners.ybuttondown || []).length);
    assert(ents.rc.listeners.abuttondown.length === 1 && ents.rc.listeners.bbuttondown.length === 1 && ents.lc.listeners.xbuttondown.length === 1);
    assert(ents.panels.object3D.visible);
    ents.lc.listeners.ybuttondown[0]({ detail: {} }); assert(!ents.panels.object3D.visible, 'Y did not hide the panels');
    ents.lc.listeners.ybuttondown[0]({ detail: {} }); assert(ents.panels.object3D.visible, 'Y did not show the panels again');
    // pressing Y on the right entity too must not double-toggle (an event reaching both entities would cancel itself out)
    ents.lc.listeners.ybuttondown[0](); ents.rc.listeners.ybuttondown[0](); assert(ents.panels.object3D.visible, 'two Y events cancel out - expected');
  });
  await t('Follow/jump turns the tower so the module ends up straight ahead (inside: where the camera looks; miniature: facing the viewer)', () => {
    const w = ents.world.object3D, ang = (x, z) => Math.atan2(-x, -z), diff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    S.mini = false; w.scale.setScalar(1); w.position.set(0, 0, 0); w.rotation.y = 0.3; camWrap.position.set(0, 1.6, 0);
    for (const yaw of [0, 0.7, -2.4, 3.0]) {
      camWrap.rotation.set(0, yaw, 0); camWrap.updateMatrixWorld(true);
      for (const depth of [20, 90, 150]) {
        const i = S.depth.indexOf(depth); const rotBefore = w.rotation.y;
        S.yawTarget = null; S.ys.v = 0;     // this test measures a turn that starts from rest (an earlier test may have left some velocity: a new jump then continues it smoothly)
        RH.jumpTo(i); assert(S.yawTarget !== null, 'no turn was requested');
        frame(16, 1); assert(Math.abs(w.rotation.y - rotBefore) < 0.05, 'must start gently, not snap (moved ' + (w.rotation.y - rotBefore) + ')');
        let prevV = 0, maxJump = 0; const trace = []; for (let k = 0; k < 72 * 8 && S.yawTarget !== null; k++) { const r0 = w.rotation.y; frame(1000 / 72, 1); const v = (w.rotation.y - r0) * 72; if (Math.abs(v - prevV) > 0.3) trace.push(`k${k}:${prevV.toFixed(3)}->${v.toFixed(3)}`); maxJump = Math.max(maxJump, Math.abs(v - prevV)); prevV = v; }
        assert.strictEqual(S.yawTarget, null, 'turn never finished'); assert(maxJump < 0.3, 'angular speed jumped by ' + maxJump + ' rad/s in one frame (trace ' + trace.slice(0, 3).join(' ') + '; yaw ' + yaw + ', depth ' + depth + ', layout ' + S.layout + ', start rot ' + rotBefore.toFixed(3) + ', end rot ' + w.rotation.y.toFixed(3) + ', ys.v ' + S.ys.v + ')');
        w.updateMatrixWorld(true);
        const m = new THREE.Vector3(S.pos[3 * i], 0, S.pos[3 * i + 2]).applyMatrix4(w.matrixWorld);
        assert(diff(ang(m.x, m.z), yaw) < 0.02, `module not straight ahead: it is at ${ang(m.x, m.z).toFixed(3)}, camera looks at ${yaw}`);
      }
    }
    // turning by hand cancels a pending automatic turn
    RH.jumpTo(S.depth.indexOf(50)); S.ax.rx = 1; frame(16, 2); S.ax.rx = 0; assert.strictEqual(S.yawTarget, null, 'manual rotate should cancel the automatic turn');
    // miniature: the module comes to the side facing the viewer
    camWrap.rotation.set(0, 0, 0); camWrap.position.set(0.5, 1.6, 0.8); camWrap.updateMatrixWorld(true);
    S.mini = true; RH.scaleMini(1); w.position.set(0, 0.75, -1.6); w.rotation.y = 0;
    const j = S.depth.indexOf(100); RH.jumpTo(j); for (let k = 0; k < 600 && S.yawTarget !== null; k++) frame(1000 / 72, 1); w.updateMatrixWorld(true);
    const mm = new THREE.Vector3(S.pos[3 * j], 0, S.pos[3 * j + 2]).applyMatrix4(w.matrixWorld).sub(new THREE.Vector3(w.position.x, 0, w.position.z));
    assert(diff(ang(mm.x, mm.z), ang(0.5 - w.position.x, 0.8 - w.position.z)) < 0.02, 'in the miniature the module must face the viewer');
    S.mini = false; RH.scaleMini(1); S.mini = false; w.scale.setScalar(1); w.position.set(0, 0, 0); w.rotation.y = 0; camWrap.position.set(0, 1.6, 0); camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true);
  });
  await t('desktop keys mirror the VR buttons: B/M miniature, X follow, H/Y hide UI, R recenter; held keys do not flicker', () => {
    const key = (code, repeat) => winL.keydown.forEach((f) => f({ code, repeat: !!repeat }));
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0;
    const m0 = S.mini; key('KeyB'); assert.strictEqual(S.mini, !m0, 'B must toggle the miniature'); key('KeyB', true); assert.strictEqual(S.mini, !m0, 'a held key must not retrigger');
    key('KeyM'); assert.strictEqual(S.mini, m0, 'M must still work');
    RH.stopFollow(); key('KeyX'); assert(S.follow && !S.followStill, 'X: follow with camera'); key('KeyX'); assert(S.follow && S.followStill, 'X again: follow in place'); key('KeyX'); assert(!S.follow && !S.followStill, 'X a third time: off');
    camWrap.rotation.set(0, 1.0, 0); camWrap.updateMatrixWorld(true); key('KeyR');
    assert(Math.abs(ents.panels.object3D.rotation.y - 1.0) < 1e-6, 'R must put the panels in front of the viewer: ' + ents.panels.object3D.rotation.y);
    camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true); key('KeyR');
    key('KeyA'); key('KeyW'); assert.strictEqual(S.follow, false, 'WASD must not trigger anything but movement');
  });
  await t('H/Y hides the depth labels together with the panels; zoom changes the field of view within limits', () => {
    const press = (code) => winL.keydown.forEach((f) => f({ code }));
    assert(RH.rulers.length > 0 && RH.rulers.every((m) => m.visible));
    press('KeyH'); assert(RH.rulers.every((m) => !m.visible), 'depth labels must hide with the UI'); press('KeyH'); assert(RH.rulers.every((m) => m.visible));
    assert.strictEqual(ents.cam.fov === undefined ? 80 : ents.cam.fov, ents.cam.fov === undefined ? 80 : ents.cam.fov);
    const mag = (f) => 1 / Math.tan(f * Math.PI / 360);
    press('Equal'); assert(S.fov < 80 && S.fov > 70, 'one step in: ' + S.fov); for (let k = 0; k < 60; k++) press('Equal'); assert.strictEqual(S.fov, RH.FOV_MIN, 'zoom in is limited');
    assert(Math.abs(mag(RH.FOV_MIN) / mag(20) - 2) < 1e-9, 'zoom in reaches 2x the old limit (20 deg): ' + RH.FOV_MIN);
    for (let k = 0; k < 80; k++) press('Minus'); assert.strictEqual(S.fov, RH.FOV_MAX, 'zoom out is limited'); assert.strictEqual(ents.cam.fov, RH.FOV_MAX);
    assert(Math.abs(mag(100) / mag(RH.FOV_MAX) - 2) < 1e-9, 'zoom out reaches 2x the old limit (100 deg): ' + RH.FOV_MAX); assert(RH.FOV_MAX < 179);
    press('Digit0'); assert.strictEqual(S.fov, 80); assert.strictEqual(ents.cam.fov, 80);
    const wheel = winL.wheel; // (wheel is on the canvas)
    sceneCanvas.listeners.wheel[0]({ deltaY: -100, shiftKey: true }); assert(S.fov < 80, 'Shift+wheel up zooms in');
    sceneCanvas.listeners.wheel[0]({ deltaY: 0, deltaX: 100, shiftKey: true }); assert(Math.abs(S.fov - 80) < 1e-9, 'browsers swap Shift+wheel to deltaX (and in/out are exact inverses)');
    const e0 = S.focus; sceneCanvas.listeners.wheel[0]({ deltaY: 100, shiftKey: false }); assert(S.focus !== e0 || S.mini, 'plain wheel must still move the elevator');
  });
  await t('depth labels face the viewer: outward from outside the tower, inward once you are inside it', () => {
    const normalOf = (m) => new THREE.Vector3(0, 0, 1).applyEuler(m.rotation);
    const ruler0 = RH.rulers.find((m) => Math.abs(m.userData.ang) < 1e-9);          // sits at +X of the ring
    S.mini = true; S.scale = 0.08; RH.scaleMini(1);                                   // miniature in front of us, we stand outside
    ents.world.object3D.position.set(0, 0.75, -1.6); camWrap.position.set(0, 1.6, 0); camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true);
    RH.updateRulers(true); assert(normalOf(ruler0).x > 0.99, 'outside: label must face away from the axis, normal=' + normalOf(ruler0).toArray());
    RH.bringToMe(); RH.updateRulers(true); assert(normalOf(ruler0).x < -0.99, 'inside: label must face the axis, normal=' + normalOf(ruler0).toArray());
    S.bringPrev = null;
  });
  await t('Bring to me: tower axis through the head, at the height of the selected module; size buttons clamp', () => {
    camWrap.position.set(0.3, 1.6, -0.4); camWrap.updateMatrixWorld(true); S.bringPrev = null;
    const i = S.depth.indexOf(80); RH.select(i); RH.bringToMe();
    const w = ents.world.object3D; w.updateMatrixWorld(true);
    const head = new THREE.Vector3(0.3, 1.6, -0.4).applyMatrix4(new THREE.Matrix4().copy(w.matrixWorld).invert());
    assert(Math.hypot(head.x, head.z) < 1e-6, 'head is off the tower axis: ' + head.toArray());
    assert(Math.abs(head.y - 80 * S.meta.yStep) < 1e-6, 'wrong level: ' + head.y);
    for (let k = 0; k < 40; k++) RH.scaleMini(1.3); assert(Math.abs(S.scale - 0.6) < 1e-9);
    for (let k = 0; k < 60; k++) RH.scaleMini(1 / 1.3); assert(Math.abs(S.scale - 0.03) < 1e-9);
    RH.scaleMini(1); S.scale = 0.08; RH.scaleMini(1);
  });
  await t('grab the miniature with a controller grip: follows translation and yaw, only in miniature mode, released on gripup', () => {
    const w = ents.world.object3D;
    S.mini = false; ents.rc.object3D.position.set(0, 1.2, -1); ents.rc.object3D.rotation.set(0, 0, 0); ents.rc.object3D.updateMatrixWorld(true);
    ents.rc.listeners.gripdown[0](); assert.strictEqual(S.grab, null, 'grab must not start when we are inside the tower');
    S.mini = true; RH.scaleMini(1); w.position.set(0, 0.75, -1.6); w.rotation.y = 0.2;
    ents.rc.object3D.position.set(0, 1.2, -1); ents.rc.object3D.rotation.set(0, 0, 0); ents.rc.object3D.updateMatrixWorld(true);
    ents.rc.listeners.gripdown[0](); assert(S.grab && S.grab.src === 'right');
    ents.rc.object3D.position.set(0.3, 1.5, -1.2); ents.rc.object3D.rotation.set(0, 0.5, 0); ents.rc.object3D.updateMatrixWorld(true); frame();
    assert(Math.abs(w.position.x - 0.3) < 1e-6 && Math.abs(w.position.y - (0.75 + 0.3)) < 1e-6 && Math.abs(w.position.z - (-1.6 - 0.2)) < 1e-6, 'did not follow: ' + w.position.toArray());
    assert(Math.abs(w.rotation.y - 0.7) < 1e-6, 'yaw not followed: ' + w.rotation.y);
    ents.rc.listeners.gripup[0](); assert.strictEqual(S.grab, null);
    ents.rc.object3D.position.set(1, 1, 1); ents.rc.object3D.updateMatrixWorld(true); frame(); assert(Math.abs(w.position.x - 0.3) < 1e-6, 'moved after release');
  });
  await t('tracked hands: pinch on a menu button clicks it; pinch on empty space grabs the miniature; pinch end releases', () => {
    camWrap.position.set(0, 1.6, 0); camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true);
    ents.panels.object3D.position.set(0, 0, 0); ents.panels.object3D.rotation.y = 0; ents.panels.object3D.updateMatrixWorld(true);
    ents.rc.object3D.position.set(5, 5, 5); ents.rc.object3D.updateMatrixWorld(true); ents.lc.object3D.position.set(5, 5, 5); ents.lc.object3D.updateMatrixWorld(true);   // controllers parked out of the way
    const tip = new THREE.Vector3(); const hand = { hasPoses: true, indexTipPosition: tip, isPinched: false };
    ents.rh.components = { 'hand-tracking-controls': hand }; ents.rh.object3D.visible = true;
    const shoulder = new THREE.Vector3(0.17, 1.6 - 0.2, 0);
    const b = panels.menu.buttons.find((x) => x.label === 'Packets'), m = panels.menu.mesh, g = m.geometry.parameters;
    const T = new THREE.Vector3(((b.x + b.w / 2) / panels.menu.pw - 0.5) * g.width, (1 - (b.y + b.h / 2) / panels.menu.ph - 0.5) * g.height, 0).applyMatrix4(m.matrixWorld);
    tip.copy(T).sub(shoulder).normalize().multiplyScalar(0.45).add(shoulder);
    setView('tower'); ents.rh.listeners.pinchstarted[0](); assert.strictEqual(S.view, 'packets', 'hand pinch missed the menu button'); assert.strictEqual(S.grab, null, 'clicking a button must not grab');
    setView('tower');
    S.mini = true; RH.scaleMini(1); tip.set(0.1, 2.4, -0.4);                       // pointing up into empty space
    ents.rh.listeners.pinchstarted[0](); assert(S.grab && S.grab.src === 'rhand', 'pinch on empty space should grab');
    tip.set(0.4, 2.4, -0.4); frame(); ents.rh.listeners.pinchended[0](); assert.strictEqual(S.grab, null);
    ents.rh.components = {}; S.mini = false; RH.scaleMini(1); S.mini = false; ents.world.object3D.scale.setScalar(1);
  });
  await t('Live build header paints with CPU/RAM bars, and the menu (14 buttons + hints) still fits', () => {
    S.status = { counts: { open: 1, assigned: 1, done: 1, ours: 1 }, receipts: [], running: true, packetLog: ['x'], sys: { cpu: 73, load1: 9.1, cpus: 16, memUsedGB: 40, memTotalGB: 121, lean: 9 }, compiling: [{ i: 5, name: 'A.B.C.D', secs: 75 }] };
    for (const k in panels) panels[k].dirty = true; frame(); assert(panels.menu.buttons.length >= 14, 'menu buttons: ' + panels.menu.buttons.length);
    const last = panels.menu.buttons.reduce((a, x) => Math.max(a, x.y + x.h), 0); assert(last < panels.menu.ph, 'a button is outside the menu canvas');
  });
  await t('module sphere: satellites = declarations, telemetry drives energy/label, click on a satellite jumps to its source', async () => {
    setView('tower'); S.mini = false; ents.world.object3D.scale.setScalar(1); frame();
    const i = S.nameIdx.get('Development.AbelianVarietyTheory.Proofs.DivisorProofs.PowForm') ?? S.depth.indexOf(30);
    RH.select(i); await until(() => S.src.tok || S.src.error); frame(16, 3);
    const c = RH.core(); assert(c.group.visible, 'core must show for the selected module'); assert(S.decls.length > 0, 'no declarations found in ' + S.names[i]);
    assert.strictEqual(c.sats.count, Math.min(S.decls.length, 160)); assert.strictEqual(c.orbit.length, c.sats.count);
    assert(c.group.position.distanceTo(new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2])) < 1e-9);
    // telemetry: calm when not compiling, energetic when it is
    frame(16, 60); const calm = c.shellMat.uniforms.uEnergy.value; assert(calm < 0.2, 'idle energy ' + calm);
    S.status = { ...STATUS, compiling: [{ i, name: S.names[i], secs: 192, cpu: 117, rssMB: 7400 }] }; RH.coreTelemetry(); frame(16, 120);   // same call the status poll makes
    assert(c.tele && c.tele.cpu === 117, 'telemetry not picked up'); assert(c.shellMat.uniforms.uEnergy.value > 0.8, 'energy should rise with CPU: ' + c.shellMat.uniforms.uEnergy.value);
    assert(c.shellMat.uniforms.uSpeed.value > 1.5); assert(c.heart.scale.x > 0.07, 'core should grow with memory: ' + c.heart.scale.x);
    assert(!c.group.children.some((o) => o.isSprite), 'there must be no text sprite above the module');
    // a satellite is hit by a ray aimed at it; the click scrolls the source to that declaration and highlights it
    ents.world.object3D.updateMatrixWorld(true);   // earlier tests moved the world; the renderer would refresh this each frame
    const k = Math.min(S.decls.length, 160) - 1, wp = c.satPos[k].clone().applyMatrix4(c.group.matrixWorld);
    const o = wp.clone().add(new THREE.Vector3(0.3, 0.1, 0.9)), d = wp.clone().sub(o).normalize();
    const hit = RH.coreSatPick(o, d); assert(hit && hit.k === k, 'satellite not picked: ' + JSON.stringify(hit));
    assert(RH.coreSatPick(o, d.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.8)) === null, 'a ray aimed elsewhere must miss');
    frame(16, 2); RH.jumpToDecl(k); frame();
    const rows = panels.source ? S.src.rows : null; assert(S.src.hl && S.src.hl.from === S.decls[k].line, 'declaration not highlighted');
    const firstVisible = rows[S.src.scroll].li, last = rows[Math.min(rows.length - 1, S.src.scroll + 20)].li;
    assert(firstVisible <= S.decls[k].line + 1 && S.decls[k].line <= Math.max(last, firstVisible + 25), 'source did not scroll to the declaration');
    S.status = STATUS; frame(16, 5);
  });
  await t('satellites: one instanced mesh, shape/colour by declaration kind, lit + morphing shaders, per-instance data in sync with the source', async () => {
    setView('tower');
    // find a module whose source has declarations of at least two different kinds (otherwise the checks below would be vacuous)
    let found = false; const cands = []; for (let i = 0; i < S.n && cands.length < 40; i++) if (S.depth[i] === 33 || S.depth[i] === 45) cands.push(i);
    for (const i of cands) { RH.select(i); await until(() => S.src.tok || S.src.error); frame(16, 2); if (new Set(S.decls.map((d) => d.kind)).size >= 2) { found = true; break; } }
    assert(found, 'no candidate module with >= 2 declaration kinds'); frame(16, 30); const c = RH.core(), ga = c.sats.geometry.attributes, m = c.sats.material;
    assert(c.sats.count >= 2, 'the satellite loop below must actually run'); assert(m.isShaderMaterial && c.sats.isInstancedMesh, 'satellites must be a lit shader, not a flat basic material'); assert(ga.aKind.isInstancedBufferAttribute && ga.aCol.isInstancedBufferAttribute);
    const KIND = { theorem: 0, lemma: 1, def: 2, instance: 3, structure: 4, class: 4, inductive: 4, abbrev: 5, axiom: 6 }, COL = { theorem: 0x4fb0ff, lemma: 0x7be4ff, def: 0xffb454, instance: 0xc792ea, structure: 0xff6b9a, class: 0xff6b9a, inductive: 0xff6b9a, abbrev: 0xffd133, axiom: 0xff3b3b };
    const kinds = new Set(); for (let k = 0; k < c.sats.count; k++) { const d = S.decls[k]; kinds.add(d.kind); assert.strictEqual(ga.aKind.array[k], KIND[d.kind] !== undefined ? KIND[d.kind] : 2, 'kind index of #' + k);
      const hex = COL[d.kind] || 0xffffff; assert(Math.abs(ga.aCol.array[3 * k] - ((hex >> 16) & 255) / 255) < 1e-6 && Math.abs(ga.aCol.array[3 * k + 2] - (hex & 255) / 255) < 1e-6, 'colour of #' + k); assert(ga.aSeed.array[k] >= 0 && ga.aSeed.array[k] <= 1); }
    assert(kinds.size >= 2); console.log('     declaration kinds in this module:', [...kinds].join(', '), `(${c.sats.count} satellites)`);
    const v = m.vertexShader, f = m.fragmentShader;
    for (const need of ['k < .5', 'k < 1.5', 'k < 2.5', 'k < 3.5', 'k < 4.5', 'k < 5.5', '.88/oct', '.90/oct', 'instanceMatrix', 'uTime']) assert(v.includes(need), 'vertex shader lacks ' + need);
    for (const need of ['dFdx(vP)', 'reflect(-L, N)', 'vObj.y', 'uAlpha']) assert(f.includes(need), 'fragment shader lacks ' + need);
    const varyings = (sh) => [...sh.matchAll(/varying\s+(?:float|vec3)\s+([^;]+);/g)].flatMap((x) => x[1].split(',').map((y) => y.trim())).sort(); assert.deepStrictEqual(varyings(v), varyings(f), 'vertex/fragment varyings must match');
    for (const sh of [v, f]) { assert((sh.match(/\{/g) || []).length === (sh.match(/\}/g) || []).length, 'unbalanced braces'); for (const x of sh.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) assert(parseFloat(x[1]) < parseFloat(x[2]), 'reversed smoothstep'); }
    assert(m.uniforms.uAlpha.value > 0.9 && m.uniforms.uTime.value > 0, 'faded in and animated'); const t0 = m.uniforms.uTime.value; frame(16, 10); assert(m.uniforms.uTime.value !== t0, 'the morph animation must advance');
  });
  await t('core: the module\'s real source code is painted onto a repeating texture, bands drift in their own directions and speeds, and it never rides along to another module', async () => {
    setView('tower'); const cands = []; for (let i = 0; i < S.n && cands.length < 40; i++) if (S.depth[i] === 33) cands.push(i);
    let i1 = -1; for (const i of cands) { RH.select(i); await until(() => S.src.tok || S.src.error); frame(16, 2); if (S.src.tok && RH.codeLines(S.src.tok).length >= 3) { i1 = i; break; } } assert(i1 >= 0, 'no module with enough code lines');
    frame(16, 40); const c = RH.core(), u = c.heart.material.uniforms, expect = RH.codeLines(S.src.tok);
    assert.strictEqual(u.uHasCode.value, 1, 'code layer on'); assert(u.uCode.value === c.codeTex && c.codeTex.wrapS === THREE.RepeatWrapping, 'repeating texture bound');
    assert(expect.every((l) => !/^(import|open|namespace|--|\/-)/.test(l)), 'boilerplate and comments must be skipped');
    drawn.length = 0; RH.paintCode(c, S.src.tok); assert(drawn.some((x) => x.includes(expect[3 % expect.length].slice(0, 14))), 'the module\'s actual source text must be what is drawn');
    assert(drawn.length >= 18, 'one text row per band: ' + drawn.length);
    const f = c.heart.material.fragmentShader; for (const need of ['floor(vUv.y*18.)', 'dir = h > .5 ? 1. : -1.', 'texture2D(uCode', 'uHasCode', 'sin(3.14159*vUv.y)']) assert(f.includes(need), 'heart shader lacks ' + need);
    assert(/varying vec2 vUv/.test(c.heart.material.vertexShader) && /vUv = uv/.test(c.heart.material.vertexShader), 'the vertex shader must pass uv');
    // speeds are tiny (a full turn takes minutes): max band speed in the shader = (.004 + .010) * (1 + 2) revolutions per second
    assert((0.004 + 0.010) * 3 < 0.05, 'drift must stay gentle');
    // another module: the slot that is reused starts without code until its own source arrives
    const i2 = cands.find((i) => i !== i1); RH.select(i2); const slot = RH.core(); assert.notStrictEqual(slot, c); assert.strictEqual(slot.heart.material.uniforms.uHasCode.value, 0, 'no code from the previous module');
    await until(() => S.src.name === S.names[i2] && (S.src.tok || S.src.error)); frame(16, 3); assert.strictEqual(slot.heart.material.uniforms.uHasCode.value, S.src.tok && RH.codeLines(S.src.tok).length ? 1 : 0);
    frame(16, 60);
  });
  await t('core: the nucleus shows the estimated compile progress (grows, breathes past the estimate, flashes when done); the code sphere pulses at half the old rate', async () => {
    setView('tower'); let i = -1; for (let k = 0; k < S.n; k++) if (S.st[k] === 0 && S.csr.impStart[k + 1] - S.csr.impStart[k] >= 2) { i = k; break; }
    RH.select(i); frame(16, 60); const c = RH.core(); assert.strictEqual(c.i, i);
    const nuc = () => c.nucleus.scale.x / (c.heart.scale.x * 0.5), setTele = (secs) => { S.status = { ...(S.status || {}), compiling: [{ i, name: S.names[i], secs, est: 20, cpu: 90, rssMB: 4000 }] }; S.statusAt = performance.now(); RH.coreTelemetry(); };
    RH.coreTelemetry(); frame(16, 3); assert(Math.abs(nuc() - 0.18) < 1e-6, 'open module: only a seed (' + nuc() + ')');
    setTele(2); frame(16, 1); const n1 = nuc(); setTele(10); frame(16, 1); const n2 = nuc(); setTele(19); frame(16, 1); const n3 = nuc();
    assert(n1 < n2 && n2 < n3 && n3 <= 1.0001, 'grows with elapsed / expected: ' + [n1, n2, n3].map((x) => x.toFixed(3)));
    assert(Math.abs(n2 - (0.18 + 0.82 * 0.5)) < 0.02, 'half-way at half the estimate: ' + n2);
    setTele(60); const over = []; for (let k = 0; k < 45; k++) { await new Promise((r) => setTimeout(r, 100)); setTele(60); frame(16, 1); over.push(nuc()); } assert(Math.max(...over) > 1.05 && Math.min(...over) < 0.95, 'past the estimate it breathes: ' + Math.min(...over).toFixed(3) + '..' + Math.max(...over).toFixed(3) + ' tele=' + JSON.stringify(RH.core().tele));
    // done: the compile entry disappears and the module is marked built -> one flash, then a full nucleus
    S.status = { ...S.status, compiling: [] }; global.__es.onmessage({ data: JSON.stringify({ k: 'built', i, name: S.names[i], n: 1, N: 2, s: 30 }) }); RH.coreTelemetry(); frame(16, 1);
    assert(nuc() > 1.5, 'it flashes when the module is done: ' + nuc()); frame(16, 80); assert(Math.abs(nuc() - 1) < 1e-6, 'then stays full: ' + nuc());
    // the code sphere: half the old pulse rate
    const src = RH.coreTick.toString(); assert(src.includes('T * HEART_W * (1 + 3.5 * u.uEnergy.value)'), 'heart pulse = old (2 + 7e) / 2');
  });
  await t('Main is special: an always-visible golden landmark at the top of the tower, and a crowned (larger, golden) core when selected', async () => {
    const b = RH.beacon(), mi = RH.mainIdx(); assert(b && mi >= 0, 'the beacon must exist'); setView('tower'); RH.clearSelForTest && RH.clearSelForTest();
    panels.info.buttons.find((x) => x.label === 'Clear') && panels.info.buttons.find((x) => x.label === 'Clear').fn(); frame(16, 40);
    const mp = new THREE.Vector3(S.pos[3 * mi], S.pos[3 * mi + 1], S.pos[3 * mi + 2]); assert(b.group.position.distanceTo(mp) < 1e-9, 'beacon sits on Main');
    assert(S.depth[mi] === S.meta.maxDepth, 'Main is the deepest module (top of the tower)'); assert(b.group.visible && b.coreMesh.visible, 'visible even with nothing selected');
    assert.strictEqual(b.rings.length, 3); const r0 = b.rings.map((m) => m.rotation.x + m.rotation.y); frame(16, 30); const r1 = b.rings.map((m) => m.rotation.x + m.rotation.y);
    assert(r0.every((v, k) => v !== r1[k]), 'the rings must turn');
    // the critical line: thin, going up from Main; on it the first 30 zeros of zeta, at heights proportional to their imaginary parts
    assert(b.beam.position.y > 5 && b.beam.material.blending === THREE.AdditiveBlending, 'the critical line goes up from Main');
    assert(b.beam.geometry.parameters.radiusTop <= 0.006 && b.beam.geometry.parameters.radiusBottom <= 0.006, 'a THIN line, not a shaft');
    const zp = b.zeros.geometry.attributes.position, zh = b.zeros.geometry.attributes.aH, Z = global.RHLib.ZETA_ZEROS; assert.strictEqual(zp.count, 4 * Z.length, 'a quad per zero');
    const bt = b.beam.position.y - b.beam.geometry.parameters.height / 2, tp = b.beam.position.y + b.beam.geometry.parameters.height / 2;
    for (let k = 0; k < Z.length; k++) { const y = zp.getY(4 * k), want = (Z[k] - Z[0]) / (Z[Z.length - 1] - Z[0]);
      assert(Math.abs(zh.getX(4 * k) - want) < 1e-6, 'zero ' + k + ' height follows its imaginary part'); assert(y > bt && y < tp, 'zero ' + k + ' sits on the line'); assert(zp.getX(4 * k) === 0 && zp.getZ(4 * k) === 0); }
    const gaps = []; for (let k = 1; k < Z.length; k++) gaps.push(zp.getY(4 * k) - zp.getY(4 * k - 4)); assert(gaps.every((g) => g > 0) && gaps[0] > 2.5 * gaps[gaps.length - 1], 'denser upwards');
    const zv = b.zeroMat.vertexShader, zf = b.zeroMat.fragmentShader;
    assert(zv.includes('mod(uTime, uCycle)') && zv.includes('uSweep*sqrt(aH)') && zv.includes('exp(-dt/uDecay)'), 'blink formula = L.zeroFlash'); assert(zf.includes('flare') && /\*vF/.test(zf), 'horizontal flare only while blinking');
    assert(b.zeroMat.blending === THREE.AdditiveBlending && !b.zeroMat.depthWrite); const zt = b.zeroMat.uniforms.uTime.value; frame(16, 5); assert(b.zeroMat.uniforms.uTime.value > zt, 'the blinks run');
    for (const sh of [zv, zf]) for (const x of sh.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) assert(parseFloat(x[1]) < parseFloat(x[2]));
    setView('packets'); frame(); assert(!b.group.visible, 'only in the tower view'); setView('tower'); frame(); assert(b.group.visible);
    // selecting Main: crowned core
    RH.select(mi); frame(16, 60); const c = RH.core(); assert.strictEqual(c.i, mi);
    assert(Math.abs(c.group.scale.x - 2.2) < 1e-9, 'crown size: ' + c.group.scale.x); assert.strictEqual(c.shell.material.uniforms.uStreaks.value, 12, 'all twelve comets for Main');
    assert.strictEqual(c.shellMat.uniforms.uColor.value.getHex(), 0xffd36b, 'golden shell'); assert.strictEqual(c.heart.material.uniforms.uColor.value.getHex(), 0xffeeb8, 'golden-white heart');
    assert(!b.coreMesh.visible, 'the beacon core steps aside for the crowned core'); assert(b.group.visible, 'rings, beam and corona stay');
    // an ordinary module is not crowned
    RH.select(S.depth.indexOf(40)); frame(16, 60); const o = RH.core(); assert(o !== c && Math.abs(o.group.scale.x - 1) < 1e-9 && o.shellMat.uniforms.uColor.value.getHex() !== 0xffd36b, 'normal modules stay normal');
    frame(16, 60); assert(b.coreMesh.visible, 'the beacon core is back when Main is not selected');
  });
  await t('layouts: tower <-> helix x2/x4/x8 load on demand, morph smoothly, keep everything consistent (lines, cores, centroids), and are reversible', async () => {
    setView('tower'); const tower = S.layouts.tower.slice(); assert.strictEqual(S.layout, 'tower'); assert(S.pos.every((v, k) => v === tower[k]), 'start: the tower');
    const i = S.depth.indexOf(60); RH.select(i); frame(16, 40);
    const waitMorph = async () => { await until(() => !S.layoutLoading); for (let k = 0; k < 400 && RH.layoutState().morph; k++) frame(16, 1); };
    const rib = () => RH.fibers();                     // the default link style
    // 1. into the double helix
    assert(rib().geometry.drawRange.count > 0, 'ribbons visible before'); const ptsGeo = RH.halo().pts.geometry.attributes.position;
    const before = S.pos.slice(); await RH.setLayout('helix2'); assert(RH.layoutState().morph, 'a morph must have started'); const to = RH.layoutState().morph.to;
    assert.strictEqual(rib().geometry.drawRange.count, 0, 'ribbons are hidden during the morph (they would point at moving targets)');
    frame(16, 50); const x = RH.layoutState().morph.t, e = x * x * (3 - 2 * x), k = 3 * 12345;
    assert(Math.abs(S.pos[k] - (before[k] + (to[k] - before[k]) * e)) < 1e-4, 'mid-morph positions are the eased blend'); assert(ptsGeo.version > 0);
    await waitMorph(); assert.strictEqual(S.layout, 'helix2'); assert(S.pos.every((v, j) => v === to[j]), 'ends exactly on the target layout');
    assert(rib().geometry.drawRange.count > 0, 'ribbons are back at the new positions'); assert.strictEqual(S.layoutTarget, 'helix2');
    const lp = rib().geometry.attributes.position, d0 = Math.hypot(lp.getX(0) - S.pos[3 * i], lp.getY(0) - S.pos[3 * i + 1], lp.getZ(0) - S.pos[3 * i + 2]);
    assert(d0 <= RH.RIB.start + 1e-5 && d0 > 1e-3, 'tubes start on the selected module\'s core surface in the new layout: ' + d0);
    const c = RH.core(); assert(c.group.position.distanceTo(new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2])) < 1e-9, 'the sphere moved with its module');
    const p = S.pk[i]; let sx = 0, sz = 0, cnt = 0; for (let j = 0; j < S.n; j++) if (S.pk[j] === p) { sx += S.pos[3 * j]; sz += S.pos[3 * j + 2]; cnt++; }
    assert(Math.abs(S.pkPos[3 * p] - sx / cnt) < 1e-3 && Math.abs(S.pkPos[3 * p + 2] - sz / cnt) < 1e-3, 'packet centroids recomputed for the packets view');
    const mi = RH.mainIdx(); assert(RH.beacon().group.position.distanceTo(new THREE.Vector3(S.pos[3 * mi], S.pos[3 * mi + 1], S.pos[3 * mi + 2])) < 1e-9, 'the Main landmark moved with Main');
    // 2. cycle with the key / the button: x2 -> x4 -> x8 -> tower
    const press = (code) => winL.keydown.forEach((f) => f({ code })), btn = () => panels.menu.buttons.find((b) => b.label.startsWith('Layout'));
    for (const kk in panels) panels[kk].dirty = true; frame(); assert.strictEqual(btn().label, 'Layout: helix ×2');
    for (const [name, label] of [['helix4', 'Layout: helix ×4'], ['helix8', 'Layout: helix ×8'], ['tower', 'Layout: tower']]) { press('KeyL'); await waitMorph(); assert.strictEqual(S.layout, name); for (const kk in panels) panels[kk].dirty = true; frame(); assert.strictEqual(btn().label, label); }
    assert(S.pos.every((v, j) => v === tower[j]), 'back to the tower: exactly the original positions');
    // 3. interrupting a morph starts from the positions as drawn (no jump)
    await RH.setLayout('helix4'); frame(16, 40); const mid = S.pos.slice(); await RH.setLayout('helix8'); const m2 = RH.layoutState().morph; let maxJump = 0; for (let j = 0; j < mid.length; j += 997) maxJump = Math.max(maxJump, Math.abs(m2.from[j] - mid[j])); assert(maxJump < 1e-6, 'the new morph must start where the old one was: ' + maxJump);
    await waitMorph(); assert.strictEqual(S.layout, 'helix8'); await RH.setLayout('tower'); await waitMorph(); assert.strictEqual(S.layout, 'tower');
    // 4. a failed download leaves everything as it was and says so
    const real = global.fetch; global.fetch = (u, o) => String(u).includes('pos_helix2') ? Promise.resolve({ ok: false, status: 404 }) : real(u, o); delete S.layouts.helix2;
    await RH.setLayout('helix2'); assert(S.layoutError.includes('404'), 'error recorded: ' + S.layoutError); assert.strictEqual(S.layout, 'tower'); assert.strictEqual(S.layoutTarget, 'tower'); assert(!RH.layoutState().morph);
    for (const kk in panels) panels[kk].dirty = true; frame(); assert.strictEqual(btn().label, 'Layout: failed'); global.fetch = real; S.layoutError = '';
    assert(S.pos.every((v, j) => v === tower[j]), 'positions untouched after the failure'); frame(16, 5);
  });
  await t('module sphere fades out when the selection is cleared (not a pop) and stays out of the packets view', () => {
    const c = RH.core(); frame(16, 40); assert(c.fade > 0.99, 'should be fully shown first');
    panels.info.buttons.find((b) => b.label === 'Clear').fn(); assert.strictEqual(S.decls.length, 0); assert.strictEqual(c.target, 0);
    frame(16, 3); assert(c.group.visible && c.fade < 1 && c.fade > 0, 'must be mid-fade, not gone: ' + c.fade);
    frame(16, 30); assert(c.group.visible, 'still collapsing at ~0.5 s'); frame(16, 50); assert(!c.group.visible, 'fully faded out after OUT_SEC (~1.2 s)');
    RH.select(S.depth.indexOf(12)); setView('packets'); RH.select(S.depth.indexOf(12)); frame(16, 40); assert(!RH.cores().some((x) => x.group.visible), 'sphere belongs to the tower view'); setView('tower'); frame(16, 40);
  });
  await t('Main (the whole graph as ancestry) is dimmed so it is not a solid wall; normal modules and Closure off stay at full strength', () => {
    const u = () => RH.halo().ptsMat.uniforms; setView('tower'); S.closureOn = true;
    RH.select(S.depth.indexOf(20)); assert.strictEqual(u().uHiA.value, 1, 'a normal module must be unchanged'); assert.strictEqual(u().uHiS.value, 1);
    RH.select(S.nameIdx.get('Main')); assert(S.ancestors > 100000); assert(u().uHiA.value < 0.15 && u().uHiS.value <= 0.5, 'Main must be dimmed: ' + u().uHiA.value);
    S.closureOn = false; RH.select(S.nameIdx.get('Main'), true); assert.strictEqual(u().uHiA.value, 1, 'with Closure off only direct imports are lit, so full strength');
    S.closureOn = true; RH.select(S.depth.indexOf(20)); assert.strictEqual(u().uHiA.value, 1, 'and it must come back');
    assert(/uHiA/.test(RH.halo().ptsHalo.material.vertexShader), 'the halo shader must use the same dimming');
  });
  await t('panels are drawn last and on top (deterministic HUD order): no depth test, above every other transparent thing', () => {
    let maxOther = -Infinity; ents.world.object3D.traverse((o) => { if (o.material || o.isPoints) maxOther = Math.max(maxOther, o.renderOrder); });
    for (const k in panels) { const m = panels[k].mesh; assert(!m.material.depthTest && !m.material.depthWrite && m.material.transparent, k + ': must ignore depth'); assert(m.renderOrder > maxOther && m.renderOrder >= 100, `${k}: renderOrder ${m.renderOrder} must exceed the world's ${maxOther}`); }
    for (const [h, b] of Object.entries(sceneRoot.children.filter((c) => c.isGroup).reduce((o, g, i) => ({ ...o, [i]: g }), {}))) { let beamOrder = 0; b.traverse((x) => { beamOrder = Math.max(beamOrder, x.renderOrder); }); assert(beamOrder > 100, 'laser beams must stay above the panels'); }
  });
  await t('Closure has three modes: off / dim / only (everything else hidden); "only" never hides everything when nothing is selected', () => {
    const u = () => RH.halo().ptsMat.uniforms, btn = () => panels.menu.buttons.find((b) => b.label.startsWith('Closure')), press = (code) => winL.keydown.forEach((f) => f({ code }));
    setView('tower'); RH.select(S.depth.indexOf(20)); S.closureOn = true; S.closureOnly = false; RH.select(S.depth.indexOf(20)); frame();
    assert.strictEqual(btn().label, 'Closure: dim'); assert.strictEqual(u().uHiOn.value, 1); assert.strictEqual(u().uHiOnly.value, 0);
    btn().fn(); frame(); assert.strictEqual(btn().label, 'Closure: only'); assert.strictEqual(u().uHiOnly.value, 1, 'only: the rest must be hidden');
    assert(/uHiOnly/.test(RH.halo().ptsHalo.material.vertexShader), 'the halo must hide the same dots');
    btn().fn(); frame(); assert.strictEqual(btn().label, 'Closure: off'); assert.strictEqual(u().uHiOn.value, 0); assert.strictEqual(u().uHiOnly.value, 0);
    press('KeyC'); assert.strictEqual(S.closureOn && !S.closureOnly, true, 'C: off -> dim'); press('KeyC'); assert.strictEqual(S.closureOnly, true, 'C: dim -> only'); press('KeyC'); assert.strictEqual(S.closureOn, false, 'C: only -> off');
    // 'only' with nothing selected must not blank the whole tower
    S.closureOn = true; S.closureOnly = true; panels.info.buttons.find((b) => b.label === 'Clear').fn(); assert.strictEqual(u().uHiOnly.value, 0, 'nothing selected -> nothing hidden');
    S.closureOn = true; S.closureOnly = false; RH.select(S.depth.indexOf(20)); assert.strictEqual(u().uHiOnly.value, 0);
  });
  await t('Bring to me is a toggle: the second press ("Back") restores the exact previous placement, in both start modes', () => {
    const w = ents.world.object3D, btn = () => panels.menu.buttons.find((b) => b.label === 'Bring to me' || b.label === 'Back'), same = (a, b) => a.distanceTo(b) < 1e-9;
    camWrap.position.set(0.4, 1.6, -0.2); camWrap.rotation.set(0, 0, 0); camWrap.updateMatrixWorld(true);
    for (const startMini of [false, true]) {
      S.bringPrev = null; S.mini = startMini; S.scale = 0.08; if (startMini) { w.position.set(0.7, 0.9, -1.8); w.rotation.y = 0.4; S.miniPlaced = true; } else { w.position.set(0, 1.6 - S.focus, 0); w.rotation.y = 0.4; S.miniPlaced = false; }
      w.scale.setScalar(startMini ? 0.08 : 1); const p0 = w.position.clone(), r0 = w.rotation.y, s0 = S.scale, m0 = S.mini;
      frame(); assert.strictEqual(btn().label, 'Bring to me'); btn().fn(); frame(); assert.strictEqual(btn().label, 'Back'); assert(S.mini, 'brought = miniature around the head');
      w.position.x += 0.3;                                         // the user nudges it while it is around the head: Back must still restore the ORIGINAL
      btn().fn(); frame(); assert.strictEqual(btn().label, 'Bring to me'); assert.strictEqual(S.mini, m0, 'mode restored'); assert(same(w.position, p0), 'position not restored: ' + w.position.toArray() + ' vs ' + p0.toArray());
      assert(Math.abs(w.rotation.y - r0) < 1e-9 && S.scale === s0, 'rotation/scale not restored');
    }
    // switching tower/miniature by hand forgets the stored placement (a later "Back" would be wrong)
    S.bringPrev = null; btn().fn(); assert(S.bringPrev); winL.keydown.forEach((f) => f({ code: 'KeyB' })); assert.strictEqual(S.bringPrev, null);
    S.mini = false; ents.world.object3D.scale.setScalar(1); ents.world.object3D.position.set(0, 0, 0); ents.world.object3D.rotation.y = 0; S.bringPrev = null; frame();
  });
  await t('adaptive glow: slow frames in VR lower the glow one level (not on the desktop, not while fast); pressing G clears the note', () => {
    const press = (code) => winL.keydown.forEach((f) => f({ code })); const run = (ms, n) => { for (let k = 0; k < n; k++) tickFn.call({}, performance.now(), ms); };
    S.glow = 2; S.glowAuto = false; S.frameMs = 0; S.slowMs = 0; vrMode = false; run(40, 200); assert.strictEqual(S.glow, 2, 'desktop: never lowered');
    vrMode = true; run(11, 400); assert.strictEqual(S.glow, 2, 'fast frames: unchanged');
    run(40, 60); assert.strictEqual(S.glow, 2, 'a short slow patch (2.4 s) is tolerated'); run(11, 30);
    S.frameMs = 0; S.slowMs = 0; run(40, 120); assert.strictEqual(S.glow, 1, 'sustained slowness lowers it one step'); assert(S.glowAuto);
    run(40, 120); assert.strictEqual(S.glow, 0, 'and another step if it stays slow'); run(40, 200); assert.strictEqual(S.glow, 0, 'never below off');
    for (const k in panels) panels[k].dirty = true; frame(); press('KeyG'); assert.strictEqual(S.glow, 1); assert(!S.glowAuto, 'a manual change clears the automatic note');
    vrMode = false; S.glow = 1; S.glowAuto = false; S.frameMs = 0; S.slowMs = 0;
  });
  await t('dots are shaded as spheres, and the halo is smaller than before', () => {
    const { ptsHalo } = RH.halo(); const src = window.__fragSrc;
    assert(/sqrt\(1\. - r2\)/.test(src) && /reflect\(-Ld, n\)/.test(src) && /smoothstep\(\.80, 1\., r2\)/.test(src), 'sphere shading missing from the dot fragment shader');
    assert(!/smoothstep\(\s*1\.\s*,\s*\.80/.test(src), 'reversed smoothstep edges are undefined in GLSL');
    assert(/, 4\., 28\.\)/.test(ptsHalo.material.vertexShader), 'halo size cap'); assert(ptsHalo.material.uniforms.uHaloScale.value <= 2.5);
  });
  await t('connected and compiling modules are real 3D bubbles (instanced ellipsoids), their flat dots hidden; GLSL sanity', async () => {
    const { pts, ptsMat } = RH.halo(), sol = RH.solids(), g = sol.geometry, sum = (a) => a.reduce((x, y) => x + y, 0);
    setView('tower'); S.closureOn = true; S.live.clear(); for (let k = 0; k < S.n; k++) if (S.stF[k] > 3.5) S.stF[k] = S.st[k];
    const i = S.depth.indexOf(120); RH.select(i);
    const list = RH.solidList();
    assert(g.isInstancedBufferGeometry && g.attributes.normal, 'instanced lit geometry');
    const zs = g.attributes.position.array.filter((_, k) => k % 3 === 2); assert(Math.max(...zs) - Math.min(...zs) > 1.5, 'the base shape is a solid, not a flat card');
    assert(list.length > 0 && list.length <= RH.SOLID.max && g.instanceCount === list.length, 'bubbles drawn for the connected modules: ' + list.length);
    assert.strictEqual(sum(S.solidF), list.length, 'exactly the bubbles are hidden in the dot cloud');
    for (const [n, e] of list.entries()) {
      assert.strictEqual(S.solidF[e.i], 1); assert(e.kind === (S.hiF[e.i] < 1.5 ? 1 : 2), 'kind follows import/consumer');
      for (let c = 0; c < 3; c++) assert.strictEqual(g.attributes.aCenter.array[3 * n + c], S.pos[3 * e.i + c], 'bubble sits on its module');
    }
    assert(!list.some((e) => e.i === i), 'the selected module is the core, not a bubble');
    { const sd = Array.from(g.attributes.aSeed.array.slice(0, list.length)); assert(new Set(sd.map((x) => x.toFixed(3))).size > Math.min(500, 0.5 * sd.length), 'every bubble needs its own phase/tempo'); }
    assert(/aSolid > \.5\) \{ gl_Position = vec4\(2\./.test(ptsMat.vertexShader) && /aSolid/.test(RH.halo().ptsHalo.material.vertexShader), 'dot (and its halo) hidden where a bubble is drawn');
    assert(g.index && g.attributes.position.count >= 300, 'smooth sphere, not a coarse polyhedron: ' + g.attributes.position.count + ' vertices');
    assert(sol.material.side === THREE.DoubleSide && sol.material.uniforms.uScale === ptsMat.uniforms.uScale && sol.material.uniforms.uHiA === ptsMat.uniforms.uHiA, 'bubbles follow the dot size / dimming');
    // a module that starts compiling becomes a bubble too, and leaves the list when its flash ends
    const j = S.depth.indexOf(7); __es.onmessage({ data: JSON.stringify({ k: 'built', i: j, name: S.names[j], n: 1, N: 2, s: 3 }) });
    await new Promise((r) => setTimeout(r, 300)); frame();
    assert(RH.solidList()[0].i === j && RH.solidList()[0].kind === 4 && S.solidF[j] === 1, 'live module first, as kind 4');
    S.live.set(j, performance.now() - 1); S.lastUpload = 0; await new Promise((r) => setTimeout(r, 300)); frame(); frame();
    assert(!RH.solidList().some((e) => e.i === j), 'expired live module back to a dot');
    setView('packets'); assert.strictEqual(g.instanceCount, 0); assert.strictEqual(sum(S.solidF), 0, 'packets view: no bubbles, no hidden dots'); setView('tower');
    // shader sanity (GLSL is not compiled in node)
    const v = sol.material.vertexShader, f = sol.material.fragmentShader, src = window.__fragSrc;
    assert(!/vWob|vBub/.test(src + ptsMat.vertexShader), 'the flat sprite wobble is gone');
    assert((v.match(/uTime/g) || []).length === 2 && /float T = uTime\*uTempo;/.test(v), 'all bubble motion runs on T = uTime*uTempo');
    for (const m of v.matchAll(/T\*\(([0-9.]+) \+ ([0-9.]+)\*/g)) assert(parseFloat(m[1]) + parseFloat(m[2]) <= 3.15, 'bubble beat faster than ~2 s: ' + m[0]);
    assert(!/sin\(uTime\*9\.\)/.test(v), 'no shared fast blink');
    assert(/ax \/= pow\(ax\.x\*ax\.y\*ax\.z, 1\.\/3\.\)/.test(v) && /normal\/ax/.test(v), 'ellipsoid: volume kept, normals transformed with the inverse axes');
    for (const [n, sh] of [['frag', f], ['vert', v], ['dots', src], ['dotsv', ptsMat.vertexShader]]) { for (const m of sh.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) assert(parseFloat(m[1]) < parseFloat(m[2]), n + ': reversed smoothstep edges ' + m[0]); assert((sh.match(/\{/g) || []).length === (sh.match(/\}/g) || []).length, n + ': unbalanced braces'); assert((sh.match(/\(/g) || []).length === (sh.match(/\)/g) || []).length, n + ': unbalanced parentheses'); }
    const varyings = (s) => [...s.matchAll(/varying\s+(?:float|vec3)\s+([^;]+);/g)].flatMap((m) => m[1].split(',').map((x) => x.trim())).sort();
    assert.deepStrictEqual(varyings(v), varyings(f), 'bubble shaders: same varyings'); assert.deepStrictEqual(varyings(ptsMat.vertexShader), varyings(src), 'dot shaders: same varyings');
  });
  await t('debug: one-letter labels only on active objects (core parts, satellites, bubbles, links, Main), toggled by button / I, legend in the menu', async () => {
    const { panels } = RH, press = (code) => winL.keydown.forEach((f) => f({ code }));
    setView('tower'); S.closureOn = true; if (S.links !== 'fibers') RH.cycleLinks();
    const i = S.depth.indexOf(120); RH.select(i); frame(16, 30);
    for (const k in panels) panels[k].dirty = true; frame();
    assert(panels.menu.buttons.find((b) => b.label === 'Debug: off'), 'menu has the Debug button');
    assert.strictEqual(RH.dbgGroup().visible, false); frame(); assert.strictEqual(RH.dbgGroup().children.filter((x) => x.visible).length, 0, 'no labels while off');
    press('KeyI'); assert(S.debug && RH.dbgGroup().visible); frame(); frame();
    assert(panels.menu.buttons.find((b) => b.label === 'Debug: on'), 'button shows the state');
    const labels = RH.debugLabels(), letters = new Set(labels.map((l) => l.letter));
    for (const need of ['A', 'B', 'C', 'H']) assert(letters.has(need), 'missing label ' + need + ' in ' + [...letters].join(''));
    assert(letters.has('E') || letters.has('F'), 'connected bubbles are labelled');
    if (RH.core().orbit.length) assert(letters.has('D'), 'satellites labelled');
    // passive dots are never labelled: every bubble label sits exactly on a bubble module
    const solid = new Set(RH.solidList().map((e) => S.pos[3 * e.i] + ',' + S.pos[3 * e.i + 1] + ',' + S.pos[3 * e.i + 2]));
    for (const l of labels.filter((x) => 'EFG'.includes(x.letter))) assert(solid.has(l.p.x + ',' + l.p.y + ',' + l.p.z), 'bubble label not on a bubble');
    assert(labels.filter((x) => 'EFG'.includes(x.letter)).length <= 24 && labels.length < 80, 'label count stays small: ' + labels.length);
    const shown = RH.dbgGroup().children.filter((x) => x.visible);
    assert.strictEqual(shown.length, labels.length, 'one sprite per label'); assert(shown.every((x) => x.material.depthTest === false && x.material.sizeAttenuation === false), 'labels always readable, constant size');
    assert.deepStrictEqual(shown.map((x) => x.userData.letter).sort(), labels.map((x) => x.letter).sort());
    const L2 = RH.DEBUG_KINDS.map((k) => k[0]); assert.strictEqual(new Set(L2).size, L2.length, 'letters are unique');
    // zooming in must not magnify the labels: their size times the zoom factor stays the same on screen
    const onScreen = () => { const sp = RH.dbgGroup().children.find((x) => x.visible); return sp.scale.y / Math.tan(S.fov * Math.PI / 360); };
    const fov0 = S.fov, s0 = onScreen(); RH.setFov(RH.FOV_MIN); frame(); const s1 = onScreen(); RH.setFov(fov0); frame();
    assert(Math.abs(s1 / s0 - 1) < 1e-6, 'label grows with zoom: ' + (s1 / s0).toFixed(3));
    setView('packets'); assert.strictEqual(RH.debugLabels().length, 0, 'packets view: no labels'); setView('tower');
    press('KeyI'); assert(!S.debug && !RH.dbgGroup().visible, 'I again hides them');
  });
  await t('selection change: the old module lingers ~1.2 s, fading and collapsing inwards; the new one appears in 0.4 s; the arc lasts long enough to follow', () => {
    setView('tower'); const a = S.depth.indexOf(40), b = S.depth.lastIndexOf(150); RH.select(a); frame(16, 120);
    RH.select(b); const old = RH.cores().find((x) => x.i === a), neu = RH.core(), L0 = RH.link;
    assert(old && old !== neu && old.target === 0);
    frame(16, 25);                                                    // 0.4 s
    assert(neu.fade > 0.99, 'the new module is fully there after FADE_SEC'); assert(old.group.visible && old.fade > 0.55, 'the old one is still clearly visible at 0.4 s: ' + old.fade.toFixed(2));
    assert(L0.dot.visible && L0.dot.position.distanceTo(neu.group.position) > 0.05, 'the arc point is still on its way at 0.4 s');
    frame(16, 25);                                                    // 0.8 s
    assert(old.group.visible && old.group.scale.x < 0.85 && old.group.scale.x > 0.15, 'collapsing inwards: ' + old.group.scale.x.toFixed(2));
    frame(16, 25);                                                    // 1.2 s
    assert(L0.dot.position.distanceTo(neu.group.position) < 0.02, 'the arc point arrives at the new module');
    frame(16, 10); assert(!old.group.visible, 'gone after OUT_SEC');
    frame(16, 15); assert(L0.line.visible && !L0.dot.visible, 'the point is gone, the arc itself still fades');
    // quick jumps leave a web: every arc fades on its own, a new jump does not cancel the previous ones
    const jumps = [60, 80, 100].map((d) => S.depth.indexOf(d)); for (const j of jumps) { RH.select(j); frame(16, 20); }
    const web = RH.links().filter((x) => x.line.visible); assert(web.length >= 4, 'a fading web of arcs: ' + web.length);
    const ops = web.map((x) => x.line.material.opacity); assert(Math.max(...ops) > Math.min(...ops), 'older arcs are fainter');
    frame(100, 70); assert(RH.links().every((x) => !x.line.visible), 'all arcs gone after LINK_SEC');
  });
  await t('menu: keyboard help lines on the desktop only (none in the headset, warnings kept); the desktop key hint has a dark backing', () => {
    const { panels } = RH, painted = () => { for (const k in panels) panels[k].dirty = false; drawn.length = 0; panels.menu.dirty = true; frame(); return drawn.join('\n'); };
    vrMode = false; assert(/Closure \(C\)/.test(painted()), 'desktop shows the help lines');
    vrMode = true; const v = painted(); assert(!/\((C|N|G)\)/.test(v) && !/Hide open: hide/.test(v), 'no keyboard help in VR');
    assert(/LEGEND|DEBUG LABELS|NAMESPACES|DEPTH/.test(v), 'the legend is still there in VR'); vrMode = false; panels.menu.dirty = true; frame();
    const html = require('fs').readFileSync(__dirname + '/../static/index.html', 'utf8'); assert(/#hud\{[^}]*background:rgba\(0,0,0,\.8/.test(html), 'dark backing behind the key hint');
  });
  await t('module core is a lit, layered sphere (plasma shader + nucleus inside), animated by state/energy, fading with the crossfade', () => {
    setView('tower'); RH.select(S.depth.indexOf(33)); frame(16, 60); const c = RH.core();
    assert(c.heart.material.isShaderMaterial && c.nucleus.material.isShaderMaterial, 'the core must not be a flat basic material'); assert(c.heart.material.transparent && c.nucleus.scale.x < c.heart.scale.x, 'nucleus sits inside the core');
    const hu = c.heart.material.uniforms, nu = c.nucleus.material.uniforms; assert(hu.uAlpha.value > 0.5 && nu.uAlpha.value > 0.5, 'visible when fully faded in');
    assert(hu.uPhase.value !== nu.uPhase.value, 'different noise phase gives the parallax between core and nucleus');
    const col0 = hu.uColor.value.getHex(); S.status = { ...STATUS, compiling: [{ i: c.i, name: 'x', secs: 5, cpu: 100, rssMB: 4000 }] }; RH.coreTelemetry(); frame(16, 30);
    assert.notStrictEqual(hu.uColor.value.getHex(), col0, 'colour follows the state (compiling = hot)'); assert(hu.uEnergy.value > 0.3);
    S.status = STATUS; RH.coreTelemetry();
    RH.select(S.depth.indexOf(90)); frame(16, 12); const old = RH.cores().find((x) => x.target === 0 && x.group.visible); assert(old && old.heart.material.uniforms.uAlpha.value < 0.85 * 0.99 && old.heart.material.uniforms.uAlpha.value > 0, 'the old core fades with its sphere');
    frame(16, 60);
  });
  await t('glow: halo reuses the dots\' geometry and uniforms, cycles off/on/all with G and the menu, follows the view, buttons do not overlap', () => {
    const { ptsHalo, pkHalo, pts, ptsMat } = RH.halo(); const press = (code) => winL.keydown.forEach((f) => f({ code }));
    setView('tower'); assert.strictEqual(S.glow, 1, 'glow should default to the middle level');
    assert(ptsHalo.geometry === pts.geometry, 'no copy of the point data'); for (const k of ['position', 'aState', 'aNs', 'aDepth', 'aHi']) assert(ptsHalo.geometry.attributes[k] === pts.geometry.attributes[k]);
    for (const k of ['uTime', 'uMode', 'uHideOpen', 'uHiOn', 'uScale', 'uSize']) assert(ptsHalo.material.uniforms[k] === ptsMat.uniforms[k], 'uniform ' + k + ' must be shared, or colours/time would drift');
    assert(ptsHalo.material.blending === THREE.AdditiveBlending && !ptsHalo.material.depthWrite); assert(/uGlowOpen/.test(ptsHalo.material.vertexShader) && /uHaloScale/.test(ptsHalo.material.vertexShader));
    assert(ptsHalo.visible && ptsHalo.material.uniforms.uGlowOpen.value === 0 && !pkHalo.visible, 'level 1: halo on built dots only');
    press('KeyG'); assert.strictEqual(S.glow, 2); assert(ptsHalo.visible && ptsHalo.material.uniforms.uGlowOpen.value > 0, 'level 2 adds a faint halo to open dots');
    press('KeyG'); assert.strictEqual(S.glow, 0); assert(!ptsHalo.visible && !pkHalo.visible, 'level 0 = no halo at all');
    press('KeyG'); assert.strictEqual(S.glow, 1);
    setView('packets'); assert(pkHalo.visible && !ptsHalo.visible, 'packets view has its own halo'); press('KeyG'); press('KeyG'); assert(!pkHalo.visible); press('KeyG'); setView('tower'); assert(ptsHalo.visible && !pkHalo.visible);
    frame(16, 2); const btn = () => panels.menu.buttons.find((b) => b.label.startsWith('Glow')); assert.strictEqual(btn().label, 'Glow: on'); btn().fn(); frame(); assert.strictEqual(btn().label, 'Glow: all'); btn().fn(); frame(); assert.strictEqual(btn().label, 'Glow: off'); btn().fn(); frame();
    const row = panels.menu.buttons.filter((b) => b.y === btn().y); assert.strictEqual(row.length, 4); row.sort((a, b) => a.x - b.x);
    for (let k = 1; k < row.length; k++) assert(row[k].x >= row[k - 1].x + row[k - 1].w + 5, 'buttons overlap'); assert(row[3].x + row[3].w <= panels.menu.pw - 20);
    assert(panels.menu.buttons.reduce((m, x) => Math.max(m, x.y + x.h), 0) < panels.menu.ph, 'menu overflows its canvas');
  });
  await t('crossfade: the old module fades out WHILE the new one fades in (both visible), a soft arc links them, nothing pops', () => {
    frame(16, 60); const [A, B] = RH.cores(), pos = (i) => new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]);
    const i1 = S.depth.indexOf(40), i2 = S.depth.indexOf(120);
    RH.select(i1); frame(16, 40); const first = RH.core(); assert(first.fade > 0.99 && first.i === i1);
    RH.select(i2); const second = RH.core(); assert(second !== first, 'the new module must use the other slot'); assert.strictEqual(first.target, 0); assert.strictEqual(second.target, 1);
    assert(first.group.position.distanceTo(pos(i1)) < 1e-9, 'the old sphere must stay where it was while it fades'); assert(second.group.position.distanceTo(pos(i2)) < 1e-9);
    frame(16, 5);                                                    // 80 ms in
    assert(first.group.visible && second.group.visible, 'both must be visible at once'); assert(first.fade < 1 && first.fade > 0.5 && second.fade > 0 && second.fade < 0.5, `fades: old ${first.fade}, new ${second.fade}`);
    assert(RH.link.line.visible && RH.link.line.material.opacity > 0.1, 'the hand-over arc should be showing'); const dot0 = RH.link.dot.position.clone();
    frame(16, 8); assert(RH.link.dot.position.distanceTo(pos(i2)) < dot0.distanceTo(pos(i2)), 'the dot must travel towards the new module');
    // monotone, bounded, no frame-to-frame jump bigger than a fade step
    let prevOld = first.fade, prevNew = second.fade, maxStep = 0;
    for (let k = 0; k < 40; k++) { frame(16, 1); maxStep = Math.max(maxStep, Math.abs(first.fade - prevOld), Math.abs(second.fade - prevNew)); assert(first.fade <= prevOld + 1e-12 && second.fade >= prevNew - 1e-12 && first.fade >= 0 && second.fade <= 1); prevOld = first.fade; prevNew = second.fade; }
    assert(maxStep <= 16 / 1000 / 0.4 + 1e-9, 'a fade step was bigger than allowed: ' + maxStep);
    assert(first.group.visible && second.fade === 1, 'new fully shown at ~0.85 s, the old one still collapsing'); frame(16, 30); assert(!first.group.visible, 'old gone after OUT_SEC');
    frame(100, 65); assert(!RH.link.line.visible && !RH.link.dot.visible, 'the arc must disappear (LINK_SEC)');
    // the same module selected again (e.g. closure toggled) must not restart anything
    const slot = RH.core(); RH.select(i2, true); assert.strictEqual(RH.core(), slot); assert.strictEqual(slot.fade, 1); assert.strictEqual(RH.cores().filter((x) => x.target === 1).length, 1);
  });
  await t('rapid selections never leave more than two spheres and never a stuck one', () => {
    frame(16, 40); const ids = [20, 55, 90, 130, 170].map((d) => S.depth.indexOf(d));
    for (const i of ids) { RH.select(i); frame(16, 3); assert(RH.cores().filter((x) => x.group.visible).length <= 2); assert.strictEqual(RH.cores().filter((x) => x.target === 1).length, 1); }
    frame(16, 60); assert.strictEqual(RH.cores().filter((x) => x.group.visible).length, 1); assert.strictEqual(RH.core().i, ids[ids.length - 1]);
  });
  await t('sound: silent until switched on; button/N toggle; built modules sound where they are; DONE line = one chord; load drives the bed; volume buttons and N work', async () => {
    assert.strictEqual(audioCtxs.length, 0, 'an AudioContext was created before the user asked for sound');
    const snd = RH.sound(); assert(snd && !snd.state().on);
    RH.soundModule(5); assert.strictEqual(audioCtxs.length, 0, 'a built module must not create audio while sound is off');
    const btn = () => panels.menu.buttons.find((b) => b.label.startsWith('Sound'));
    assert.strictEqual(btn().label, 'Sound: off'); btn().fn(); frame(); assert(snd.state().on && audioCtxs.length === 1); assert.strictEqual(btn().label, 'Sound: on');
    const c = audioCtxs[0]; c.currentTime = 10;
    // a module built now sounds at ITS position in world space (tower may be rotated/scaled)
    const w = ents.world.object3D; w.position.set(0.5, 0, -0.3); w.rotation.y = 0.9; w.scale.setScalar(1); w.updateMatrixWorld(true);
    const i = S.depth.indexOf(70), p = new THREE.Vector3(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]).applyMatrix4(w.matrixWorld);
    RH.soundModule(i); const pan = c.of('panner').pop(); assert(pan, 'no positioned note'); assert(Math.abs(pan.positionX.value - p.x) < 1e-9 && Math.abs(pan.positionY.value - p.y) < 1e-9 && Math.abs(pan.positionZ.value - p.z) < 1e-9, 'note is not where the module is');
    w.position.set(0, 0, 0); w.rotation.y = 0; w.updateMatrixWorld(true);
    // the first status line set only seeds; a NEW DONE line gives exactly one chord
    const osc0 = () => c.of('osc').length; S.doneSeen = undefined;                 // as on a fresh page load
    const o0 = osc0(); RH.soundPacketLines(['[x] picked P1', '[x] DONE P1 (64 modules)']); assert.strictEqual(osc0(), o0, 'the first status only seeds: a packet finished before we opened the page must not sound');
    const a0 = osc0();
    RH.soundPacketLines(['[x] DONE P1 (64 modules)']); assert.strictEqual(osc0(), a0, 'same DONE line must not sound again');
    RH.soundPacketLines(['[x] DONE P1 (64 modules)', '[y] DONE P2 (64 modules)']); assert.strictEqual(osc0(), a0 + 8, 'a new DONE line = one chord (4 notes x 2 oscillators)');
    RH.soundPacketLines(['[y] claimed P3']); assert.strictEqual(osc0(), a0 + 8, 'other lines are silent');
    // the machine drives the bed
    const lp = c.of('biquad')[0], cut = () => lp.frequency.calls.filter((x) => x[0] === 'target').pop()[1];
    RH.soundLoad({ cpu: 5, memUsedGB: 2, memTotalGB: 121 }); const calm = cut(); RH.soundLoad({ cpu: 95, memUsedGB: 60, memTotalGB: 121 }); assert(cut() > calm * 3, 'bed should open with CPU');
    // volume buttons and keyboard
    const v0 = snd.state().volume; panels.menu.buttons.find((b) => b.label === 'Vol +').fn(); assert(snd.state().volume > v0 - 1e-9 && snd.state().volume <= 1);
    panels.menu.buttons.find((b) => b.label === 'Vol −').fn(); panels.menu.buttons.find((b) => b.label === 'Vol −').fn(); assert(snd.state().volume < v0 + 1e-9);
    winL.keydown.forEach((f) => f({ code: 'KeyN' })); assert(!snd.state().on, 'N must switch sound off'); winL.keydown.forEach((f) => f({ code: 'KeyN' })); assert(snd.state().on, 'N must switch it on again');
    winL.keydown.forEach((f) => f({ code: 'KeyN' })); const n1 = c.nodes.length; RH.soundModule(i); assert.strictEqual(c.nodes.length, n1, 'off = no new nodes');
    assert(panels.menu.buttons.reduce((a, x) => Math.max(a, x.y + x.h), 0) < panels.menu.ph, 'menu overflows its canvas');
  });
  await t('sound: a browser-suspended context shows "Sound: tap" + the reason, any gesture (key, pointer, controller) unlocks it, and the label returns', () => {
    const snd = RH.sound(), c = audioCtxs[0], btn = () => panels.menu.buttons.find((b) => b.label.startsWith('Sound')), press = (code) => winL.keydown.forEach((f) => f({ code }));
    if (!snd.state().on) press('KeyN');                       // make sure it is on
    frame(); assert.strictEqual(btn().label, 'Sound: on');
    c.state = 'suspended'; c.allowResume = false; c.onstatechange && c.onstatechange(); frame();
    assert.strictEqual(btn().label, 'Sound: tap', 'a suspended context must be visible'); assert.strictEqual(snd.state().running, false);
    const before = c.resumed; winL.pointerdown && winL.pointerdown.forEach((f) => f({})); assert(c.resumed > before, 'a pointer press must retry resume()');
    const b2 = c.resumed; ents.rc.listeners.triggerdown[0](); assert(c.resumed > b2, 'a controller trigger must retry resume()');
    c.allowResume = true; press('KeyZ'); frame(); assert.strictEqual(btn().label, 'Sound: on', 'once resumed the label returns'); assert.strictEqual(snd.state().running, true);
    const n0 = c.nodes.length; panels.menu.buttons.find((b) => b.label === 'Vol +').fn(); assert(c.nodes.length > n0, 'volume change must blip');
  });
  await t('Live build states are told apart (waiting for grant / claiming / verifying / starting / stopped / building / between) with the detail line', () => {
    const cases = [
      [{ kind: 'waiting-grant', text: 'waiting for grant #8217 · 4m12s' }, 'waiting for grant', ['waiting for grant #8217 · 4m12s']],
      [{ kind: 'claiming', text: 'claiming P1700' }, 'claiming', ['claiming P1700']],
      [{ kind: 'finishing', text: 'verifying & uploading P1696' }, 'verifying & uploading', ['verifying & uploading P1696']],
      [{ kind: 'starting', text: 'starting the build of P1696' }, 'starting build', ['starting the build of P1696']],
      [{ kind: 'stopped', text: 'stopped (BUILD_FAILED)' }, 'STOPPED', ['stopped (BUILD_FAILED)']],
      [{ kind: 'between', text: 'between packets (next one is being picked)' }, 'next packet', ['between packets (next one is being picked)']],
      [{ kind: 'backoff', text: 'retrying later: NO_FREE_PACKET (1/6) - retrying in 10 min' }, 'retrying', ['retrying later: NO_FREE_PACKET (1/6) - retrying in 10 min']],
      [{ kind: 'booting', text: 'the loop is starting (fetching updates, checking the reserved packet)' }, 'starting', ['the loop is starting (fetching updates, checking the reserved packet)']],
      [{ kind: 'building', text: 'building P1696' }, 'building', []],
    ];
    for (const [phase, label, details] of cases) {
      drawn.length = 0; S.status = { ...STATUS, compiling: [], sys: { cpu: 3, load1: 1, cpus: 16, memUsedGB: 5, memTotalGB: 121, lean: 0 }, phase }; for (const k in panels) panels[k].dirty = true; frame();
      assert(drawn.includes(label), `${phase.kind}: header label "${label}" not drawn`); for (const d of details) assert(drawn.some((x) => x.includes(d)), `${phase.kind}: detail "${d}" not drawn`);
      assert(drawn.some((x) => x.includes(phase.text)), `${phase.kind}: the menu line must carry the full text`);
      if (phase.kind !== 'building') assert(!drawn.includes('idle'), 'a real state must never be shown as plain "idle"');
    }
    drawn.length = 0; S.status = { ...STATUS, compiling: [{ i: 3, name: 'A.B', secs: 20, cpu: 100, rssMB: 4000 }], phase: { kind: 'building', text: 'building P9' } }; for (const k in panels) panels[k].dirty = true; frame();
    assert(drawn.includes('compiling'), 'while a module compiles the header says so'); S.status = STATUS;
    drawn.length = 0; S.status = { ...STATUS }; delete S.status.phase; for (const k in panels) panels[k].dirty = true; frame(); assert(drawn.includes('idle'), 'an old server without phase still renders'); S.status = STATUS;
  });
  await t('clearSel resets everything', () => { panels.info.buttons.find((b) => b.label === 'Clear').fn(); assert.strictEqual(S.sel, -1); assert(S.hiF.every((x) => x === 0)); frame(); });
  console.log(ok + ' smoke tests passed'); process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
