#!/usr/bin/env python3
"""Precompute the "spine" layout: the proof as a lightning-shaped tree of declarations.

Reads the Lean sources of a prepared volume (--vol, read only) and data/ from build_graph.py, writes
per level data/pos_<level>.f32 (a position for every module, like the other layouts) and data/<level>.json (the tree the viewer draws).

  trunk    = a chain of declarations from `riemannHypothesis` (Main), each one named in the proof of the previous one (the longest
             one a bounded search finds, at most SPINE_LEN; with the current sources ~60 steps down to import depth 1)
  branches = a sample of the declarations each trunk step names, expanded breadth-first up to three more levels
  dust     = modules the tree never reaches, scattered faintly around it (the same place on every level)

Three levels share the trunk: spine (skeleton: a sample, 4 levels), spine2 (dense: up to 10 levels) and spine3 (full: every module,
hung under its closest importer above, height = import depth along the trunk).  Each writes pos_<name>.f32, <name>.json and <name>.bin.

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
CENTER_Z = -12.0                       # the tree stands this far in front of the viewer (who stands on the tower's axis), not around their head
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

# ---------------------------------------------------------------- 3. geometry: the trunk (shared by every level)
import random
rnd = random.Random(a.seed)
T = len(trunk)
ph = [rnd.uniform(0, 6.28) for _ in range(6)]
trunk_nodes = []                       # {n, m, p, up, lv}
for i, d in enumerate(trunk):
    s = i / max(1, T - 1)
    y = TOP_Y + (BOT_Y - TOP_Y) * s
    x = 1.6 * math.sin(5.1 * s + ph[0]) + 0.6 * math.sin(13.0 * s + ph[1]) + rnd.gauss(0, 0.07)
    z = CENTER_Z + 1.6 * math.sin(4.3 * s + ph[2]) + 0.6 * math.sin(11.0 * s + ph[3]) + rnd.gauss(0, 0.07)
    trunk_nodes.append({"n": label(d), "m": d[0], "p": [round(x, 3), round(y, 3), round(z, 3)], "up": i - 1 if i else -1, "lv": 0})

def rand_dir(r, y_squash):
    while True:
        v = [r.gauss(0, 1) for _ in range(3)]
        l = math.sqrt(sum(c * c for c in v))
        if l > 1e-6:
            return v[0] / l, v[1] / l * y_squash, v[2] / l

# levels 1 and 2: declarations.  The branches of each trunk step grow breadth first (every branch gets twigs before any gets
# more), at most PER_STEP nodes per step: the first steps of the proof name far more lemmas than the last ones.
DECL_LEVELS = {
    "spine":  {"BR": BR, "LEN": LEN, "PER_STEP": PER_STEP},
    "spine2": {"BR": [32, 16, 10, 8, 6, 5, 4, 4, 3, 3], "PER_STEP": 600,
               "LEN": [(2.0, 5.0), (0.8, 2.2), (0.4, 1.1), (0.25, 0.7), (0.18, 0.5), (0.14, 0.4), (0.11, 0.32), (0.09, 0.26), (0.07, 0.2), (0.06, 0.16)]},
}
def decl_level(cfg, seed):
    r = random.Random(seed)
    nodes = [dict(x) for x in trunk_nodes]
    placed = set(trunk)
    BRl, LENl, PER = cfg["BR"], cfg["LEN"], cfg["PER_STEP"]
    for i in range(T):
        todo, count = [(trunk[i], i, 1, None)], 0
        while todo and count < PER:
            d, ni, lv, outward = todo.pop(0)
            if lv > len(BRl):
                continue
            cands = [c for c in deps(d) if c not in placed]
            r.shuffle(cands)
            for c in cands[:BRl[lv - 1]]:
                if count >= PER:
                    break
                placed.add(c); count += 1
                dx, dy, dz = rand_dir(r, 0.55)
                if outward is not None:    # deeper levels keep roughly the parent's direction, so the tree fans out instead of tangling
                    dx, dy, dz = dx * 0.6 + outward[0], dy * 0.6 + outward[1], dz * 0.6 + outward[2]
                    l = math.sqrt(dx * dx + dy * dy + dz * dz); dx, dy, dz = dx / l, dy / l, dz / l
                L = r.uniform(*LENl[lv - 1]); p0 = nodes[ni]["p"]
                p = (p0[0] + dx * L, min(TOP_Y + 1.0, p0[1] + dy * L), p0[2] + dz * L)
                nodes.append({"n": label(c), "m": c[0], "p": [round(v, 3) for v in p], "up": ni, "lv": lv})
                todo.append((c, len(nodes) - 1, lv + 1, (dx, dy, dz)))
    return nodes

# level 3: every module.  Each one hangs under one of the modules that import it (the closest above in import depth: a short
# step), so the tree spans the whole project; trunk modules sit on their trunk node.  Height follows import depth, mapped onto
# the trunk (the trunk step at that depth), and each module wanders a little away from its parent, pulled back to the trunk.
def module_level(seed):
    r = random.Random(seed)
    nodes = [dict(x) for x in trunk_nodes]
    node_of = {}
    for k, nd in enumerate(nodes):
        node_of.setdefault(nd["m"], k)
    con = [[] for _ in range(n)]
    for k in range(0, len(edges), 2):
        con[edges[k + 1]].append(edges[k])
    by_d = defaultdict(list)                                   # import depth -> trunk heights at that depth
    for nd in trunk_nodes:
        by_d[depth[nd["m"]]].append(nd["p"])
    known = sorted((d, sum(p[1] for p in ps) / len(ps)) for d, ps in by_d.items())
    def y_of(d):
        if d <= known[0][0]:
            return known[0][1] - (known[0][0] - d) * 0.05
        for (d0, y0), (d1, y1) in zip(known, known[1:]):
            if d <= d1:
                return y0 + (y1 - y0) * (d - d0) / (d1 - d0)
        return known[-1][1]
    tys = [nd["p"] for nd in trunk_nodes]
    def trunk_xz(y):                                           # the trunk's x, z at height y
        best = min(tys, key=lambda p: abs(p[1] - y)); return best[0], best[2]
    # every node keeps an angle and a radius around the trunk: a child stays near its parent's angle (a branch stays a branch)
    # but drifts, and its radius is pulled towards its own random target, so the whole tree is a round, hairy column
    gen, polar = {}, {}
    for k, nd in enumerate(nodes):
        gen[k] = 0; polar[k] = (r.uniform(0, 2 * math.pi), 0.0)
    for i in sorted(range(n), key=lambda i: -depth[i]):        # importers first: they are always deeper (higher)
        if i in node_of or not con[i]:
            continue
        c = min(con[i], key=lambda c: (depth[c], c))           # the importer closest above
        up = node_of[c]; a0, r0 = polar[up]
        ang = a0 + r.gauss(0, 0.45)
        rad = min(4.5, max(0.3, 0.6 * r0 + 0.4 * (0.4 + 3.8 * math.sqrt(h01(i, 4))) + r.gauss(0, 0.2)))
        y = y_of(depth[i]) + r.uniform(-0.08, 0.08)
        tx, tz = trunk_xz(y)
        k = len(nodes); gen[k] = g = gen[up] + 1; polar[k] = (ang, rad)
        nodes.append({"n": None, "m": i, "p": [round(tx + rad * math.cos(ang), 2), round(y, 2), round(tz + rad * math.sin(ang), 2)], "up": up, "lv": min(g, 4)})
        node_of[i] = k
    return nodes

# ---------------------------------------------------------------- 4. module positions: a module sits on its first (highest) node, the rest is dust
def h01(i, k):
    x = (i * 0x9E3779B1 + k * 0x85EBCA6B + 0x165667B1) & 0xFFFFFFFF
    x ^= x >> 16; x = (x * 0x7FEB352D) & 0xFFFFFFFF; x ^= x >> 15; x = (x * 0x846CA68B) & 0xFFFFFFFF; x ^= x >> 16
    return x / 4294967296.0

def write_level(name, nodes, kind, legend):
    pos = array("f", [0.0]) * (3 * n)
    reached = bytearray(n)
    for nd in nodes:
        m = nd["m"]
        if not reached[m]:
            reached[m] = 1
            pos[3 * m:3 * m + 3] = array("f", nd["p"])
    for i in range(n):                 # the dust: the same place on every level
        if reached[i]:
            continue
        r = DUST_R * math.sqrt(0.08 + 0.92 * h01(i, 1)); th = 2 * math.pi * h01(i, 2)
        pos[3 * i] = r * math.cos(th); pos[3 * i + 1] = depth[i] * meta["yStep"] + (h01(i, 3) - 0.5) * 0.4; pos[3 * i + 2] = CENTER_Z + r * math.sin(th)
    (DATA / f"pos_{name}.f32").write_bytes(pos.tobytes())
    (DATA / f"{name}.bin").write_bytes(bytes(reached))
    doc = {"root": a.root, "steps": T, "kind": kind, "legend": legend}
    if kind == "decl":
        doc["nodes"] = nodes
    else:                              # 175k nodes: parallel arrays instead of objects (a third of the size)
        doc.update(n=[x["n"] for x in nodes], m=[x["m"] for x in nodes], up=[x["up"] for x in nodes], lv=[x["lv"] for x in nodes],
                   p=[c for x in nodes for c in x["p"]])
    (DATA / f"{name}.json").write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{name}: {len(nodes)} nodes, {sum(reached)} of {n} modules reached; {(DATA / f'{name}.json').stat().st_size / 1e6:.2f} MB  ({time.time() - t0:.0f} s)")

trunk_line = f"trunk = {T}-step proof spine from {a.root}"
for k, (name, cfg) in enumerate(DECL_LEVELS.items()):
    write_level(name, decl_level(cfg, a.seed + k), "decl", [trunk_line, "branches = sampled lemmas each step names" + (" (dense)" if k else ""), "dust = modules never reached"])
write_level("spine3", module_level(a.seed + 7), "module", [trunk_line, "branches = every module, under one of its importers", "(height = import depth along the trunk)"])
print("trunk:", " → ".join(f"{label(d)}[{depth[d[0]]}]" for d in trunk))
