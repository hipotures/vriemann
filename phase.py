"""What is the replay loop doing right now?  Pure logic (no I/O) so it can be unit-tested on made-up logs.

Kinds: building | finishing | starting | waiting-grant | claiming | between | booting | backoff | stopped | idle
"""
import re

_EV = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\] (.*)$")
_FAIL = re.compile(r"LOOP_STOP|NO_FREE_PACKET|GAVE_UP|NO_CLAIM|BUILD_FAILED|HASH_MISMATCH|RELEASE_FAILED|UPLOAD_MISMATCH|claim failed")


def parse_events(lines):
    """[(kind, seconds_of_day, data)] from the loop log (kinds: picked, claimed, granted, done, fail)."""
    out = []
    for line in lines:
        m = _EV.match(line.strip())
        if not m:
            continue
        secs = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)); msg = m.group(4)
        if (x := re.match(r"picked (\S+)", msg)):
            out.append(("picked", secs, x.group(1)))
        elif (x := re.match(r"claimed #(\d+)", msg)):
            out.append(("claimed", secs, int(x.group(1))))
        elif (x := re.match(r"granted #(\d+) (\S+)", msg)):
            out.append(("granted", secs, (int(x.group(1)), x.group(2))))
        elif (x := re.match(r"DONE (\S+)", msg)):
            out.append(("done", secs, x.group(1)))
        elif (x := re.match(r"LOOP_BACKOFF (\d+)s after (.*)", msg)):
            out.append(("backoff", secs, f"{x.group(2)} - retrying in {int(x.group(1)) // 60} min"))
        elif _FAIL.search(msg):
            out.append(("fail", secs, msg[:110]))
    return out


def decide(lines, loop_alive, build_running, receipt_exists, now_secs):
    """receipt_exists(packet_id) -> bool: has the build of that packet already produced its receipt?"""
    ev = parse_events(lines)
    age = lambda s: (now_secs - s) % 86400
    last_done = max((i for i, e in enumerate(ev) if e[0] == "done"), default=-1)
    since = ev[last_done + 1:]                      # what happened after the last finished packet
    if not loop_alive:
        reason = next((e[2] for e in reversed(ev) if e[0] == "fail"), None)
        return {"kind": "stopped", "text": "stopped" + (f" ({reason})" if reason else " (loop is not running)")}
    if ev and ev[-1][0] == "backoff":               # the loop failed transiently and is waiting before it tries again
        return {"kind": "backoff", "text": "retrying later: " + ev[-1][2]}
    granted = next((e for e in since if e[0] == "granted"), None)       # the packet being worked on
    if granted:
        n, pid = granted[2]
        if build_running:
            return {"kind": "building", "text": f"building {pid}", "id": pid, "issue": n}
        if receipt_exists(pid):
            return {"kind": "finishing", "text": f"verifying & uploading {pid}", "id": pid, "issue": n}
        return {"kind": "starting", "text": f"starting the build of {pid}", "id": pid, "issue": n}
    if build_running:                               # a build with no grant line in view (log rotated): still building
        return {"kind": "building", "text": "building"}
    claimed = next((e for e in reversed(since) if e[0] == "claimed"), None)
    picked = next((e for e in reversed(since) if e[0] == "picked"), None)
    if claimed and (not picked or claimed[1] >= picked[1]):
        a = age(claimed[1])
        return {"kind": "waiting-grant", "text": f"waiting for grant #{claimed[2]} · {a // 60}m{a % 60:02d}s", "issue": claimed[2], "age": a}
    if picked:
        return {"kind": "claiming", "text": f"claiming {picked[2]}", "id": picked[2]}
    if last_done >= 0:
        return {"kind": "between", "text": "between packets (next one is being picked)"}
    if not ev:                                      # the loop process is alive but has not logged anything yet: it is starting up
        return {"kind": "booting", "text": "the loop is starting (fetching updates, checking the reserved packet)"}
    return {"kind": "idle", "text": "idle"}
