#!/usr/bin/env python3
"""Local server for the RH replay VR viewer. Python standard library only.

Everything it serves is read from this machine: the module graph snapshot, the
prepared Lean volume (source code) and our own build logs/receipts.  No GitHub calls.

  python3 server.py                      # http://127.0.0.1:8443
  python3 server.py --host 0.0.0.0 --cert fullchain.pem --key privkey.pem   # HTTPS for WebXR
"""
import math, argparse, gzip, json, os, re, ssl, sys, threading, time, queue, collections
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from email.utils import formatdate, parsedate_to_datetime

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))      # python -I does not put the script's own directory on sys.path
from phase import decide as decide_phase
HOME = Path.home()
ap = argparse.ArgumentParser()
ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to reach it from the headset")
ap.add_argument("--port", type=int, default=8443)
ap.add_argument("--cert"); ap.add_argument("--key")
ap.add_argument("--repo", default=str(HOME / "DEV/alpoge-rh-replay"))
ap.add_argument("--vol", default=str(HOME / "rh-replay-vol"))
ap.add_argument("--receipts", default=str(HOME / "rh-receipts"))
ap.add_argument("--packet-log", default=str(HOME / "rh-tools/packet.log"))
args = ap.parse_args()
REPO, VOL, RECEIPTS, PACKET_LOG = Path(args.repo), Path(args.vol), Path(args.receipts), Path(args.packet_log)
SRC_ROOT = (VOL / "lean" / "src").resolve()

# ---------------------------------------------------------------- module index
ids, names = [], []
with gzip.open(ROOT / "data/names.txt.gz", "rt", encoding="utf-8") as f:
    for line in f:
        i, m = line.rstrip("\n").split("\t")
        ids.append(i); names.append(m)
N = len(names)
id_idx = {v: k for k, v in enumerate(ids)}
name_idx = {v: k for k, v in enumerate(names)}

# snapshot states from the published index: 1 assigned, 2 already observed/built
snap = bytearray(N)
with gzip.open(REPO / "tracker/modules.jsonl.gz", "rt", encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        k = id_idx[r["id"]]
        if r["state"] == "assigned" or r["wave"]:
            snap[k] = 1
        elif r["state"] != "open":
            snap[k] = 2

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
BUILT = re.compile(r"^\S?\s*\[(\d+)/(\d+)\]\s+Built\s+(\S+?)(?::\S+)?\s+\(([\d.]+)(ms|s)\)")

# ---------------------------------------------------------------- our own builds
lock = threading.Lock()
ours = set()                                 # row indices we built locally (any of our logs)
ring = collections.deque(maxlen=400)         # recent events for late subscribers
subs = set()
seq = 0
active = {"path": None, "off": 0, "buf": b"", "mtime": 0.0}


def publish(ev):
    global seq
    with lock:
        seq += 1
        ev["seq"] = seq; ev["t"] = time.time()
        ring.append(ev)
        for q in list(subs):
            try:
                q.put_nowait(ev)
            except queue.Full:
                subs.discard(q)


durations = {}                       # module index -> seconds Lean took to build it (from our build logs)
_lines = {}
_fit = {"n": -1, "a": 3.1, "b": 0.18, "sd": 0.3}


def src_lines(name):
    if name not in _lines:
        try:
            with open(SRC_ROOT / (name.replace(".", "/") + ".lean"), "rb") as f:
                _lines[name] = sum(1 for _ in f)
        except OSError:
            _lines[name] = 0
    return _lines[name]


def time_model():
    """secs ~ a * lines^b, a least-squares fit in log space over every module we have built (refit as history grows), with its residual sd."""
    if abs(len(durations) - _fit["n"]) >= 200 or _fit["n"] < 0:
        pts = [(math.log(n), math.log(t)) for k, t in list(durations.items()) if t >= 0.3 and (n := src_lines(names[k])) >= 3]
        if len(pts) >= 30:
            mx = sum(x for x, _ in pts) / len(pts); my = sum(y for _, y in pts) / len(pts)
            vx = sum((x - mx) ** 2 for x, _ in pts)
            b = sum((x - mx) * (y - my) for x, y in pts) / vx if vx > 0 else 0.0
            a = my - b * mx
            sd = (sum((y - a - b * x) ** 2 for x, y in pts) / len(pts)) ** 0.5
            _fit.update(a=math.exp(a), b=b, sd=sd)
        _fit["n"] = len(durations)
    return _fit


def estimate_secs(name):
    """Expected compile time of a module, generous (90th percentile of the fit): Lean reports no progress inside a module,
    and the file length explains only part of it, so most modules should finish before the estimate runs out."""
    f = time_model()
    return max(3.0, min(3600.0, f["a"] * max(1, src_lines(name)) ** f["b"] * math.exp(1.2816 * f["sd"])))


def parse_line(text, announce):
    text = ANSI.sub("", text).rstrip()
    if not text:
        return
    m = BUILT.match(text)
    if m:
        k = name_idx.get(m.group(3))
        if k is not None:
            ours.add(k)
            secs = float(m.group(4)) / (1000.0 if m.group(5) == "ms" else 1.0)
            durations[k] = secs
            if announce:
                publish({"k": "built", "i": k, "name": m.group(3), "n": int(m.group(1)), "N": int(m.group(2)), "s": secs})
            return
    if announce:
        publish({"k": "line", "text": text[:300]})


def newest_log():
    best, bt = None, -1.0
    for p in RECEIPTS.glob("*/build.log"):
        try:
            t = p.stat().st_mtime
        except OSError:
            continue
        if t > bt:
            best, bt = p, t
    return best, bt


def scan_history():
    for p in RECEIPTS.glob("*/build.log"):
        try:
            with open(p, "rb") as f:
                for raw in f:
                    parse_line(raw.decode("utf-8", "replace"), False)
        except OSError:
            pass


def tail_loop():
    last_pl = 0.0
    while True:
        try:
            p, mt = newest_log()
            if p is not None:
                size = p.stat().st_size
                if active["path"] != p:                    # new run: start from its beginning
                    active.update(path=p, off=0, buf=b"")
                if size < active["off"]:                   # file recreated
                    active.update(off=0, buf=b"")
                if size > active["off"]:
                    with open(p, "rb") as f:
                        f.seek(active["off"]); chunk = f.read(size - active["off"])
                    active["off"] = size
                    data = active["buf"] + chunk
                    *lines, rest = data.split(b"\n")
                    active["buf"] = rest
                    for raw in lines:
                        parse_line(raw.decode("utf-8", "replace"), True)
                    active["mtime"] = mt
            if PACKET_LOG.exists():
                t = PACKET_LOG.stat().st_mtime
                if t != last_pl:
                    last_pl = t
                    publish({"k": "status", "lines": tail_lines(PACKET_LOG, 6)})
        except Exception as e:                              # keep the tailer alive
            print("tail error:", e)
        time.sleep(0.4)


def tail_lines(path, n):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 8192))
            txt = f.read().decode("utf-8", "replace")
        return [ANSI.sub("", l) for l in txt.splitlines() if l.strip()][-n:]
    except OSError:
        return []

# ---------------------------------------------------------------- state vector
_state = {"t": 0.0, "sig": None, "buf": b"", "counts": {}}


def completed_ids():
    out = []
    try:
        with open(REPO / "tracker/completed.tsv", encoding="utf-8") as f:
            next(f)
            for line in f:
                k = id_idx.get(line.split("\t", 1)[0])
                if k is not None:
                    out.append(k)
    except OSError:
        pass
    return out


def receipt_objects():
    out = []
    for p in RECEIPTS.glob("*/receipt.json"):
        try:
            for mid in json.loads(p.read_text()).get("objects", {}):
                k = id_idx.get(mid)
                if k is not None:
                    out.append(k)
        except (OSError, ValueError):
            pass
    return out


def state_vector():
    """0 open, 1 assigned to someone, 2 built/accepted by others, 3 built by us."""
    now = time.time()
    try:
        sig = ((REPO / "tracker/completed.tsv").stat().st_mtime, len(ours), len(ring) and ring[-1]["seq"])
    except OSError:
        sig = None
    if now - _state["t"] < 3 and _state["buf"]:
        return _state
    buf = bytearray(snap)
    for k in completed_ids():
        buf[k] = 2
    for k in list(ours) + receipt_objects():
        buf[k] = 3
    c = collections.Counter(buf)
    _state.update(t=now, sig=sig, buf=bytes(buf), counts={"open": c[0], "assigned": c[1], "done": c[2], "ours": c[3]})
    return _state


_pprev = {}   # pid -> (cpu ticks, wall time) for per-process CPU%


def compiling():
    """Modules our volume's `lean` processes are compiling right now (a heavy module can sit silent for minutes)."""
    out = []
    try:
        up = float(open("/proc/uptime").read().split()[0]); hz = os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError):
        return out
    prefix = str(SRC_ROOT) + "/"
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            if open(f"/proc/{pid}/comm").read().strip() != "lean":
                continue
            src = next((a.decode("utf-8", "replace") for a in open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
                        if a.endswith(b".lean") and a.decode("utf-8", "replace").startswith(prefix)), None)
            if src is None:
                continue
            start = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[19])
            name = src[len(prefix):-len(".lean")].replace("/", ".")
            k = name_idx.get(name)
            if k is not None:
                st = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
                ticks = int(st[11]) + int(st[12]); now = time.time(); cpu = 0.0
                prev = _pprev.get(pid)
                if prev and now - prev[1] > 0.5:
                    cpu = 100.0 * (ticks - prev[0]) / hz / (now - prev[1])
                elif prev:
                    cpu = prev[2]
                _pprev[pid] = (ticks, now, cpu) if (not prev or now - prev[1] > 0.5) else prev
                rss = int(open(f"/proc/{pid}/statm").read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1048576
                out.append({"i": k, "name": name, "secs": round(up - start / hz), "cpu": round(cpu), "rssMB": round(rss), "est": round(estimate_secs(name), 1)})
        except (OSError, ValueError, IndexError):
            continue
    return sorted(out, key=lambda d: -d["secs"])


_cpu = {"prev": None, "pct": 0.0, "t": 0.0}


def cpu_percent():
    """Whole-machine CPU use since the previous call (>=1 s apart), from /proc/stat."""
    try:
        f = open("/proc/stat").readline().split()[1:]
        vals = list(map(int, f)); idle = vals[3] + vals[4]; total = sum(vals)
    except (OSError, ValueError, IndexError):
        return _cpu["pct"]
    now = time.time()
    if _cpu["prev"] is None:
        _cpu["prev"] = (total, idle); _cpu["t"] = now
    elif now - _cpu["t"] >= 1.0:
        dt, di = total - _cpu["prev"][0], idle - _cpu["prev"][1]
        if dt > 0:
            _cpu["pct"] = round(100.0 * (dt - di) / dt, 1)
        _cpu["prev"] = (total, idle); _cpu["t"] = now
    return _cpu["pct"]


def sysinfo(n_lean):
    mem = {}
    try:
        for line in open("/proc/meminfo"):
            k, rest = line.split(":", 1); mem[k] = int(rest.split()[0])      # kB
        total, avail = mem["MemTotal"], mem["MemAvailable"]
        load1 = float(open("/proc/loadavg").read().split()[0])
    except (OSError, ValueError, KeyError):
        return {}
    return {"cpu": cpu_percent(), "load1": load1, "cpus": os.cpu_count(), "memUsedGB": round((total - avail) / 1048576, 1),
            "memTotalGB": round(total / 1048576, 1), "lean": n_lean}


def cmdlines():
    out = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                out.append(open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace"))
            except OSError:
                pass
    return out


def loop_phase(n_lean):
    cl = cmdlines()
    alive = any(("run-packet.sh" in c or "run-pipeline.sh" in c or "run-forever.sh" in c) for c in cl)
    building = n_lean > 0 or any(("tracker/tasks.py" in c and " build " in c) for c in cl)
    lt = time.gmtime()
    return decide_phase(tail_lines(PACKET_LOG, 60), alive, building, lambda pid: (RECEIPTS / pid / "receipt.json").exists(), lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec)


def status():
    st = state_vector()
    rec = []
    for p in sorted(RECEIPTS.glob("*/receipt.json")):
        try:
            r = json.loads(p.read_text())
            rec.append({"task": ",".join(r.get("tasks", []))[:40], "ended": r.get("ended_utc", ""),
                        "modules": len(r.get("objects", {}))})
        except (OSError, ValueError):
            pass
    rec.sort(key=lambda r: r["ended"])
    age = time.time() - active["mtime"] if active["mtime"] else None
    allc = compiling(); comp = allc[:16]
    for p in [p for p in _pprev if not os.path.exists(f"/proc/{p}")]:
        _pprev.pop(p, None)
    return {"modules": N, "counts": st["counts"], "receipts": rec[-12:], "compiling": comp, "sys": sysinfo(len(allc)),
            "running": bool(comp) or (age is not None and age < 90), "buildAge": age, "phase": loop_phase(len(allc)),
            "activeRun": active["path"].parent.name if active["path"] else None,
            "packetLog": tail_lines(PACKET_LOG, 8)}

# ---------------------------------------------------------------- HTTP
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
        ".json": "application/json", ".txt": "text/plain; charset=utf-8"}
GZ_CACHE = {}
STATIC = {"/": ROOT / "static/index.html"}


def resolve_static(path):
    if path in STATIC:
        return STATIC[path]
    for prefix, base in (("/static/", ROOT / "static"), ("/vendor/", ROOT / "vendor"), ("/data/", ROOT / "data")):
        if path.startswith(prefix):
            p = (base / path[len(prefix):]).resolve()
            if p.is_file() and base.resolve() in p.parents:
                return p
    return None


class H(BaseHTTPRequestHandler):
    server_version = "rh-vr/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        pass

    def send_bytes(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/state":
                return self.send_bytes(200, state_vector()["buf"], "application/octet-stream")
            if u.path == "/api/status":
                return self.send_bytes(200, json.dumps(status()).encode(), "application/json")
            if u.path == "/api/find":
                k = name_idx.get(q.get("name", [""])[0])
                if k is None:
                    return self.send_bytes(404, b"unknown module", "text/plain")
                return self.send_bytes(200, json.dumps({"i": k}).encode(), "application/json")
            if u.path == "/api/src":
                return self.api_src(q)
            if u.path == "/api/events":
                return self.api_events()
            p = resolve_static(u.path)
            if p is None:
                return self.send_bytes(404, b"not found", "text/plain")
            return self.static(p)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def api_src(self, q):
        try:
            k = int(q.get("i", [""])[0])
            if not 0 <= k < N:
                raise IndexError(k)          # no negative (wrap-around) indices
            name = names[k]
        except (ValueError, IndexError):
            return self.send_bytes(400, b"bad index", "text/plain")
        p = (SRC_ROOT / (name.replace(".", "/") + ".lean")).resolve()
        if SRC_ROOT not in p.parents or not p.is_file():
            return self.send_bytes(404, b"source not found", "text/plain")
        data = p.read_bytes()
        note = b""
        if len(data) > 300_000:
            data, note = data[:300_000], b"\n-- [truncated by viewer at 300 kB]\n"
        return self.send_bytes(200, data + note, "text/plain; charset=utf-8",
                               {"X-Module": name, "X-Source-Size": str(p.stat().st_size)})

    def api_events(self):
        qu = queue.Queue(maxsize=1000)
        with lock:
            backlog = list(ring)[-60:]
            subs.add(qu)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")       # body is close-delimited; keeps reverse proxies happy
            self.send_header("X-Accel-Buffering", "no")   # nginx/Traefik style proxies: do not buffer the stream
            self.end_headers()
            self.wfile.write(b"retry: 3000\n\n")
            for ev in backlog:
                self.wfile.write(b"data: " + json.dumps(ev).encode() + b"\n\n")
            self.wfile.flush()
            while True:
                try:
                    ev = qu.get(timeout=15)
                    self.wfile.write(b"data: " + json.dumps(ev).encode() + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with lock:
                subs.discard(qu)
            self.close_connection = True

    def static(self, p):
        st = p.stat()
        lm = formatdate(st.st_mtime, usegmt=True)
        ims = self.headers.get("If-Modified-Since")
        if ims:
            try:
                if parsedate_to_datetime(ims).timestamp() >= int(st.st_mtime):
                    self.send_response(304); self.send_header("Last-Modified", lm); self.send_header("Content-Length", "0")
                    self.end_headers(); return
            except (TypeError, ValueError):
                pass
        body = p.read_bytes()
        extra = {"Last-Modified": lm, "Vary": "Accept-Encoding"}
        if p.suffix == ".gz":
            extra["Content-Encoding"] = "gzip"
            ctype = "text/plain; charset=utf-8"
        else:
            ctype = MIME.get(p.suffix, "application/octet-stream")
            if len(body) > 2048 and "gzip" in self.headers.get("Accept-Encoding", "") and p.name != "aframe.min.js.gz":
                key = (str(p), st.st_mtime)
                if key not in GZ_CACHE:
                    GZ_CACHE[key] = gzip.compress(body, compresslevel=6)
                body = GZ_CACHE[key]
                extra["Content-Encoding"] = "gzip"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    scan_history(); time_model()            # fit the compile-time model once up front (reads ~50k source files, ~2 s)
    # start the tailer at the end of the existing active log, but keep a short tail for the panel
    p, mt = newest_log()
    if p is not None:
        active.update(path=p, off=p.stat().st_size, buf=b"", mtime=mt)
        recent = []
        with open(p, "rb") as f:
            for raw in f:
                line = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip()
                m = BUILT.match(line)
                if m and name_idx.get(m.group(3)) is not None:
                    recent.append((m, line))
        for m, line in recent[-24:]:
            publish({"k": "built", "i": name_idx[m.group(3)], "name": m.group(3), "n": int(m.group(1)), "N": int(m.group(2)),
                     "s": float(m.group(4)) / (1000.0 if m.group(5) == "ms" else 1.0), "old": True})
    threading.Thread(target=tail_loop, daemon=True).start()
    srv = Server((args.host, args.port), H)
    scheme = "http"
    if args.cert and args.key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    print(f"rh-vr: {N} modules, {len(ours)} built by us locally -> {scheme}://{args.host}:{args.port}/", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
