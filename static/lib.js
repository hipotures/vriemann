/* Pure helpers for the viewer (no DOM, no THREE) so they can be unit-tested in node. */
(function (root) {
  'use strict';

  /** CSR adjacency from edges.u32 = [importer, imported] pairs (row indices). */
  function buildCSR(n, edges) {
    const m = edges.length >> 1;
    const impStart = new Uint32Array(n + 1), conStart = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) { impStart[edges[2 * e] + 1]++; conStart[edges[2 * e + 1] + 1]++; }
    for (let i = 0; i < n; i++) { impStart[i + 1] += impStart[i]; conStart[i + 1] += conStart[i]; }
    const impList = new Uint32Array(m), conList = new Uint32Array(m);
    const ip = impStart.slice(0, n), cp = conStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      impList[ip[a]++] = b;      // a imports b
      conList[cp[b]++] = a;      // b is consumed by a
    }
    return { n, impStart, impList, conStart, conList };
  }

  /** All transitive imports (ancestors) of i, excluding i. Returns {mark:Uint8Array, count}. */
  function closureImports(csr, i) {
    const mark = new Uint8Array(csr.n);
    const stack = [i];
    mark[i] = 2;
    let count = 0;
    while (stack.length) {
      const x = stack.pop();
      for (let k = csr.impStart[x]; k < csr.impStart[x + 1]; k++) {
        const y = csr.impList[k];
        if (!mark[y]) { mark[y] = 1; count++; stack.push(y); }
      }
    }
    return { mark, count };
  }

  const KW = new Set(('theorem lemma def instance structure inductive class namespace section end open import variable universe ' +
    'noncomputable private protected abbrev example by fun have show from let in match with if then else where at calc obtain ' +
    'rcases intro intros exact simp rw apply refine constructor cases induction omega ring linarith norm_num nlinarith ' +
    'unfold rfl use exists rintro simpa conv set_option attribute macro syntax notation local scoped deriving extends ' +
    'mutual partial unsafe opaque').split(' '));
  const RED = new Set(['sorry', 'admit', 'axiom']);

  /** Cheap Lean tokenizer: array (per line) of [text, type]; types c comment, s string, k keyword, r sorry/axiom, n number, x plain. */
  function tokenize(text) {
    const out = [];
    let inBlock = 0;
    for (const line of text.split('\n')) {
      const toks = [];
      let plain = '';
      const flush = () => {
        if (!plain) return;
        const re = /[A-Za-z_][A-Za-z0-9_'.!?]*|\d[\d_.]*|[^A-Za-z_\d]+/g;
        let m;
        while ((m = re.exec(plain)) !== null) {
          const w = m[0];
          const head = /^[A-Za-z_]/.test(w) ? w.split('.')[0] : '';
          let ty = 'x';
          if (KW.has(w)) ty = 'k';
          else if (RED.has(w) || RED.has(head)) ty = 'r';
          else if (/^\d/.test(w)) ty = 'n';
          toks.push([w, ty]);
        }
        plain = '';
      };
      let i = 0;
      while (i < line.length) {
        if (inBlock > 0) {
          const e = line.indexOf('-/', i), s = line.indexOf('/-', i);
          if (e < 0 && s < 0) { toks.push([line.slice(i), 'c']); i = line.length; break; }
          if (s >= 0 && (e < 0 || s < e)) { inBlock++; toks.push([line.slice(i, s + 2), 'c']); i = s + 2; }
          else { inBlock--; toks.push([line.slice(i, e + 2), 'c']); i = e + 2; }
          continue;
        }
        const ch = line[i], nx = line[i + 1];
        if (ch === '-' && nx === '-') { flush(); toks.push([line.slice(i), 'c']); i = line.length; break; }
        if (ch === '/' && nx === '-') { flush(); inBlock = 1; toks.push(['/-', 'c']); i += 2; continue; }
        if (ch === '"') {
          flush();
          let j = i + 1;
          while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
          toks.push([line.slice(i, j + 1), 's']); i = j + 1; continue;
        }
        plain += ch; i++;
      }
      flush();
      out.push(toks);
    }
    return out;
  }


  /** Soft-wrap token lines to `cols` code points; continuation rows get an indent and n=0 (no line number). */
  function wrapTokens(tokLines, cols, indent) {
    indent = indent == null ? 4 : indent;
    const rows = [];
    tokLines.forEach((toks, li) => {
      const chars = [], types = [];
      for (const [t, ty] of toks) for (const ch of t) { chars.push(ch); types.push(ty); }
      if (chars.length <= cols) { rows.push({ n: li + 1, li, toks }); return; }
      let start = 0, first = true;
      while (start < chars.length) {
        const width = first ? cols : cols - indent, half = Math.floor(width * 0.5);
        let end = Math.min(start + width, chars.length);
        if (end < chars.length) { let b = end; while (b > start + half && chars[b - 1] !== ' ') b--; if (b > start + half) end = b; }
        const row = []; let cur = null;
        if (!first) row.push([' '.repeat(indent), 'x']);
        for (let k = start; k < end; k++) { if (cur && cur[1] === types[k]) cur[0] += chars[k]; else { cur = [chars[k], types[k]]; row.push(cur); } }
        rows.push({ n: first ? li + 1 : 0, li, toks: row });
        start = end; first = false;
      }
    });
    return rows;
  }


  /**
   * Critically damped spring with a speed limit (a.k.a. SmoothDamp): eases IN and OUT, velocity is continuous,
   * no overshoot.  st = {v} carries the velocity between frames.  Returns the new position.
   */
  function smoothDamp(cur, target, st, smoothTime, maxSpeed, dt) {
    smoothTime = Math.max(0.0001, smoothTime);
    const omega = 2 / smoothTime, x = omega * dt;
    const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const maxChange = maxSpeed * smoothTime;
    const change = Math.max(-maxChange, Math.min(maxChange, cur - target));
    const tgt = cur - change;
    const temp = (st.v + omega * change) * dt;
    st.v = (st.v - omega * temp) * k;
    let out = tgt + (change + temp) * k;
    if ((target - cur > 0) === (out > target)) { out = target; st.v = dt > 0 ? (out - target) / dt : 0; }
    return out;
  }


  const DECL = new Set(['theorem', 'lemma', 'def', 'instance', 'structure', 'inductive', 'class', 'abbrev']);
  const MODS = new Set(['private', 'protected', 'noncomputable', 'unsafe', 'partial', 'nonrec', 'local', 'scoped']);
  /** Top-level declarations: [{kind, name, line, lines}] (lines = span up to the next declaration). */
  function declarations(tokLines) {
    const out = [];
    tokLines.forEach((toks, li) => {
      const first = toks.find((x) => x[0].trim());
      const attr = !!first && first[0].startsWith('@[');
      for (let k = 0; k < toks.length; k++) {
        const [t, ty] = toks[k];
        const isDecl = (ty === 'k' && DECL.has(t)) || (ty === 'r' && t === 'axiom');
        if (!isDecl) continue;
        let ok = attr;
        if (!ok) { ok = true; for (let q = 0; q < k; q++) { const w = toks[q][0].trim(); if (w && !MODS.has(w) && toks[q][1] !== 'c') { ok = false; break; } } }
        if (!ok) break;
        let name = '';
        for (let q = k + 1; q < toks.length; q++) { const w = toks[q][0]; if (/^\s*$/.test(w)) continue; if (/^[A-Za-z_]/.test(w)) name = w; break; }
        out.push({ kind: t, name, line: li, lines: 1 });
        break;
      }
    });
    for (let k = 0; k < out.length; k++) out[k].lines = Math.max(1, (k + 1 < out.length ? out[k + 1].line : tokLines.length) - out[k].line);
    return out;
  }

  /**
   * How strongly to draw the highlighted ancestry: the more modules are lit, the dimmer and smaller each one, so the total
   * brightness stays about constant (Main has 175,186 ancestors = the whole graph; at full strength plus additive glow it is a solid wall).
   */
  function hiScale(count, target) {
    target = target || 2500; const r = Math.max(1, count) / target;
    if (r <= 1) return { a: 1, s: 1 };
    return { a: Math.max(0.1, Math.pow(1 / r, 0.5)), s: Math.max(0.45, Math.pow(1 / r, 0.25)) };
  }

  /**
   * Geometry for connection tubes.  edges = [{a:[x,y,z], b:[x,y,z], kind:0|1, phase:0..1}] (a = the selected module, b = its neighbour;
   * kind 0 = import, kind 1 = consumer).  Each edge is a quadratic Bezier bowed away from the tower axis (so it hugs the wall instead of
   * cutting through the middle).  Each of segs+1 rings has `sides` vertices; every vertex stores the ring centre (pos) and the outward
   * unit normal (nrm, parallel-transported so the tube does not twist) and the vertex shader picks the radius (min pixel width, taper,
   * pulse bulge).  start: the tube begins this far from a (on the selected module's core surface), at most 45% of the edge length.
   * dir = the way information flows along t (0 = a, 1 = b): imports flow TO the selected module (-1), consumers AWAY from it (+1).
   */
  function buildTubes(edges, segs, sides, start) {
    const nPts = segs + 1, vPer = nPts * sides, V = edges.length * vPer, I = edges.length * segs * sides * 6;
    const pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3), t = new Float32Array(V),
      dir = new Float32Array(V), phase = new Float32Array(V), kind = new Float32Array(V), index = new Uint32Array(I);
    start = start || 0;
    edges.forEach((e, k) => {
      let [ax, ay, az] = e.a; const [bx, by, bz] = e.b;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      let ox = mx, oz = mz; const ol = Math.hypot(ox, oz); if (ol > 1e-6) { ox /= ol; oz /= ol; } else { ox = 1; oz = 0; }
      const len = Math.hypot(bx - ax, by - ay, bz - az), bow = Math.min(1.5, 0.22 * len);
      const cx = mx + ox * bow, cy = my, cz = mz + oz * bow, base = k * vPer;
      const s0 = Math.min(start, 0.45 * len);                                        // move the start onto the core surface, towards the control point
      if (s0 > 0) { let dx = cx - ax, dy = cy - ay, dz = cz - az; const dl = Math.hypot(dx, dy, dz) || 1; ax += dx / dl * s0; ay += dy / dl * s0; az += dz / dl * s0; }
      let px0 = 0, py0 = 1, pz0 = 0;                                                  // parallel-transported frame (no twisting)
      for (let s = 0; s <= segs; s++) {
        const q = s / segs, u = 1 - q;
        const px = u * u * ax + 2 * u * q * cx + q * q * bx, py = u * u * ay + 2 * u * q * cy + q * q * by, pz = u * u * az + 2 * u * q * cz + q * q * bz;
        let tx = 2 * u * (cx - ax) + 2 * q * (bx - cx), ty = 2 * u * (cy - ay) + 2 * q * (by - cy), tz = 2 * u * (cz - az) + 2 * q * (bz - cz);
        const tl = Math.hypot(tx, ty, tz); if (tl > 1e-9) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 0; ty = 1; tz = 0; }
        if (s === 0) { [px0, py0, pz0] = Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0]; }
        let d = px0 * tx + py0 * ty + pz0 * tz, nx = px0 - d * tx, ny = py0 - d * ty, nz = pz0 - d * tz;   // project the previous normal
        let nl = Math.hypot(nx, ny, nz); if (nl < 1e-6) { [nx, ny, nz] = Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0]; d = nx * tx + ny * ty + nz * tz; nx -= d * tx; ny -= d * ty; nz -= d * tz; nl = Math.hypot(nx, ny, nz); }
        nx /= nl; ny /= nl; nz /= nl; px0 = nx; py0 = ny; pz0 = nz;
        const bx2 = ty * nz - tz * ny, by2 = tz * nx - tx * nz, bz2 = tx * ny - ty * nx;          // binormal = T x N
        for (let r = 0; r < sides; r++) {
          const ang = 2 * Math.PI * r / sides, ca = Math.cos(ang), sa = Math.sin(ang), v = base + s * sides + r;
          pos[3 * v] = px; pos[3 * v + 1] = py; pos[3 * v + 2] = pz;
          nrm[3 * v] = ca * nx + sa * bx2; nrm[3 * v + 1] = ca * ny + sa * by2; nrm[3 * v + 2] = ca * nz + sa * bz2;
          t[v] = q; dir[v] = e.kind === 0 ? -1 : 1; phase[v] = e.phase; kind[v] = e.kind;
        }
      }
      for (let s = 0; s < segs; s++) for (let r = 0; r < sides; r++) {
        const r1 = (r + 1) % sides, a0 = base + s * sides + r, a1 = base + s * sides + r1, b0 = a0 + sides, b1 = a1 + sides, o = ((k * segs + s) * sides + r) * 6;
        index[o] = a0; index[o + 1] = a1; index[o + 2] = b0; index[o + 3] = a1; index[o + 4] = b1; index[o + 5] = b0;   // CCW seen from outside
      }
    });
    return { pos, nrm, t, dir, phase, kind, index, vertexCount: V, indexCount: I };
  }

  /**
   * Geometry for glowing connection fibres (the default link style).  Same edges as buildTubes.  Each edge is a CUBIC Bezier that leaves the
   * selected module's core radially (P0 on the core surface, direction = towards the neighbour, pushed outwards from the tower axis and fanned
   * around by the edge's phase, so a module with many connections sprouts them like a dandelion instead of one bundle) and then curves into
   * the neighbour.  Every sample gets two vertices (side -1 / +1) that the vertex shader spreads across the view (camera-facing ribbon with a
   * Gaussian profile = no hard, aliased edge).  Also returns dock[] = the unit direction each edge leaves the core in (for the ripples
   * on the core's membrane where imports arrive).
   */
  function buildFibers(edges, segs, start) {
    const nPts = segs + 1, vPer = nPts * 2, V = edges.length * vPer, I = edges.length * segs * 6;
    const pos = new Float32Array(V * 3), tan = new Float32Array(V * 3), side = new Float32Array(V), t = new Float32Array(V),
      dir = new Float32Array(V), phase = new Float32Array(V), kind = new Float32Array(V), index = new Uint32Array(I), dock = [];
    start = start || 0;
    const norm = (x, y, z, fx, fy, fz) => { const l = Math.hypot(x, y, z); return l > 1e-9 ? [x / l, y / l, z / l] : [fx, fy, fz]; };
    edges.forEach((e, k) => {
      const [ax, ay, az] = e.a, [bx, by, bz] = e.b, len = Math.hypot(bx - ax, by - ay, bz - az);
      const [ux, uy, uz] = norm(bx - ax, by - ay, bz - az, 0, 1, 0);
      const [ox, , oz] = norm((ax + bx) / 2, 0, (az + bz) / 2, 1, 0, 0);
      let [e1x, e1y, e1z] = norm(uy * 0 - uz * 1, uz * 0 - ux * 0, ux * 1 - uy * 0, 1, 0, 0);       // u x up
      if (Math.abs(uy) > 0.98) [e1x, e1y, e1z] = [1, 0, 0];
      const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
      const ang = 2 * Math.PI * e.phase, j1 = 0.35 * Math.cos(ang), j2 = 0.35 * Math.sin(ang);
      const [dx, dy, dz] = norm(ux + 0.45 * ox + j1 * e1x + j2 * e2x, uy + j1 * e1y + j2 * e2y, uz + 0.45 * oz + j1 * e1z + j2 * e2z, ux, uy, uz);
      dock.push([dx, dy, dz]);
      const s0 = Math.min(start, 0.45 * len), bow = Math.min(1.2, 0.2 * len);
      const p0 = [ax + dx * s0, ay + dy * s0, az + dz * s0], p1 = [p0[0] + dx * 0.4 * len, p0[1] + dy * 0.4 * len, p0[2] + dz * 0.4 * len];
      const p2 = [bx - ux * 0.3 * len + ox * bow, by - uy * 0.3 * len, bz - uz * 0.3 * len + oz * bow], p3 = [bx, by, bz], base = k * vPer;
      for (let s = 0; s <= segs; s++) {
        const q = s / segs, r = 1 - q, w0 = r * r * r, w1 = 3 * r * r * q, w2 = 3 * r * q * q, w3 = q * q * q;
        const d0 = -3 * r * r, d1 = 3 * r * r - 6 * r * q, d2 = 6 * r * q - 3 * q * q, d3 = 3 * q * q;
        const P = [0, 1, 2].map((c) => w0 * p0[c] + w1 * p1[c] + w2 * p2[c] + w3 * p3[c]);
        const T = norm(...[0, 1, 2].map((c) => d0 * p0[c] + d1 * p1[c] + d2 * p2[c] + d3 * p3[c]), ux, uy, uz);
        for (let sd = 0; sd < 2; sd++) {
          const v = base + s * 2 + sd;
          pos[3 * v] = P[0]; pos[3 * v + 1] = P[1]; pos[3 * v + 2] = P[2]; tan[3 * v] = T[0]; tan[3 * v + 1] = T[1]; tan[3 * v + 2] = T[2];
          side[v] = sd ? 1 : -1; t[v] = q; dir[v] = e.kind === 0 ? -1 : 1; phase[v] = e.phase; kind[v] = e.kind;
        }
      }
      for (let s = 0; s < segs; s++) { const v0 = base + s * 2, o = (k * segs + s) * 6; index[o] = v0; index[o + 1] = v0 + 1; index[o + 2] = v0 + 2; index[o + 3] = v0 + 1; index[o + 4] = v0 + 3; index[o + 5] = v0 + 2; }
    });
    return { pos, tan, side, t, dir, phase, kind, index, dock, vertexCount: V, indexCount: I };
  }

  // ---- the critical line above Main: the first 30 non-trivial zeros of zeta (imaginary parts, all on Re s = 1/2)
  const ZETA_ZEROS = [14.134725, 21.022040, 25.010858, 30.424876, 32.935062, 37.586178, 40.918719, 43.327073, 48.005151, 49.773832,
    52.970321, 56.446248, 59.347044, 60.831779, 65.112544, 67.079811, 69.546402, 72.067158, 75.704691, 77.144840,
    79.337375, 82.910381, 84.735493, 87.425275, 88.809111, 92.491899, 94.651344, 95.870634, 98.831194, 101.317851];
  /** 0..1 height of every zero along the line: proportional to its imaginary part, so they get denser upwards, as the real ones do */
  const zeroHeights = (zs) => zs.map((g) => (g - zs[0]) / (zs[zs.length - 1] - zs[0]));
  /** Runway "rabbit": a flash runs up the line, accelerating (height ~ time^2), and every zero blinks when it passes.
   *  Returns the blink brightness 0..1 of a zero at height h (0..1) at time t (s); the same formula is in the GLSL. */
  function zeroFlash(h, t, sweep, cycle, decay) {
    const tau = ((t % cycle) + cycle) % cycle, dt = tau - sweep * Math.sqrt(h);
    return dt >= 0 ? Math.exp(-dt / decay) : 0;
  }

  /** Nucleus size 0..1 = estimated progress of the module: compiling -> elapsed / expected (the server's estimate from the module's
   *  length and our build history), capped at 1; built (state 2/3) -> 1; otherwise 0 (just a seed). */
  function nucleusProgress(tele, state, sinceStatus) {
    if (tele) { const est = tele.est > 0 ? tele.est : 60; return Math.max(0, Math.min(1, ((tele.secs || 0) + Math.max(0, sinceStatus || 0)) / est)); }
    return state === 2 || state === 3 ? 1 : 0;
  }

  /** angle wrapped to (-PI, PI] */
  const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };


  // ---- sound helpers (pure; used by audio.js) ----
  /** MIDI note from a module's position in the tower: deeper = lower, always inside the pentatonic scale of cfg. */
  function noteMidi(depth, maxDepth, ns, cfg) {
    const per = cfg.scale.length, total = per * cfg.octaves;
    let idx = Math.round(((maxDepth - depth) / Math.max(1, maxDepth)) * (total - 1));
    idx += ((ns | 0) % 3 + 3) % 3 - 1;                       // neighbouring namespaces differ by a scale step
    idx = Math.max(0, Math.min(total - 1, idx));
    return cfg.baseMidi + 12 * Math.floor(idx / per) + cfg.scale[idx % per];
  }
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  /** Token bucket: at most `burst` events at once, then `perSec` on average.  now() returns seconds. */
  function makeThinner(perSec, burst, now) {
    let tokens = burst, last = null;
    return { take() {
      const t = now(); if (last === null) last = t;
      tokens = Math.min(burst, tokens + Math.max(0, t - last) * perSec); last = t;
      if (tokens >= 1) { tokens -= 1; return true; } return false;
    } };
  }
  /** Background "breathing": brighter and louder with CPU load, deeper with memory use (cpu, mem in 0..1). */
  function bedParams(cpu, mem, cfg) {
    cpu = Math.max(0, Math.min(1, cpu || 0)); mem = Math.max(0, Math.min(1, mem || 0));
    return { cutoff: cfg.cutoffMin + (cfg.cutoffMax - cfg.cutoffMin) * Math.pow(cpu, 0.8), gain: cfg.gain * (0.4 + 0.6 * cpu), sub: 0.25 + 0.75 * mem };
  }
  const masterGain = (v, max) => Math.max(0, Math.min(1, v)) ** 2 * max;     // perceptual taper

  /** Count sorry/axiom words in a token table. */
  function countRed(tokLines) {
    let sorry = 0, axiom = 0;
    for (const l of tokLines) for (const [t, ty] of l) if (ty === 'r') { if (t === 'axiom') axiom++; else sorry++; }
    return { sorry, axiom };
  }

  /**
   * Point closest to a ray (lateral distance, mildly favouring nearer points).
   * pos: Float32Array xyz; o,d: {x,y,z} (d normalised); st: Uint8Array states or null;
   * hideOpen: skip state 0.  maxAng: tangent of the acceptance cone.
   */
  function pickPoint(pos, n, o, d, st, hideOpen, maxAng) {
    let best = -1, bestScore = Infinity;
    const lim = maxAng * maxAng;
    for (let i = 0; i < n; i++) {
      if (hideOpen && st && st[i] === 0) continue;
      const vx = pos[3 * i] - o.x, vy = pos[3 * i + 1] - o.y, vz = pos[3 * i + 2] - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0.05) continue;
      const px = vx - t * d.x, py = vy - t * d.y, pz = vz - t * d.z;
      const r2 = px * px + py * py + pz * pz;
      if (r2 > lim * t * t) continue;
      const score = r2 * (1 + 0.1 * t);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /** Per-packet counts from the state vector. */
  function packetStats(n, pk, st, nPk) {
    const tot = new Uint16Array(nPk), open = new Uint16Array(nPk), assigned = new Uint16Array(nPk),
      done = new Uint16Array(nPk), ours = new Uint16Array(nPk);
    for (let i = 0; i < n; i++) {
      const p = pk[i];
      tot[p]++;
      const s = st[i];
      if (s === 0) open[p]++; else if (s === 1) assigned[p]++; else if (s === 2) done[p]++; else ours[p]++;
    }
    return { tot, open, assigned, done, ours };
  }

  function hsv(h, s, v) {  // same formula as the vertex shader; returns 0..255
    const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
  }
  const nsColor = (i) => hsv((i * 0.61803) % 1, 0.65, 0.95);
  const fmt = (x) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0') + '%';

  const api = { buildCSR, closureImports, tokenize, wrapTokens, declarations, wrapPi, hiScale, buildTubes, buildFibers, ZETA_ZEROS, zeroHeights, zeroFlash, nucleusProgress, noteMidi, midiHz, makeThinner, bedParams, masterGain, smoothDamp, countRed, pickPoint, packetStats, hsv, nsColor, fmt, pct };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.RHLib = api;
})(typeof self !== 'undefined' ? self : this);
