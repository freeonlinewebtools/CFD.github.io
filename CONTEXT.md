# HyperFOAM — handoff

An interactive 2D computational fluid dynamics workbench. Vanilla ES modules,
no build step, no dependencies, served straight from GitHub Pages.

**Run it:** the page uses ES modules, so `file://` will not work.
`python -m http.server` then `http://localhost:8000/`.

---

## 1. Read this first

This document is written for whoever picks the project up next. The most
useful thing in it is not the architecture — it is section 5, **what was tried
and failed**. Several plausible-looking fixes have already been built,
measured and reverted. Repeating them costs a session.

Three habits that paid off and are worth keeping:

- **Measure before fixing.** Every real bug in this project was found by
  instrumenting, and every wrong diagnosis came from reasoning about the code
  instead. The cavity problem cost four failed attempts because I kept
  proposing causes rather than tracing where the divergence actually grew.
- **Suspect the measurement before the physics.** This document previously
  blamed the non-converging drag entirely on the staircase boundary. That was
  half right: the larger effect was that the convergence study gave the finer
  grids less physical time, so it was comparing an established wake against a
  transient (limitation 1). A plausible cause written down in a handoff note is
  still just a hypothesis — the first thing worth checking is whether the number
  disagreeing with you was measured correctly.
- **Never edit source with PowerShell `Set-Content`.** It re-encodes UTF-8
  through CP1252 and silently corrupts every non-ASCII character in the file.
  This happened once to `main.js` (383 damaged runs). Use the editing tools.

- **A green suite is evidence about the suite, not about the code.** The
  staggered solver shipped with the whole test suite passing and its *default*
  configuration diverging in ten steps, because `validate.mjs`, `water.mjs` and
  every case in `mac.mjs` set `vorticity = 0` while the app defaults it to 1.
  When a feature has a switch, at least one test has to run with the switch in
  the position the users get. And when a safety net exists — here `speedCap` —
  something must test with it OFF, or a runaway is quietly clamped into a result
  that merely looks disappointing.

One recurring shape worth naming, since it has now caused four separate bugs:
**a thing can be well-formed and still be wrong.** The `.mp4` files were valid
H.264 in the wrong container; the collapsible panels set `hidden` correctly on
an element CSS kept visible; the drag study ran the right solver for the wrong
length of time; the frame recorder advanced the flow correctly and never moved
the water surface. In each case the code did what it said. Test the *outcome* —
can a player open it, did the panel disappear, is the wake actually developed,
did the surface move — not the mechanism.

---

## 2. Layout

```
index.html          shell markup — static containers only, JS fills them
styles.css          Blender-derived theme (grey ramp, 4px radii)
src/
  main.js           app state, simulation loop, interaction, recording  (~1500 lines)
  shell.js          builds menus, toolbar, viewport header, status bar
  grid.js           Grid (fields, boundaries) + Poisson (multigrid)
  ns.js             Navier-Stokes solver
  lbm.js            D2Q9-TRT lattice Boltzmann
  diagnostics.js    forces, integrals, Strouhal
  particles.js      Lagrangian tracers
  scene.js          scene document, object model, boundary roles
  svg.js            SVG -> scene polygons (self-contained parser, no DOM)
  stl.js            STL parse + plane slice + loop stitching -> outlines
  freesurface.js    free-surface water: fill fraction, gravity, advection
  mp4.js            minimal ISO-BMFF muxer for the WebCodecs H.264 path
  geometry.js       signed distance functions for every primitive
  raster.js         scene -> solver masks (solid, coverage, bcType, bcU/V, bcK)
  transform.js      move/scale/rotate/mirror, gizmo handles, snapping
  history.js        snapshot undo/redo
  scenarios.js      19 built-in scenarios, as scene objects
  webm.js           minimal Matroska muxer for the WebCodecs VP9 path
  projects.js       localStorage projects + .hyperfoam.json import/export
  recorder.js       offline capture (WebCodecs / MediaRecorder / PNG zip)
  render-gl.js      WebGL2 field renderer (default)
  render-gpu.js     WebGPU field renderer (opt-in, same shader ported to WGSL)
  render-2d.js      Canvas2D fallback
  overlays.js       vectors, streamlines, contours, gizmos, colour bar, probe
  colormaps.js      LUTs
  ui/               icons, widgets, menu, outliner, properties, panels, splitter
```

### Data flow

```
Scene (vector objects)
  → Raster        (solid / coverage / bcType / bcU,bcV / bcK)
    → Grid        (solver fields)
      → NS or LBM (step)
        → render-gl / render-gpu / render-2d  (field)
        + overlays               (vectors, gizmos, HUD)
```

The **Scene is the single source of truth for geometry.** Scenarios, drawn
shapes and paint layers all become scene objects. There is no second mask.
An earlier "legacy mask merged with the scene raster" bridge existed and was
removed — do not reintroduce a second producer.

### Conventions that bite

- **Grid indexing:** `idx = i + j * stride`, `stride = nx + 2`, interior is
  `1..nx` × `1..ny`, one ghost cell all round.
- **j increases DOWNWARD**, matching the canvas. Clip space in WebGL runs
  upward — the vertex shader flips `vUV.y` for exactly this reason. Removing
  that flip renders the whole field upside down while overlays stay correct.
  Guarded by `orient.mjs`.
- **Units are cells and time-units.** `u,v` in cells/time, `visc` in
  cells²/time, `CFL = max|u|·dt`. This is what makes CFL a controllable number
  rather than an emergent one.
- **`u`/`v` are a READ-ONLY MIRROR by default.** The solver ships with `ns.mac`
  on, and then the velocity state lives on faces in `uf`/`vf`;
  `Grid.refreshCentred` rebuilds `u`/`v` once per step for everything
  downstream. Reading them is fine and is what every renderer, overlay,
  particle and force integral does. **Writing them expecting the solver to
  notice is not** — the next refresh overwrites it. Contributions reach the
  solver either as a cell-centred increment through `Grid.addCentredToFaces`
  (how confinement, the SGS model and brush impulses do it) or by writing the
  faces directly (how gravity does it). See "Staggered solver".
- **`fx`/`fy` are per-frame velocity IMPULSES, not forces.** They are *not*
  multiplied by `dt`. Scaling them by dt couples interaction strength to the
  timestep, which is itself derived from peak speed — a feedback loop.
- **Dye has three separate buffer sets:** field (`dR`), sources (`sR`), scratch
  (`tR`). Aliasing source with scratch re-injects the whole dye field every
  frame and it compounds at `(1+dt)` per frame.
- Positive `transform.rot` lifts the leading edge of a shape lying along +x,
  so aerofoil angle of attack maps straight onto it.
- **Anything drawn on the field needs `theme.halo` behind it.** The field is
  whatever colour the colormap produces, so overlay text and rules have no
  guaranteed contrast — the drag readout was unreadable over the warm end of
  the speed map and the scale bar vanished into mid-green. `Overlays.label()`
  outlines before filling. The halo must **oppose `theme.text`**, not match the
  chrome: it is dark in the dark theme and light in the light one. Hardcoding
  the dark value fixed the dark theme and made the light one invisible.
  Overlays that draw their own panel (colour bar, probe) do not need it.
- **`hidden` needs the global `[hidden]` rule in `styles.css`.** The UA rule is
  low priority, so any author `display:` beats it and the attribute does
  nothing while the JS looks correct. This is why the property groups did not
  retract and the status-bar fields would not hide.
- **`fx`/`fy` accumulate across pointer events, so brushes must clamp.**
  They are cleared inside `ns.step()`, but `pointermove` fires many times per
  frame — more when the frame rate drops, and more still where strokes overlap
  the same cells. Every event used to add a full relaxation toward the target,
  so the push tool's strength scaled with the mouse polling rate: against a
  target of 6.5 cells/time, one event a frame settled at 6.8 and eight at 64.6.
  `limitImpulse()` clamps what has ACCUMULATED, which makes a stroke idempotent
  within a frame. Any new brush must call it. Guarded by `phaseA.mjs`.
- **Displayed vorticity is NEGATED, and must be.** `j` increases downward, so
  the coordinate system on screen is left-handed and the textbook expression
  `dv/dx - du/dy` comes out POSITIVE for CLOCKWISE rotation — verified by
  constructing both rotations and reading the sign. Every convention a reader
  brings has positive vorticity turning anticlockwise, so all four display
  paths (both shaders, the Canvas2D fallback, the particle colouring) flip it.
  `vorticityConfinement` does NOT, because it only needs self-consistency.
  Guarded by `phaseA.mjs`.
- **Fluid fully enclosed by solid is turned into solid** (`fillEnclosedPockets`).
  Such a pocket exchanges nothing with the domain, and leaving it as fluid is
  actively harmful: its pressure problem is singular, the projection is not
  exactly consistent, and the divergence it cannot remove has nowhere to flush.
  Measured, a ring painted round moving fluid amplified about 1.35x per step —
  no damping gentle enough to look like fluid beats that. Meshers discard
  disconnected fluid zones for the same reason.
- **`coverage` tracks SOLID roles only.** It is the fractional form of the same
  body `solid` describes, so `grad(coverage)` is a surface delta for a real
  wall. Letting porous regions, inlets or outlets contribute would put drag on
  a body that is not there. It reaches the solver as `grid.coverage`, with
  `grid.hasCoverage` false when a mask was painted straight into `grid.solid`
  and no fractional data exists — consumers must keep a staircase fallback.

---

## 3. Current state

### Validated against published data

All from `npm run validate`, D = 24 at 384×192 unless stated, settled in
simulation time (see limitation 1 — the older figures here were taken on an
under-developed wake and did not mean what they said).

Both solvers are shown, because the change of default is recent and the
collocated column is what most of the older notes in this file were written
against. `MAC=1` selects the staggered one.

| quantity | staggered | collocated | reference |
|---|---|---|---|
| Strouhal, Re 200 | **0.200** | 0.196 | 0.19 – 0.20 |
| Strouhal, Re 400 | 0.213 | 0.210 | 0.20 – 0.21 |
| Strouhal, Re 100 | 0.177 | 0.177 | 0.16 – 0.17 |
| Strouhal, Re 60 | 0.147 | 0.153 | 0.13 – 0.14 |
| **Cd, Re 20 (steady)** | 1.694 | **2.131** | ≈ 2.05 |
| **Cd, Re 40 (steady)** | 1.311 | **1.440** | ≈ 1.55 |
| Cd, Re 200 (shedding) | **1.217** | 0.979 | 1.28 – 1.40 |
| Cd, Re 400 (shedding) | **1.329** ✓ | 0.973 | 1.25 – 1.40 |
| Cl rms, Re 400 | 0.582 | 0.514 | — |
| Shedding onset | between Re 40 and 60 | same | ≈ 47 |
| Peak speed past a cylinder | 2.1 × inlet | 2.1 × inlet | 2.0 (potential flow) |

**The two solvers are wrong in opposite directions, and it is worth knowing
which way.** The collocated form is good in the *steady* regime — Re 20 and
Re 40 bracket the reference to 4–7 % — and loses 20–30 % of the drag as soon as
a wake starts shedding. The staggered form is the reverse: it recovers almost
all of the shedding-regime deficit (Re 400 lands in band, Re 200 just under) and
gives up accuracy at low Re, where it now reads ~17 % low.

That fits the diagnosis. The shedding deficit was projection consistency, which
the staggered operators fix outright; the steady-regime softening is the compact
gradient resolving a thin attached boundary layer on a coverage-weighted body,
where the wide stencil was flattering it. **If you are measuring a bluff body in
a real wake, use the default. If you are measuring creeping flow, the collocated
path is currently closer** — and neither is a substitute for finer cells across
the body.

### Staggered solver (MAC) — the default since the refinement pass

`ns.mac`, mirrored by `app.staggered` and switchable in Numerics ▸ Pressure
solve. Velocities live on **cell faces**, pressure at centres:

```
uf[i,j]  x-velocity on the LEFT face of cell (i,j),  at x = i - 1/2   (i = 1..nx+1)
vf[i,j]  y-velocity on the TOP  face of cell (i,j),  at y = j - 1/2   (j = 1..ny+1)

div[idx] = (uf[idx+1] - uf[idx]) + (vf[idx+s] - vf[idx])   // stored NEGATED
uf[idx] -= p[idx] - p[idx-1]                                // exact adjoint
```

**The one rule.** *Faces are the state. Interpolate increments and diagnostics
across the staggering freely; never interpolate the state back into the solver.*
`u`/`v` still exist and still mean what they always did, but they are a
**derived, one-way mirror** refreshed once per step by `Grid.refreshCentred` for
the renderers, particles, overlays and force integration. Nothing reads them
back. That is the entire difference from the reverted attempt in section 5: a
filter applied to an output is a resampling, a filter applied to a state
compounds every step.

**What it bought, measured on `tests/validate.mjs`:**

| Re | collocated Cd | staggered Cd | published |
|---|---|---|---|
| 60 | 1.196 | 1.171 | 1.35–1.45 |
| 100 | 1.070 | 1.159 | 1.30–1.40 |
| 200 | 0.979 | **1.217** | 1.28–1.40 |
| 400 | 0.973 | **1.329** ✓ in band | 1.25–1.40 |

Shedding is *preserved*, not lost — Cl rms 0.362 → 0.370 at Re 200, 0.514 →
0.582 at Re 400 — which is exactly what the previous attempt destroyed. Strouhal
lands in the published band at Re 200 (0.200) where the collocated form sat
just under it. Limitation 1 (drag low by 20–30 %) is substantially reduced but
not gone; the low-Re end is still soft, and Re 20 got slightly worse
(2.131 → 1.694 against a published ~2.05).

**Two things that cost hours, both worth knowing before touching this:**

- **Each projection needs its OWN warm-start pressure buffer** (`g.p` and
  `g.pPre`). Both warm-start from their previous solve, which is what makes two
  V-cycles enough — but they solve *different* right-hand sides, so one shared
  buffer means each starts from the other's answer and neither converges. The
  collocated path tolerated this because its wide gradient cannot see a
  checkerboard and so filtered the leftover away; the compact staggered gradient
  has no such null space, which is a virtue for accuracy and means unconverged
  pressure goes straight into the velocity. Measured on an inviscid
  Taylor–Green vortex: shared buffer took the kinetic energy 2048 → 12217 in
  forty steps. One buffer each holds 2040 over two hundred steps.
- **Face loops must not run to `nx+1` / `ny+1` in the diffusion sweep.** Only
  the *free* faces are relaxed; the domain-boundary faces are prescribed. Running
  past them also walked off the end of the array, where a `Float32Array` read
  returns `undefined` and poisons the field with NaN on the first step.

**Cost: about 2.5× the collocated step** — 6.1 → 17.2 ms at 256×128 in Node.
Inherent, not a missed optimisation: two face lattices are advected instead of
one fused centred pass, each needing a cross-staggering gather for the
transporting velocity. Inlining the samplers changed nothing measurable. At the
default grid and one sub-step per frame this is still ~58 steps/s.

**Guarded by `tests/mac.mjs`** (10 checks): operator adjointness, projection
convergence, monotonic behaviour under more V-cycles on a *ragged* solid, a
driven closed box for 300 steps, a Taylor–Green vortex that must keep both its
vorticity (99.5 %) and its energy (99.6 %) over 200 steps — the last catches
diffusion and instability, which are opposite failures — and case 6, below.

**The reported explosion is REDUCED, NOT FIXED.** Measured directly, wind tunnel,
speed cap disabled so a runaway shows as one:

| geometry | collocated | staggered |
|---|---|---|
| ragged blob | stable / 1500 steps | stable / 1500 steps |
| smooth blob | stable / 1500 steps | stable / 1500 steps |
| **blob + one-cell-thick spurs** | **ran away, 2.7e6** | **ran away, 1.3e4** |

Two things follow, and both matter. Raggedness of an outline is *not* the
trigger — that hypothesis is now dead, and it was the fourth. **Thin solid
features are**: a spur one cell thick has fluid on both sides of a wall with no
cell in between, and neither discretisation has anywhere to put the pressure
jump. The staggered form is ~200× less violent about it but still diverges, so
`speedCap` remains load-bearing rather than decorative. The likely real fix is
cut cells (section 8), which give a thin feature a fractional face area instead
of an all-or-nothing one.

**`t1` has two owners — do not snapshot into it.** The centred passes reach the
faces as an increment: snapshot the mirror, let them run, difference, scatter.
That snapshot first used `g.t1`, which `vorticityConfinement` claims as its curl
scratch and overwrites on entry, so the "increment" was `u − curl` — the whole
velocity field, scattered onto the faces every step, running away in ten. It is
now `g.snapU` / `g.snapV`.

The instructive part is why nothing caught it: `validate.mjs`, `water.mjs` and
every other case in `mac.mjs` set `vorticity = 0`, while the app defaults it to
1. Every suite was green and the default configuration was broken. `mac.mjs`
case 6 runs confinement ON with the cap OFF for exactly this reason — with the
cap on, a runaway is clamped into something that merely looks poor.

`validate.mjs` and `water.mjs` run the **staggered** solver by default, matching
the app; `COLLOCATED=1` selects the old path for comparison. That direction
matters — they were briefly the other way round, which validates a configuration
nobody runs.

### Renderer backends

WebGL2 by default; WebGPU is opt-in under **View ▸ Renderer**. `render-gpu.js`
is a straight port of `render-gl.js` — same fields, same per-output-pixel
evaluation, the GLSL rewritten as WGSL and kept line-for-line comparable so the
two cannot quietly become different products. `ROW_FOR_MODE` and `NORM_FLOOR`
are exported from `render-gl.js` and imported by the WebGPU path so there is no
second copy to drift.

`tests/backend-parity.py` renders an intentionally **asymmetric** state through
both and compares coarse pixel signatures: mean channel difference is 0.00–0.01
out of 255, while the same comparison against a vertically flipped image scores
30–46. That margin is the point — an orientation bug is the failure this
codebase has actually shipped, and a symmetric test scene hides it completely.

Three things the API forces, all of which cost a bug on the way in:

- **Creation is async**, so `boot()` awaits it.
- **A canvas keeps its first context type for life.** Asking for `webgpu` after
  `webgl2` returns null forever, so the backend must be decided before the first
  `getContext` — which is why switching prompts for a reload and why a failed
  WebGPU start replaces the canvas element before falling back.
- **There is no `preserveDrawingBuffer`.** Once a WebGPU frame is presented its
  canvas reads back BLACK, and both the PNG export and the recorder compose from
  a later task. Every exported image was a black rectangle while the app looked
  perfect on screen. `composeFrame()` now re-issues the field draw in the same
  task as the readback, and `savePNG` goes through it rather than compositing
  its own canvas. `tests/gpu-capture.py` exports through the real File ▸ Save
  image path and fails if the result is blank — it caught this, and a
  "does WebGPU render?" check would not have.

### Editor: getting geometry in

Three routes, all under **File**:

| route | for |
|---|---|
| `Import SVG…` | outlines drawn in Illustrator, Inkscape, any vector tool |
| `Import 3D model (STL)…` | a section cut through a real CAD model |
| the drawing tools | sketching directly |

**STL slicing** (`src/stl.js`) is three separable stages — `parseSTL`,
`sliceMesh`, `stitchLoops` — each tested against meshes whose cross-section is
known analytically, so a failure names the stage. Notes that cost time:

- **Do not trust a leading `solid`** to mean ASCII. Plenty of binary exporters
  write that word into the 80-byte header; the length arithmetic
  (`84 + 50n === byteLength`) is decisive and is checked first.
- **Stitching is the hard part.** A slice yields segments in triangle order, and
  a solver needs rings. Endpoints that should coincide come from interpolating
  along two different edges and differ in the last bits, so they are welded on a
  tolerance derived from the model's own size — a 3 mm bracket and a 30 m hull
  cannot share a fixed epsilon.
- **Coplanar triangles are skipped**, not expanded into their three edges. Their
  neighbours already produce that boundary, and adding it again gives the
  stitcher a degree-four junction to misroute at.
- Open chains are kept and become walls. Real meshes are often not watertight,
  and the preview shows closed rings in blue, open chains in amber.

**Orientation is a control, not a guess.** Cutting across X leaves (Y,Z), across
Y leaves (Z,X), across Z leaves (X,Y), and those pairs do not share a
handedness — so a wing faces into the flow on one axis and away on another,
through no fault of the model. Nothing in an STL says which way the file
considers "forward", so guessing per axis would be wrong for half of all models.
Flip H / Flip V / Rotate are offered instead, applied BEFORE fitting so a
quarter turn re-checks the blockage cap rather than sizing by the old bounding
box and rotating out of the tunnel.

**The preview shows the section in the tunnel, not fitted to the canvas.**
Fit-to-canvas answers "what shape is this", which is already obvious. The
question worth answering before adding is what it will DO: how much of the
channel it blocks, which way it faces, where it sits. So the domain is drawn to
its real aspect with the inlet edge marked, and the preview and the added object
go through the same `sliceToScene` call — a preview that computes its own
geometry is a preview that can lie.

### Editor: SVG import and design analysis

**SVG import** is `File > Import SVG…`. Self-contained parser — no DOMParser, so
it is testable headlessly, which is why `tests/svg.mjs` exercises the real code
path rather than a browser-only one. Handles nested `<g>` transforms, all path
commands including arcs and the S/T reflections, and the primitive elements.
Closed subpaths become solid polygons, open ones become walls carrying the
stroke width. Deliberate limits are in the module header: fill-rule holes are
not cut (a letter 'O' imports as a disc — the rasteriser has no negative
objects) and `<text>` is ignored, so convert to outlines first.

**Sizing is a blockage decision, not a layout one.** Imports are capped at a
quarter of the tunnel height and just under half its length, and placed a third
of the way in. Fitting the drawing to the domain the obvious way put a 69 %
blockage in the tunnel — the walls then accelerate the flow past the body and
every coefficient is meaningless. A circle imported this way lands near the
32-cell diameter the validation above is quoted at.

**Design analysis** is `Simulation > Analyse design…` (Ctrl I): averaged Cd and
Cl with their spread, L/D, Re, St, the sub-cell frontal dimensions, and an
explicit confidence line driven by the validation above — "good" in the steady
regime, "indicative" once a wake sheds. Three things it deliberately does, each
because the naive version was actively misleading:

- averages over a window instead of quoting the live value, because a shedding
  body's instantaneous Cd swings by tens of per cent and reading it at the wrong
  instant is how you conclude one design beats another;
- discards samples for 120 frames after any geometry change — the pressure
  transient when a body appears reached Cd = 13 and dominated the mean for
  hundreds of frames;
- refuses to print a Strouhal number outside 0.02–1, because the crossing
  detector reads turbulent noise as a very short period and reported St = 12.4.

### Test suites — `tests/`, run with `npm test`

`npm test` runs all eight. `npm run validate` runs the published-data
comparison in section 3 — it now settles in simulation time, so it takes
appreciably longer than it used to and is not part of `npm test`.
`tests/trace.mjs` is the instrumentation used to locate the closed-domain
divergence — keep it, it is how that was found.


| file | covers | count |
|---|---|---|
| `test.mjs` | physics regression, all scenarios | 46 |
| `phaseA.mjs` | interaction bounds, particles, colour map | 22 |
| `phaseB.mjs` | scene, SDFs, undo, raster, transforms | 72 |
| `orient.mjs` | render orientation across all three paths | 11 |
| `porous.mjs` | porous boundary behaviour | 14 |
| `forces.mjs` | coverage-weighted force integration | 23 |
| `svg.mjs` | SVG paths, transforms, fitting, rasterising | 37 |
| `stl.mjs` | STL parsing, slicing, loop stitching | 28 |
| `rec.mjs` | recorder fixed-step capture, ZIP writer | 38 |
| `mp4.mjs` | MP4 box structure and sample offsets | 32 |
| `webm.mjs` | WebM/EBML tree, clusters, timing drift | 19 |
| `mac.mjs` | staggered operators, closed box, vortex preservation | 8 |
| `water.mjs` | free surface, fill save/load, solver call sites | 21 |
| `boot2.mjs` | boots the whole shell against a stub DOM | sweep |

`mac.mjs` and `water.mjs` case 7 are worth knowing about because neither tests a
number. `mac.mjs` case 1 checks an algebraic identity (`<div a, b> = -<a, grad b>`)
rather than a simulation result — if that fails, no amount of solver tuning will
help. `water.mjs` case 7 reads `main.js` as *text* and fails if any call site
steps the solver without the free-surface bracket around it; that is a rule about
call sites, not runtime values, and it caught the recorder bug's shape rather
than one instance of it.

Browser checks sit outside `npm test` because they need a server and Chrome. Run
`python -m http.server 8123` first, then:

| script | proves |
|---|---|
| `tests/mp4-play.py` | Chrome demuxes, seeks and decodes a muxed MP4 |
| `tests/webm-play.py` | the same for WebM |
| `tests/capture-timing.py` | a stuttering render does **not** stutter the file |
| `tests/mp4-motion.py` | motion advances at a constant rate |
| `tests/backend-parity.py` | WebGPU draws the same picture as WebGL 2 |
| `tests/gpu-capture.py` | image export is not blank on either backend |
| `tests/refine-smoke.py` | help panel, tab strip, water scenarios, mode switching |

`refine-smoke.py` reaches the app through **`window.hyperfoam`**, set at the end
of `boot()`. Note the name: `window.app` is already the `#app` *element*, via the
DOM's id-to-global rule, so a handle called `app` silently resolves to a div and
every check against it reads as "missing". Everything in `main.js` is otherwise
module-private, which is right for the app and leaves UI changes — a generated
panel, a mode switch — with nothing able to verify them.

`forces.mjs` tests the force integral against **analytic** fields rather than a
running flow, so the answers are known exactly: a uniform pressure gradient must
lift a body by its own area (Archimedes), and a uniform velocity must report a
wetted length of πD. That separates an error in the integration from an error in
the flow being integrated — which is what made the diagnosis below possible.

`boot2.mjs` is the most valuable one — it constructs the entire interface and
clicks every menu item, tool, slider, tab and key. It catches wiring errors
that no unit test would.

**Browser verification: partially closed.** `browser-use` is still not
installed — but **Playwright is already present** (Python, `site-packages`), and
Chrome with it, so a real browser needs nothing new downloaded:

```python
browser = await pw.chromium.launch(channel="chrome", headless=True,
                                   args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
```

Run `python -m http.server 8000` and drive that against it. Confirmed with this
change: the page boots under a real ES module loader with **zero page errors and
zero console errors**, WebGL2 initialises, the field renders a correct
downstream wake (right way up — the flip bug would show here), and the status
bar reports live Cd/Cl/CFL from the coverage-weighted diagnostics.

Two traps. `readPixels` on the default framebuffer after compositing returns a
near-blank buffer — it reads ~0 pixel range on a perfectly good frame, so judge
the render from a **screenshot**, not from `readPixels`. And headless Chrome
needs the two GL flags above or it falls back to a software path that never
gives you WebGL2.

Still worth extending: nothing yet drives the *tools* through real pointer
events, which is where `boot2.mjs`'s stub DOM is weakest.

---

## 4. Known limitations

### 1. Force coefficients are low — largely fixed by the staggered solver  *(was: item 15)*

**Current status.** With the staggered solver (now the default) this is mostly
resolved in the regime it mattered: Cd at Re 400 is 1.329 against a published
1.25–1.40, and the mesh-refinement sequence at Re 200 now reads
1.259 → 1.217 → 1.200 at D = 16/24/32 — converging, and toward the reference
rather than away from it. Under the collocated solver the same sequence was
1.196 → 0.979 → 0.929.

What remains is at the **low-Reynolds** end, where the staggered path is now
~17 % low (Re 20: 1.694 against ≈ 2.05) and the collocated one was better. See
"The two solvers are wrong in opposite directions" in section 3, and section 8
for why cut cells are the natural next step.

The history below is kept because the reasoning still applies, and because two
of the three faults it describes were nothing to do with the solver.

---

The old entry here reported that Cd fell with mesh refinement (1.187 → 0.917 →
0.791 at D = 16/24/32) and blamed the staircase surface. **Three independent
faults were behind that, and all three are fixed.** The lesson is section 1's:
the largest was found only by instrumenting, and it was not the one being
blamed. Every one of them was resolution-dependent, which is what made the
symptom look like a failure to converge.

**Fault A — the convergence study was invalid.** `validate.mjs` settled each
case for a fixed number of *steps*. A finer mesh is also a longer tunnel, so
the same 400 steps bought steadily less physical development. At 384×192 that
was **0.70 tunnel flow-throughs** — the vortex street had barely started. Held
at constant physical time instead, at D = 24, Re 200:

| settle | Cd | Cl rms | St |
|---|---|---|---|
| 0.70 flow-throughs | 0.917 | 0.113 | 0.159 |
| 2.59 flow-throughs | 1.057 | 0.371 | 0.198 |
| 5.16 flow-throughs | 1.057 | 0.375 | 0.197 |
| 10.31 flow-throughs | 1.058 | 0.377 | 0.197 |

Cl rms more than triples and St lands in its reference band. The old numbers
were measuring a transient. `validate.mjs` now settles **2.5 flow-throughs** and
samples **12 shedding periods**, both in simulation time, so every grid gets
equal physics — the constants are `SETTLE_FLOWS` / `SAMPLE_CYCLES` at the top.

**Fault B — the staircase surface (the real item 15).** Measured directly:

| | D=8 | D=16 | D=32 | D=64 | limit |
|---|---|---|---|---|---|
| staircase faces / πD | 1.353 | 1.313 | 1.293 | 1.283 | 4/π = 1.273 |
| Σ&#124;∇coverage&#124; / πD | 1.010 | 1.016 | 1.016 | 1.015 | 1 |

The staircase does not merely overestimate the perimeter, it **converges to a
27 % error** — refining the mesh cannot fix it. The coverage field measures the
true perimeter to 1.5 % at every resolution.

`diagnostics.forces()` is now weighted by `grad(coverage)`, using the identity
`n dS = -grad(X)` to turn the surface integral into a volume one over a smeared,
sub-cell surface. Verified in `forces.mjs` against analytic fields: the integral
recovers a body's area to **0.01–0.34 %** at D = 12…64. Skin friction keeps its
half-cell wall-gradient estimate but is rescaled to the true wetted area.

**Fault C — the reference length was the bounding box.** `L` divides every
coefficient, and it counted *cells*: a circle of diameter D measured **D+1**.

| D | 8 | 16 | 24 | 32 | 64 |
|---|---|---|---|---|---|
| bounding box / D | 1.125 | 1.063 | 1.042 | 1.031 | 1.016 |
| coverage silhouette / D | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

That is a 1.6–12.5 % error which *shrinks as the mesh refines* — so it looked
like convergence and hid inside the other two. Worse, it depended on **where the
body sat relative to the cell grid**: `validate.mjs`'s cylinder is centred on a
half-integer in y but an integer in x, so it measured 24 rows and 25 columns.
The reported Cd, which uses `max(height, width)`, was 4 % low; St, which uses
the height, happened to be right. Move the same body half a cell and that
swaps over.

`bodyBounds()` now integrates the coverage gradient instead: summing `|∂χ/∂x|`
along a row totals 2 wherever the row crosses the body, so `½Σ|∂χ/∂x|` is the
extent in **y** (and vice versa — easy to transpose, so `forces.mjs` tests a
40×12 rectangle). This feeds `L` and the Strouhal length alike, and returns D
exactly regardless of placement. Being a total variation it is the silhouette
only for a **convex** body.

**Result.** Grid convergence at Re 200, equal physical time throughout:

| grid | D | Cd | Cl rms | St | | was: Cd | Cl rms |
|---|---|---|---|---|---|---|---|
| 256×128 | 16 | 1.196 | 0.370 | 0.190 | | 1.187 | 0.326 |
| 384×192 | 24 | 0.979 | 0.362 | 0.196 | | 0.917 | 0.113 |
| 512×256 | 32 | 0.929 | 0.358 | 0.199 | | 0.791 | 0.016 |

**Cl rms was collapsing twenty-fold under refinement and is now flat to 3 %**,
and St converges into its reference band. Cd still falls, but the *increments*
now shrink about four-fold per refinement (−0.217 then −0.050) instead of
marching steadily away; Richardson on those three points extrapolates to
≈ 0.89. So the coefficients converge — to a value roughly 30 % below the
reference.

**What remains.** That residual is not the boundary treatment. The steady-regime
drag in section 3 is accurate to 4–7 % using this same integral, so the geometry
and the surface integral are fine; the deficit is specific to resolving a
shedding wake. Suspect limitation 3 (the projection is not exactly consistent,
so the wake diffuses) before suspecting anything here. Secondary O(h) terms that
do remain in the integral: the wall shear is a half-cell one-sided difference,
and the pressure is mirrored into the solid assuming ∂p/∂n = 0.

### 2. Closed domains diverge — FIXED by the staggered solver

Under the **collocated** solver, any fully sealed region driven from inside went
non-finite in 25–50 steps, which is why `lid-cavity` is commented out in
`scenarios.js`.

Traced precisely: divergence exploded at the cell adjacent to the wall on the
driven row. An emitter *hard-constrains* velocity every frame while a wall a
few cells away demands zero; in an open domain the fluid leaves and the target
is achievable, in a sealed one it needs a return circulation that takes many
frames to establish, so constraint and pressure fought each other.

Two problems were entangled: the driver (an interior velocity constraint is
ill-posed for a closed box — a real lid-driven cavity uses a moving *wall*), and
the collocated projection.

**The projection half is now fixed.** `tests/mac.mjs` case 4 drives a closed box
from the top row for 300 steps: finite throughout, peak divergence bounded at
8.8e-2. The scenario is still commented out because the *driver* is still an
interior constraint; rebuilt as a moving wall it should now work.

### 3. The projection is not exactly consistent — FIXED by the staggered solver

Under the collocated solver `div` was a **wide** centred stencil while the
Laplacian solved was **compact**. Their composition was not the operator being
inverted, so the projection never fully removed the divergence it measured, and
more V-cycles could make a ragged case *worse* — the residual went 5.5 → 594,
the signature of converging accurately onto the wrong operator.

**Fixed by the staggered (MAC) grid**, now the default (`ns.mac`, `app.staggered`).
Velocities live on faces, pressure at centres; divergence and gradient are exact
adjoints, verified numerically in `tests/mac.mjs` case 1. More cycles now
converge monotonically (case 3). See "Staggered solver" below.

The collocated path is still there behind the Numerics ▸ Staggered grid switch,
for comparison and as a fallback.

### 4. Boundary roles: partial

Implemented and reaching the solver: no-slip, slip, moving, rotating, porous,
inlet, outlet, symmetry. Only **porous** is quantitatively verified
(`porous.mjs`). Slip, outlet and symmetry are implemented but only lightly
tested — they need validation cases.

### 5. Free-surface water — wired and running

`Free-surface water` in the mode tabs. A tank with a surface you can watch,
water brushes to add and remove it, obstacles that float in it, and the speed
field still readable underneath. Runs at ~60 fps at 256x128.

**Switching mode sets the solver up, and it has to.** Water and airflow want
opposite settings, and every one of these was found by watching it misbehave:

| setting | why |
|---|---|
| wind tunnel OFF | an inlet forcing flow through a tank is not a tank |
| vorticity confinement 0 | it amplifies every local vorticity extremum, and the sharpest ones sit ON the surface — it feeds the interface, not a wake |
| LES off | a model of unresolved turbulence, which a smooth surface does not have |
| viscosity 0.05 | water at this resolution is otherwise near-inviscid, and an inviscid free surface never stops ringing |

**Two scaling traps, both of which pinned the peak speed on the ceiling.**

- `referenceSpeed()` sets the timestep FLOOR and the speed CAP, so it is not
  cosmetic. In a tank it must be the gravity-wave speed `sqrt(g H)`, not the
  airflow default of 2.4 — water outruns that immediately.
- **The dt floor must not apply to water at all.** Once it binds, CFL control
  stops working: the step stays too large, the advection runs past the limiter
  it is designed for, speeds grow, and the floor holds the step there. It is a
  feedback loop. Measured, CFL pinned at 2.4 with the peak on the cap; without
  the floor the same tank settles around 8.

**The water brush lays down 0.12 fill per stamp, not 0.5.** At 0.5 one stroke
saturated every cell it touched, so the brush conjured a solid block of water in
mid-air; the block free-falls and lands as a water hammer, and the peak speed
sat on the ceiling for nine seconds afterwards. Building it up over several
passes is gentler and closer to what the tool is for.

**Switching modes must restore what it changed.** Water overwrites nine
settings, and leaving them changed on the way back means the air simulation
silently behaves differently after a visit to water, with nothing on screen to
say why — reported as "the free surface affects the air one". `setPhysics`
snapshots the airflow setup on the way in and restores it on the way out.

**And the pressure stencil has to be restored too.** The finest level is rebuilt
every solve while a surface exists, because the surface moves. Nothing rebuilt
it afterwards, so airflow kept solving against a diagonal that counted air cells
nobody had any more — invisible until the pressure came out wrong. `Poisson`
now tracks whether it last built an air stencil and undoes it, at the source, so
anything that turns a surface off cannot forget. Guarded by `water.mjs`, which
probes the cell that is MADE air: a neighbour keeps a diagonal of 4 either way,
so probing beside the surface cannot tell a restored stencil from a stale one.

**Start-from presets** — still, dam break, drop — are in the Water panel. A level
tank proves the surface holds, which is the thing most easily got wrong, but it
is not much to look at.

**On the staggered solver, gravity goes on the faces.** It is the one part of
the surface that WRITES to the solver's state rather than reading from it, so
added to the cell-centred mirror it is discarded by the next refresh and the
water simply never falls. `FreeSurface.mac` mirrors `ns.mac`; `app.setStaggered`
sets both, and forgetting one is the failure. A face is accelerated when
*either* side holds water — requiring both skips the surface face itself, which
is exactly where gravity has to act.

**Water scenarios exist now** — Still tank, Dam break, Falling drop, Weir — in
`scenarios.js` with `physics: 'water'`, which both filters them out of the
airflow menu and makes `applyScenario` switch modes on the way in. `sc.water`
names a fill preset and is applied AFTER the raster, so the weir's geometry is
already solid when the water lands on it.

**Everything that advances the solver goes through `advanceNS`.** The live loop
had the `syncAir` / `preProject` / `postProject` bracket around `ns.step` and the
frame recorder called `ns.step` bare, so every exported video of a water scene
advanced the flow while the surface stood perfectly still — an export that looks
like a broken *simulation* rather than a broken *exporter*, which is why it went
unnoticed. `water.mjs` case 7 reads `main.js` as text and fails on any `ns.step`
call outside the helper.

**The fill field is saved with the project**, run-length encoded to base64 by
`encodeFill` / `decodeFill` in `freesurface.js` — a 256×128 tank comes to about
630 characters, roughly a tenth of a byte per cell, because nearly every cell is
exactly 0 or 1. The grid size travels with it and a mismatch is skipped rather
than trusted: a fill array poured into a different resolution is not
wrong-looking, it is scrambled, since the run offsets no longer line up with
rows. Physics mode and the surface are restored LAST in `restorePayload`,
because `setPhysics` resets the surface and would discard anything set before it.

### 5d. `src/flip.js` — the particle liquid solver, NOW LIVE

**Water mode runs this.** `freesurface.js` is retired and no longer imported by
`main.js`; sections 5, 5b and 5c below describe that older scheme and are kept
for the reasoning, not as a description of what runs.

**Why it exists.** The fill-fraction scheme cannot conserve mass — interpolating
a fraction and writing it back is lossy every step. Measured after every bug in
it was fixed, a tank still lost **11–24 %** of its water depending on what you
did to it, and `sharpen()` and `correctVolume()` existed only to disguise that.
It is leaky by construction, not by defect.

**What works** (`tests/flip.mjs`, 10 checks, in `npm test`):

- **Mass is exact, not approximate.** Particle count is an integer and the step
  neither creates nor destroys one, so the assertion is `===`, not a tolerance.
  22016 → 22016 over 400 steps. That test could not have been written against
  the old representation.
- Dam break runs the tank; nothing tunnels through a wall; save/load
  round-trips positions to 1/32 of a cell.
- The existing `projectMAC` is reused **unchanged** — staggered projection,
  per-region sealed handling, multigrid. `flip.js` only supplies a velocity
  field and takes one back.

**Density control needs THREE mechanisms, and each fixes what the others cannot.**
This is the part that took the measuring, and getting any one of them wrong
looks like a different bug entirely:

1. **Velocity extrapolation past the surface** (`extrapolateFaces`). G2P gathers
   from a 3x3 stencil, so a surface particle reaches faces OUTSIDE the water.
   Those get no mass from P2G and the projection skips faces with air on both
   sides, so they hold exactly zero — every surface particle had its velocity
   averaged toward zero every step. It reads as a mysteriously damped surface
   being sucked inward, and it was the hidden cause the other two were being
   over-tuned to fight.
2. **A divergence bias for bulk volume** (`updateBias`, `Flip.BIAS_K`). Crowded
   cells are given a small outflow target. **The sign is worth deriving, not
   guessing**: `div` is stored negated, so the solve gives
   `Laplacian(p) = -div_stored` and the correction leaves `D_new = D - Lap(p)`.
   Writing `div_stored = -D + bias` gives `D_new = +bias`, which is outflow.
   Subtracting instead sucks particles *into* the cells already too full — the
   pool compacted into the bottom seven rows and stopped dead, and it looks like
   gravity, not like a sign error.
3. **Population rebalancing** (`rebalance`). A divergence source is a smooth,
   grid-scale instrument; clumping is local. With the bias alone, cells held
   27–76 parcels against a target of 4 however it was tuned. Capping the
   population fixed it outright.

**Rebalancing MOVES parcels, it does not delete them.** Deleting the excess was
tried first and passes every quiet test: a dam break then compresses at the
impact, many cells cross the cap in one step, and the thinning takes the water
with it — 11480 parcels down to 2178, an **81 % loss**, while a still pool
looked perfect. Mass conservation that holds only when nothing is happening is
not mass conservation. A parcel with nowhere to go now simply stays put.

**Measured, 400 steps on a settled tank:** volume exact (22016 → 22016 parcels),
surface drift 1.0 row, occupied volume −1.3 %, densest cell 11 against a target
of 4. `BIAS_K` 0.6 is a balance point, not a floor: 0.25 sinks the tank 4.2 rows,
0.8 raises it 1.1.

**Still imperfect:** a settled pool retains a residual peak speed of about 12
against a gravity-wave speed of 20 — it shimmers rather than sitting still.
Recorded, not asserted away, in `tests/flip.mjs` case 6.

**A position-redistribution pass was tried and removed.** Pushing particles down
the density gradient after advection is what some production solvers do; here it
made compression *worse*. It is in the git history, not in the file. Diagnose
why before re-adding it.

**Water pins the staggered grid on.** P2G and G2P transfer to and from faces, so
the collocated path has nowhere to put the momentum. `app.setStaggered` forces
it in water mode rather than letting the toggle produce a silently dead
simulation.

### 5c. Water + drawn solids — the blow-up, and what it actually was

Reported as "liquid and when drawing solids still gives a lot of bugs ... it
still blows up to super high speed", with a tank shattered into flying blobs and
the legend reading **258** against a ceiling of 182. Three separate faults, none
of them in the solver:

**1. The volume target did not track the geometry.** Drawing a solid destroys
the water in those cells — correctly, it is inside a wall now — but
`targetVolume` still counted it, so the target became permanently unreachable
and `correctVolume` pumped water into every surface cell **every step, forever**.
Mass appearing at the surface under gravity is an energy source. The water was
not exploding, it was being inflated. Measured: drawing a lid on a settled tank
took the peak from 2.7 to the ceiling; re-baselining the target left it at 3.5.
`FreeSurface.syncGeometry()` now does that, called from `app.reraster()`.

**2. Water sealed away from air evaporated.** Incompressible water in a rigid
container with no air in it *cannot move* — no free surface to deform, nowhere
to go. The solver could not express that: a sealed pocket is all-Neumann and
singular, and the moment one cell fell below `FULL` it was reclassified as air,
whose Dirichlet p = 0 emptied its neighbours in a cascade. All 578 cells of a
boxed-in pocket evaporated within fifty steps, and the collapse drove the peak
to the ceiling. `markSealed()` flood-fills outward from air; anything unreached
is frozen — velocity zeroed, fraction held across advect/sharpen/correctVolume.
Physically correct **and** unconditionally stable. `Poisson.classifyRegions`
additionally makes the sealed subsystem well-posed per region rather than by one
global `hasAir` test, which was right only when every region was alike.

**3. The reported speed could exceed the ceiling by 41 %.** The face clamp bounds
each velocity COMPONENT, so both on the limit reconstructs `cap*sqrt(2)` — which
is precisely 182 → 258. `Grid.refreshCentred(cap)` now applies a hard magnitude
clamp to the published mirror. **That is the guarantee**: the colour scale, the
legend, the probe, the diagnostics and the particles all read that array, so no
part of the app can report or act on a speed above the cap whatever happens
upstream, and a NaN becomes a zero instead of spreading. The water cap also came
down from 8x to 3x the gravity-wave speed — free fall from the top of a tank is
only 1.4x, so 3x is real headroom and a spike now saturates somewhere plausible.

Guarded by `water.mjs` cases 8, 9 and 10; case 10 drives the field with absurd
impulses for 200 steps and asserts the published peak never exceeds the cap.

**What is still not fixed.** Painting a lot of water into mid-air and letting it
fall can still saturate the ceiling on impact. Traced: the peak lives in cells
with fill 0.56–0.67 — a cell 56 % full counts as FULL and takes the pressure
impulse sized for a brimming one, so it over-accelerates, and the count above
50 went 0 → 197 in two steps. A cascade through the interface, not a water
hammer. The real cure weights momentum by the fraction (or a ghost-fluid
condition at the surface); both are a different solver.

**An interface limiter was tried for it and reverted.** Damping a sliver toward
the surrounding water fixed the brush cases (158 → 34) and cost 10.7 % of the
volume, because it modifies the velocity *after* the projection and a divergent
field does not conserve the fraction it advects. Bounded saturation beats
silent mass loss. Do not re-add it without solving that first.

**Still to do:** the surface carries some cell-scale ripple that a proper VOF or
level set would not, and there is no wave-maker yet.

### 5b. Free-surface internals — core notes

`src/freesurface.js` plus the air-mask support in `grid.js` / `ns.js`. Verified
in `water.mjs`: a pool stays flat and holds its level, a dam break collapses and
runs the full length of the tank, a dropped blob falls and stays coherent.

**The air is not simulated.** To water, air is very nearly a constant-pressure
vacuum, and pretending otherwise means resolving a density ratio of 1000 across
one cell — a different and much harder problem, which is what the still-disabled
"coupled air–water" tab would be.

Three things cost time and are worth knowing before extending it:

- **Air is Dirichlet, solid is Neumann, and that single difference is the whole
  feature.** A solid neighbour is EXCLUDED from the pressure stencil (zero
  normal gradient); an air neighbour is KEPT in it holding p = 0. Get that
  backwards and the water sits under an invisible lid. `countNeighbours` takes
  an optional air mask for exactly this, and `removeRegionMeans` is skipped when
  air is present — the Dirichlet pins the datum, so removing the mean would
  destroy it.
- **The residual must be zero wherever the smoother does not run.** That test
  was `solid[idx]`, which misses air cells; their garbage residual was restricted
  onto the coarse grid and prolongated back into the water. Symptom: 90% of the
  water vanished in 200 steps. It is now `solid || nf === 0`.
- **Advecting a fraction diffuses the interface, and second order is not
  enough.** MacCormack alone still left a dropped blob spread over twice its
  area at half density with no cell above half full — volume conserved, water
  gone. An artificial compression step (`sharpen`, the interFoam idea) fixes it.
  A real cure reconstructs the interface geometrically (VOF/PLIC) or tracks a
  signed distance; both are much more code.

**Still to do:** wire it to the Free-surface water mode tab — a scenario set, a
render mode that draws the surface, and the brush tools acting on `fill`.

### 6. Not built

- DXF / PNG-mask import (item 23)
- ~~WebGPU backend (item 33)~~ — **built**, see "Renderer backends" below.
- Free-surface water and coupled air–water. Mode tabs exist, disabled, with
  explanations on hover.
- Live editing while the solver runs (item 24). Edit mode currently pauses.

---

## 5. Things already tried that did not work

Do not repeat these without reading why they failed.

**Rhie–Chow momentum interpolation** (for limitation 3). Added
`(wide − compact) Laplacian of previous pressure` to the right-hand side. At
full strength it is a positive feedback loop — the closed case failed three
times sooner (48 → 16 frames). Would need heavy under-relaxation and probably
outer iteration.

**"Minimal MAC": staggered projection, cell-centred transport.** Interpolate
cell → face, project on faces, interpolate back. It *worked* as theory
predicts — divergence halved, 0.324 % → 0.171 %. But the round trip
`u → uf → u` composes to `(u[i−1] + 2u[i] + u[i+1]) / 4`, a low-pass filter
applied twice per step. It smoothed away the vorticity it existed to protect:
**cylinder Cd 1.25 → 0.59, shedding amplitude 0.90 → 0.10.** Reverted.
**A real MAC solver must keep transport on faces too.** That is the whole job,
not a shortcut.

→ **Done properly, it works.** See "Staggered solver" below. The rule that made
the difference: the faces are the state, and nothing interpolates the state back
into the solver. The mirror is one-way.

**Coarse-grid null-space deflation.** Coarse multigrid levels solved singular
all-Neumann systems with nothing removing the constant. Real bug, genuinely
fixed, still in place (`Poisson.smooth(..., deflate)` at the coarsest level
only — doing it at every level costs two full passes per level per cycle).
Doubled time-to-divergence for the cavity but did not fix it.

**Cross-region pressure mirroring.** Walls separating two disconnected fluid
regions were averaging pressure across them, comparing two independently
removed datums. Real bug, fixed (pressure is now reflected per cell in the
gradient, never read across a wall). Did not fix the cavity.

**Driving the lid-driven cavity with emitters instead of a moving wall.**
Same failure, same frame count. The driver mechanism is not the difference.

**A fully rigorous viscous traction, `-∫ μ(∇u + ∇uᵀ)·∇χ`.** The theoretically
correct companion to the coverage-weighted pressure integral, and it is wrong
here for a concrete reason: it evaluates strain with centred differences, and
across a wall — where u jumps from the fluid value to zero in one cell — a
centred difference **halves** the gradient. Skin friction came out at 0.094
against the staircase's 0.300 where the geometry alone justifies 0.236. The
half-cell one-sided estimate that was already in place is the better model on
this grid; only its *area* was wrong, so only the area is corrected. Revisit
this if the boundary layer is ever resolved over several cells.

---

## 6. Recording

`recorder.js` steps the solver a **fixed** amount per output frame, renders,
and captures. It does not record the realtime loop — a 60 fps file is 60 fps
of smooth motion whether the machine ran at 120 fps or 18.

- Encoders: WebCodecs → MediaRecorder → PNG sequence (a real stored-ZIP
  writer), selected by capability with automatic fallthrough.
- **Resolution is independent of the viewport.** Output size is taken from the
  *domain* aspect, up to 8K. During capture the canvas backing store is
  resized while CSS size is left alone, so the browser downscales for display
  and **the viewport becomes a live preview of the actual frames**.
- The recorder yields to the browser once per frame (`yieldFrame`), which is
  what makes the preview update and the cancel button responsive.
- **No GIF.** 256 colours reproduces a continuous field badly and the files
  dwarf an equivalent WebM. PNG sequence is offered instead.

### Both video formats are frame-exact — do not route either to MediaRecorder

This is the most important thing in this section. **MediaRecorder timestamps by
the wall clock**, so it cannot produce an offline render. `captureStream(0)` plus
`track.requestFrame()` looks like it fixes that, and the code used to carry a
comment claiming it did — it does not. `requestFrame` decides *when* a frame is
captured; MediaRecorder still stamps whatever arrives with real time. A frame
that took 50 ms to render becomes a 50 ms frame in the file.

Measured, 60 frames at 30 fps with a deliberate 90 ms stall every tenth frame
(`tests/capture-timing.py`):

| path | render took | file duration |
|---|---|---|
| MediaRecorder | 3.03 s | **2.865 s** |
| MP4 via `mp4.js` | 1.02 s | **2.000 s** |
| WebM via `webm.js` | 0.99 s | **2.000 s** |

The intended duration is 2.000 s. MediaRecorder tracked how long rendering took
— exports stuttered wherever the machine did, which is exactly what "it seems to
be recording the screen" means. And WebM is the DEFAULT format in
`app.recordSpec`, so this was the common path, not an edge case.

Both formats are now muxed from WebCodecs output. MediaRecorder remains only as
a fallback for browsers with no WebCodecs at all, and its wall-clock behaviour
is noted at the call site so nobody re-routes to it for convenience.

**A related, smaller fix in the same area.** `dtFor` used to re-derive the
capture's timestep from the instantaneous peak speed on every frame, the way the
realtime loop does. Frames were evenly spaced in *time* but each advanced the
simulation by a different amount. Measured on a settled wake the spread was only
~1.2 % — too small to see, so this was **not** the reported stutter — but it is
wrong in principle and would show badly on a starting flow or right after a body
is added. `captureStep()` now fixes the step for the whole capture and
`subSteps()` absorbs stability into step COUNT. Both live in `recorder.js` and
are unit-tested; `rec.mjs` previously drove the Recorder with a constant stub
`dtFor` and asserted "every step used the same dt", which proved only that the
loop passed a constant through.

**MP4 is properly contained.** The WebCodecs path used to write its
elementary stream straight to a `.mp4` — valid H.264, no boxes, and no player
would open it. `src/mp4.js` wraps it: `ftyp` / `mdat` / `moov`, with `mdat`
written first so sample offsets are known in one pass. Two things to know if
you touch it:

- the encoder **must** be configured `avc: { format: 'avc' }`. Annex-B start
  codes produce a file that looks structurally fine and decodes to garbage,
  because `avcC` describes length-prefixed AVCC and nothing checks;
- `metadata.decoderConfig.description` arrives once, with the first chunk, and
  IS the AVCDecoderConfigurationRecord. Miss it and there is nothing to put in
  the sample description. The muxer throws rather than emit a broken file, and
  the recorder falls back to a format that plays.

`src/webm.js` does the same job for VP9: EBML header, Segment, Info, Tracks,
one Cluster per keyframe, Cues. Block timestamps are a **signed 16-bit** offset
from their cluster's, which is why clusters break on keyframes instead of the
file being one long cluster — past ~32.7 s that would overflow. Frame times come
from the frame index rather than being accumulated, so millisecond rounding
cannot drift over a long capture.

`tests/mp4.mjs` and `tests/webm.mjs` check the container trees; the `-play.py`
pair are the ones that matter, since they encode real frames, mux, and make
Chrome demux, seek and decode the result. Structure tests alone would have
passed on the old broken output too — it was well-formed bytes in the wrong
shape. `tests/capture-timing.py` guards the wall-clock regression above.

### The 30-second high-resolution target

At 4K/30fps that is 900 frames of 8.3 MP. The field shader evaluates per
output pixel, so those frames are genuinely sharp — but the *physical* detail
is bounded by the grid. The panel now says which limit you are against
(`recordDetail()` reports pixels-per-cell and warns when the grid, not the
resolution, is the constraint). For genuinely detailed 4K, raise the grid to
384×192 or higher **and** the render height.

Solver cost is roughly 10 ms/frame at 256×128 and 40 ms at 384×192, so a
900-frame render is a few minutes — acceptable offline, which is exactly why
capture is decoupled from realtime.

---

## 7. Roadmap as it stands

Agreed order, after SVG import / analysis / MP4 landed:

1. **UI and options pass** — *first round done.* An interaction audit driving
   every menu, tab and tool button in a real browser now comes back clean: nine
   property tabs all build, eighteen tool buttons all respond, no console
   errors. What changed:
   - the global `[hidden]` rule, which fixed collapsing property groups and
     status-bar field visibility (see section 1);
   - `Overlays.label()` — a theme-aware halo, so readouts on the field stay
     legible over any colormap and in both themes;
   - a shared left rule for labels: `.sf-l` and `.cf` were 9px left of every
     `.nf-l` in the same group, giving the panel a ragged edge;
   - bounded number fields now show a proportional fill, so a value's position
     in its range is visible without dragging. Bipolar ranges fill out from
     zero — a buoyancy of 0 filling half the track read as "half of something";
   - the stage matte sits below the panel greys with the canvas shadowed onto
     it, so the letterboxing round a fixed-aspect domain reads as a mount.

   The tab strip now carries hairline separators splitting it into setup /
   geometry / output, plus the accent underline and the title below it. Nine
   unlabelled glyphs is still the weakest affordance in the interface; labels or
   a wider strip would be the next step.

   The keyboard help is **generated** from the `TOOLS` array (`buildHelp` in
   `shell.js`) rather than written out. The hand-written version had drifted to
   the point of being wrong: it listed none of the eleven tool shortcuts and
   claimed W toggled the wind tunnel long after W had become Add water.

   Two shortcuts were dead and are now live. `R` and `W` are claimed by both a
   global action and a tool, and the global switch returned unconditionally — so
   the toolbar advertised "(R)" for Rectangle and "(W)" for Add water while
   neither key did any such thing. Each now falls through to the tool dispatch
   when the global action does not apply: rotate needs a selection, and a tank
   has no wind tunnel.
2. ~~**WebGPU backend**~~ — **done**. See "Renderer backends" in section 3.
3. ~~**Free-surface water**~~ — **done and wired**, with scenarios. See section 4.5.

### Interaction: brushes

The push tool takes a **Swirl** modifier (0 = drive along the stroke, 1 = drive
every cell around the brush centre) with a rotation direction. The tangential
profile is solid-body inside half the radius and falls off outside it — a 1/r
profile would put unbounded speed at the centre and one cell would carry the
whole impulse. Holding still keeps winding it, because the push tool is
otherwise movement-driven and a vortex is made by dwelling. Verified to produce
a Rankine vortex with a low-pressure core; circulation survives 120 free frames
after the brush stops.

Tracer count is a live control (**View ▸ Overlays ▸ Density**). Drawing them
costs ~2 ms a frame at full density on a 2400×1200 canvas, in proportion to how
many there are — that is the lever when the frame budget is tight. Colour mode
no longer changes the cost: trails are bucketed by bin with a counting sort and
each bin's path is built once and stroked twice (dark casing, then colour),
which cut path operations from 58k to 35k a frame and removed the per-mode
penalty that made vorticity the expensive one.

Particle visualisation was reworked alongside this — tracers are coloured by a
scalar array rather than by index, following ParaView's Lagrangian workflow for
OpenFOAM clouds. `docs/particles-plan.md` has the research and the staged plan;
stages 2-5 (a tracer legend, size/opacity channels, placeable seeds, and
streaklines as distinct from pathlines) are scoped but unbuilt.

The solver work in section 4 is orthogonal to all three and can be picked up
whenever the numbers matter more than the interface.

### What the refinement pass changed, in one list

Correctness, all of them silently wrong rather than visibly broken:

- **The frame recorder ignored the free surface.** Every exported video of a
  water scene had a frozen surface over a moving flow. Both call sites now go
  through `advanceNS`, and `water.mjs` case 7 fails on a third appearing.
- **Projects did not save the water.** `physics` and the fill field are now in
  the payload; see section 4.5.
- **Cd / Cl / Re / St were reported in water mode**, where they normalise by a
  free-stream speed that a tank does not have. Replaced with volume drift and
  Froude number, in the status bar and in Ctrl+I, and the Copy button matches.
- **`R` and `W` did nothing** despite the toolbar advertising them.
- **`t1` aliasing in the staggered step** — see "Staggered solver".

The solver rewrite, its measurements and its remaining failure mode are under
"Staggered solver" in section 3. Polish is under item 1 of the roadmap.

## 8. If you only do one thing

**Carry coverage into the solver.** Item 15 is half done: the force *integral*
is coverage-weighted (limitation 1), but the *flow* still sees a binary
staircase. `grid.coverage` is now populated on every raster and read by exactly
one consumer, so the input is already plumbed through and unused everywhere
else.

This is now the single highest-value piece of solver work, and the staggered
rewrite sharpened the case for it rather than replacing it. Staggering fixed the
*projection* — drag in the shedding regime went from 20–30 % low to roughly in
band, and it now converges under mesh refinement instead of away from it — but it
also made the remaining error more clearly geometric: the steady-regime drag got
*worse* (Re 20: 2.13 → 1.69), which is what you would expect when a more accurate
pressure gradient is applied to a body whose shape the solver still sees as a
staircase. A cut-cell treatment addresses exactly that, and on a staggered grid it
is more natural to express, because a fractional face area is a property of a
face and faces are now where the unknowns live.

Two places want it:

- **The Poisson stencil.** `Poisson.countNeighbours` counts whole fluid
  neighbours (`nf` = 0…4). A cut cell should contribute a *fractional* face
  area, which turns the diagonal into a real number and makes the pressure
  solve see the body's actual shape.
- **The wall BC.** `applySolidBC` sets u = 0 in any cell over half covered. A
  60 %-covered cell should retain 40 % of its velocity, not lose all of it —
  this is what currently moves the effective wall by up to half a cell.

Do it **in that order and measure between them**, and re-run `npm run validate`
against the table in section 3. Note the warning in section 5: a change that is
theoretically correct can still lose more than it gains on a grid this coarse.
The minimal-MAC attempt halved the divergence and destroyed the vorticity; the
rigorous viscous traction is exact in the continuum and halves the wall
gradient here. **Both looked right on paper.** `forces.mjs` is the pattern that
catches this — test against an analytic field, where the answer is known.

**Keep using the browser.** Playwright is already installed and the smoke test
in section 3 now runs — extend it to drive the tools through real pointer
events, which is where the stub-DOM tests are weakest.
