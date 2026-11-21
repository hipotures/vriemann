#!/usr/bin/env python3
"""Precompute the 3D layout and compact binary graph files for the VR viewer.

Reads tracker/modules.jsonl.gz and packets.tsv from the replay repo (read only) and
writes data/*.  Run once (takes a few seconds); the headset only draws the result.

Layout ("proof tower"): y = import depth, every depth level is a ring around the
vertical axis, modules sorted by name so namespaces form contiguous arcs.
"""
import argparse, gzip, json, math, struct, sys
from array import array
from collections import Counter
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--repo", default=str(Path.home() / "DEV/alpoge-rh-replay"))
ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "data"))
a = ap.parse_args()
repo, out = Path(a.repo), Path(a.out)
out.mkdir(parents=True, exist_ok=True)

rows = [json.loads(l) for l in gzip.open(repo / "tracker/modules.jsonl.gz", "rt", encoding="utf-8")]
n = len(rows)
# the client addresses modules by row index (ids are not sequential in the file)
idx = {r["id"]: i for i, r in enumerate(rows)}

# --- namespaces (first two name components), most frequent get ids 0..253, rest 255
def ns_of(name):
    p = name.split(".")
    return ".".join(p[:2]) if len(p) > 1 else p[0]
ns_count = Counter(ns_of(r["module"]) for r in rows)
ns_list = [k for k, _ in ns_count.most_common(254)]
ns_id = {k: i for i, k in enumerate(ns_list)}

# --- positions
by_depth = {}
for i, r in enumerate(rows):
    by_depth.setdefault(r["depth"], []).append(i)
max_depth = max(by_depth)
Y_STEP, R0, R_BAND = 0.1, 5.0, 4.0
pos = array("f", [0.0]) * (3 * n)
for d, members in by_depth.items():
    members.sort(key=lambda i: rows[i]["module"])
    m = len(members)
    for k, i in enumerate(members):
        ang = 2 * math.pi * k / m
        rr = (k * 0.6180339887498949) % 1.0
        h = ((k * 2654435761) & 0xFFFFFFFF) / 4294967296.0
        rad = R0 + R_BAND * rr
        pos[3 * i] = rad * math.cos(ang)
        pos[3 * i + 1] = d * Y_STEP + (h - 0.5) * 0.06
        pos[3 * i + 2] = rad * math.sin(ang)

depth = bytes(r["depth"] for r in rows)                      # depth <= 202 fits a byte
nsb = bytes(ns_id.get(ns_of(r["module"]), 255) for r in rows)
pk = array("H", (int(r["packet"][1:]) - 1 for r in rows))     # packet index 0..2857
n_packets = max(pk) + 1

# --- alternative layouts: N-fold helix (2 = DNA-like double helix, 4, 8).  Height stays = import depth (so Main is still on top and the
#     elevator / rulers / dependency flow work unchanged); each strand is a right-handed helix, modules sit in a tube around it.
#     Strand = namespace (bin-packed so no strand is much fatter than the others; a namespace bigger than one share is split by packet).
HELIX = {"radius": 6.0, "tube": 0.9, "pitchLevels": 48.0, "spread": 0.30}
def hash01(i, k):
    """32-bit integer hash with good avalanche (a plain multiplicative hash makes hash01(i,1..3) linearly dependent: points land on a curve)."""
    x = (i * 0x9E3779B1 + k * 0x85EBCA6B + 0x165667B1) & 0xFFFFFFFF
    x ^= x >> 16; x = (x * 0x7FEB352D) & 0xFFFFFFFF; x ^= x >> 15; x = (x * 0x846CA68B) & 0xFFFFFFFF; x ^= x >> 16
    return x / 4294967296.0

def strand_assignment(N):
    share = n / N
    sizes = Counter(nsb)
    load = [0.0] * N
    assign = {}
    for ns, size in sizes.most_common():
        k = max(1, min(N, math.ceil(size / share)))
        chosen = sorted(range(N), key=lambda t: load[t])[:k]
        for t in chosen:
            load[t] += size / k
        assign[ns] = chosen
    return [assign[nsb[i]][pk[i] % len(assign[nsb[i]])] for i in range(n)]

def helix_layout(N):
    strand = strand_assignment(N)
    R, TUBE, PITCH, SPREAD = HELIX["radius"], HELIX["tube"], HELIX["pitchLevels"], HELIX["spread"]
    out = array("f", [0.0]) * (3 * n)
    counts = [0] * N
    for i in range(n):
        d = rows[i]["depth"]; st = strand[i]; counts[st] += 1
        theta = 2 * math.pi * st / N + 2 * math.pi * d / PITCH + (hash01(i, 1) - 0.5) * 2 * SPREAD
        rho = TUBE * math.sqrt(hash01(i, 2)); a = 2 * math.pi * hash01(i, 3)
        rad = R + rho * math.cos(a)
        out[3 * i] = rad * math.cos(theta); out[3 * i + 1] = d * Y_STEP + rho * math.sin(a) * 0.5; out[3 * i + 2] = rad * math.sin(theta)
    return out, counts

helix_files = {}
for N in (2, 4, 8):
    arr, counts = helix_layout(N)
    helix_files[f"pos_helix{N}.f32"] = arr.tobytes()
    print(f"  helix x{N}: strand sizes {counts}  (max/min = {max(counts) / max(1, min(counts)):.2f})")

# --- edges: importer -> imported (row indices)
edges = array("I")
for i, r in enumerate(rows):
    for dep in r["imports"]:
        edges.append(i)
        edges.append(idx[dep])

# --- packet centroids + sizes
sx = [0.0] * n_packets; sy = [0.0] * n_packets; sz = [0.0] * n_packets; cnt = [0] * n_packets
for i in range(n):
    p = pk[i]
    sx[p] += pos[3 * i]; sy[p] += pos[3 * i + 1]; sz[p] += pos[3 * i + 2]; cnt[p] += 1
pc = array("f")
for p in range(n_packets):
    c = max(cnt[p], 1)
    pc.extend((sx[p] / c, sy[p] / c, sz[p] / c))

def wr(name, data):
    (out / name).write_bytes(bytes(data) if not isinstance(data, (bytes, bytearray)) else data)

wr("pos.f32", pos.tobytes())
for name, data in helix_files.items():
    wr(name, data)
wr("depth.u8", depth)
wr("ns.u8", nsb)
wr("packet.u16", pk.tobytes())
wr("edges.u32", edges.tobytes())
wr("packet_centroid.f32", pc.tobytes())
with gzip.open(out / "names.txt.gz", "wb", compresslevel=9) as f:
    f.write("\n".join(r["id"] + "\t" + r["module"] for r in rows).encode("utf-8"))
(out / "meta.json").write_text(json.dumps({
    "modules": n, "edges": len(edges) // 2, "packets": n_packets, "maxDepth": max_depth,
    "yStep": Y_STEP, "namespaces": ns_list, "helix": HELIX, "layouts": ["tower", "helix2", "helix4", "helix8"],
}))
print(f"modules={n} edges={len(edges)//2} packets={n_packets} maxDepth={max_depth} namespaces={len(ns_list)}")
for f in sorted(out.iterdir()):
    print(f"  {f.name:22s} {f.stat().st_size/1e6:7.2f} MB")
