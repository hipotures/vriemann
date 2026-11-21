"""python3 -I tests/test_phase.py  -- the loop-phase decision on made-up logs"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from phase import decide, parse_events
ok = 0
def t(name, got, **want):
    global ok
    for k, v in want.items():
        assert got.get(k) == v, f"{name}: {k} = {got.get(k)!r}, expected {v!r}  (full: {got})"
    ok += 1; print("ok  ", name, "->", got["text"])
NOW = 10 * 3600 + 30 * 60 + 0      # 10:30:00
nr = lambda pid: False
yes = lambda pid: True

t("claim placed, grant not yet there: waiting, with age", decide(["[10:25:48] picked P1","[10:25:48] claimed #8006"], True, False, nr, NOW), kind="waiting-grant", issue=8006, age=252)
assert "waiting for grant #8006 · 4m12s" == decide(["[10:25:48] claimed #8006"], True, False, nr, NOW)["text"]
t("only picked: claiming", decide(["[10:29:55] picked P1700"], True, False, nr, NOW), kind="claiming", id="P1700")
t("granted and lean/tasks running: building", decide(["[10:20:00] picked P1","[10:20:10] claimed #5","[10:21:00] granted #5 P1"], True, True, nr, NOW), kind="building", id="P1")
t("granted, build done (receipt exists), no DONE yet: verifying & uploading", decide(["[10:21:00] granted #5 P1"], True, False, yes, NOW), kind="finishing", id="P1")
t("granted, no build process, no receipt: starting", decide(["[10:29:58] granted #5 P1"], True, False, nr, NOW), kind="starting")
# pipelined: while P1 builds, the NEXT packet is picked/claimed/granted in the background - that must not look like 'waiting'
pipe = ["[10:21:00] granted #5 P1", "[10:21:02] picked P2", "[10:21:20] claimed #6"]
t("pipeline: building P1 while P2 waits for its grant: still 'building'", decide(pipe, True, True, nr, NOW), kind="building", id="P1")
t("pipeline: P1 finished, P2 grant still pending: 'verifying', NOT 'waiting'", decide(pipe, True, False, yes, NOW), kind="finishing", id="P1")
t("after DONE the next packet (already granted in the background) is the one in progress", decide(pipe + ["[10:29:00] granted #6 P2", "[10:29:30] DONE P1 (64 modules)"], True, False, nr, NOW), kind="between")
t("DONE then claim of the next: waiting for it", decide(["[10:20:00] DONE P1 (64 modules)", "[10:20:05] picked P2", "[10:20:20] claimed #9"], True, False, nr, NOW), kind="waiting-grant", issue=9)
t("DONE then grant of the next: that is the packet in progress", decide(["[10:20:00] DONE P1 (64 modules)", "[10:20:20] granted #9 P2"], True, True, nr, NOW), kind="building", id="P2")
t("loop process gone: stopped, with the last failure as the reason", decide(["[10:00:00] granted #5 P1", "[10:09:00] BUILD_FAILED P1 #5 rc=1 exit=1"], False, False, nr, NOW), kind="stopped")
assert "BUILD_FAILED" in decide(["[10:09:00] BUILD_FAILED P1"], False, False, nr, NOW)["text"]
t("loop gone, no failure line: stopped (loop is not running)", decide(["[10:00:00] DONE P1"], False, False, nr, NOW), kind="stopped")
t("no events yet but the loop process is alive: it is booting, not idle", decide([], True, False, nr, NOW), kind="booting")
t("unrecognised lines are no events: still booting", decide(["[10:00:00] something else"], True, False, nr, NOW), kind="booting")
t("alive, but the only thing in the log is a failure: idle (a real, rare idle)", decide(["[10:00:00] NO_FREE_PACKET"], True, False, nr, NOW), kind="idle")
t("build process but log has nothing: still reported as building", decide([], True, True, nr, NOW), kind="building")
t("midnight wrap: claim at 23:58:30, now 00:01:00 -> 2m30s", decide(["[23:58:30] claimed #7"], True, False, nr, 60), kind="waiting-grant", age=150)
t("garbage lines are ignored (-> booting, no events)", decide(["Note: linter chatter", "", "[xx] nonsense"], True, False, nr, NOW), kind="booting")
assert len(parse_events(["[10:00:00] picked P1", "[10:00:01] claimed #3", "[10:00:09] granted #3 P1", "[10:30:00] DONE P1 (64 modules)"])) == 4
t("loop backoff after a transient failure: retrying, with the reason", decide(["[10:20:00] NO_FREE_PACKET", "[10:20:01] LOOP_BACKOFF 600s after NO_FREE_PACKET (1/6)"], True, False, nr, NOW), kind="backoff")
assert "10 min" in decide(["[10:20:01] LOOP_BACKOFF 600s after NO_FREE_PACKET (1/6)"], True, False, nr, NOW)["text"]
t("after a backoff a new claim means the loop is working again", decide(["[10:20:01] LOOP_BACKOFF 600s after NO_FREE_PACKET (1/6)", "[10:30:00] picked P5"], True, False, nr, NOW), kind="claiming")
r = decide(["[10:00:00] granted #5 P1", "[10:09:00] BUILD_FAILED P1 #5 rc=1 exit=1", "[10:09:01] LOOP_STOP the cycle failed with exit code 6 (needs a human: see the lines above)"], False, False, nr, NOW)
t("loop stopped by itself: the text carries the reason a human needs", r, kind="stopped"); assert "LOOP_STOP" in r["text"] and "exit code 6" in r["text"], r["text"]
r2 = decide(["[10:09:01] LOOP_STOP stop file found (graceful)"], False, False, nr, NOW); assert "stop file" in r2["text"], r2["text"]; ok += 1; print("ok   graceful stop is explained:", r2["text"])
print(ok, "phase tests passed")
