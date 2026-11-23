#!/usr/bin/env python3
"""Precompute the "spine" layout: the proof as a lightning-shaped tree of declarations.

Reads the Lean sources of a prepared volume (--vol, read only) and data/ from build_graph.py, writes
data/pos_spine.f32 (a position for every module, like the other layouts) and data/spine.json (the tree the viewer draws).

  trunk    = a chain of declarations from `riemannHypothesis` (Main), each one named in the proof of the previous one (the longest
             one a bounded search finds, at most SPINE_LEN; with the current sources ~60 steps down to import depth 1)
  branches = a sample of the declarations each trunk step names, expanded breadth-first up to three more levels
  dust     = modules the tree never reaches, scattered faintly around it

The dependency graph is approximate: a declaration's body is the text up to the next declaration in the file, a reference is any
identifier whose last component is the short name of a declaration (local names such as hypotheses and binders excluded), resolved to
the same module first, then a directly imported one, then the closest one below that the module imports transitively.  Exact data would need Lean (ConstantInfo.getUsedConstants); for a picture this is enough.
"""
import argparse, gzip, json, math, re, sys, time
from array import array
from collections import defaultdict
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--vol", default=str(Path.home() / "rh-replay-vol"))
ap.add_argument("--data", default=str(Path(__file__).resolve().parent / "data"))
ap.add_argument("--root", default="riemannHypothesis", help="declaration at the top of the trunk")
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--budget", type=int, default=20000, help="trunk search: declarations to try (more = slower, maybe longer)")
a = ap.parse_args()
SRC, DATA = Path(a.vol) / "lean/src", Path(a.data)
if not SRC.is_dir():
    sys.exit(f"no Lean sources in {SRC} (prepare a volume with ./verify.sh <dir> --prepare-only from the replay repo, or pass --vol)")

SPINE_LEN = 120                        # trunk steps at most
BR = [16, 8, 4, 3]                     # branches sampled per node at level 0 (trunk), 1, 2, 3
LEN = [(2.0, 5.0), (0.8, 2.2), (0.35, 1.0), (0.15, 0.5)]   # branch length range per level (world units, the tower is ~20 high)
DUST_R, TOP_Y, BOT_Y = 13.0, 20.2, 0.6
PER_STEP = 45                          # nodes per trunk step at most (branches + twigs)

meta = json.loads((DATA / "meta.json").read_text())
n = meta["modules"]
names = [l.split("\t", 1)[1] for l in gzip.open(DATA / "names.txt.gz", "rt", encoding="utf-8").read().split("\n")]
mod_idx = {m: i for i, m in enumerate(names)}
depth = (DATA / "depth.u8").read_bytes()
edges = array("I"); edges.frombytes((DATA / "edges.u32").read_bytes())
imports = defaultdict(set)
for k in range(0, len(edges), 2):
    imports[edges[k]].add(edges[k + 1])

# ---------------------------------------------------------------- 1. index every declaration (short name -> where)
DECL = re.compile(r"^(?:@\[[^\]\n]*\]\s*)?(?:(?:private|protected|noncomputable|nonrec|partial|unsafe|scoped)\s+)*"
                  r"(?:theorem|lemma|def|abbrev|instance|structure|class|inductive|opaque|axiom)\b[ \t]*([^\s:({\[⦃]*)", re.M)
ID = re.compile(r"[^\W\d][\w'!?]*(?:\.[^\W\d][\w'!?]*)*")
# names bound inside a declaration (hypotheses, binders, have/obtain/intro...) shadow global ones: `hn`, `hy`, `this` are not lemmas
BOUND = re.compile(r"(?:\b(?:have|let|set|intro|intros|fun|obtain|rcases|rintro|cases|induction|generalizing|with|at|using)\b|[(\[{⦃⟨,|])\s*([^\W\d][\w'!?]*)")
KEYWORDS = set("""by exact apply refine intro intros simp simpa rw rwa have show from fun let in at with using calc conv
 obtain rcases rintro cases induction constructor use exists left right linarith nlinarith positivity ring field_simp norm_num
 omega decide trivial rfl this sorry if then else match do return assumption contradiction exfalso push_cast gcongr congr ext
 funext specialize unfold dsimp change filter_upwards aesop tauto bound fin_cases interval_cases split_ifs by_contra by_cases
 Type Prop Sort true false True False theorem lemma def where only""".split())
t0 = time.time()
where = defaultdict(list)              # short name -> [(module, decl ordinal)]
starts = {}                            # module -> [start offsets], only kept for files we read again later
decl_names = {}                        # module -> [full name as written]
for f in SRC.rglob("*.lean"):
    m = mod_idx.get(f.relative_to(SRC).with_suffix("").as_posix().replace("/", "."))
    if m is None:
        continue
    txt = f.read_text(encoding="utf-8", errors="replace")
    nm = []
    for k, mt in enumerate(DECL.finditer(txt)):
        full = mt.group(1); nm.append(full)
        if full:
            where[full.rsplit(".", 1)[-1]].append((m, k))
    decl_names[m] = nm
print(f"indexed {sum(len(v) for v in decl_names.values())} declarations in {len(decl_names)} files ({time.time() - t0:.0f} s)")

_bodies = {}
def bodies(m):
    """the text of every declaration in module m (cached)"""
    if m not in _bodies:
        txt = (SRC / (names[m].replace(".", "/") + ".lean")).read_text(encoding="utf-8", errors="replace")
        st = [mt.start() for mt in DECL.finditer(txt)] + [len(txt)]
        _bodies[m] = [txt[st[k]:st[k + 1]] for k in range(len(st) - 1)]
    return _bodies[m]

def resolve(short, m):
    c = where.get(short)
    if not c:
        return None
    same = [x for x in c if x[0] == m]
    if same:
        return same[0]
    imp = [x for x in c if x[0] in imports[m]]
    if imp:
        return imp[0]
    below = [x for x in c if depth[x[0]] < depth[m]]       # depth = longest import chain below, so anything m imports is lower
    if not below:
        return None
    if len(below) == 1:
        return below[0] if imported(m, below[0][0]) else None
    for x in sorted(below, key=lambda x: -depth[x[0]]):    # closest below first
        if imported(m, x[0]):
            return x
    return None

_imp_memo = {}
def imported(m, t, budget=40000):
    """does m import t (transitively)?  BFS over imports, pruned below t's depth; gives up (False) after `budget` modules"""
    key = (m, t)
    if key not in _imp_memo:
        dt, seen, todo, ok = depth[t], {m}, [m], False
        while todo and not ok and len(seen) < budget:
            u = todo.pop()
            for v in imports[u]:
                if v == t:
                    ok = True; break
                if v not in seen and depth[v] > dt:
                    seen.add(v); todo.append(v)
        _imp_memo[key] = ok
    return _imp_memo[key]

_deps = {}
def deps(d):
    """declarations named in the body of d, in order of first mention, without d itself"""
    if d not in _deps:
        m, k = d
        b = bodies(m)
        body = b[k] if k < len(b) else ""
        hdr = DECL.match(body)
        if hdr:
            body = body[hdr.end():]
        out, seen = [], {d}
        local = set(BOUND.findall(body)) | KEYWORDS
        for idt in ID.findall(body):
            short = idt.rsplit(".", 1)[-1]
            if short in local or idt in local or len(short) < 3:
                continue
            r = resolve(short, m)
            if r and r not in seen:
                seen.add(r); out.append(r)
        _deps[d] = out
    return _deps[d]

def label(d):
    return decl_names[d[0]][d[1]].rsplit(".", 1)[-1]

# ---------------------------------------------------------------- 2. the trunk: a long chain that descends slowly
main = mod_idx["Main"]
root = next((x for x in where.get(a.root, []) if x[0] == main), None) or (where.get(a.root) or [None])[0]
if root is None:
    sys.exit(f"declaration {a.root} not found")

FAN = 32                               # continuations considered per declaration (the first ones named)
def order(d):
    """continuations of d, best first: the smallest step down in import depth (long chains descend slowly instead of
    dropping to the foundations in three steps), then heavy steps (many names = many branches)"""
    return sorted(deps(d)[:FAN], key=lambda c: (-depth[c[0]], -len(deps(c))))

def find_chain(root, L, budget):
    """depth-first search for a chain of L declarations, each named in the body of the previous one.  A fully explored
    declaration remembers the longest chain below it (hx), so a dead end is never explored twice (a plain greedy walk
    or backtracking without that memo dead-ends in some structure field after ~30-50 steps)."""
    hx, path, onpath, its, below, best = {}, [root], {root}, [iter(order(root))], [0], [root]
    while path and len(path) < L and budget > 0:
        c = next(its[-1], None)
        if c is None:
            d = path.pop(); onpath.discard(d); its.pop(); hx[d] = 1 + below.pop()
            if below:
                below[-1] = max(below[-1], hx[d])
            continue
        if c in onpath:
            continue
        if c in hx:
            below[-1] = max(below[-1], hx[c])
            if hx[c] < L - len(path):
                continue
        budget -= 1
        path.append(c); onpath.add(c); its.append(iter(order(c))); below.append(0)
        if len(path) > len(best):
            best = path[:]
    return path if len(path) >= L else best

trunk = find_chain(root, SPINE_LEN, a.budget)
print(f"trunk: {len(trunk)} steps through {len({d[0] for d in trunk})} modules")

# ---------------------------------------------------------------- 3. geometry
import random
rnd = random.Random(a.seed)
nodes = []                             # {n, m, p, up, lv}
def add(d, p, up, lv):
    nodes.append({"n": label(d), "m": d[0], "p": [round(v, 3) for v in p], "up": up, "lv": lv}); return len(nodes) - 1

T = len(trunk)
ph = [rnd.uniform(0, 6.28) for _ in range(6)]
for i, d in enumerate(trunk):
    s = i / max(1, T - 1)
    y = TOP_Y + (BOT_Y - TOP_Y) * s
    x = 1.6 * math.sin(5.1 * s + ph[0]) + 0.6 * math.sin(13.0 * s + ph[1]) + rnd.gauss(0, 0.07)
    z = 1.6 * math.sin(4.3 * s + ph[2]) + 0.6 * math.sin(11.0 * s + ph[3]) + rnd.gauss(0, 0.07)
    add(d, (x, y, z), i - 1 if i else -1, 0)

def rand_dir(y_squash):
    while True:
        v = [rnd.gauss(0, 1) for _ in range(3)]
        l = math.sqrt(sum(c * c for c in v))
        if l > 1e-6:
            return v[0] / l, v[1] / l * y_squash, v[2] / l

placed = set(trunk)
def grow(i):
    """the branches of trunk step i, breadth first (every branch gets twigs before any gets more), at most PER_STEP nodes:
    the first steps of the proof name far more lemmas than the last ones, uncapped the top would be one big bush"""
    todo, count = [(trunk[i], i, 1, None)], 0
    while todo and count < PER_STEP:
        d, ni, lv, outward = todo.pop(0)
        if lv > len(BR):
            continue
        cands = [c for c in deps(d) if c not in placed]
        rnd.shuffle(cands)
        for c in cands[:BR[lv - 1]]:
            if count >= PER_STEP:
                break
            placed.add(c); count += 1
            dx, dy, dz = rand_dir(0.55)
            if outward is not None:    # deeper levels keep roughly the parent's direction, so the tree fans out instead of tangling
                dx, dy, dz = dx * 0.6 + outward[0], dy * 0.6 + outward[1], dz * 0.6 + outward[2]
                l = math.sqrt(dx * dx + dy * dy + dz * dz); dx, dy, dz = dx / l, dy / l, dz / l
            L = rnd.uniform(*LEN[lv - 1]); p0 = nodes[ni]["p"]
            p = (p0[0] + dx * L, min(TOP_Y + 1.0, p0[1] + dy * L), p0[2] + dz * L)
            todo.append((c, add(c, p, ni, lv), lv + 1, (dx, dy, dz)))

for i in range(len(trunk)):
    grow(i)
print(f"tree: {len(nodes)} nodes ({sum(1 for x in nodes if x['lv'] == 1)} branches, {sum(1 for x in nodes if x['lv'] > 1)} twigs)")

# ---------------------------------------------------------------- 4. module positions: a module sits on its first (highest) node, the rest is dust
pos = array("f", [0.0]) * (3 * n)
reached = bytearray(n)
for nd in nodes:
    m = nd["m"]
    if not reached[m]:
        reached[m] = 1
        pos[3 * m:3 * m + 3] = array("f", nd["p"])
def h01(i, k):
    x = (i * 0x9E3779B1 + k * 0x85EBCA6B + 0x165667B1) & 0xFFFFFFFF
    x ^= x >> 16; x = (x * 0x7FEB352D) & 0xFFFFFFFF; x ^= x >> 15; x = (x * 0x846CA68B) & 0xFFFFFFFF; x ^= x >> 16
    return x / 4294967296.0
for i in range(n):
    if reached[i]:
        continue
    r = DUST_R * math.sqrt(0.08 + 0.92 * h01(i, 1)); th = 2 * math.pi * h01(i, 2)
    pos[3 * i] = r * math.cos(th); pos[3 * i + 1] = depth[i] * meta["yStep"] + (h01(i, 3) - 0.5) * 0.4; pos[3 * i + 2] = r * math.sin(th)

(DATA / "pos_spine.f32").write_bytes(pos.tobytes())
(DATA / "spine.bin").write_bytes(bytes(reached))
(DATA / "spine.json").write_text(json.dumps({"root": a.root, "steps": T, "levels": len(BR), "nodes": nodes}, separators=(",", ":")))
print(f"reached {sum(reached)} of {n} modules; wrote pos_spine.f32, spine.bin, spine.json ({(DATA / 'spine.json').stat().st_size / 1e6:.2f} MB) in {time.time() - t0:.0f} s")
print("trunk:", " → ".join(f"{label(d)}[{depth[d[0]]}]" for d in trunk))
