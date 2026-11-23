// node tests/test_lib.js   (run against the generated data/ and the prepared Lean volume)
const fs = require('fs'), zlib = require('zlib'), path = require('path'), assert = require('assert');
const L = require('../static/lib.js');
const D = path.join(__dirname, '../data');
const u32 = (f) => { const b = fs.readFileSync(path.join(D, f)); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); };
const f32 = (f) => { const b = fs.readFileSync(path.join(D, f)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const meta = JSON.parse(fs.readFileSync(path.join(D, 'meta.json')));
const n = meta.modules;
const lines = zlib.gunzipSync(fs.readFileSync(path.join(D, 'names.txt.gz'))).toString().split('\n');
assert.strictEqual(lines.length, n);
const names = lines.map((l) => l.split('\t')[1]);
const depth = fs.readFileSync(path.join(D, 'depth.u8'));
const pos = f32('pos.f32');
const edges = u32('edges.u32');
let ok = 0; const t = (name, fn) => { fn(); ok++; console.log('ok  ' + name); };

t('csr: edge counts and symmetry', () => {
  const c = L.buildCSR(n, edges);
  assert.strictEqual(c.impList.length, meta.edges); assert.strictEqual(c.conList.length, meta.edges);
  assert.strictEqual(c.impStart[n], meta.edges);
  // every import goes strictly to a shallower module (this is what "depth" means)
  for (let i = 0; i < n; i += 37) for (let k = c.impStart[i]; k < c.impStart[i + 1]; k++) assert(depth[c.impList[k]] < depth[i]);
  // consumer lists are the transpose
  let checked = 0;
  for (let i = 0; i < n && checked < 2000; i += 91) for (let k = c.conStart[i]; k < c.conStart[i + 1]; k++) {
    const j = c.conList[k]; let found = false;
    for (let q = c.impStart[j]; q < c.impStart[j + 1]; q++) if (c.impList[q] === i) found = true;
    assert(found); checked++;
  }
});
t('closure: contains direct imports, excludes self, is transitive', () => {
  const c = L.buildCSR(n, edges);
  let i = 0; for (let k = 0; k < n; k++) if (depth[k] === 5) { i = k; break; }
  const { mark, count } = L.closureImports(c, i);
  assert.strictEqual(mark[i], 2); assert(count > 0);
  let cnt = 0; for (let k = 0; k < n; k++) if (mark[k] === 1) cnt++;
  assert.strictEqual(cnt, count);
  for (let k = c.impStart[i]; k < c.impStart[i + 1]; k++) assert.strictEqual(mark[c.impList[k]], 1);
  for (let k = 0; k < n; k++) if (mark[k] === 1) for (let q = c.impStart[k]; q < c.impStart[k + 1]; q++) assert(mark[c.impList[q]] === 1);
  const deepest = depth.indexOf(meta.maxDepth);
  const r = L.closureImports(c, deepest); console.log('     deepest module', names[deepest], 'has', r.count, 'ancestors');
});
t('layout: y follows depth, ring radius 5..9', () => {
  for (let i = 0; i < n; i += 101) {
    assert(Math.abs(pos[3 * i + 1] - depth[i] * meta.yStep) < 0.031);
    const r = Math.hypot(pos[3 * i], pos[3 * i + 2]); assert(r >= 4.99 && r <= 9.01, r);
  }
});
t('pickPoint: finds the point we aim at', () => {
  for (const i of [0, 777, 54321, 120000, n - 1]) {
    const o = { x: 0, y: pos[3 * i + 1] + 0.2, z: 0 };   // stand at the tower axis
    const v = { x: pos[3 * i] - o.x, y: pos[3 * i + 1] - o.y, z: pos[3 * i + 2] - o.z }; const l = Math.hypot(v.x, v.y, v.z);
    const d = { x: v.x / l, y: v.y / l, z: v.z / l };
    const got = L.pickPoint(pos, n, o, d, null, false, 0.02);
    assert(got >= 0); const dx = pos[3 * got] - pos[3 * i], dy = pos[3 * got + 1] - pos[3 * i + 1], dz = pos[3 * got + 2] - pos[3 * i + 2];
    assert(Math.hypot(dx, dy, dz) < 0.1, 'picked a neighbour, not the target: ' + Math.hypot(dx, dy, dz));
  }
  const t0 = process.hrtime.bigint(); L.pickPoint(pos, n, { x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, null, false, 0.02);
  console.log('     pick over', n, 'points:', Number(process.hrtime.bigint() - t0) / 1e6, 'ms');
  // looking away from everything finds nothing
  assert.strictEqual(L.pickPoint(pos, n, { x: 0, y: 500, z: 0 }, { x: 0, y: 1, z: 0 }, null, false, 0.02), -1);
  // hideOpen skips state 0
  const st = new Uint8Array(n); const i = 4000;
  const o = { x: 0, y: pos[3 * i + 1], z: 0 }, d = { x: pos[3 * i], y: 0, z: pos[3 * i + 2] }; const l = Math.hypot(d.x, d.z); d.x /= l; d.z /= l;
  assert(L.pickPoint(pos, n, o, d, st, false, 0.02) >= 0); assert.strictEqual(L.pickPoint(pos, n, o, d, st, true, 0.02), -1);
});
t('tokenize: comments, strings, keywords, sorry, nested blocks', () => {
  const src = 'import Mathlib\n/- block\n /- nested -/ still -/\ntheorem foo : 1 = 1 := by -- trailing\n  sorry\ndef s := "a \\" b" -- c\naxiom bad : False\n/-- doc -/ lemma x := 1.5';
  const T = L.tokenize(src);
  assert.strictEqual(T.length, 8);
  assert(T[0].some(([x, ty]) => x === 'import' && ty === 'k'));
  assert(T[1].every(([, ty]) => ty === 'c')); assert(T[2].every(([, ty]) => ty === 'c'));   // still inside the nested comment
  assert(T[3].some(([x, ty]) => x === 'theorem' && ty === 'k')); assert(T[3].some(([x, ty]) => x.startsWith('-- trailing') && ty === 'c'));
  assert(T[4].some(([x, ty]) => x === 'sorry' && ty === 'r'));
  assert(T[5].some(([x, ty]) => ty === 's' && x === '"a \\" b"')); assert(T[5].some(([x, ty]) => x === '-- c' && ty === 'c'));
  assert(T[6].some(([x, ty]) => x === 'axiom' && ty === 'r'));
  assert(T[7].some(([x, ty]) => x === 'lemma' && ty === 'k')); assert(T[7].some(([x, ty]) => x === '1.5' && ty === 'n'));
  assert.deepStrictEqual(L.countRed(T), { sorry: 1, axiom: 1 });
  // tokens re-concatenate to the original line (nothing lost or duplicated)
  src.split('\n').forEach((line, k) => assert.strictEqual(T[k].map((x) => x[0]).join(''), line));
});
t('tokenize: real Lean files from the volume round-trip, Main.lean has no sorry', () => {
  const root = path.join(process.env.HOME, 'rh-replay-vol/lean/src');
  let files = 0, bad = 0, lines = 0;
  for (const i of [0, 1000, 20000, 60000, 100000, 150000, n - 1, names.indexOf('Main')]) {
    const f = path.join(root, names[i].replace(/\./g, '/') + '.lean'); if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8'); const T = L.tokenize(txt); files++; lines += T.length;
    txt.split('\n').forEach((line, k) => { if (T[k].map((x) => x[0]).join('') !== line) bad++; });
    if (names[i] === 'Main') assert.deepStrictEqual(L.countRed(T), { sorry: 0, axiom: 0 });
  }
  assert(files >= 5, 'too few source files found: ' + files); assert.strictEqual(bad, 0);
  console.log('     round-tripped', files, 'files /', lines, 'lines');
});
t('wrapTokens: nothing lost, no row too wide, numbering only on first rows, Unicode safe', () => {
  const root = path.join(process.env.HOME, 'rh-replay-vol/lean/src'); let wrapped = 0, rowsN = 0;
  const cp = (s) => [...s].length;
  const files = [0, 1000, 20000, 60000, 100000, 150000, n - 1].map((i) => path.join(root, names[i].replace(/\./g, '/') + '.lean')).filter((f) => fs.existsSync(f));
  files.push(path.join(root, 'Main.lean'));
  const synthetic = 'theorem x (𝕜 : Type) [Field 𝕜] : ∀ a b c d e f g : 𝕜, a + b + c + d + e + f + g = g + f + e + d + c + b + a := by simp [add_comm, add_left_comm, add_assoc, mul_comm]\n' + 'x'.repeat(300);
  for (const txt of [...files.map((f) => fs.readFileSync(f, 'utf8')), synthetic]) {
    const T = L.tokenize(txt), lines = txt.split('\n');
    for (const cols of [40, 72, 100]) {
      const R = L.wrapTokens(T, cols);
      let li = -1, acc = '';
      const flush = () => { if (li >= 0) assert.strictEqual(acc, lines[li]); };
      for (const row of R) {
        const text = row.toks.map((x) => x[0]).join('');
        assert(cp(text) <= cols, 'row too wide: ' + cp(text) + ' > ' + cols);
        assert(Number.isInteger(row.li) && (row.n === 0 || row.n === row.li + 1), 'row.li must be the source line');
        if (row.n) { flush(); li = row.n - 1; acc = text; } else { assert(text.startsWith('    ')); acc += text.slice(4); }
        if (!row.n) wrapped++; rowsN++;
      }
      flush();
      assert.strictEqual(R.filter((r) => r.n).length, lines.length);
    }
  }
  assert(wrapped > 0, 'nothing was wrapped, test is vacuous'); console.log('     rows', rowsN, 'continuations', wrapped);
});
t('smoothDamp: eases in and out, continuous velocity, speed limit, no overshoot', () => {
  const dt = 1 / 72, run = (dist, T, vmax) => {
    const st = { v: 0 }; let x = 0, prevV = 0, maxA = 0, maxV = 0, steps = 0, over = 0, firstV = null;
    while (steps < 72 * 20) {
      x = L.smoothDamp(x, dist, st, T, vmax, dt); steps++;
      const v = (st.v); maxV = Math.max(maxV, Math.abs(v)); maxA = Math.max(maxA, Math.abs(v - prevV) / dt); prevV = v;
      if (firstV === null) firstV = Math.abs(v); over = Math.max(over, x - dist);
      if (Math.abs(x - dist) < 1e-4 && Math.abs(v) < 1e-3) break;
    }
    return { x, steps, maxV, maxA, over, firstV, t: steps * dt };
  };
  for (const dist of [0.3, 2, 10, 20]) {
    const r = run(dist, 1.1, 4);
    assert(Math.abs(r.x - dist) < 1e-3, 'did not arrive'); assert(r.over < 1e-3, 'overshoot ' + r.over);
    assert(r.maxV <= 4 * 1.05, 'speed limit broken: ' + r.maxV);
    assert(r.firstV < 0.2 * Math.max(0.5, Math.min(4, dist)), 'abrupt start: first-frame speed ' + r.firstV);
    console.log('     dist', String(dist).padStart(4), 'm: arrives in', r.t.toFixed(1) + 's, peak', r.maxV.toFixed(2), 'm/s, first frame', r.firstV.toFixed(3), 'm/s, max accel', r.maxA.toFixed(1), 'm/s2');
  }
  // the old exponential ease for comparison: first-frame speed = 2*distance (a 10 m ride starts at 20 m/s)
  const oldFirst = (10 * Math.min(1, dt * 2)) / dt; assert(oldFirst > 15);
  console.log('     old ease: first-frame speed for 10 m =', oldFirst.toFixed(0), 'm/s');
  let x = 5, st = { v: 0 }; for (let i = 0; i < 400; i++) x = L.smoothDamp(x, 5, st, 1.1, 4, dt); assert.strictEqual(x, 5);
});
t('declarations: kinds, names, spans, attributes/modifiers, nothing inside comments; real files', () => {
  const src = ['theorem a : 1 = 1 := rfl', '@[simp] lemma b : True := trivial', 'private def c := 3', 'instance : Foo := ⟨⟩', '/- theorem fake -/', '-- theorem fake2',
    'axiom ax : False', '  have h : x := by simp', 'noncomputable def d := 1', 'structure S where', '  x : Nat'].join('\n');
  const T = L.tokenize(src), D = L.declarations(T);
  assert.deepStrictEqual(D.map((d) => d.kind), ['theorem', 'lemma', 'def', 'instance', 'axiom', 'def', 'structure']);
  assert.deepStrictEqual(D.map((d) => d.name), ['a', 'b', 'c', '', 'ax', 'd', 'S']);
  assert.deepStrictEqual(D.map((d) => d.line), [0, 1, 2, 3, 6, 8, 9]);
  assert.strictEqual(D.reduce((s, d) => s + d.lines, 0), T.length - 0 - D[0].line);
  assert.strictEqual(D[4].lines, 2); assert.strictEqual(D[6].lines, 2);
  const root = path.join(process.env.HOME, 'rh-replay-vol/lean/src'); let files = 0, total = 0;
  for (const i of [0, 1000, 20000, 60000, 100000, 150000, n - 1]) {
    const f = path.join(root, names[i].replace(/\./g, '/') + '.lean'); if (!fs.existsSync(f)) continue;
    const Dd = L.declarations(L.tokenize(fs.readFileSync(f, 'utf8'))); files++; total += Dd.length;
    for (const d of Dd) assert(d.lines >= 1 && ['theorem', 'lemma', 'def', 'instance', 'structure', 'inductive', 'class', 'abbrev', 'axiom'].includes(d.kind));
  }
  assert(files >= 5 && total > files, 'real files should have declarations: ' + total + ' in ' + files); console.log('     real files:', files, 'declarations:', total);
});
t('wrapPi stays in (-PI, PI] and is a pure 2PI shift', () => {
  for (const a of [0, 1, -1, 3.2, -3.2, 10, -10, 100.5]) { const w = L.wrapPi(a); assert(w > -Math.PI - 1e-12 && w <= Math.PI + 1e-12); assert(Math.abs(Math.sin(w) - Math.sin(a)) < 1e-9 && Math.abs(Math.cos(w) - Math.cos(a)) < 1e-9); }
});
t('hiScale: untouched for normal modules, strongly dimmed for huge ancestries (Main = whole graph), monotone and bounded', () => {
  assert.deepStrictEqual(L.hiScale(0), { a: 1, s: 1 }); assert.deepStrictEqual(L.hiScale(1740), { a: 1, s: 1 }); assert.deepStrictEqual(L.hiScale(2500), { a: 1, s: 1 });
  let pa = 1, ps = 1; for (const c of [3000, 5000, 20000, 80000, 175186, 1e7]) { const h = L.hiScale(c); assert(h.a <= pa && h.s <= ps, 'must not grow with count'); assert(h.a >= 0.1 && h.s >= 0.45, 'bounded'); pa = h.a; ps = h.s; }
  const m = L.hiScale(175186); assert(m.a < 0.15 && m.s <= 0.5, 'Main: ' + JSON.stringify(m));
  // total lit "brightness" (count * alpha * size^2) stays within an order of magnitude instead of growing 70x
  const tot = (c) => { const h = L.hiScale(c); return c * h.a * h.s * h.s; }; assert(tot(175186) / tot(2500) < 12, 'still ' + (tot(175186) / tot(2500)).toFixed(1) + 'x brighter than a normal module');
});
t('helix layouts: same height rule as the tower, right-handed strands at the right angle, tube-shaped, balanced, deterministic', () => {
  const H = meta.helix, PI2 = 2 * Math.PI; const ns = fs.readFileSync(path.join(D, 'ns.u8'));
  for (const N of [2, 4, 8]) {
    const P = f32(`pos_helix${N}.f32`); assert.strictEqual(P.length, n * 3);
    let bad = 0, maxRad = 0, minRad = 1e9, maxDy = 0; const perStrand = new Array(N).fill(0);
    for (let i = 0; i < n; i++) {
      const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2]; assert(Number.isFinite(x + y + z));
      const rad = Math.hypot(x, z); maxRad = Math.max(maxRad, rad); minRad = Math.min(minRad, rad); maxDy = Math.max(maxDy, Math.abs(y - depth[i] * meta.yStep));
      // which strand is it on?  angle - (pitch turn) must be 2*pi*s/N within the angular spread
      let a = (Math.atan2(z, x) - PI2 * depth[i] / H.pitchLevels) % PI2; if (a < 0) a += PI2; const s = Math.round(a / (PI2 / N)) % N, dev = Math.abs(((a - s * PI2 / N + Math.PI) % PI2 + PI2) % PI2 - Math.PI);
      if (dev > H.spread + 0.2) bad++; perStrand[s]++;
    }
    assert.strictEqual(bad, 0, N + '-fold: modules off their strand angle: ' + bad);
    assert(minRad >= H.radius - H.tube - 1e-3 && maxRad <= H.radius + H.tube + 1e-3, `radius range ${minRad}..${maxRad}`); assert(maxDy <= H.tube * 0.5 + 1e-3, 'height must stay depth*yStep +- the tube: ' + maxDy);
    const mx = Math.max(...perStrand), mn = Math.min(...perStrand); assert(mx / mn < 1.15, `strands unbalanced: ${perStrand}`);
    // Main (deepest module) is still at the top
    const top = depth.indexOf(meta.maxDepth); assert(Math.abs(P[3 * top + 1] - meta.maxDepth * meta.yStep) <= H.tube * 0.5 + 1e-3);
    console.log(`     ${N}-fold: radius ${minRad.toFixed(2)}..${maxRad.toFixed(2)} m, strands ${perStrand.join('/')}`);
  }
  // right-handed: going up one pitch turns the strand by a full revolution counter-clockwise, half a pitch by half a turn
  const P2 = f32('pos_helix2.f32'); const find = (d) => { for (let i = 0; i < n; i++) if (depth[i] === d) return i; }; const ang = (i) => Math.atan2(P2[3 * i + 2], P2[3 * i]);
  const q = H.pitchLevels / 4, i0 = find(20), i1 = find(20 + q); const diffq = ((ang(i1) - ang(i0)) % PI2 + PI2) % PI2; assert(Math.abs(diffq - Math.PI / 2) < 0.9, 'a quarter pitch should turn about +90 degrees, got ' + (diffq * 180 / Math.PI).toFixed(0));
});
t('helix layouts differ from the tower and from each other, and are not degenerate (no two modules on the same spot)', () => {
  const T = pos, A = f32('pos_helix2.f32'), B = f32('pos_helix4.f32'), C = f32('pos_helix8.f32'); const dist = (X, Y, i) => Math.hypot(X[3 * i] - Y[3 * i], X[3 * i + 1] - Y[3 * i + 1], X[3 * i + 2] - Y[3 * i + 2]);
  let dTA = 0, dAB = 0, dBC = 0; for (let i = 0; i < n; i += 97) { dTA += dist(T, A, i); dAB += dist(A, B, i); dBC += dist(B, C, i); } assert(dTA > 1 && dAB > 1 && dBC > 1, 'layouts must really differ');
  const seen = new Set(); let dup = 0; for (let i = 0; i < n; i += 7) { const k = [A[3 * i], A[3 * i + 1], A[3 * i + 2]].map((v) => Math.round(v * 1000)).join(','); if (seen.has(k)) dup++; seen.add(k); } assert(dup < 5, 'duplicate positions: ' + dup);
  // the tube cross-section must be filled in 2D: correlation of radial offset and vertical offset ~ 0 (a curve would give |r| close to 1)
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, m = 0; for (let i = 0; i < n; i += 11) { const ra = Math.hypot(A[3 * i], A[3 * i + 2]) - meta.helix.radius, dy = A[3 * i + 1] - depth[i] * meta.yStep; sa += ra; sb += dy; saa += ra * ra; sbb += dy * dy; sab += ra * dy; m++; }
  const corr = (sab / m - (sa / m) * (sb / m)) / Math.sqrt((saa / m - (sa / m) ** 2) * (sbb / m - (sb / m) ** 2)); assert(Math.abs(corr) < 0.05, 'cross-section is a curve, not a filled tube: corr ' + corr.toFixed(3));
});
t('buildTubes: counts, start on the core surface, exact far end, unit normals perpendicular to the arc, no twist, outward winding, flow by kind, bow, degenerate edges', () => {
  const E = [ { a: [5, 1, 0], b: [0, 6, 5], kind: 0, phase: 0.25 }, { a: [5, 1, 0], b: [-5, 3, 1], kind: 1, phase: 0.75 }, { a: [5, 1, 0], b: [5.1, 1, 0], kind: 1, phase: 0 }, { a: [5, 1, 0], b: [5, 1, 0], kind: 0, phase: 0 } ];
  const S = 16, K = 6, ST = 0.22, R = L.buildTubes(E, S, K, ST), per = (S + 1) * K;
  assert.strictEqual(R.vertexCount, E.length * per); assert.strictEqual(R.indexCount, E.length * S * K * 6);
  for (const k of ['pos', 'nrm', 't', 'dir', 'phase', 'kind']) assert([...R[k]].every(Number.isFinite), k + ' has NaN/Inf (degenerate edge?)');
  assert(R.index.every((v) => v < R.vertexCount), 'index out of range');
  const P = (v) => [R.pos[3 * v], R.pos[3 * v + 1], R.pos[3 * v + 2]], N = (v) => [R.nrm[3 * v], R.nrm[3 * v + 1], R.nrm[3 * v + 2]];
  const sub = (p, q) => p.map((x, i) => x - q[i]), dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2], len = (p) => Math.hypot(...p);
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  E.forEach((e, k) => {
    const v0 = k * per, vN = v0 + per - K, el = len(sub(e.b, e.a));
    for (let r = 0; r < K; r++) assert.deepStrictEqual(P(v0 + r), P(v0), 'a ring shares one centre');
    const s0 = len(sub(P(v0), e.a)); assert(Math.abs(s0 - Math.min(ST, 0.45 * el)) < 1e-5, 'edge ' + k + ' starts ' + s0 + ' from the module (core surface, clamped for short edges)');
    assert(len(sub(P(vN), e.b)) < 1e-5, 'edge ' + k + ' ends exactly at the neighbour');
    assert.strictEqual(R.t[v0], 0); assert.strictEqual(R.t[vN], 1);
    for (let v = v0; v < v0 + per; v++) { assert(Math.abs(len(N(v)) - 1) < 1e-5, 'unit normal'); assert.strictEqual(R.dir[v], e.kind === 0 ? -1 : 1); assert.strictEqual(R.phase[v], e.phase); }
    if (el < 1e-6) return;
    for (let s = 0; s < S; s++) {
      const c0 = P(v0 + s * K), c1 = P(v0 + (s + 1) * K), T = sub(c1, c0), tl = len(T); if (tl < 1e-9) continue;
      for (let r = 0; r < K; r++) {
        assert(Math.abs(dot(N(v0 + s * K + r), T) / tl) < 0.2, 'normals are (nearly) perpendicular to the arc');
        assert(dot(N(v0 + s * K + r), N(v0 + (s + 1) * K + r)) > 0.9, 'no twist between neighbouring rings (edge ' + k + ', sample ' + s + ')');
      }
      let sn = [0, 0, 0]; for (let r = 0; r < K; r++) sn = sn.map((x, i) => x + N(v0 + s * K + r)[i]); assert(len(sn) < 1e-5, 'a ring goes all the way round');
    }
  });
  // triangles face OUTWARDS (the material renders front faces only): inflate the tube and compare each face normal with the vertex normals
  const W = 0.05, X = (v) => P(v).map((x, i) => x + W * N(v)[i]);
  for (let o = 0; o < 2 * S * K * 6; o += 3) { const [i0, i1, i2] = [R.index[o], R.index[o + 1], R.index[o + 2]], fn = cross(sub(X(i1), X(i0)), sub(X(i2), X(i0)));
    const avg = [0, 1, 2].map((d) => N(i0)[d] + N(i1)[d] + N(i2)[d]); assert(dot(fn, avg) > 0, 'triangle ' + o / 3 + ' faces inwards'); }
  // the arc bulges away from the axis: its middle is farther out than the straight chord's middle
  for (const k of [0, 1]) { const m = k * per + (S / 2) * K, mid = Math.hypot(R.pos[3 * m], R.pos[3 * m + 2]), ch = Math.hypot((E[k].a[0] + E[k].b[0]) / 2, (E[k].a[2] + E[k].b[2]) / 2); assert(mid > ch + 0.05, 'edge ' + k + ' must bow outwards: ' + mid + ' vs ' + ch); }
  // on the axis itself there is no "away", and a vertical edge has tangent = the default up vector: still finite
  const Z = L.buildTubes([{ a: [0, 0, 0], b: [0, 5, 0], kind: 0, phase: 0 }], 8, 6, 0.2); assert([...Z.pos, ...Z.nrm].every(Number.isFinite));
  assert.strictEqual(L.buildTubes(E, S, K).pos[0], 5, 'no start offset by default');
});
t('buildFibers: counts, start on the core surface, exact far end, leaves the core radially and fanned out, smooth cubic arc, flow by kind, degenerate edges', () => {
  const E = [ { a: [5, 1, 0], b: [0, 6, 5], kind: 0, phase: 0.25 }, { a: [5, 1, 0], b: [-5, 3, 1], kind: 1, phase: 0.75 }, { a: [5, 1, 0], b: [5.1, 1, 0], kind: 0, phase: 0.5 }, { a: [5, 1, 0], b: [5, 1, 0], kind: 1, phase: 0 } ];
  const S = 32, ST = 0.22, R = L.buildFibers(E, S, ST), per = (S + 1) * 2;
  assert.strictEqual(R.vertexCount, E.length * per); assert.strictEqual(R.indexCount, E.length * S * 6); assert.strictEqual(R.dock.length, E.length);
  for (const k of ['pos', 'tan', 'side', 't', 'dir', 'phase', 'kind']) assert([...R[k]].every(Number.isFinite), k + ' has NaN/Inf');
  assert(R.index.every((v) => v < R.vertexCount)); assert(R.dock.flat().every(Number.isFinite));
  const P = (v) => [R.pos[3 * v], R.pos[3 * v + 1], R.pos[3 * v + 2]], sub = (p, q) => p.map((x, i) => x - q[i]), len = (p) => Math.hypot(...p), dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  E.forEach((e, k) => {
    const v0 = k * per, vN = v0 + per - 2, el = len(sub(e.b, e.a));
    assert(Math.abs(len(sub(P(v0), e.a)) - Math.min(ST, 0.45 * el)) < 1e-5, 'fibre ' + k + ' starts on the core surface');
    assert(len(sub(P(vN), e.b)) < 1e-5, 'fibre ' + k + ' ends exactly at the neighbour');
    assert(Math.abs(len(R.dock[k]) - 1) < 1e-6, 'dock direction is a unit vector');
    if (el > 1e-6) { const st = sub(P(v0), e.a); assert(dot(st, R.dock[k]) / len(st) > 0.999, 'it leaves the core along its dock direction'); assert(dot(R.dock[k], sub(e.b, e.a)) / el > 0.5, 'roughly towards the neighbour'); }
    for (let s = 0; s <= S; s++) { const v = v0 + 2 * s; assert.deepStrictEqual(P(v), P(v + 1)); assert.strictEqual(R.side[v] + R.side[v + 1], 0); assert(Math.abs(len([R.tan[3 * v], R.tan[3 * v + 1], R.tan[3 * v + 2]]) - 1) < 1e-6); assert.strictEqual(R.dir[v], e.kind === 0 ? -1 : 1); }
    if (el > 1) for (let s = 0; s < S; s++) { const a = 3 * (v0 + 2 * s), b = 3 * (v0 + 2 * s + 2); assert(R.tan[a] * R.tan[b] + R.tan[a + 1] * R.tan[b + 1] + R.tan[a + 2] * R.tan[b + 2] > 0.95, 'kink in fibre ' + k + ' at ' + s); }
  });
  // many edges to the SAME neighbour direction: the phase fans them out (no single bundle leaving the core)
  const fan = L.buildFibers(Array.from({ length: 8 }, (_, k) => ({ a: [5, 1, 0], b: [0, 6, 5], kind: 0, phase: k / 8 })), 8, ST).dock;
  let minDot = 1; for (let x = 0; x < 8; x++) for (let y = x + 1; y < 8; y++) minDot = Math.min(minDot, dot(fan[x], fan[y])); assert(minDot < 0.9, 'fan-out: ' + minDot);
  const Z = L.buildFibers([{ a: [0, 0, 0], b: [0, 5, 0], kind: 0, phase: 0.3 }], 8, 0.2); assert([...Z.pos, ...Z.tan].every(Number.isFinite));
});
t('critical line: 30 real zeta zeros, denser upwards; the blink runs bottom -> top, accelerating, one blink per zero per cycle, then dark', () => {
  const Z = L.ZETA_ZEROS; assert.strictEqual(Z.length, 30); assert(Math.abs(Z[0] - 14.134725) < 1e-6 && Math.abs(Z[1] - 21.02204) < 1e-5 && Math.abs(Z[29] - 101.317851) < 1e-6);
  for (let k = 1; k < Z.length; k++) assert(Z[k] > Z[k - 1]);
  const H = L.zeroHeights(Z); assert.strictEqual(H[0], 0); assert.strictEqual(H[29], 1);
  const sweep = 4, cycle = 6, decay = 0.3, f = (h, t) => L.zeroFlash(h, t, sweep, cycle, decay);
  // the moment each zero lights up, found by scanning time
  const on = H.map((h) => { for (let t = 0; t < cycle; t += 0.001) if (f(h, t) > 0.99) return t; return -1; });
  assert(on.every((t) => t >= 0 && t <= sweep + 0.01), 'every zero blinks within the sweep');
  for (let k = 1; k < 30; k++) assert(on[k] > on[k - 1], 'bottom to top');
  const iv = on.slice(1).map((t, k) => t - on[k]); assert(iv[0] > 4 * iv[iv.length - 1], 'faster and faster: first gap ' + iv[0].toFixed(3) + ' s, last ' + iv[iv.length - 1].toFixed(3) + ' s');
  // a blink dies out: shortly after, the zero is dark again until the next cycle; and the whole line repeats every cycle
  for (const h of [0, 0.5, 1]) { const t0 = sweep * Math.sqrt(h); assert(f(h, t0 + 1.5) < 0.01, 'blink decays'); assert(f(h, t0 - 0.01) < 1e-3, 'dark before'); assert(Math.abs(f(h, t0 + 0.1) - f(h, t0 + 0.1 + cycle)) < 1e-9, 'periodic'); }
});
t('nucleusProgress: elapsed / expected while compiling (capped), full when built, a seed otherwise', () => {
  const P = L.nucleusProgress;
  assert.strictEqual(P({ secs: 5, est: 10 }, 4, 0), 0.5); assert.strictEqual(P({ secs: 5, est: 10 }, 4, 2.5), 0.75, 'advances between status polls');
  assert.strictEqual(P({ secs: 50, est: 10 }, 4, 0), 1, 'capped at 1 past the estimate'); assert.strictEqual(P({ secs: 0, est: 10 }, 4, -3), 0, 'never negative');
  assert.strictEqual(P({ secs: 30 }, 4, 0), 0.5, 'no estimate: assume 60 s'); assert.strictEqual(P({ secs: 3, est: 0 }, 4, 0), 0.05);
  assert.strictEqual(P(null, 2, 0), 1); assert.strictEqual(P(null, 3, 0), 1, 'built (by others / by us): full');
  assert.strictEqual(P(null, 0, 0), 0); assert.strictEqual(P(null, 1, 0), 0, 'open / assigned: just a seed');
});
t('packetStats + colour helpers', () => {
  const st = new Uint8Array(n).map((_, i) => i % 4); const pk = new Uint16Array(fs.readFileSync(path.join(D, 'packet.u16')).buffer.slice(0));
  const ps = L.packetStats(n, pk, st, meta.packets);
  let tot = 0; for (let k = 0; k < meta.packets; k++) { tot += ps.tot[k]; assert.strictEqual(ps.tot[k], ps.open[k] + ps.assigned[k] + ps.done[k] + ps.ours[k]); }
  assert.strictEqual(tot, n);
  assert.deepStrictEqual(L.hsv(0, 1, 1), [255, 0, 0]); assert.strictEqual(L.fmt(1234567), '1,234,567'); assert.strictEqual(L.pct(1, 4), '25.0%');
});
t('pickSolids: live first, then connected nearest to the selection, capped; selection and plain dots excluded', () => {
  const pos = new Float32Array([0, 0, 0, 5, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 9, 0, 0]);
  const hi = new Float32Array([3, 1, 2, 1, 0, 1]);                  // 0 = selected, 4 = plain dot
  const all = L.pickSolids(hi, pos, 0, [4], 10);
  assert.deepStrictEqual(all.map((e) => [e.i, e.kind]), [[4, 4], [2, 2], [3, 1], [1, 1], [5, 1]]);
  assert.deepStrictEqual(L.pickSolids(hi, pos, 0, [4], 3).map((e) => e.i), [4, 2, 3], 'the cap keeps the live one and the nearest');
  assert.deepStrictEqual(L.pickSolids(hi, pos, 0, [3], 10).filter((e) => e.i === 3).map((e) => e.kind), [4], 'a live connected module appears once, as live');
  assert.deepStrictEqual(L.pickSolids(hi, pos, -1, [], 10), [], 'no selection: no connected bubbles');
  assert(!L.pickSolids(hi, pos, 0, [0, 4], 10).some((e) => e.i === 0), 'a compiling selected module stays the core, no bubble inside it');
  assert.strictEqual(L.pickSolids(hi, pos, 0, [1, 2, 3], 2).length, 2, 'the cap also holds for live ones');
});
t('buildSpine: one trunk curve through every trunk node plus one ribbon per branch, finite, tapering, aG runs down the tree', () => {
  const nodes = [{ p: [0, 10, 0], up: -1, lv: 0 }, { p: [0.5, 5, 0], up: 0, lv: 0 }, { p: [0, 0, 0.5], up: 1, lv: 0 },
    { p: [3, 5, 0], up: 1, lv: 1 }, { p: [4, 4, 1], up: 3, lv: 2 }];
  const b = L.buildSpine(nodes, { sub: 4, segs: 6 });
  assert.strictEqual(b.trunkSteps, 3); assert.strictEqual(b.curves, 3);
  const trunkV = (2 * 4 + 1) * 2, branchV = 7 * 2; assert.strictEqual(b.vertexCount, trunkV + 2 * branchV); assert.strictEqual(b.indexCount, (8 + 6 + 6) * 6);
  assert(b.pos.every(Number.isFinite) && b.tan.every(Number.isFinite)); assert(Math.max(...b.index) < b.vertexCount);
  const at = (v) => [b.pos[3 * v], b.pos[3 * v + 1], b.pos[3 * v + 2]];
  assert.deepStrictEqual(at(0), [0, 10, 0]); assert.deepStrictEqual(at(2 * 4), [0.5, 5, 0]); assert.deepStrictEqual(at(trunkV - 1), [0, 0, 0.5]);   // the nodes themselves are exact
  assert.deepStrictEqual(at(trunkV), [0.5, 5, 0]); assert.deepStrictEqual(at(trunkV + branchV - 1), [3, 5, 0]);                                     // a branch: parent -> node
  assert(b.w[trunkV] > b.w[trunkV + branchV - 1] && b.w[0] > b.w[trunkV], 'branches are thinner than the trunk and taper');
  assert.strictEqual(b.g[0], 0); assert.strictEqual(b.g[trunkV - 1], 1); assert(Math.abs(b.g[trunkV] - 0.5) < 1e-6, 'a branch flashes when the flash passes its trunk step');
  assert.deepStrictEqual([...new Set(b.lv)].sort(), [0, 1, 2]);
});
if (fs.existsSync(path.join(D, 'spine.json'))) t('spine data: trunk from riemannHypothesis in Main, every node in range, positions finite, Main on top', () => {
  const js = JSON.parse(fs.readFileSync(path.join(D, 'spine.json'))), reached = fs.readFileSync(path.join(D, 'spine.bin')), sp = f32('pos_spine.f32');
  assert.strictEqual(js.nodes[0].n, 'riemannHypothesis'); assert.strictEqual(names[js.nodes[0].m], 'Main'); assert.strictEqual(js.nodes[0].up, -1);
  assert.strictEqual(reached.length, n); assert.strictEqual(sp.length, 3 * n); assert(sp.every(Number.isFinite));
  js.nodes.forEach((nd, k) => { assert(nd.m >= 0 && nd.m < n && reached[nd.m] === 1); assert(nd.up < k, 'parents come first'); assert(nd.lv === 0 || nd.lv === js.nodes[nd.up].lv + 1 || js.nodes[nd.up].lv === 0); });
  const main = names.indexOf('Main'); assert.deepStrictEqual([...sp.slice(3 * main, 3 * main + 3)].map((x) => +x.toFixed(2)), js.nodes[0].p.map((x) => +x.toFixed(2)));
  const b = L.buildSpine(js.nodes); assert(b.pos.every(Number.isFinite)); assert.strictEqual(b.trunkSteps, js.steps);
});
console.log(ok + ' tests passed');
