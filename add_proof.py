#!/usr/bin/env python3
"""Add another Lean proof to the viewer (picked in the menu's PROOF row), e.g. grh-lean:

  git clone https://github.com/hipotures/grh-lean ~/DEV/grh-lean
  python3 add_proof.py grh ~/DEV/grh-lean/grh --title "GRH in Lean 4 (readable)" --label GRH
  python3 add_proof.py grh-compact ~/DEV/grh-lean/grh-compact --title "GRH in Lean 4 (compact)" --label "GRH compact"

Everything goes into proofs/<key>/ (not in git), in the same shape as the replay, so the usual scripts build it:
  tracker/modules.jsonl.gz   one row per module: id, module, imports (project-internal only), depth, packet (= folder), state
  packets.json               the folder name of every packet
  lean/src                   a symlink to the project's sources
  data/                      build_graph.py + build_spine.py output (layouts, spine)

Depth = the longest chain of project-internal imports below a module (Mathlib does not count).  The server finds every
proofs/*/data/meta.json by itself at start.
"""
import argparse, gzip, json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("key", help="short id, used in the URL (?proof=<key>)")
ap.add_argument("project", help="a Lake project folder (lakefile.toml / lakefile.lean)")
ap.add_argument("--title", default=None, help="shown at the top of the menu")
ap.add_argument("--label", default=None, help="short name on the menu button")
ap.add_argument("--src", default=None, help="source folder inside the project (default: srcDir of lakefile.toml, else the project)")
ap.add_argument("--state", default="done", choices=["open", "done"], help="state of every module (done = machine-checked: green)")
ap.add_argument("--root", default="riemannHypothesis", help="declaration at the top of the spine (in Main)")
ap.add_argument("--no-spine", action="store_true")
a = ap.parse_args()
if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", a.key):
    sys.exit("key: lowercase letters, digits, - and _ only")
proj = Path(a.project).expanduser().resolve()
src = a.src
if src is None:
    lk = proj / "lakefile.toml"
    mt = re.search(r'^srcDir\s*=\s*"([^"]+)"', lk.read_text(), re.M) if lk.exists() else None
    src = mt.group(1) if mt else "."
SRC = (proj / src).resolve()
out = ROOT / "proofs" / a.key

IMPORT = re.compile(r"^(?:public\s+|private\s+|meta\s+)*import\s+(\S+)")
def header_imports(txt):
    """the imports of the header only (`import` later in a file is prose in a doc comment)"""
    res, depth = [], 0
    for line in txt.splitlines():
        s = line.strip()
        if depth:                                       # inside a plain block comment
            depth += s.count("/-") - s.count("-/")
            continue
        if not s or s.startswith("--") or s == "module" or s == "prelude":
            continue
        if s.startswith("/-") and not s.startswith(("/-!", "/--")):
            depth = s.count("/-") - s.count("-/")
            continue
        m = IMPORT.match(s)
        if not m:
            break
        res.append(m.group(1))
    return res

files = sorted(p for p in SRC.rglob("*.lean") if ".lake" not in p.parts)
mods = {p.relative_to(SRC).with_suffix("").as_posix().replace("/", "."): p for p in files}
if not mods:
    sys.exit(f"no .lean files in {SRC}")
imports = {m: [i for i in header_imports(p.read_text(encoding="utf-8", errors="replace")) if i in mods] for m, p in mods.items()}

depth = {}
def dep(m):
    """longest import chain below m (iterative: no recursion limit; a cycle is an error)"""
    stack, onstack = [(m, iter(imports[m]))], {m}
    while stack:
        u, it = stack[-1]
        v = next(it, None)
        if v is None:
            stack.pop(); onstack.discard(u)
            depth[u] = 1 + max((depth[w] for w in imports[u]), default=-1)
        elif v in onstack:
            sys.exit(f"import cycle through {v}")
        elif v not in depth:
            stack.append((v, iter(imports[v]))); onstack.add(v)
for m in mods:
    if m not in depth:
        dep(m)
if max(depth.values()) > 255:
    sys.exit("import depth above 255 does not fit the viewer's depth.u8")

def folder(m):
    """packet = folder, up to three name components (a top-level file is its own packet)"""
    p = m.split(".")
    return ".".join(p[:min(3, len(p) - 1)]) or m
pk_list = sorted({folder(m) for m in mods})
pk_id = {f: i for i, f in enumerate(pk_list)}

order = sorted(mods, key=lambda m: (depth[m], m))
mid = {m: f"G{k + 1:06d}" for k, m in enumerate(order)}   # not M…: the replay's receipts never match these modules
(out / "tracker").mkdir(parents=True, exist_ok=True)
with gzip.open(out / "tracker/modules.jsonl.gz", "wt", encoding="utf-8") as f:
    for m in order:
        f.write(json.dumps({"id": mid[m], "module": m, "imports": [mid[i] for i in imports[m]], "depth": depth[m],
                            "packet": f"P{pk_id[folder(m)] + 1:04d}", "state": a.state, "wave": []}, ensure_ascii=False) + "\n")
(out / "packets.json").write_text(json.dumps(pk_list, ensure_ascii=False))
(out / "lean").mkdir(exist_ok=True)
link = out / "lean/src"
if link.is_symlink() and link.resolve() != SRC:
    link.unlink()
if not link.exists():
    link.symlink_to(SRC, target_is_directory=True)
print(f"{a.key}: {len(mods)} modules, {sum(map(len, imports.values()))} imports, max depth {max(depth.values())}, {len(pk_list)} folders")

run = lambda *cmd: subprocess.run([sys.executable, *map(str, cmd)], check=True)
run(ROOT / "build_graph.py", "--repo", out, "--out", out / "data", "--title", a.title or f"{proj.name} in Lean 4",
    "--label", a.label or a.key, "--packet-word", "folder")
if not a.no_spine:
    if "Main" not in mods:
        print("no Main module: no spine (build_spine.py starts from --root in Main)")
    else:
        run(ROOT / "build_spine.py", "--vol", out, "--data", out / "data", "--root", a.root, "--max-defs", 3)
print(f"done: python3 server.py, then pick '{a.label or a.key}' in the menu (or open /?proof={a.key})")
