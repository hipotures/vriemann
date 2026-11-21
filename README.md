# VRiemann – RH replay proof tower (VR / desktop viewer)

A visualization of the Lean verification of Alpöge's RH proof ([alpoge-rh-replay](https://github.com/rohanarun/alpoge-rh-replay)):
175,187 modules as a "tower" (Y axis = import depth, each ring = the modules of one depth, sorted by name). Everything is read locally – no GitHub requests.

## Running
    python3 build_graph.py            # once (or after the index changes) – writes the 3D layout to data/
    python3 server.py --host <LAN-IP> --port 8080   # plain HTTP behind a reverse proxy that terminates TLS
    python3 server.py --host 0.0.0.0 --cert fullchain.pem --key privkey.pem   # HTTPS for headsets (WebXR requires HTTPS)

The server reads: `~/DEV/alpoge-rh-replay/tracker` (index, completed.tsv), `~/rh-replay-vol/lean/src` (Lean sources),
`~/rh-receipts/*/build.log` + `receipt.json` (our live builds), `~/rh-tools/packet.log` (build loop status). Paths: `--repo --vol --receipts --packet-log`.
A-Frame 1.7.0 (three.js r173) is vendored in `vendor/` – no CDN.

## Controls
Desktop: drag = look around, WASD = move, Q/E = elevator (depth), click = select / press a button, wheel over the code = scroll (in the miniature: size),
**B or M** = tower ⇄ miniature, **X** = follow live (off → camera → in place), **H or Y** = hide/show the UI, **R** = panels in front of me (A is "left", so recenter is R). **K** = connection style (fibres / tubes), **+ / −** or Shift+wheel = zoom (0 = reset).
VR (Touch controllers): trigger = select / button, left stick ▲▼ = elevator, right stick ◀▶ = rotate the world, right stick ▲▼ over the code = scroll,
A = put the panels in front of me, B = tower ⇄ miniature on a table, X = follow live, Y = hide/show the panels.

## Recording, miniature, hands
- **H or Y** (keyboard) / **Y** (left controller) – hides/shows the whole interface: panels, hint and VR button. For recordings.
- **Miniature** (B / M): the tower on a table. **Grip** on a controller or a **pinch in empty space** with a hand grabs it to move/rotate it;
  right stick ▲▼ (desktop: wheel) changes its size; **Bring to me** slides the tower's axis into your head (at the height of the selected module) –
  the points surround your head up close. The "depth" labels flip by themselves: readable from outside when you are outside, from inside when inside.
- **Hands**: without controllers you see your hands (hand tracking); aiming = a ray from the shoulder through the index fingertip, pinch = click.
- **The selected module** is a living sphere: a full surface with flowing bands and one "comet" per import (speed grows with the CPU of the `lean` process
  compiling that module right now); the core pulses and grows with memory (RES = resident size, mostly shared Mathlib .olean files);
  time/CPU/RES are in the Live build panel, there is no text over the sphere. The middle sphere carries the module's **Lean code** on its surface and pulses
  (faster with CPU, slowly enough to read). The small **nucleus** inside shows the **estimated compile progress**: Lean reports no progress within a module, so the server
  estimates the expected time from the file length with a power law fitted to every module we have built (90th percentile: ~94% finish before it runs out). The nucleus grows
  from a seed to full size, **breathes slowly when a module runs past its estimate**, flashes once when the module is built, and stays full for built modules. **Declarations from the code** orbit around it (theorem/lemma/def/instance/axiom; size = length, `axiom` in red) –
  **clicking a satellite scrolls the code to that declaration** and highlights it.
  Changing the selected module is a **smooth crossfade** (~0.4 s): the old sphere fades out, the new one fades in, both are visible at once, and a soft arc with a travelling point "hands over" attention.
- **Live build** panel: machine CPU and RAM bars plus the number of `lean` processes, so you can see that work is happening.

## Sound (off by default)
Generated live (Web Audio, no files), toggled with the **Sound** button in the menu or the **N** key (browsers only play after a click).
Three quiet layers: a **bed** (a slow low "breath": brighter with CPU, deeper with memory), **a note for every built module** (pentatonic scale, deeper = lower,
in VR it comes from the module's place in the tower; thinned to ~4 per second, max 10 at once) and a rare **chord** when one of our packets finishes.
Turning it on plays a **two-note confirmation**, and changing the volume plays a short blip, so you know at once whether it works. When the browser keeps audio suspended until the first gesture, the button shows **"Sound: tap"** and why;
every click / key / controller trigger retries. Default levels: notes about −22…−19 dBFS, bed −40 (idle) … −28 (load); a test keeps them from drifting back to inaudible.
All tuning numbers are at the top of `static/audio.js` (`CFG`): volume, density, brightness, decay, reverb. The browser remembers the volume.

## Layout: tower or helix
The **Layout** button in the menu (or the **L** key) cycles the layout: tower (rings) → double helix (like DNA) → ×4 → ×8. Height is still import depth (Main on top), so the elevator, rulers
and the Main marker work the same; **strand = namespace** (balanced by size, big namespaces split by packet), each strand is a right-handed helix of radius 6 m,
and the modules sit in a tube of radius ~0.9 m around it. The layouts (`data/pos_helix{2,4,8}.f32`) are generated by `build_graph.py` and loaded on first use (2 MB). The transition is smooth (1.6 s).

## Connections (fibres or tubes)
**Fibres** (default): every connection of the selected module is a faint, glowing light-guide along a cubic arc that **leaves the core radially** (fanned out, so
many connections sprout like a dandelion instead of one bundle) and then curves into its neighbour. **Comets** (bright head, short tail) run the way knowledge flows.
**Imports** (cyan) get dense, fast comets flowing INTO the core, and every arrival makes a **ripple on the core's membrane** where the fibre docks.
**Consumers** (magenta) are thin, dim, dashed threads with a rare slow wave going OUT, so they do not compete with the imports.
Fibres are additive (overlaps add up to a glowing trunk instead of a solid wall), have a soft Gaussian profile (no hard, aliased edge), fade at both ends and with distance,
and each has its own pace. Tune them with `FIB` in `app.js` (`segs`, `width`, `minPx`, `speed`, `freq`, `conSpeed`, `docks`).

**Tubes** (**K** or the **Links** button in the menu toggles; the browser remembers the choice): lit, opaque 3D tubes that hide each other like objects, thin where they leave the core,
with a bright bulge travelling along them. Tune them with `RIB` (`segs`, `sides`, `width` = radius, `start`, `minPx`, `speed`, `freq`).

Both styles draw up to `RIB.max` = 192 connections (all of them for ~99.8% of modules); only for hubs is the remainder a faint haze of thin lines.

## Glow
The **Glow** button in the menu or the **G** key: off → on (a soft halo around built / assigned / ours / compiling points) →
"all" (also a faint halo around grey, still-open points; heavy for a headset GPU). The halo is the same geometry drawn a second time, larger and additive – no
data copy. Strength and size are tuned in `GLOW` at the start of the glow section in `app.js`. The browser remembers the choice.

## Main and the critical line
Main (the final theorem, depth 202) has a golden landmark: a star, three turning rings and a corona. Above it rises the **critical line**: a thin warm line with the
**first 30 non-trivial zeros of zeta** on it, at heights proportional to their imaginary parts (14.13, 21.02, 25.01, …, 101.32), so they get denser upwards like the real ones.
Like the sequenced approach lights of a runway (or an obstruction light for passing mathematicians), a blink runs up the line every 6 s, faster and faster, and each zero
flashes with a short horizontal flare as it is passed. Tune it with `ZERO` in `app.js` (`y0`, `span`, `sweep`, `cycle`, `decay`).

## What you see
Colours: grey = open, blue = assigned to someone, green = built (by others), gold = built by us, pulsing orange = building right now.
**Closure** (button or **C**) has three modes: off → *dim* (everything else dimmed to 22%) → *only* (everything else disappears, leaving the selection and its imports).
Selected module: the whole chain of its imports (cyan), direct consumers (magenta), Lean code with highlighting (`sorry`/`axiom` in red).
Every module is normally a dot shaded like a ball (a camera-facing sprite: cheap, but flat if you put a controller through it). The **connected modules** (imports / consumers of the
selection) and the **compiling** ones are instead real 3D **soap bubbles**: instanced ellipsoids with a see-through middle and an iridescent rim, which slowly tumble and squeeze in all
three axes (volume kept). They have real depth, so a controller cuts them like solid objects. Up to `SOLID.max` = 6,000 at once (compiling ones first, then the connected nearest to the
selection); beyond that the rest stay plain dots. Tune them with `SOLID` in `app.js` (`max`, `detail`, `minPx`, `wobble`).
The "Packets" view = 2,858 packets as spheres (colour = % built). "Follow live" (X) cycles off → **camera** (selects the module that has been compiling the longest and takes you there: elevator + turning the tower) → **in place** (the scene stays still, only the selection moves: each new module gets its core, links and code where it is) → off. A manual selection turns follow off.

## Tests
    node tests/test_lib.js                                   # logic on the real data
    python3 tests/test_phase.py                              # build-loop phase detection
    node tests/test_audio.js                                 # sound engine with a fake AudioContext
    NODE_PATH=<…/node_modules with three@0.173.0> node tests/smoke_app.js [http://127.0.0.1:8080]   # app.js without a browser, against a running server
Not tested: GLSL rendering and real controllers (they need a browser / headset).
