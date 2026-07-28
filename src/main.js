import { Grid } from './grid.js';
import { NavierStokes } from './ns.js';
import { LatticeBoltzmann } from './lbm.js';
import { Diagnostics } from './diagnostics.js';
import { Particles } from './particles.js';
import { GLRenderer, MODES } from './render-gl.js';
import { GPURenderer } from './render-gpu.js';
import { Canvas2DRenderer } from './render-2d.js';
import { Overlays } from './overlays.js';
import { PALETTE, MAPS } from './colormaps.js';
import { SCENARIOS, SCENARIO_BY_ID } from './scenarios.js';
import { Scene, Shapes, BOUNDARIES } from './scene.js';
import { Raster } from './raster.js';
import { History } from './history.js';
import * as T from './transform.js';
import { buildShell, modal, promptName, pickProject } from './shell.js';
import { el, selectField, numberField, button } from './ui/widgets.js';
import * as Projects from './projects.js';
import { Recorder, FORMATS as RECORD_FORMATS, capabilities as Recorder_capabilities,
         captureStep, subSteps } from './recorder.js';
import { importSVG } from './svg.js';
import { parseSTL, sliceToScene, planeAxes, AXES } from './stl.js';
import { Flip, FULL } from './flip.js';

const THEMES = {
  dark: {
    name: 'dark', light: false,
    bg: [0.114, 0.114, 0.114], body: [0.58, 0.59, 0.60],
    text: 'rgba(232,236,241,0.94)', textDim: 'rgba(150,158,170,0.78)',
    // Outline drawn behind overlay text and rules that sit directly on the
    // field. It must OPPOSE `text`, not match the chrome: the field is whatever
    // colour the colormap produces, and a halo the same tone as the text it
    // surrounds provides no contrast at all.
    halo: 'rgba(0,0,0,0.66)',
    panelBg: 'rgba(24,26,29,0.90)', panelLine: 'rgba(255,255,255,0.14)',
    vector: 'rgba(232,238,245,0.45)',
    stream: a => `rgba(232,238,245,${a})`,
    contour: 'rgba(232,238,245,0.22)',
    probeLine: 'rgba(255,255,255,0.45)', probeArrow: 'rgba(237,158,92,0.92)',
    drag: 'rgba(214,104,94,0.94)', lift: 'rgba(104,164,208,0.94)',
    selected: 'rgba(237,158,92,0.95)', objectEdge: 'rgba(255,255,255,0.30)',
    lockedEdge: 'rgba(255,255,255,0.14)',
    gizmo: 'rgba(71,114,179,0.95)', gizmoFill: 'rgba(24,26,29,0.9)',
  },
  light: {
    name: 'light', light: true,
    bg: [0.910, 0.910, 0.910], body: [0.30, 0.30, 0.29],
    text: 'rgba(28,30,34,0.94)', textDim: 'rgba(88,94,102,0.78)',
    halo: 'rgba(255,255,255,0.82)',
    panelBg: 'rgba(250,250,250,0.92)', panelLine: 'rgba(0,0,0,0.18)',
    vector: 'rgba(28,30,34,0.42)',
    stream: a => `rgba(20,22,26,${a})`,
    contour: 'rgba(20,22,26,0.24)',
    probeLine: 'rgba(0,0,0,0.45)', probeArrow: 'rgba(178,106,32,0.92)',
    drag: 'rgba(166,58,50,0.94)', lift: 'rgba(46,102,150,0.94)',
    selected: 'rgba(178,106,32,0.95)', objectEdge: 'rgba(0,0,0,0.35)',
    lockedEdge: 'rgba(0,0,0,0.16)',
    gizmo: 'rgba(59,110,168,0.95)', gizmoFill: 'rgba(250,250,250,0.92)',
  },
};

const GRIDS = {
  '192x96': [192, 96], '256x128': [256, 128],
  '320x160': [320, 160], '384x192': [384, 192],
};

const FLUIDS = {
  air:        { visc: 0.006, diff: 0.0,   vort: 1.0, fade: 0.994 },
  water:      { visc: 0.030, diff: 0.004, vort: 0.6, fade: 0.997 },
  glycerine:  { visc: 0.220, diff: 0.010, vort: 0.0, fade: 0.999 },
  smoke:      { visc: 0.004, diff: 0.020, vort: 1.4, fade: 0.985 },
  superfluid: { visc: 0.0,   diff: 0.0,   vort: 2.0, fade: 0.999 },
};

const stage = document.getElementById('stage');
let fieldCanvas = document.getElementById('field');
const fxCanvas = document.getElementById('fx');
const helpBox = document.getElementById('help');
const toastBox = document.getElementById('toast');

let layout = { w: 0, h: 0, dpr: 1, sx: 1, sy: 1 };
let shell = null;
let toastTimer = 0;

export const RENDER_BACKENDS = [
  { value: 'webgl2', label: 'WebGL 2  (default)' },
  { value: 'webgpu', label: 'WebGPU  (experimental)' },
];

const app = {
  GRIDS, FLUIDS, SCENARIOS, RENDER_BACKENDS,

  grid: null, ns: null, lbm: null, diag: null, parts: null,
  scene: null, raster: null, history: null,
  renderer: null, overlays: null,

  // Legacy scenario geometry lives beside the scene until the built-in
  // scenarios are rebuilt as scene objects. Both feed one merged mask, so the
  // solver still sees a single source of truth.
  draft: null,                // in-progress drawing, not yet a scene object

  solver: 'ns',
  mode: 'speed',              // which field the colour map shows
  mode2: 'simulate',          // Edit | Simulate
  tool: 'paint',
  gridKey: '256x128',
  fluid: 'air',
  themeName: 'dark',
  // Read at boot before any getContext; see setupRenderer.
  backendPref: (() => {
    try { return localStorage.getItem('hyperfoam-backend') === 'webgpu' ? 'webgpu' : 'webgl2'; }
    catch { return 'webgl2'; }
  })(),
  theme: THEMES.dark,

  windTunnel: true,
  running: true,
  speed: 1.0,
  targetCFL: 1.0,
  windSpeed: 120,
  physics: 'air',        // 'air' | 'water'
  staggered: true,       // MAC face velocities; see NavierStokes.mac
  waterFill: 0.45,       // starting depth as a fraction of the domain
  brush: 14,
  particleDensity: 1,
  swirl: 0,          // 0 = straight push, 1 = pure rotation
  swirlDir: 1,       // +1 clockwise on screen
  brushHintUntil: 0,       // show the numeric radius until this timestamp
  force: 90,
  soundSpeed: 1.0,
  snapGrid: false,
  snapStep: 1,

  showVectors: false, showStreamlines: false, showContours: false,
  showParticles: false, dyeOverlay: false, showGizmos: true,

  scenario: null,
  inlets: [],
  inletColour: 0, paintColour: 0,
  projectName: 'untitled',
  dirty: false,

  fps: 60, frameMs: 0, _fpsT: 0, _fpsN: 0, frame: 0, dt: 0.05,
  norm: { speed: 1, press: 0.01, curl: 0.01, grad: 0.001, q: 0.001 },
  probe: { i: -1, j: -1 },
  pointer: { down: false, over: false, x: 0, y: 0, px: 0, py: 0, startX: 0, startY: 0, mode: null, handle: null },
  operator: null,             // modal G / R / S state
};

/* ── setup ────────────────────────────────────────────────────────────── */

/* Renderer selection: WebGL2 by default, WebGPU on request.
 *
 * WebGPU is NOT the automatic choice even where it works. The audience includes
 * managed school devices, whose WebGPU coverage is materially worse than their
 * WebGL2 coverage, and a workbench that fails to start is worse than one using
 * an older API to draw an identical picture. So the preference is opt-in,
 * remembered, and falls back silently if the device cannot honour it.
 *
 * A canvas can only ever have ONE context type. Asking for 'webgpu' after
 * 'webgl2' on the same element returns null forever, so the backend has to be
 * decided before the first getContext — which is why this runs before anything
 * else in boot and why a switch reloads rather than swapping in place.
 */

async function setupRenderer() {
  app.overlays = new Overlays(fxCanvas);
  let r = null;

  if (app.backendPref === 'webgpu') {
    r = await GPURenderer.create(fieldCanvas);
    if (!r) {
      toast('WebGPU is not available here — using WebGL 2.', 'warn');
      // The canvas is spent: a failed 'webgpu' getContext still claims it.
      // Replace the element so WebGL2 gets a clean one.
      fieldCanvas = swapCanvas(fieldCanvas);
    }
  }
  if (!r) r = GLRenderer.create(fieldCanvas);
  app.renderer = r || new Canvas2DRenderer(fieldCanvas);
  if (!r) document.getElementById('backend-warn').hidden = false;
}

/* Replace a canvas with a fresh one of the same id and geometry. */
function swapCanvas(old) {
  const next = old.cloneNode(false);
  old.replaceWith(next);
  return next;
}

function buildSimulation(key) {
  const [nx, ny] = GRIDS[key];
  const grid = new Grid(nx, ny);
  app.grid = grid;
  app.ns = new NavierStokes(grid);
  app.lbm = new LatticeBoltzmann(grid);
  app.diag = new Diagnostics(grid);
  app.water = new Flip(grid);
  app.setStaggered(app.staggered);
  app.parts = new Particles(grid, PALETTE, Math.min(1600, nx * 6), 14);
  app.parts.seed(app.windTunnel);

  if (!app.scene) {
    app.scene = new Scene(nx, ny);
    app.history = new History(app.scene);
  } else {
    app.scene.nx = nx; app.scene.ny = ny; app.scene.revision++;
  }
  app.raster = new Raster(nx, ny);
  applyFluid(app.fluid);
  app.sync();
}

/* Switch between the staggered and collocated solvers.
 *
 * The surface has to be told as well: gravity is the one part of it that writes
 * to the solver's state rather than reading from it, so it needs to know where
 * that state lives. Everything else in the app — renderers, particles,
 * overlays, the force integration — reads the cell-centred mirror and cannot
 * tell the two apart.
 *
 * Changing this mid-run changes which arrays are authoritative, so the flow is
 * reseeded rather than reinterpreted; carrying a half-converted field across
 * the switch would look like an instability and be blamed on the new solver. */
app.setStaggered = function (on) {
  app.staggered = !!on;
  /* Water has no choice about this. The particle solver transfers momentum to
   * and from FACES — that is what P2G and G2P mean — so the collocated path
   * simply has nowhere to put it. Rather than let the toggle produce a silently
   * dead simulation, water mode pins it on; the switch still works in airflow,
   * which is where the comparison is meaningful. */
  const forced = app.physics === 'water';
  if (app.ns) app.ns.mac = app.staggered || forced;
  if (app.water) app.water.mac = true;
};

function applyFluid(name) {
  const f = FLUIDS[name];
  if (!f) return;
  app.fluid = name;
  app.ns.visc = f.visc; app.ns.diff = f.diff;
  app.ns.vorticity = f.vort; app.ns.dyeFade = f.fade;
  app.lbm.tau = Math.min(1.6, Math.max(0.52, 3 * (f.visc * 0.06) + 0.5));
  shell?.props.invalidate('physics');
  shell?.props.invalidate('numerics');
}
app.applyFluid = applyFluid;

app.sync = function sync() {
  const { ns, lbm } = app;
  ns.windTunnel = app.windTunnel;
  lbm.windTunnel = app.windTunnel;
  app.grid.openX = app.windTunnel;
  ns.inletSpeed = app.windSpeed / 50;
  lbm.inletSpeed = Math.min(0.16, app.windSpeed / 1400);
  /* A splash legitimately outruns the wave speed, but not by twenty-five
   * times — that multiplier is calibrated for an airflow scenario where the
   * reference IS the flow. Eight is loose enough for a real impact and tight
   * enough that a water hammer saturates instead of dominating the field. */
  /* The ceiling, in multiples of the reference speed.
   *
   * Airflow keeps a generous 25x: a channel squeezed by geometry legitimately
   * demands a large multiple of the inlet by continuity alone, and clipping
   * that would be clipping physics.
   *
   * Water gets 3x, down from 8x. The fastest thing that can happen in a tank is
   * free fall from the top, which is sqrt(2gH) — about 1.4x the gravity-wave
   * speed the reference is built from — so 3x is real headroom for a splash and
   * still far below the old limit. It matters because the cap is what a user
   * SEES when anything does go wrong: the reported peak was 258 against a
   * ceiling of 182, which reads as a simulation that has exploded. Bounded at
   * three times the wave speed, a numerical spike saturates somewhere plausible
   * instead of somewhere alarming. */
  ns.speedCap = referenceSpeed() * (app.physics === 'water' ? 3 : 25);
};

/* The speed the whole experiment is scaled against.
 *
 * It sets the timestep FLOOR and the speed ceiling, so getting it wrong does
 * not merely mislabel things — it breaks the CFL control. In a tunnel it is the
 * inlet speed, which is the obvious answer.
 *
 * In a tank it is NOT the airflow default. Water accelerates under gravity to
 * speeds an air scenario never reaches, and with 2.4 as the yardstick the
 * timestep floor pinned CFL at 2.4 (the advection is designed for ~1) while the
 * ceiling clamped at 60 — measured, the surface chattered and the peak speed sat
 * on the cap. The natural scale for a free surface is the gravity-wave speed
 * sqrt(g H), which is what actually propagates across a tank of depth H.
 */
function referenceSpeed() {
  if (app.solver === 'lbm') return Math.max(0.02, app.lbm.inletSpeed);
  if (app.physics === 'water') {
    const depth = Math.max(4, app.grid.ny * app.waterFill);
    return Math.max(2.4, Math.sqrt(Math.max(0.1, app.water.gravity) * depth));
  }
  return app.windTunnel ? Math.max(0.4, app.ns.inletSpeed) : 2.4;
}

/* ── geometry ─────────────────────────────────────────────────────────── */

/* Rebuild the solver's masks from the scene. The scene is the only producer —
 * scenarios, drawn shapes and paint layers all go through it, so there is one
 * place where geometry comes from and one place it can be wrong. */
app.reraster = function reraster() {
  app.raster.build(app.scene, { force: true });
  app.raster.applyTo(app.grid, referenceSpeed());
  app.ns.onGeometryChanged();
  /* The surface has to be told the domain changed.
   *
   * Water inside cells that just became solid is gone, and a volume target that
   * still counts it is unreachable — which turns the volume correction into a
   * permanent mass source pumping water in every step. That is what "drawing
   * solids in water blows up" was. See FreeSurface.syncGeometry. */
  if (app.physics === 'water') app.water.syncGeometry();
  // Averaged coefficients describe a body. Change the body and the samples
  // taken before it are not a longer average of the same thing, they are a
  // different experiment — and the pressure transient just after a shape
  // appears is large enough to dominate the mean for hundreds of frames.
  app.diag.resetStats();
  app.renderer.markGeometryDirty();
  rebuildEmitters();
  app.dirty = true;
  shell?.props.invalidate('scene');
};

/* Emitters are scene objects whose boundary role is `inlet`. */
function rebuildEmitters() {
  const out = [];
  let n = 0;
  for (const o of app.scene.objects) {
    if (!o.visible || o.boundary !== 'inlet') continue;
    const b = T.bounds(o);
    const r = Math.max(2, Math.round(Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2));
    const a = (o.bcParams.direction || 0) * Math.PI / 180;
    const spd = o.bcParams.speed ?? 1;
    const col = PALETTE[(o.bcParams.colour ?? n++) % PALETTE.length];
    out.push({
      i: Math.round(o.transform.x), j: Math.round(o.transform.y),
      ux: Math.cos(a) * spd, uy: Math.sin(a) * spd,
      radius: r, strength: o.bcParams.strength ?? 14,
      col, cr: col[0] / 255, cg: col[1] / 255, cb: col[2] / 255,
    });
  }
  app.inlets = out;
}

/* The freehand paint layer, created on first use. Kept as a scene object so
 * painting is undoable, hideable and saved like anything else. */
function sketchLayer(create = true) {
  let layer = app.scene.objects.find(o => o.type === 'sketch');
  if (!layer && create) {
    layer = Shapes.sketch(app.grid.nx, app.grid.ny, { name: 'Sketch' });
    app.scene.add(layer, 0);              // below drawn shapes
  }
  return layer || null;
}

app.rasterStats = () => app.raster.stats();

app.commitScene = function (label, key = null) {
  app.history.commit(label, key);
  app.dirty = true;
};

function resetFlow() {
  app.sync();
  app.grid.clearFlow();
  app.grid.clearDye();
  app.ns.seedFreestream();
  app.lbm.reset();
  app.diag.resetShedding();
  app.norm = { speed: 1, press: 0.01, curl: 0.01, grad: 0.001, q: 0.001 };
  app.parts.seed(app.windTunnel);
}
app.resetFlow = resetFlow;

app.clearAll = function () {
  app.scene.clear();
  app.scenario = null;
  app.commitScene('clear scene');
  app.reraster();
  resetFlow();
  app.onSelectionChanged();
  toast('Scene cleared');
};

app.applyScenario = function (id) {
  const sc = SCENARIO_BY_ID[id];
  app.scene.clear();

  if (!sc) {
    app.scenario = null;
    app.commitScene('clear scenario');
    app.reraster(); resetFlow();
    app.onSelectionChanged();
    shell?.props.invalidate('scene');
    return;
  }

  /* Physics mode first, because `setPhysics` rewrites nine solver settings,
   * clears the scenario and resets the surface — everything below would be
   * undone by it. It no-ops when the mode is already right. */
  app.setPhysics(sc.physics === 'water' ? 'water' : 'air');

  for (const o of sc.objects(app.grid.nx, app.grid.ny, { aoa: sc.aoa })) app.scene.add(o);

  if (app.windTunnel !== sc.wind) {
    app.windTunnel = sc.wind;
    app.sync();
  }
  app.scenario = sc;
  app.history.reset(`scenario: ${sc.label}`);
  app.reraster();
  resetFlow();
  /* The fill goes in AFTER the raster, so a preset can be carved by the scene's
   * own geometry — the weir is a scene rectangle, and water laid down before it
   * existed would be sitting inside a solid. */
  if (sc.water) {
    app.water.preset(sc.water);
    app.water.syncAir();
  }
  app.onSelectionChanged();
  shell?.props.invalidate('scene');
  shell?.props.invalidate('physics');
};

/* ── scene editing ────────────────────────────────────────────────────── */

app.addShape = function (kind) {
  const cx = app.grid.nx * 0.35, cy = (app.grid.ny + 1) / 2;
  const s = app.grid.ny;
  let obj;
  if (kind === 'rect') obj = Shapes.rect(cx, cy, s * 0.22, s * 0.22, { name: 'Rectangle' });
  else if (kind === 'circle') obj = Shapes.circle(cx, cy, s * 0.11, { name: 'Circle' });
  else obj = Shapes.naca(cx, cy, s * 0.46, { camber: 0.02, thickness: 0.12, aoa: 4 }, { name: 'Aerofoil' });
  app.scene.add(obj);
  app.scene.select(obj.id);
  app.commitScene(`add ${kind}`);
  app.reraster();
  app.onSelectionChanged();
  if (app.mode2 !== 'edit') app.setAppMode('edit');
};

/* ── purpose-built creators (building / aerofoil tools) ──────────────── */

const FOIL_PRESETS = {
  '0012': { camber: 0, camberPos: 0.4, thickness: 0.12 },
  '2412': { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
  '4412': { camber: 0.04, camberPos: 0.4, thickness: 0.12 },
  '0006': { camber: 0, camberPos: 0.4, thickness: 0.06 },
};

app.buildingSpec = { w: 24, h: 48, roughness: 0.2, wall: 'noslip' };
app.foilSpec = { preset: '2412', chord: 92, aoa: 4, camber: 0.02, camberPos: 0.4, thickness: 0.12 };

app.setFoilPreset = function (id) {
  app.foilSpec.preset = id;
  const p = FOIL_PRESETS[id];
  if (p) Object.assign(app.foilSpec, p);
  shell?.props.invalidate('add');
};

app.foilResolution = function () {
  const s = app.foilSpec;
  const camberCells = s.chord * s.camber;
  const thickCells = s.chord * s.thickness;
  return { camberCells, thickCells, warn: s.camber > 0 && camberCells < 1.5 };
};

app.addBuilding = function () {
  const s = app.buildingSpec;
  const obj = Shapes.rect(app.grid.nx * 0.3, app.grid.ny - s.h / 2 - 2, s.w, s.h, {
    name: 'Building',
    boundary: s.wall,
    bcParams: s.wall === 'porous' ? { resistance: 0.6 } : {},
  });
  app.scene.add(obj);

  // Surface roughness as a thin porous skin around the body. A rough wall
  // thickens the boundary layer and moves separation forward; representing it
  // as a slightly resistive shell reproduces that without needing a wall model.
  if (s.wall === 'noslip' && s.roughness > 0.02) {
    const skin = Shapes.rect(obj.transform.x, obj.transform.y, s.w + 3, s.h + 3, {
      name: 'Surface roughness',
      boundary: 'porous',
      bcParams: { resistance: Math.min(0.9, s.roughness * 0.7) },
    });
    app.scene.add(skin, app.scene.objects.indexOf(obj));   // beneath the solid
  }

  app.scene.select(obj.id);
  app.commitScene('add building');
  app.reraster();
  app.onSelectionChanged();
  if (app.mode2 !== 'edit') app.setAppMode('edit');
};

app.addFoil = function () {
  const s = app.foilSpec;
  const obj = Shapes.naca(app.grid.nx * 0.3, (app.grid.ny + 1) / 2, s.chord,
    { camber: s.camber, camberPos: s.camberPos, thickness: s.thickness, aoa: s.aoa },
    { name: s.preset === 'custom' ? 'Aerofoil' : `NACA ${s.preset}` });
  app.scene.add(obj);
  app.scene.select(obj.id);
  app.commitScene('add aerofoil');
  app.reraster();
  app.onSelectionChanged();
  if (app.mode2 !== 'edit') app.setAppMode('edit');
  const r = app.foilResolution();
  if (r.warn) toast(`Camber is only ${r.camberCells.toFixed(1)} cells — too small to resolve`, 'bad');
};

app.duplicateSelection = function () {
  const ids = [...app.scene.selection];
  if (!ids.length) return;
  const made = [];
  for (const id of ids) { const c = app.scene.duplicate(id); if (c) made.push(c.id); }
  app.scene.selection.clear();
  for (const id of made) app.scene.selection.add(id);
  app.commitScene('duplicate');
  app.reraster();
  app.onSelectionChanged();
};

app.deleteSelection = function () {
  const ids = [...app.scene.selection];
  if (!ids.length) return;
  for (const id of ids) app.scene.remove(id);
  app.commitScene('delete');
  app.reraster();
  app.onSelectionChanged();
};

app.mirrorSelection = function (axis) {
  const sel = app.scene.selected();
  if (!sel.length) return;
  for (const o of sel) T.mirror(o, axis);
  app.scene.revision++;
  app.commitScene('mirror');
  app.reraster();
  app.onSelectionChanged();
};

app.setBoundary = function (obj, role) {
  obj.boundary = role;
  const defaults = { moving: { speed: 1, direction: 0 }, rotating: { omega: 1 }, porous: { resistance: 0.5 }, inlet: { speed: 1, direction: 0 }, outlet: { pressure: 0 } };
  obj.bcParams = { ...(defaults[role] || {}), ...obj.bcParams };
  app.scene.revision++;
  app.commitScene('boundary role');
  app.reraster();
  shell?.props.invalidate('object');
};

/* Align a multi-selection against its own bounding box. */
app.alignSelection = function (edge) {
  const sel = app.scene.selected().filter(o => o.type !== 'sketch');
  if (sel.length < 2) { toast('Select at least two objects'); return; }
  const box = app.scene.selectionBounds();
  for (const o of sel) {
    const b = T.bounds(o);
    if (edge === 'left') o.transform.x += box.minX - b.minX;
    else if (edge === 'right') o.transform.x += box.maxX - b.maxX;
    else if (edge === 'top') o.transform.y += box.minY - b.minY;
    else if (edge === 'bottom') o.transform.y += box.maxY - b.maxY;
    else if (edge === 'cx') o.transform.x += (box.minX + box.maxX) / 2 - (b.minX + b.maxX) / 2;
    else if (edge === 'cy') o.transform.y += (box.minY + box.maxY) / 2 - (b.minY + b.maxY) / 2;
  }
  app.scene.revision++;
  app.commitScene(`align ${edge}`);
  app.reraster();
  app.onSelectionChanged();
};

/* Even spacing between the outermost two, measured centre to centre. */
app.distributeSelection = function (axis) {
  const sel = app.scene.selected().filter(o => o.type !== 'sketch');
  if (sel.length < 3) { toast('Select at least three objects'); return; }
  const key = axis === 'x' ? 'x' : 'y';
  sel.sort((a, b) => a.transform[key] - b.transform[key]);
  const first = sel[0].transform[key], last = sel[sel.length - 1].transform[key];
  const step = (last - first) / (sel.length - 1);
  sel.forEach((o, i) => { o.transform[key] = first + step * i; });
  app.scene.revision++;
  app.commitScene(`distribute ${axis}`);
  app.reraster();
  app.onSelectionChanged();
};

app.selectAll = function () {
  app.scene.selection.clear();
  for (const o of app.scene.objects) if (o.visible && !o.locked) app.scene.selection.add(o.id);
  app.onSelectionChanged();
};
app.deselectAll = function () { app.scene.selection.clear(); app.onSelectionChanged(); };

app.onSelectionChanged = function () {
  shell?.props.invalidate('object');
  shell?.outliner.sync(true);
  if (shell) shell.outlinerCount.textContent = `${app.scene.objects.length} object${app.scene.objects.length === 1 ? '' : 's'}`;
};

app.undo = function () { if (app.history.undo()) { app.reraster(); app.onSelectionChanged(); toast(`Undo`); } };
app.redo = function () { if (app.history.redo()) { app.reraster(); app.onSelectionChanged(); toast(`Redo`); } };

/* ── settings setters used by the shell and panels ────────────────────── */

app.setTool = function (id) { app.tool = id; shell?.syncTools(); shell?.props.invalidate('tool'); };
app.setMode = function (v) { app.mode = v; shell?.fieldSelect.set(v); shell?.props.invalidate('view'); };
app.setSolver = function (v) { app.solver = v; resetFlow(); shell?.props.invalidate('numerics'); };
app.setWindTunnel = function (v) { app.windTunnel = v; app.sync(); resetFlow(); shell?.props.invalidate('physics'); };
app.setRunning = function (v) { app.running = v; shell?.syncPlay(); };
app.setOverlay = function (key, v) {
  app[key] = v;
  if (key === 'showParticles' && v) app.parts.seed(app.windTunnel);
  shell?.overlayToggles.get(key)?.set(v);
  shell?.props.invalidate('view');
};
app.setGrid = function (v) {
  app.gridKey = v;
  const sc = app.scenario?.id;
  buildSimulation(v);
  app.renderer.markGeometryDirty();
  resize();
  if (sc) app.applyScenario(sc); else { app.reraster(); resetFlow(); }
};
app.setTheme = function (name) {
  app.themeName = THEMES[name] ? name : 'dark';
  app.theme = THEMES[app.themeName];
  document.documentElement.dataset.theme = app.themeName;
  app.overlays.barKey = '';
  try { localStorage.setItem('hyperfoam-theme', app.themeName); } catch {}
  shell?.props.invalidate('view');
};

/* Switching backend needs a reload: a canvas keeps the first context type it is
 * given for life, so the choice has to be made before the first getContext. */
app.setBackend = function (v) {
  const next = v === 'webgpu' ? 'webgpu' : 'webgl2';
  if (next === app.backendPref) return;
  app.backendPref = next;
  try { localStorage.setItem('hyperfoam-backend', next); } catch {}
  shell?.props.invalidate('view');
  modal({
    title: 'Reload to switch renderer',
    build: body => {
      body.append(el('p', 'note',
        'A canvas keeps whichever graphics context it is first given, so the '
        + 'renderer is chosen once at startup. Reload to use '
        + (next === 'webgpu' ? 'WebGPU' : 'WebGL 2') + '.'
        + (next === 'webgpu'
          ? ' If this device cannot start WebGPU, it will fall back to WebGL 2 automatically.'
          : '')));
      return { value: () => null };
    },
    buttons: [{ label: 'Later' }, { label: 'Reload now', primary: true, value: 'reload' }],
  }).then(a => { if (a === 'reload') location.reload(); });
};

/* Tracer count as a fraction of the grid-derived maximum. Drawing them is
 * ~2 ms a frame at full density, so this is the direct lever when the frame
 * budget is tight. */
app.setParticleDensity = function (v) {
  app.particleDensity = Math.max(0.1, Math.min(1, v));
  app.parts.density = app.particleDensity;
  app.parts.setCount(app.parts.max * app.particleDensity);
  shell?.props.invalidate('view');
};

/* Rebuild the tool panel, so options that only apply to some settings (the
 * rotation direction, which is meaningless at zero swirl) appear and vanish. */
app.refreshTool = function () { shell?.props.invalidate('tool'); };

/* Switch between airflow and free-surface water.
 *
 * The two want opposite domain conditions, so the switch sets both rather than
 * leaving the user to discover it: water needs the tunnel OFF (an inlet forcing
 * flow through a tank is not a tank) and gravity ON, while air needs neither.
 * Getting this wrong produces a tank that empties out of the outlet, which
 * looks like a solver bug and is not one. */
app.setPhysics = function (v) {
  const next = v === 'water' ? 'water' : 'air';
  if (next === app.physics) return;
  app.physics = next;
  // Re-apply the staggered rule now the mode is known: water pins it on.
  app.setStaggered(app.staggered);
  if (next === 'water') {
    /* Remember the airflow setup before overwriting it.
     *
     * Water needs nine settings changed, and leaving them changed on the way
     * back is not a small thing: viscosity, turbulence and the wind tunnel all
     * stay wrong, so the air simulation silently behaves differently after a
     * visit to water mode and there is nothing on screen to say why. Snapshot
     * and restore, so the mode tabs are a view onto two setups rather than a
     * one-way door. */
    app._airSetup = {
      vorticity: app.ns.vorticity, les: app.ns.les, lbmLes: app.lbm.les,
      visc: app.ns.visc, gravity: app.ns.gravity,
      windTunnel: app.windTunnel, particles: app.showParticles,
      dyeOverlay: app.dyeOverlay, mode: app.mode, scenario: app.scenario,
    };
    app.setWindTunnel(false);
    app.scenario = null;
    /* Airflow's turbulence defaults are actively wrong for a free surface.
     *
     * Vorticity confinement amplifies every local vorticity extremum, and the
     * sharpest ones in a tank sit exactly on the surface, so it feeds the
     * interface instead of the wake — measured, it left the surface chattering
     * at cell scale with the peak speed twenty times what a settling pool
     * should show. The Smagorinsky model is likewise a model of unresolved
     * turbulence, which a smooth surface does not have. Both off.
     *
     * Viscosity is raised because water at this resolution is otherwise almost
     * inviscid, and an inviscid free surface never stops ringing. */
    app.ns.vorticity = 0;
    app.ns.les = false;
    app.lbm.les = false;
    app.ns.visc = 0.05;
    app.ns.gravity = 0;            // dye buoyancy; the surface has its own
    app.water.reset(app.waterFill);
    app.setMode('speed');
    app.showParticles = false;
    app.dyeOverlay = false;
  } else {
    app.grid.hasAir = false;
    app.grid.air.fill(0);
    const a = app._airSetup;
    if (a) {
      app.ns.vorticity = a.vorticity; app.ns.les = a.les; app.lbm.les = a.lbmLes;
      app.ns.visc = a.visc; app.ns.gravity = a.gravity;
      app.showParticles = a.particles; app.dyeOverlay = a.dyeOverlay;
      app.scenario = a.scenario;
      app.setMode(a.mode);
      app.setWindTunnel(a.windTunnel);
      app._airSetup = null;
    }
  }
  /* Force a topology rebuild across the mode change.
   *
   * The pressure stencil at the finest level is rebuilt every solve while a
   * free surface exists, because the surface moves. Leaving water mode stops
   * that happening, and without this the air simulation would keep solving
   * against the last stencil the WATER produced — a diagonal that counts air
   * cells nobody has any more. It is invisible until the pressure comes out
   * wrong. */
  app.ns.onGeometryChanged();
  resetFlow();
  shell?.modeTabs?.set(next);
  syncAllUI();
};

app.waterPreset = function (name) {
  app.water.preset(name);
  resetFlow();
  shell?.props.invalidate('physics');
};

app.resetWater = function (frac) {
  if (frac !== undefined) app.waterFill = Math.max(0.05, Math.min(0.95, frac));
  app.water.reset(app.waterFill);
  resetFlow();
  shell?.props.invalidate('physics');
};

app.setAppMode = function (v) {
  app.mode2 = v;
  document.body.classList.toggle('mode-edit', v === 'edit');
  shell?.modeSwitch.set(v);
  // Editing with the solver running would advect a field through geometry
  // that is moving under it; hold still until the user is done.
  if (v === 'edit') { app._wasRunning = app.running; app.setRunning(false); app.setTool('select'); }
  else { app.setRunning(app._wasRunning !== false); if (app.tool === 'select') app.setTool('paint'); }
  shell?.syncTools();
};

app.togglePanels = function () {
  document.body.classList.toggle('panel-hidden');
  app.queueResize();
};
app.toggleFullscreen = function () {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(e => toast(`Fullscreen refused: ${e.message}`, 'bad'));
};
app.toggleHelp = function (force) {
  helpBox.hidden = force === undefined ? !helpBox.hidden : !force;
};
app.resetLayout = function () { shell.splitRight.reset(); shell.splitProps.reset(); app.queueResize(); };

/* ── projects ─────────────────────────────────────────────────────────── */

function payload() {
  return {
    scene: app.scene.toJSON(),
    /* The grid size travels WITH the field, not just in `gridKey`. A fill array
     * written at one resolution and poured into another is not wrong-looking,
     * it is silently scrambled — the run offsets no longer line up with rows —
     * so a mismatch has to be detectable and skippable rather than trusted. */
    water: app.physics === 'water'
      ? { nx: app.grid.nx, ny: app.grid.ny, particles: app.water.serialise() }
      : null,
    settings: {
      physics: app.physics, staggered: app.staggered,
      solver: app.solver, mode: app.mode, gridKey: app.gridKey, fluid: app.fluid,
      windTunnel: app.windTunnel, windSpeed: app.windSpeed, speed: app.speed,
      targetCFL: app.targetCFL, theme: app.themeName, scenario: app.scenario?.id || null,
      visc: app.ns.visc, vorticity: app.ns.vorticity, les: app.ns.les,
      overlays: {
        dyeOverlay: app.dyeOverlay, showVectors: app.showVectors,
        showStreamlines: app.showStreamlines, showContours: app.showContours,
        showParticles: app.showParticles, showGizmos: app.showGizmos,
      },
    },
  };
}

function restorePayload(data) {
  const s = data.settings || {};
  if (s.gridKey && GRIDS[s.gridKey] && s.gridKey !== app.gridKey) { app.gridKey = s.gridKey; buildSimulation(s.gridKey); }
  if (data.scene) {
    const loaded = Scene.fromJSON(data.scene);
    app.scene.objects.length = 0;
    for (const o of loaded.objects) app.scene.objects.push(o);
    app.scene.selection.clear();
    app.scene.revision++;
    app.history.reset('open project');
  }
  if (s.fluid && FLUIDS[s.fluid]) applyFluid(s.fluid);
  if (typeof s.staggered === 'boolean') app.setStaggered(s.staggered);
  if (s.solver) app.solver = s.solver;
  if (s.mode) app.mode = s.mode;
  if (typeof s.windTunnel === 'boolean') app.windTunnel = s.windTunnel;
  if (s.windSpeed) app.windSpeed = s.windSpeed;
  if (s.speed) app.speed = s.speed;
  if (s.targetCFL) app.targetCFL = s.targetCFL;
  if (s.visc) app.ns.visc = s.visc;
  if (typeof s.vorticity === 'number') app.ns.vorticity = s.vorticity;
  if (typeof s.les === 'boolean') { app.ns.les = s.les; app.lbm.les = s.les; }
  if (s.theme) app.setTheme(s.theme);
  for (const [k, v] of Object.entries(s.overlays || {})) if (k in app) app[k] = v;

  app.sync();
  app.scenario = s.scenario ? SCENARIO_BY_ID[s.scenario] || null : null;
  if (app.scenario) app.applyScenario(app.scenario.id); else { app.reraster(); resetFlow(); }

  /* Physics mode and the surface come LAST, in that order.
   *
   * `setPhysics` rewrites nine solver settings and calls `water.reset()`, so
   * anything restored before it is thrown away; and a scenario applied
   * afterwards would do the same. This is the end of the function for a
   * reason. */
  app.setPhysics(s.physics === 'water' ? 'water' : 'air');
  const w = data.water;
  if (w && app.physics === 'water' && w.nx === app.grid.nx && w.ny === app.grid.ny) {
    app.water.ensureSize();
    app.water.deserialise(w.particles || '');
    app.water.targetVolume = app.water.volume();
    app.water.syncAir();
  }
  syncAllUI();
}

app.newProject = async function () {
  if (app.dirty) {
    const go = await modal({
      title: 'New project',
      build: b => { b.append(Object.assign(document.createElement('p'), { className: 'note', textContent: 'Unsaved changes will be lost.' })); return { value: () => true }; },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Discard and continue', primary: true, value: true }],
    });
    if (!go) return;
  }
  app.scene.clear();
  app.history.reset('new');
  app.scenario = null;
  app.projectName = 'untitled';
  app.dirty = false;
  app.reraster(); resetFlow(); syncAllUI();
  toast('New project');
};

app.saveProject = async function () {
  let name = app.projectName;
  if (!name || name === 'untitled') { name = await promptName('Save project', 'My scene'); if (!name) return; }
  const res = Projects.saveProject(name, payload());
  if (!res.ok) { toast(res.error, 'bad'); return; }
  app.projectName = name; app.dirty = false;
  shell.projectLabel.textContent = name;
  toast(`Saved “${name}”`, 'ok');
};

app.saveProjectAs = async function () {
  const name = await promptName('Save project as', app.projectName === 'untitled' ? 'My scene' : `${app.projectName} copy`);
  if (!name) return;
  const res = Projects.saveProject(name, payload());
  if (!res.ok) { toast(res.error, 'bad'); return; }
  app.projectName = name; app.dirty = false;
  shell.projectLabel.textContent = name;
  toast(`Saved “${name}”`, 'ok');
};

app.openProject = async function () {
  const name = await pickProject();
  if (!name) return;
  const data = Projects.loadProject(name);
  if (!data) { toast('That project could not be read.', 'bad'); return; }
  restorePayload(data);
  app.projectName = name; app.dirty = false;
  shell.projectLabel.textContent = name;
  toast(`Opened “${name}”`);
};

/* Design report: what the current geometry is doing, with the averaged
 * coefficients rather than the instantaneous ones the status bar shows. */
app.analyseDesign = function () {
  const { diag, ns, lbm } = app;
  const uRef = app.solver === 'lbm' ? lbm.inletSpeed : ns.inletSpeed;
  const visc = app.solver === 'lbm' ? lbm.viscosity : ns.visc;
  const r = diag.report(uRef, visc);
  const aero = app.physics !== 'water';

  modal({
    title: aero ? 'Design analysis' : 'Tank analysis',
    build: body => {
      // In a tank there need not be a body at all — the water is the subject.
      if (!r && aero) {
        body.append(el('p', 'note', 'There is no body in the domain. Add a shape, or import one, and run the simulation.'));
        return { value: () => null };
      }
      const sec = title => { body.append(el('h4', 'an-h', title)); };
      const row = (k, v, tone) => {
        const d = el('div', 'an-row');
        d.append(el('span', 'an-k', k));
        const val = el('b', 'an-v', v);
        if (tone) val.dataset.tone = tone;
        d.append(val);
        body.append(d);
      };
      const f = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : '—');

      /* Cd, Cl, Re and St all normalise by a free-stream reference speed. In a
       * tank there is no free stream — `referenceSpeed()` returns the gravity
       * wave speed sqrt(gH) instead — so every one of these numbers would come
       * out well-formed, plausible, and meaningless. Report what a tank
       * actually has instead of dressing up a number nobody should act on. */
      if (aero) {
        sec('Forces');
        if (r.cd) {
          row('Drag coefficient  Cd', `${f(r.cd.mean)}  ± ${f(r.cd.rms, 3)}`);
          row('Lift coefficient  Cl', `${f(r.cl.mean)}  ± ${f(r.cl.rms, 3)}`);
          row('Lift / drag', f(r.liftToDrag, 2));
          row('Cd range over window', `${f(r.cd.min)} … ${f(r.cd.max)}`);
          row('Samples averaged', String(r.cd.n));
        } else {
          row('Drag coefficient  Cd', 'no samples yet');
        }

        sec('Flow');
        row('Reynolds number', r.re > 1e4 ? `${(r.re / 1000).toFixed(1)}k` : f(r.re, 0));
        row('Regime', r.regime);
        if (r.strouhal > 0) {
          row('Strouhal number  St', f(r.strouhal));
          row('Shedding frequency', `${f(r.sheddingFreq, 4)} / time unit`);
        } else if (r.strouhalNoisy) {
          row('Strouhal number  St', 'no clean shedding', 'warn');
        }
      } else {
        sec('Tank');
        const target = app.water.targetVolume;
        const now = app.water.volume();
        const drift = target > 0 ? (now - target) / target : 0;
        row('Water volume', `${now.toFixed(0)} cells`);
        row('Volume drift', `${(drift * 100).toFixed(2)}%`,
          Math.abs(drift) > 0.05 ? 'warn' : 'ok');
        const fr = app.norm.speed / Math.max(referenceSpeed(), 1e-6);
        row('Froude number  Fr', f(fr, 2), fr > 1 ? 'warn' : '');
        row('Flow', fr > 1 ? 'supercritical' : 'subcritical');
        row('Peak speed', `${f(app.norm.speed, 2)} cells / time`);
        body.append(el('p', 'note', 'Drag and lift coefficients are not shown in '
          + 'water mode: they normalise by a free-stream speed, and a tank has no '
          + 'free stream. Switch to airflow to measure a body.'));
      }

      if (r) {
        sec('Geometry');
        row('Reference length', `${f(r.refLength, 2)} cells`);
        row('Frontal height', `${f(r.frontalHeight, 2)} cells`);
        row('Frontal width', `${f(r.frontalWidth, 2)} cells`);
        row('Solid cells', String(r.cells));
        // Under about 20 cells across, the boundary layer has nowhere to live.
        if (aero && r.refLength < 20) {
          body.append(el('p', 'note', 'The body is small relative to the grid. '
            + 'Below roughly 20 cells across, the boundary layer is under-resolved '
            + 'and the coefficients get noticeably worse — use a finer grid.'));
        }
      }

      if (aero && r) {
        sec('How much to trust this');
        row('Confidence', r.confidence,
          r.confidence === 'good' ? 'ok' : r.confidence === 'warming up' ? '' : 'warn');
        body.append(el('p', 'note', r.note));
        if (r.steadiness > 0.15 && r.cd) {
          body.append(el('p', 'note', `Cd is still varying by ${(r.steadiness * 100).toFixed(0)}% `
            + 'across the averaging window. Let it run longer before comparing designs.'));
        }
      }
      return { value: () => null };
    },
    buttons: [
      { label: 'Copy', value: 'copy' },
      { label: 'Close', primary: true, value: null },
    ],
  }).then(action => {
    if (action !== 'copy') return;
    // Whatever is copied must match what was shown — pasting a Cd from a tank
    // into a report is exactly the mistake the panel above refuses to make.
    const target = app.water?.targetVolume || 0;
    const lines = (aero
      ? r && [
        `Design analysis — ${app.projectName || 'untitled'}`,
        `Cd ${r.cd ? r.cd.mean.toFixed(3) : '—'} ± ${r.cd ? r.cd.rms.toFixed(3) : '—'}`,
        `Cl ${r.cl ? r.cl.mean.toFixed(3) : '—'} ± ${r.cl ? r.cl.rms.toFixed(3) : '—'}`,
        `L/D ${r.liftToDrag.toFixed(2)}`,
        `Re ${r.re.toFixed(0)} (${r.regime})`,
        r.strouhal > 0 ? `St ${r.strouhal.toFixed(3)}` : null,
        `Reference length ${r.refLength.toFixed(2)} cells`,
        `Confidence: ${r.confidence} — ${r.note}`,
      ]
      : [
        `Tank analysis — ${app.projectName || 'untitled'}`,
        `Water volume ${app.water.volume().toFixed(0)} cells`,
        `Volume drift ${target > 0 ? (((app.water.volume() - target) / target) * 100).toFixed(2) : '—'}%`,
        `Fr ${(app.norm.speed / Math.max(referenceSpeed(), 1e-6)).toFixed(2)}`,
        `Peak speed ${app.norm.speed.toFixed(2)} cells / time`,
        r ? `Reference length ${r.refLength.toFixed(2)} cells` : null,
      ]);
    if (!lines) return;
    const text = lines.filter(Boolean).join('\n');
    navigator.clipboard?.writeText(text)
      .then(() => toast('Analysis copied'))
      .catch(() => toast('Could not copy', 'bad'));
  });
};

app.exportFile = function () {
  Projects.download(app.projectName, payload());
  toast('Exported .hyperfoam.json');
};

/* Import an SVG as scene geometry.
 *
 * Closed subpaths become solid polygons; open ones become walls carrying the
 * stroke's own width, because an open path is a line in the drawing and a line
 * in a tunnel is a barrier rather than a filled body. Everything arrives
 * selected so it can be moved or scaled immediately. */
app.importSVG = async function () {
  try {
    const res = await Projects.pickText('.svg,image/svg+xml');
    if (!res) return;
    const { nx, ny } = app.grid;
    const { shapes } = importSVG(res.text, { nx, ny });

    app.scene.selection.clear();
    for (const s of shapes) {
      const obj = s.closed
        ? Shapes.polygonAbs(s.pts, { name: res.name || 'Imported' })
        : Shapes.wall(0, 0, s.pts, s.thickness, { name: res.name || 'Imported wall' });
      app.scene.add(obj);
      app.scene.selection.add(obj.id);
    }
    app.commitScene(`import ${res.name}`);
    app.reraster();
    app.onSelectionChanged();
    const n = shapes.length;
    toast(`Imported ${n} shape${n === 1 ? '' : 's'} from “${res.name}”`);
  } catch (err) { toast(err.message, 'bad'); }
};

/* Import a 3D model and take a 2D section through it.
 *
 * A 2D solver can only test a cross-section, and picking the right one is a
 * judgement the user has to make while LOOKING at the model — a slice halfway
 * up a car is a different experiment from one through its mirrors. So this is a
 * dialog with a live preview rather than a fixed rule: choose an axis, scrub the
 * plane, watch the outline change, then add it.
 *
 * Closed rings become solid polygons; open chains become walls, since a
 * non-watertight mesh still slices to something worth testing and silently
 * dropping it would lose geometry the preview clearly shows.
 */
app.importSTL = async function () {
  let res, mesh;
  try {
    res = await Projects.pickBinary('.stl,model/stl,application/vnd.ms-pki.stl');
    if (!res) return;
    mesh = parseSTL(res.data);
  } catch (err) { toast(err.message, 'bad'); return; }

  const state = { axis: 2, t: 0.5, flipX: false, flipY: false, turns: 0 };
  const posFor = () => mesh.min[state.axis] + (mesh.max[state.axis] - mesh.min[state.axis]) * state.t;
  const orientOf = () => ({ flipX: state.flipX, flipY: state.flipY, turns: state.turns });

  const chosen = await modal({
    title: `Slice “${res.name}”`,
    build: body => {
      const cv = el('canvas', 'slice-prev');
      cv.width = 520; cv.height = 300;
      body.append(cv);
      const info = el('p', 'note', '');
      const controls = el('div', 'slice-ctl');
      body.append(controls, info);

      /* The preview shows the section IN THE TUNNEL, not fitted to the canvas.
       *
       * Fit-to-canvas answers "what shape is this", which you can already see.
       * The question that actually matters before adding is "what will this do
       * in the domain" — how much of the channel it blocks, which way it faces
       * into the flow, and where it sits. So the domain is drawn to its real
       * aspect with the section placed and scaled exactly as `sliceToScene`
       * will place it, and both go through the same code so the preview cannot
       * disagree with the result. */
      const draw = () => {
        const ctx = cv.getContext('2d');
        const css = getComputedStyle(document.documentElement);
        const col = n => (css.getPropertyValue(n) || '').trim();
        ctx.fillStyle = col('--sunken') || '#1d1d1d';
        ctx.fillRect(0, 0, cv.width, cv.height);

        const { nx, ny } = app.grid;
        let fitted = null;
        try {
          fitted = sliceToScene(mesh, { axis: state.axis, position: posFor(),
                                        nx, ny, orient: orientOf() });
        } catch (err) {
          info.textContent = err.message;
          return;
        }

        // Domain box, to the grid's real aspect, centred with a margin.
        const pad = 14;
        const k = Math.min((cv.width - pad * 2) / nx, (cv.height - pad * 2) / ny);
        const ox = (cv.width - nx * k) / 2, oy = (cv.height - ny * k) / 2;
        ctx.strokeStyle = col('--line') || '#3c3c3c';
        ctx.lineWidth = 1;
        ctx.strokeRect(ox + 0.5, oy + 0.5, nx * k, ny * k);
        // Inlet edge, so "which way is the flow" is never in doubt — the whole
        // reason a flip control exists.
        ctx.strokeStyle = col('--accent') || '#4772b3';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ox + 1, oy + 2); ctx.lineTo(ox + 1, oy + ny * k - 2);
        ctx.stroke();
        ctx.fillStyle = col('--dimmer') || '#6f6f6f';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('flow →', ox + 6, oy + 5);

        let minY = Infinity, maxY = -Infinity;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        for (const sh of fitted.shapes) {
          ctx.beginPath();
          for (let i = 0; i < sh.pts.length; i += 2) {
            const X = ox + sh.pts[i] * k, Y = oy + sh.pts[i + 1] * k;
            minY = Math.min(minY, sh.pts[i + 1]); maxY = Math.max(maxY, sh.pts[i + 1]);
            if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
          }
          if (sh.closed) ctx.closePath();
          // Closed rings become solid; open chains become walls. Showing the
          // difference here saves a surprise after adding.
          ctx.strokeStyle = sh.closed ? (col('--text') || '#e5e5e5') : (col('--warn') || '#d9a441');
          ctx.stroke();
          if (sh.closed) {
            ctx.fillStyle = 'rgba(255,255,255,0.10)';
            ctx.fill();
          }
        }

        const ax = planeAxes(state.axis);
        const closed = fitted.shapes.filter(s => s.closed).length;
        const blockage = (maxY - minY) / ny * 100;
        // An odd number of quarter turns puts the OTHER plane axis along the
        // flow, so naming both would be wrong — only one of them is streamwise.
        const streamwise = state.turns % 2 ? ax.up : ax.across;
        info.textContent =
          `${fitted.shapes.length} outline${fitted.shapes.length === 1 ? '' : 's'} `
          + `(${closed} closed, ${fitted.shapes.length - closed} open) · `
          + `plane ${ax.cut} = ${posFor().toPrecision(4)} · `
          + `model ${streamwise} runs along the flow · `
          + `blocks ${blockage.toFixed(0)}% of the channel`;
      };

      selectField(controls, {
        label: 'Slice axis', value: String(state.axis), options: AXES,
        onChange: v => {
          // A new axis is a new plane pair, so a flip chosen for the old one
          // means nothing on it. Starting from unflipped is less confusing than
          // silently carrying a transform across.
          state.axis = Number(v); state.flipX = state.flipY = false; state.turns = 0;
          rebuildOrientRow();
          draw();
        },
      });
      numberField(controls, {
        label: 'Position', value: state.t, min: 0, max: 1, step: 0.01, precision: 3,
        hint: 'Where the cutting plane sits along the chosen axis, 0 to 1 across '
            + 'the model. Drag to scrub through the section.',
        onChange: v => { state.t = v; draw(); },
      });

      /* Orientation. Which way a section comes out depends on which two axes
       * the cut leaves and their handedness, so a wing can face upstream on one
       * axis and downstream on another through no fault of the model. */
      const orientRow = el('div', 'sf');
      controls.append(orientRow);
      const rebuildOrientRow = () => {
        orientRow.textContent = '';
        orientRow.append(el('span', 'sf-l', 'Orientation'));
        const box = el('div', 'slice-btns');
        orientRow.append(box);
        button(box, {
          label: 'Flip H', variant: state.flipX ? 'primary' : null,
          hint: 'Mirror across the flow direction — use it when the leading edge '
              + 'points downstream.',
          onClick: () => { state.flipX = !state.flipX; rebuildOrientRow(); draw(); },
        });
        button(box, {
          label: 'Flip V', variant: state.flipY ? 'primary' : null,
          hint: 'Mirror top to bottom, which reverses the sign of any camber.',
          onClick: () => { state.flipY = !state.flipY; rebuildOrientRow(); draw(); },
        });
        button(box, {
          label: `Rotate ${state.turns * 90}°`,
          hint: 'Quarter turns. Applied before the section is sized, so turning '
              + 'a long shape upright re-checks it against the blockage limit.',
          onClick: () => { state.turns = (state.turns + 1) % 4; rebuildOrientRow(); draw(); },
        });
      };
      rebuildOrientRow();
      draw();
      return { value: () => null };
    },
    buttons: [{ label: 'Cancel' }, { label: 'Add section', primary: true, value: 'add' }],
  });
  if (chosen !== 'add') return;

  try {
    const { nx, ny } = app.grid;
    const { shapes } = sliceToScene(mesh, { axis: state.axis, position: posFor(),
                                           nx, ny, orient: orientOf() });
    app.scene.selection.clear();
    for (const s of shapes) {
      const obj = s.closed
        ? Shapes.polygonAbs(s.pts, { name: res.name })
        : Shapes.wall(0, 0, s.pts, 2, { name: `${res.name} edge` });
      app.scene.add(obj);
      app.scene.selection.add(obj.id);
    }
    app.commitScene(`slice ${res.name}`);
    app.reraster();
    app.onSelectionChanged();
    toast(`Added ${shapes.length} outline${shapes.length === 1 ? '' : 's'} from “${res.name}”`);
  } catch (err) { toast(err.message, 'bad'); }
};

app.importFile = async function () {
  try {
    const res = await Projects.pickFile();
    if (!res) return;
    restorePayload(res.data);
    app.projectName = res.name || 'imported';
    app.dirty = false;
    shell.projectLabel.textContent = app.projectName;
    toast(`Imported “${app.projectName}”`);
  } catch (err) { toast(err.message, 'bad'); }
};

/* ── offline recording ───────────────────────────────────────────────── */

app.recordSpec = {
  format: 'webm', fps: 30, seconds: 6, scale: 1, quality: 1,
  overlays: true, height: 1080, preview: true,
};
app.recording = false;
app.recordProgress = 0;

export const RENDER_HEIGHTS = [
  { value: 540, label: '960 × 540' },
  { value: 720, label: '1280 × 720  (720p)' },
  { value: 1080, label: '1920 × 1080  (1080p)' },
  { value: 1440, label: '2560 × 1440  (1440p)' },
  { value: 2160, label: '3840 × 2160  (4K)' },
  { value: 4320, label: '7680 × 4320  (8K)' },
];
app.renderHeights = () => RENDER_HEIGHTS;

app.recordCaps = () => Recorder_capabilities();
app.recordFormats = () => RECORD_FORMATS.map(f => ({ value: f.id, label: f.label }));

/* Output size follows the DOMAIN's aspect, not the viewport's, so a recording
 * is never letterboxed or stretched by however the window happened to be
 * shaped. Rounded to even numbers because most video codecs reject odd ones. */
app.recordSize = function () {
  const { nx, ny } = app.grid;
  const h = app.recordSpec.height;
  let w = Math.round(h * (nx / ny));
  w -= w % 2;
  return { w, h: h - (h % 2) };
};

/* The field shader evaluates per output pixel, so a larger canvas produces a
 * genuinely sharper image rather than an upscaled one — but the SIMULATION
 * detail is still bounded by the grid. Raising the render height alone gives
 * smoother gradients and cleaner edges; resolving finer eddies needs a finer
 * grid as well. This estimate says which limit you are against. */
app.recordDetail = function () {
  const { w, h } = app.recordSize();
  return { pxPerCell: h / app.grid.ny, gridLimited: h / app.grid.ny > 6, w, h };
};

app.recordEstimate = function () {
  const r = app.recordSpec;
  const frames = Math.max(1, Math.round(r.fps * r.seconds));
  const { w, h } = app.recordSize();
  const mp = (w * h) / 1e6;
  // PNG of a smooth field lands around 1.2 bytes/px; video is far smaller.
  const bytes = r.format === 'png'
    ? frames * w * h * 1.2
    : frames * w * h * r.quality * 0.07 / 8 * 1;
  const secsPerFrame = (app.frameMs || 12) / 1000 * Math.max(1, mp / 0.5);
  return { frames, mp, bytes, minutes: (frames * secsPerFrame) / 60 };
};

/* Compose the two canvases into one frame buffer, reused across the capture
 * so a long render does not allocate a canvas per frame. */
let composeCanvas = null;
function composeFrame(withOverlays) {
  if (!composeCanvas) composeCanvas = document.createElement('canvas');
  const w = fieldCanvas.width, h = fieldCanvas.height;
  if (composeCanvas.width !== w || composeCanvas.height !== h) {
    composeCanvas.width = w; composeCanvas.height = h;
  }
  /* Redraw the field immediately before reading it.
   *
   * WebGL2 keeps its last frame because the context is created with
   * preserveDrawingBuffer. WebGPU has no such option: once a frame is
   * presented, the canvas texture is gone, and a `drawImage` from any later
   * task reads BLACK. Both the PNG export and the recorder compose from a
   * separate task, so on WebGPU every captured frame came out empty — the app
   * looked perfect on screen and produced black files.
   *
   * Redrawing here costs one extra field draw per captured frame, which is
   * nothing against encoding it, and it makes the capture independent of when
   * the caller happens to run. */
  if (app.renderer && app.renderer.backend === 'webgpu') drawFieldOnly();

  const c = composeCanvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.drawImage(fieldCanvas, 0, 0);
  if (withOverlays) c.drawImage(fxCanvas, 0, 0);
  return composeCanvas;
}

app.startRecording = async function () {
  if (app.recording) return;
  const r = app.recordSpec;
  const frames = Math.max(1, Math.round(r.fps * r.seconds));

  // Overlays are drawn by render(), so gate them for the duration rather than
  // trying to strip them from the composed frame afterwards.
  const saved = {
    vectors: app.showVectors, streams: app.showStreamlines, contours: app.showContours,
    particles: app.showParticles, gizmos: app.showGizmos, running: app.running,
  };
  if (!r.overlays) {
    app.showVectors = app.showStreamlines = app.showContours = false;
    app.showParticles = false; app.showGizmos = false;
  }
  app.running = false;                 // the recorder drives the clock now
  app.recording = true;
  app.recordProgress = 0;

  /* Render at the requested output size while leaving the canvases' CSS size
   * alone. The backing store becomes (say) 4K, the browser scales it down to
   * the viewport for display, and the viewport therefore shows a live preview
   * of the actual frames being written. `layout` keeps CSS-pixel scales; the
   * overlay context is told the new device ratio so it draws at full output
   * resolution too rather than a blurry upscale. */
  const out = app.recordSize();
  const cssW = layout.w, cssH = layout.h;
  app.renderer.resize(out.w, out.h);
  app.overlays.resize(out.w, out.h, out.w / Math.max(1, cssW));
  toast(`Rendering ${frames} frames at ${out.w}×${out.h}…`);
  shell.props.invalidate('render');

  /* Simulated time per OUTPUT FRAME, fixed for the whole capture.
   *
   * This used to be re-derived from the instantaneous peak speed on every
   * frame, the same way the realtime loop picks its timestep. The frame
   * *timing* in the file was still perfectly uniform — but the amount of
   * simulation each frame advanced was not, so the motion juddered, and it
   * juddered worst exactly when the flow sped up. That reads as the capture
   * following the screen, because a rising peak speed both shrinks the
   * adaptive step and makes the solver slower to draw.
   *
   * Fixing it here and absorbing stability into SUB-STEPS below is what makes
   * the recording independent of what the machine or the flow is doing: a
   * faster flow costs more compute per frame, never less simulated time.
   *
   * Chosen from the reference speed rather than the current peak so the value
   * does not depend on which instant the user pressed record. */
  const captureDt = captureStep({
    targetCFL: app.targetCFL,
    uRef: Math.max(referenceSpeed(), app.ns.measureMaxSpeed()),
    scale: r.scale,
  });

  const rec = new Recorder({
    dtFor: () => captureDt,
    stepOnce: dt => {
      app.sync();
      applyInlets();
      if (app.solver === 'lbm') {
        const el = app.lbm.step(PALETTE);
        app.ns.dyeStep(el);
      } else {
        // Sub-divide the fixed frame step into as many solver steps as the
        // CURRENT flow needs to stay within the CFL target. This is where a
        // speed-up is paid for — in step count, not in simulated time.
        const steps = subSteps(dt, app.ns.measureMaxSpeed(), app.targetCFL);
        advanceNS(dt / steps, steps);
        app.ns.dyeStep(dt);
      }
      if (app.showParticles) app.parts.advect(dt, app.norm);
    },
    renderOnce: () => render(),
    compose: () => composeFrame(r.overlays),
    // Wait for a real paint, not just a task boundary, so the viewport
    // genuinely shows each frame as it is captured.
    yieldFrame: () => (r.preview
      ? new Promise(res => requestAnimationFrame(() => res()))
      : new Promise(res => setTimeout(res, 0))),
  });
  app._recorder = rec;

  try {
    const out = await rec.run({ ...r, frames }, p => {
      app.recordProgress = p;
      if (Math.round(p * 100) % 5 === 0) shell.props.invalidate('render');
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out.blob);
    a.download = `${app.projectName}.${out.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(out.note ? `${out.frames} frames — ${out.note}` : `Rendered ${out.frames} frames`, 'ok');
  } catch (err) {
    console.error(err);
    toast(`Render failed: ${err.message}`, 'bad');
  } finally {
    app.recording = false;
    app._recorder = null;
    app.showVectors = saved.vectors; app.showStreamlines = saved.streams;
    app.showContours = saved.contours; app.showParticles = saved.particles;
    app.showGizmos = saved.gizmos; app.running = saved.running;
    resize();                          // restore the viewport's own resolution
    shell.props.invalidate('render');
    syncAllUI();
  }
};

/* Progress banner drawn straight onto the overlay while capturing, so the
 * viewport carries its own status instead of it living only in a side panel
 * the user may have scrolled away from. */
app.drawRecordHUD = function () {
  if (!app.recording) return;
  const o = app.overlays, t = app.theme;
  const pct = Math.round(app.recordProgress * 100);
  const est = app.recordEstimate();
  const done = Math.round(app.recordProgress * est.frames);
  o.operatorHint(`Rendering  ${pct}%   frame ${done} / ${est.frames}   ${app.recordSize().w}×${app.recordSize().h}`, t);
};

app.cancelRecording = function () {
  if (app._recorder) { app._recorder.cancel(); toast('Cancelling…'); }
};

app.savePNG = function () {
  // Through composeFrame, which is the one place that knows a WebGPU canvas
  // must be redrawn in the same task to be readable at all. Compositing here
  // instead produced a perfectly black PNG on that backend.
  const src = composeFrame(true);
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  out.getContext('2d').drawImage(src, 0, 0);
  out.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${app.projectName}-${app.mode}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
};

app.copyLink = function () {
  const p = new URLSearchParams();
  p.set('s', app.solver); p.set('g', app.gridKey); p.set('m', app.mode);
  p.set('f', app.fluid); p.set('w', app.windTunnel ? '1' : '0');
  p.set('u', String(app.windSpeed)); p.set('t', app.themeName);
  if (app.scenario) p.set('sc', app.scenario.id);
  const url = `${location.origin}${location.pathname}#${p}`;
  navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast('Could not copy', 'bad'));
};

function toast(text, tone) {
  toastBox.textContent = text;
  toastBox.dataset.tone = tone || '';
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, 2600);
}

function syncAllUI() {
  if (!shell) return;
  shell.fieldSelect.set(app.mode);
  shell.modeSwitch.set(app.mode2);
  shell.syncPlay(); shell.syncTools();
  for (const [k, h] of shell.overlayToggles) h.set(app[k]);
  shell.projectLabel.textContent = app.projectName;
  shell.props.invalidate();
  app.onSelectionChanged();
}

/* ── layout ───────────────────────────────────────────────────────────── */

function resize() {
  const rect = stage.getBoundingClientRect();
  const { nx, ny } = app.grid;
  const aspect = nx / ny;
  let w = rect.width, h = rect.width / aspect;
  if (h > rect.height) { h = rect.height; w = rect.height * aspect; }
  w = Math.max(64, Math.floor(w)); h = Math.max(32, Math.floor(h));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [fieldCanvas, fxCanvas]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
  app.renderer.resize(Math.round(w * dpr), Math.round(h * dpr));
  app.overlays.resize(Math.round(w * dpr), Math.round(h * dpr), dpr);
  layout = { w, h, dpr, sx: w / nx, sy: h / ny };
}

let resizeQueued = false;
app.queueResize = function () {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => requestAnimationFrame(() => { resizeQueued = false; resize(); }));
};
const ro = new ResizeObserver(() => app.queueResize());

/* ── interaction helpers ──────────────────────────────────────────────── */

/* Stop an accumulated brush impulse from pushing past what it aims at.
 *
 * `fx`/`fy` are per-frame impulses, cleared inside `ns.step()`. But
 * `pointermove` fires many times per frame — more when the frame rate drops,
 * and more still when two strokes overlap the same cells — and every event adds
 * another full relaxation toward the target. Measured against a brush target of
 * 6.5 cells/time: one event a frame settled at 6.8, four at 7.7, and eight at
 * 64.6. That is the "drawing makes the speed blow up, especially where strokes
 * overlap" report, and it got worse exactly when the frame rate did.
 *
 * Clamping what has ACCUMULATED — rather than each contribution — makes the
 * brush idempotent within a frame: the same stroke does the same thing whether
 * the mouse reports at 125 Hz or 1000 Hz. Fluid already moving faster than the
 * brush keeps its speed, so a brush is never a brake.
 */
function limitImpulse(u, v, fx, fy, idx, targetSpeed) {
  const nu = u[idx] + fx[idx], nv = v[idx] + fy[idx];
  const m = Math.hypot(nu, nv);
  const lim = Math.max(targetSpeed, Math.hypot(u[idx], v[idx]));
  if (m <= lim || m < 1e-9) return;
  const k = lim / m;
  fx[idx] = nu * k - u[idx];
  fy[idx] = nv * k - v[idx];
}

function applyInlets() {
  const g = app.grid;
  const { nx, ny, stride: s, solid, u, v, fx, fy, sR, sG, sB } = g;
  const uRef = referenceSpeed();
  for (const src of app.inlets) {
    const r = src.radius;
    const rate = Math.min(0.8, Math.max(0.1, src.strength / 20));
    const tx = src.ux * uRef, ty = src.uy * uRef;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const d2 = di * di + dj * dj;
        if (d2 > r * r) continue;
        const i = src.i + di, j = src.j + dj;
        if (i < 1 || i > nx || j < 1 || j > ny) continue;
        const idx = i + j * s;
        if (solid[idx]) continue;
        const fall = 1 - Math.sqrt(d2) / (r + 1);
        const a = fall * rate;
        fx[idx] += (tx - u[idx]) * a;
        fy[idx] += (ty - v[idx]) * a;
        // Emitters overlap each other as readily as brush strokes do.
        limitImpulse(u, v, fx, fy, idx, Math.hypot(tx, ty));
        sR[idx] += src.cr * fall * 2.5;
        sG[idx] += src.cg * fall * 2.5;
        sB[idx] += src.cb * fall * 2.5;
      }
    }
  }
}

/* A held swirl keeps driving even when the pointer is still.
 *
 * The push tool is movement-driven: no motion, no impulse. That is right for
 * shoving fluid along, and wrong for building a vortex, which is made by
 * dwelling in one place. With swirl engaged, holding the button keeps feeding
 * the rotation at a steady rate. */
function applyHeldSwirl() {
  if (app.swirl <= 0 || !app.pointer.down || app.tool !== 'paint') return;
  if (app.mode2 !== 'simulate' && app.mode2 !== 'edit') return;
  paintBrush(app.pointer.x, app.pointer.y, 0, 0, 6);
}

/* Push the fluid under the brush.
 *
 * `swirl` bends the push into rotation: at 0 every cell is driven along the
 * stroke, at 1 every cell is driven around its centre, and in between the two
 * are mixed. That combination is what makes a cyclone — pure rotation alone
 * just spins a disc and dissipates, whereas a little inflow with a lot of
 * rotation feeds the core the way a real vortex is fed.
 *
 * The tangent is taken from the offset within the brush, so the swirl's axis
 * follows the cursor rather than being pinned to where the stroke began.
 */
function paintBrush(gx, gy, dirX, dirY, mag) {
  const g = app.grid;
  const { nx, ny, stride: s, solid, u, v, fx, fy, sR, sG, sB } = g;
  const r = app.brush;
  const col = PALETTE[app.paintColour % PALETTE.length];
  const cr = col[0] / 255, cg = col[1] / 255, cb = col[2] / 255;
  const ci = Math.round(gx), cj = Math.round(gy), ri = Math.ceil(r);
  const uRef = referenceSpeed();
  const target = (app.force / 100) * uRef * 3 * Math.min(1, mag / 6);
  const tx = dirX * target, ty = dirY * target, rate = 0.35;
  const swirl = app.swirl;
  const spin = app.swirlDir;              // +1 clockwise on screen, -1 anti
  for (let dj = -ri; dj <= ri; dj++) {
    for (let di = -ri; di <= ri; di++) {
      const d2 = di * di + dj * dj;
      if (d2 > r * r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      const idx = i + j * s;
      if (solid[idx]) continue;
      const fall = 1 - Math.sqrt(d2) / (r + 1);
      const a = fall * rate;
      let ttx = tx, tty = ty;
      if (swirl > 0) {
        // Tangent at this offset. Screen y runs down, so (-dj, di) turns
        // clockwise — the same sense `rotating` boundaries use.
        const d = Math.sqrt(d2);
        if (d > 1e-6) {
          /* Cyclone profile: a TIGHT solid-body core, then decay outward.
           *
           * A core at half the radius put the peak speed on a circle halfway
           * out and made a ring with a dead middle, which is not what a cyclone
           * looks like. Real ones peak at a small eyewall and trail off as
           * roughly 1/r. Pure 1/r is unusable — it is unbounded at the centre
           * and one cell would carry the whole impulse — so the inner 18% is
           * solid-body, which is exactly the Rankine construction. */
          const rc = r * 0.18;
          const prof = d < rc ? d / rc : Math.pow(rc / d, 0.75);
          const sp = target * prof * spin;
          const tanX = -dj / d, tanY = di / d;
          ttx = tx * (1 - swirl) + tanX * sp * swirl;
          tty = ty * (1 - swirl) + tanY * sp * swirl;
        }
      }
      fx[idx] += (ttx - u[idx]) * a;
      fy[idx] += (tty - v[idx]) * a;
      limitImpulse(u, v, fx, fy, idx, Math.abs(target));
      sR[idx] += cr * fall * 3; sG[idx] += cg * fall * 3; sB[idx] += cb * fall * 3;
    }
  }
}

/* ── freehand painting on the sketch layer ───────────────────────────── */

function stampSketch(gx, gy, erase) {
  const layer = sketchLayer(!erase);
  if (!layer) return;
  const { w, h, data } = layer.params;
  const r = Math.max(1, app.brush * 0.85);
  const ci = Math.round(gx), cj = Math.round(gy), ri = Math.ceil(r);
  for (let dj = -ri; dj <= ri; dj++) {
    for (let di = -ri; di <= ri; di++) {
      if (di * di + dj * dj > r * r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 1 || i > w || j < 1 || j > h) continue;
      data[(i - 1) + (j - 1) * w] = erase ? 0 : 1;
    }
  }
}

function strokeSketch(x0, y0, x1, y1, erase) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, app.brush * 0.35)));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    stampSketch(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, erase);
  }
  app.scene.revision++;
  app.reraster();
}

/* Flood fill the connected fluid region under the cursor into the sketch
 * layer. Bounded by anything already solid, from any object. */
function floodFill(gx, gy) {
  const g = app.grid;
  const { nx, ny, stride: s, solid } = g;
  const si = Math.round(gx), sj = Math.round(gy);
  if (si < 1 || si > nx || sj < 1 || sj > ny) return;
  if (solid[si + sj * s]) { toast('That cell is already solid'); return; }

  const seen = new Uint8Array(g.size);
  const stack = new Int32Array(g.size);
  let top = 0, filled = 0;
  const start = si + sj * s;
  stack[top++] = start; seen[start] = 1;
  const cells = [];
  while (top > 0) {
    const idx = stack[--top];
    const i = idx % s, j = (idx / s) | 0;
    cells.push(idx);
    filled++;
    // An unbounded region would swallow the entire domain; stop and say so
    // rather than silently turning the tunnel into a brick.
    if (filled > nx * ny * 0.6) { toast('That region is not enclosed', 'bad'); return; }
    const push = k => { if (!seen[k] && !solid[k]) { seen[k] = 1; stack[top++] = k; } };
    if (i > 1) push(idx - 1);
    if (i < nx) push(idx + 1);
    if (j > 1) push(idx - s);
    if (j < ny) push(idx + s);
  }

  const layer = sketchLayer(true);
  const { w, data } = layer.params;
  for (const idx of cells) {
    const i = idx % s, j = (idx / s) | 0;
    data[(i - 1) + (j - 1) * w] = 1;
  }
  app.scene.revision++;
  app.commitScene('fill');
  app.reraster();
  toast(`Filled ${filled} cells`);
}

/* ── emitters as scene objects ───────────────────────────────────────── */

function addInletFromDrag(x0, y0, x1, y1) {
  const { nx, ny } = app.grid;
  if (x0 < 1 || x0 > nx || y0 < 1 || y0 > ny) return;
  let dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1.5) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  const speed = Math.min(2.5, Math.max(0.4, len / 22));
  const obj = Shapes.circle(x0, y0, Math.max(2, app.brush * 0.6), {
    name: 'Emitter',
    boundary: 'inlet',
    bcParams: {
      speed,
      direction: Math.atan2(dy, dx) * 180 / Math.PI,
      strength: Math.min(20, Math.max(6, len * 0.7)),
      colour: app.inletColour,
    },
  });
  app.scene.add(obj);
  app.commitScene('add emitter');
  app.reraster();
  app.onSelectionChanged();
}

/* ── simulation ───────────────────────────────────────────────────────── */

function computeNorm(mode) {
  const g = app.grid;
  const { nx, ny, stride: s, u, v, p, solid } = g;
  const hasSolid = g.hasSolid;
  let speed = 0, pAbs = 0, curl = 0, grad = 0, q = 0;
  const wantCurl = mode === 'vorticity', wantP = mode === 'pressure';
  const wantGrad = mode === 'schlieren', wantQ = mode === 'qcriterion';
  const wantOther = wantCurl || wantP || wantGrad || wantQ;

  for (let j = 2; j <= ny - 1; j++) {
    const jS = j * s;
    for (let i = 2; i <= nx - 1; i++) {
      const idx = i + jS;
      if (hasSolid && solid[idx]) continue;
      const a = u[idx], b = v[idx];
      const m = a * a + b * b;
      if (m > speed) speed = m;
      if (!wantOther) continue;
      if (wantCurl) {
        const w = Math.abs(0.5 * (v[idx + 1] - v[idx - 1] - u[idx + s] + u[idx - s]));
        if (w > curl) curl = w;
      } else if (wantP) {
        const t = Math.abs(p[idx]); if (t > pAbs) pAbs = t;
      } else if (wantGrad) {
        const gx = 0.5 * (p[idx + 1] - p[idx - 1]), gy = 0.5 * (p[idx + s] - p[idx - s]);
        const t = gx * gx + gy * gy; if (t > grad) grad = t;
      } else if (wantQ) {
        const dudx = 0.5 * (u[idx + 1] - u[idx - 1]), dudy = 0.5 * (u[idx + s] - u[idx - s]);
        const dvdx = 0.5 * (v[idx + 1] - v[idx - 1]), dvdy = 0.5 * (v[idx + s] - v[idx - s]);
        const w = 0.5 * (dvdx - dudy);
        const sq = dudx * dudx + dvdy * dvdy + 0.5 * (dudy + dvdx) * (dudy + dvdx);
        const t = Math.abs(0.5 * (2 * w * w - sq)); if (t > q) q = t;
      }
    }
  }
  const n = app.norm;
  const MAX_RISE = 1.10, DECAY = 0.985;
  const blend = (cur, next, floor) => {
    if (!(next > 0)) return Math.max(cur * DECAY, floor);
    if (next > cur) return Math.max(Math.min(next, cur * MAX_RISE), floor);
    return Math.max(cur + (next - cur) * 0.05, floor);
  };
  n.speed = blend(n.speed, Math.sqrt(speed), 1e-3);
  if (wantCurl) n.curl = blend(n.curl, curl, 1e-4);
  if (wantP) n.press = blend(n.press, pAbs, 1e-6);
  if (wantGrad) n.grad = blend(n.grad, Math.sqrt(grad), 1e-7);
  if (wantQ) n.q = blend(n.q, q, 1e-7);
  return n;
}

/* Advance the NS solver by `steps` sub-steps of `subDt` each.
 *
 * The free surface has to BRACKET the solver: gravity goes in before the
 * projection so the pressure answers it, and the fraction is advected after, on
 * the velocity field the projection just made divergence free. Advecting it
 * beforehand would move the surface with a velocity that is about to be
 * corrected.
 *
 * This exists as one function because it was two. The live loop had the bracket
 * and the frame recorder called `ns.step` bare, so every exported video of a
 * water scene advanced the flow while the surface stood perfectly still — an
 * export that looks like a broken simulation rather than a broken exporter.
 * Anything that advances the solver goes through here.
 */
function advanceNS(subDt, steps) {
  for (let k = 0; k < steps; k++) {
    if (app.physics === 'water') {
      /* The particle solver runs its own cycle and calls the projection
       * itself — there is no grid advection step to bracket, because the
       * particles ARE the advection. See src/flip.js. */
      app.water.step(subDt, app.ns);
    } else {
      app.ns.step(subDt, PALETTE);
    }
  }
}

function simulate() {
  const { ns, lbm, diag } = app;
  app.sync();
  applyInlets();
  let elapsed;

  if (app.solver === 'lbm') {
    lbm.les = ns.les; lbm.cs = ns.cs; lbm.gravity = ns.gravity * 0.02;
    lbm.steps = Math.max(1, Math.round(app.speed * 6));
    elapsed = lbm.step(PALETTE);
    ns.dyeStep(elapsed);
    diag.forces(lbm.inletSpeed, lbm.viscosity, 1);
    diag.integrals(1, lbm.viscosity, lbm.meanNut, 0.5773502692);
    app.dt = 1;
  } else {
    const uMax = ns.measureMaxSpeed();
    const steps = Math.max(1, Math.ceil(app.speed));
    const scale = app.speed / steps;
    let dt = uMax > 1e-6 ? (app.targetCFL * scale) / uMax : 0.4;
    /* The floor stops a single wild cell freezing the whole simulation, which
     * matters in a tunnel where the flow scale is genuinely set by the inlet.
     *
     * It must NOT apply to a free surface. Gravity accelerates water past any
     * fixed yardstick, and once the floor binds the CFL control stops working
     * altogether — the step stays too big, the advection runs past the limiter
     * it was designed for, speeds grow, and the floor holds the step there. That
     * is a feedback loop, and it was the whole reason a settling tank sat on the
     * speed ceiling: measured, CFL pinned at 2.4 with the peak at the cap, while
     * the same solver without a floor settled at a quarter of that. The hard
     * 1e-4 minimum below is enough to prevent an actual freeze. */
    if (app.physics !== 'water') {
      const dtFloor = 0.1 * (app.targetCFL * scale) / Math.max(referenceSpeed(), 1e-6);
      if (dt < dtFloor) dt = dtFloor;
    }
    dt = Math.min(0.4, Math.max(1e-4, dt));
    app.dt = dt;
    advanceNS(dt, steps);
    ns.dyeStep(dt * steps);
    elapsed = dt * steps;
    diag.forces(ns.inletSpeed, ns.visc, dt);
    diag.integrals(dt, ns.visc, ns.meanNut, app.soundSpeed);
  }

  applyHeldSwirl();
  diag.sample();
  if (app.windTunnel) diag.trackShedding(elapsed, app.solver === 'lbm' ? lbm.inletSpeed : ns.inletSpeed);
  if (app.showParticles) app.parts.advect(elapsed, app.norm);
}

/* Just the field, no overlays. Split out so composeFrame can re-issue it in the
 * same task as a readback; see the note there. */
function drawFieldOnly() {
  const norm = computeNorm(app.mode);
  app.renderer.draw(app.grid, {
    mode: app.mode, stats: norm, theme: app.theme,
    dyeOverlay: app.dyeOverlay && app.mode !== 'dye',
    soundSpeed: app.soundSpeed,
    water: app.physics === 'water' ? app.water.fill : null,
    waterColour: app.theme.light ? [0.12, 0.34, 0.62] : [0.16, 0.42, 0.72],
  });
  return norm;
}

function render() {
  const { grid, overlays, renderer, diag, theme } = app;
  const norm = drawFieldOnly();

  overlays.begin();
  overlays.setMaxSpeed(Math.max(norm.speed, 1e-3));
  const { sx, sy } = layout;

  if (app.showContours) overlays.contours(grid, sx, sy, theme);
  if (app.showStreamlines) overlays.streamlines(grid, sx, sy, theme, app.windTunnel);
  if (app.showVectors) overlays.vectors(grid, sx, sy, theme);
  if (app.showParticles) app.parts.render(overlays.ctx, sx, sy, theme.light, MAPS);
  overlays.inlets(app.inlets, sx, sy);
  if (app.windTunnel && grid.hasSolid) overlays.forceArrows(diag, sx, sy, theme);
  if (app.showGizmos && app.scene.objects.length) {
    overlays.selection(app.scene, sx, sy, theme, { handles: app.mode2 === 'edit', rotOffset: 6 });
  }
  overlays.draft(app.draft, sx, sy, theme);
  if (app.recording) app.drawRecordHUD();
  // Brush ring last among the field overlays, so it is never buried under
  // vectors or streamlines — it tracks the cursor and has to stay findable.
  const br = toolRadius(app.tool, app.brush);
  if (br !== null && app.pointer.over && !app.operator) {
    overlays.brushCursor(app.pointer.x, app.pointer.y, br, sx, sy, theme, {
      dashed: ERASE_TOOLS.has(app.tool),
      // The number is only worth the clutter while it is being changed.
      label: performance.now() < app.brushHintUntil ? `${br.toFixed(br < 10 ? 1 : 0)} cells` : null,
    });
  }
  overlays.colourBar(app.mode, norm, theme);
  overlays.scaleBar(sx, theme, grid.nx);
  if (app.operator) overlays.operatorHint(app.operator.hint, theme);
  else if (app.draft) {
    overlays.operatorHint(PATH_TOOLS.has(app.draft.kind)
      ? 'Click to add points · double-click or right-click to finish · Esc to cancel'
      : 'Drag to size · Shift constrains · Esc to cancel', theme);
  }

  if (app.probe.i > 0 && !app.pointer.down && app.mode2 === 'simulate') {
    overlays.probe(grid, app.probe.i, app.probe.j, sx, sy, theme, null);
  }
}

function updateStatus() {
  const { diag } = app;
  const s = shell.status;
  const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  s.set('fps', String(app.fps));
  s.set('ms', app.frameMs.toFixed(1));
  s.set('grid', `${app.grid.nx}×${app.grid.ny}`);
  s.set('dt', app.solver === 'lbm' ? '1 lu' : f(app.dt, 4));
  s.set('cfl', f(diag.cfl, 2), diag.cfl > 2 ? 'bad' : diag.cfl > 1.2 ? 'warn' : '');
  /* Flag the speed ceiling when it is actually doing something.
   *
   * A choked channel legitimately demands more speed than the grid can carry —
   * verified against a flat-walled control, so it is continuity, not an
   * instability — but pinned at the ceiling that is indistinguishable from a
   * blown-up field. Saying which it is turns a mystery into a reading. */
  const capped = app.solver === 'lbm' ? 0 : (app.ns.capped || 0);
  s.set('umax', f(app.norm.speed, 2), capped > 0 ? 'warn' : '');
  if (capped > 0) {
    // "places", not "cells": the staggered path clamps FACES, so a cell count
    // would be wrong there and the reading is meant to be a magnitude anyway.
    s.message(`Speed limited in ${capped} place${capped === 1 ? '' : 's'} — the flow is `
      + 'choked by the geometry, or the grid is too coarse for it.');
  } else if (app._lastCapped) {
    s.message('');
  }
  app._lastCapped = capped;
  const re = diag.re;
  s.set('re', !isFinite(re) ? '∞' : re > 1000 ? (re / 1000).toFixed(1) + 'k' : re.toFixed(0));
  s.set('cl', f(diag.cl, 3));
  s.set('cd', f(diag.cd, 3));
  s.set('st', diag.strouhal > 0.001 ? f(diag.strouhal, 3) : '—');
  s.set('ke', diag.ke > 100 ? diag.ke.toFixed(0) : f(diag.ke, 3));
  s.set('regime', diag.regime);

  /* Aerodynamic coefficients need a free stream to be referred to, which is
   * what the wind tunnel provides; water turns the tunnel off, so this hides
   * them there too. In their place go the two numbers that actually diagnose a
   * tank — how much water has leaked away, and whether the flow is sub- or
   * supercritical. */
  const water = app.physics === 'water';
  for (const id of ['re', 'cl', 'cd', 'st']) s.show(id, app.windTunnel && !water);
  for (const id of ['vol', 'fr']) s.show(id, water);
  if (water) {
    const target = app.water.targetVolume;
    const drift = target > 0 ? (app.water.volume() - target) / target : 0;
    s.set('vol', `${(drift * 100).toFixed(1)}%`, Math.abs(drift) > 0.05 ? 'warn' : '');
    // Fr = u / sqrt(gH): below 1 the surface can carry information upstream.
    const fr = app.norm.speed / Math.max(referenceSpeed(), 1e-6);
    s.set('fr', f(fr, 2), fr > 1 ? 'warn' : '');
  }
}

let last = performance.now();
function loop(now) {
  const dtMs = now - last; last = now;
  app._fpsN++; app._fpsT += dtMs;
  if (app._fpsT >= 500) { app.fps = Math.round(app._fpsN * 1000 / app._fpsT); app._fpsT = 0; app._fpsN = 0; }

  const t0 = performance.now();
  if (app.running && app.mode2 === 'simulate') { app.frame++; simulate(); }
  render();
  app.frameMs = app.frameMs * 0.9 + (performance.now() - t0) * 0.1;

  if (app.frame % 4 === 0 || !app.running) updateStatus();
  shell.outliner.sync();
  requestAnimationFrame(loop);
}

/* ── pointer ──────────────────────────────────────────────────────────── */

function toGrid(e) {
  const rect = fieldCanvas.getBoundingClientRect();
  const { nx, ny } = app.grid;
  return {
    x: ((e.clientX - rect.left) / rect.width) * nx + 0.5,
    y: ((e.clientY - rect.top) / rect.height) * ny + 0.5,
  };
}

const DRAG_TOOLS = new Set(['draw-rect', 'draw-circle']);
const PATH_TOOLS = new Set(['draw-poly', 'draw-wall']);

/* Effective reach of each radius tool, in cells.
 *
 * These are the SAME expressions the tools themselves use, kept together so the
 * cursor ring and the click cannot drift apart — a ring that lies about what a
 * click will do is worse than no ring. Tools absent from this map draw no ring.
 */
const TOOL_RADIUS = {
  'water-add': b => b,                    // add water
  'water-del': b => b,                    // remove water
  'paint': b => b,                        // push fluid
  'sketch': b => Math.max(1, b * 0.85),   // paint solid
  'sketch-erase': b => Math.max(1, b * 0.85),
  'inlet': b => Math.max(2, b * 0.6),     // emitter footprint
  'erase-inlet': b => b,                  // hit radius for picking an emitter
  'draw-wall': b => Math.max(1, b * 0.5), // half the wall thickness
};
const ERASE_TOOLS = new Set(['sketch-erase', 'erase-inlet', 'water-del']);

/* How much fill one water-brush stamp lays down.
 *
 * At 0.5 a single stroke saturated every cell it touched, so the brush conjured
 * a solid block of water in mid-air. That block then free-falls and lands as a
 * water hammer: measured, the peak speed sat on the ceiling for nine seconds
 * afterwards. Building the water up over several passes is both gentler on the
 * solver and closer to what the tool is for. */
const WATER_RATE = 0.12;
export const toolRadius = (tool, brush) =>
  (TOOL_RADIUS[tool] ? TOOL_RADIUS[tool](brush) : null);

function snap(v) { return app.snapGrid ? T.snapValue(v, app.snapStep) : v; }

/* Turn the in-progress draft into a real object. */
function commitDraft() {
  const d = app.draft;
  app.draft = null;
  if (!d) return;
  let obj = null;

  if (d.kind === 'draw-rect') {
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 1 || h < 1) return;
    obj = Shapes.rect((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, w, h, { name: 'Rectangle' });
  } else if (d.kind === 'draw-circle') {
    const rx = Math.abs(d.x1 - d.x0) / 2, ry = Math.abs(d.y1 - d.y0) / 2;
    if (rx < 0.5 || ry < 0.5) return;
    obj = Shapes.ellipse((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, rx, ry, { name: 'Ellipse' });
  } else if (d.kind === 'draw-poly') {
    if (d.pts.length < 6) return;                    // fewer than three vertices
    obj = Shapes.polygonAbs(d.pts, { name: 'Polygon' });
  } else if (d.kind === 'draw-wall') {
    if (d.pts.length < 4) return;
    let cx = 0, cy = 0;
    for (let i = 0; i < d.pts.length; i += 2) { cx += d.pts[i]; cy += d.pts[i + 1]; }
    cx /= d.pts.length / 2; cy /= d.pts.length / 2;
    const rel = d.pts.map((v, i) => (i % 2 === 0 ? v - cx : v - cy));
    obj = Shapes.wall(cx, cy, rel, Math.max(1, app.brush * 0.5), { name: 'Wall' });
  }

  if (!obj) return;
  app.scene.add(obj);
  app.scene.select(obj.id);
  app.commitScene(`draw ${obj.type}`);
  app.reraster();
  app.onSelectionChanged();
}

function cancelDraft() {
  if (!app.draft) return false;
  app.draft = null;
  return true;
}

function bindPointer() {
  fxCanvas.addEventListener('pointerdown', e => {
    fxCanvas.setPointerCapture(e.pointerId);
    const g = toGrid(e);
    const p = app.pointer;
    p.down = true; p.x = p.px = p.startX = g.x; p.y = p.py = p.startY = g.y;

    // A modal operator swallows the click as its confirmation.
    if (app.operator) { endOperator(true); e.preventDefault(); return; }

    const tool = app.tool;

    if (PATH_TOOLS.has(tool)) {
      if (!app.draft || app.draft.kind !== tool) app.draft = { kind: tool, pts: [] };
      app.draft.pts.push(snap(g.x), snap(g.y));
      e.preventDefault();
      return;
    }
    if (DRAG_TOOLS.has(tool)) {
      app.draft = { kind: tool, x0: snap(g.x), y0: snap(g.y), x1: snap(g.x), y1: snap(g.y) };
      e.preventDefault();
      return;
    }
    if (tool === 'fill') { floodFill(g.x, g.y); e.preventDefault(); return; }
    if (tool === 'erase-obj') {
      const hit = app.scene.pick(g.x, g.y);
      if (hit) {
        app.scene.remove(hit.id);
        app.commitScene('erase object');
        app.reraster(); app.onSelectionChanged();
      }
      e.preventDefault();
      return;
    }
    if (tool === 'water-add' || tool === 'water-del') {
      app.water.paint(g.x, g.y, app.brush, tool === 'water-add' ? WATER_RATE : -WATER_RATE);
      e.preventDefault();
      return;
    }
    if (tool === 'sketch' || tool === 'sketch-erase') {
      strokeSketch(g.x, g.y, g.x, g.y, tool === 'sketch-erase');
      e.preventDefault();
      return;
    }
    if (tool === 'erase-inlet') {
      const hit = app.scene.objects.filter(o => o.boundary === 'inlet')
        .find(o => Math.hypot(o.transform.x - g.x, o.transform.y - g.y) < app.brush);
      if (hit) { app.scene.remove(hit.id); app.commitScene('remove emitter'); app.reraster(); app.onSelectionChanged(); }
      e.preventDefault();
      return;
    }

    if (tool === 'select') {
      const box = app.scene.selectionBounds();
      const handle = box ? T.hitHandle(box, g.x, g.y, 3, 6) : null;
      if (handle) { p.mode = 'handle'; p.handle = handle; p.box = box; snapshotSelection(); }
      else {
        const hit = app.scene.pick(g.x, g.y);
        if (hit) {
          if (!app.scene.selection.has(hit.id)) app.scene.select(hit.id, e.shiftKey);
          else if (e.shiftKey) app.scene.selection.delete(hit.id);
          p.mode = 'move'; snapshotSelection();
        } else { app.scene.selection.clear(); p.mode = null; }
        app.onSelectionChanged();
      }
      e.preventDefault();
      return;
    }

    if (tool === 'paint') app.paintColour = (app.paintColour + 1) % PALETTE.length;
    if (tool === 'inlet') app.inletColour = (app.inletColour + 1) % PALETTE.length;
    e.preventDefault();
  });

  /* Scroll to resize the active brush.
   *
   * Multiplicative, not additive: the radius spans 1 to 60 cells, and a fixed
   * increment is either unusably coarse at the bottom or glacial at the top.
   * A constant ratio per notch gives the same felt sensitivity everywhere.
   *
   * Only bound for tools that HAVE a radius, so the wheel keeps its normal
   * meaning elsewhere, and passive:false because the default action has to be
   * suppressed or the page scrolls underneath.
   */
  fxCanvas.addEventListener('wheel', e => {
    if (toolRadius(app.tool, app.brush) === null) return;
    e.preventDefault();
    const notches = e.deltaMode === 1 ? e.deltaY : e.deltaY / 100;
    app.brush = Math.max(1, Math.min(60, app.brush * Math.pow(1.14, -notches)));
    app.brushHintUntil = performance.now() + 1100;
    // NOT app.dirty — that flag means "the project has unsaved changes" and
    // arms the beforeunload prompt. The render loop draws every frame anyway,
    // so nothing here needs to request a redraw.
    shell?.props.invalidate('tool');
  }, { passive: false });

  fxCanvas.addEventListener('pointerenter', () => { app.pointer.over = true; });
  fxCanvas.addEventListener('pointerleave', () => { app.pointer.over = false; });

  fxCanvas.addEventListener('pointermove', e => {
    const g = toGrid(e);
    const p = app.pointer;
    p.over = true;
    p.px = p.x; p.py = p.y; p.x = g.x; p.y = g.y;
    app.probe.i = Math.round(g.x); app.probe.j = Math.round(g.y);

    if (app.operator) { updateOperator(g); return; }

    // Path tools track the cursor between clicks, with no button held.
    if (app.draft && PATH_TOOLS.has(app.draft.kind)) { app.draft.cx = g.x; app.draft.cy = g.y; return; }
    if (!p.down) return;

    if (app.draft && DRAG_TOOLS.has(app.draft.kind)) {
      app.draft.x1 = snap(g.x); app.draft.y1 = snap(g.y);
      if (e.shiftKey) {                      // constrain to a square / circle
        const s = Math.max(Math.abs(app.draft.x1 - app.draft.x0), Math.abs(app.draft.y1 - app.draft.y0));
        app.draft.x1 = app.draft.x0 + Math.sign(app.draft.x1 - app.draft.x0 || 1) * s;
        app.draft.y1 = app.draft.y0 + Math.sign(app.draft.y1 - app.draft.y0 || 1) * s;
      }
      e.preventDefault();
      return;
    }

    if (p.mode === 'move') {
      let dx = snap(g.x - p.startX), dy = snap(g.y - p.startY);
      for (const o of app.scene.selected()) {
        const base = p.snapshot.get(o.id);
        o.transform.x = base.x + dx; o.transform.y = base.y + dy;
      }
      app.scene.revision++; app.reraster();
    } else if (p.mode === 'handle') {
      if (p.handle === 'rot') {
        const cx = (p.box.minX + p.box.maxX) / 2, cy = (p.box.minY + p.box.maxY) / 2;
        const a0 = Math.atan2(p.startY - cy, p.startX - cx);
        const a1 = Math.atan2(g.y - cy, g.x - cx);
        let deg = (a1 - a0) * 180 / Math.PI;
        if (e.ctrlKey) deg = Math.round(deg / 15) * 15;
        for (const o of app.scene.selected()) {
          const base = p.snapshot.get(o.id);
          o.transform.x = base.x; o.transform.y = base.y; o.transform.rot = base.rot;
          T.rotateAbout(o, deg, cx, cy);
        }
      } else {
        const d = T.handleDrag(p.box, p.handle, g.x, g.y, { uniform: e.shiftKey });
        for (const o of app.scene.selected()) {
          const base = p.snapshot.get(o.id);
          o.transform.x = base.x; o.transform.y = base.y;
          o.transform.sx = base.sx; o.transform.sy = base.sy;
          T.scaleAbout(o, d.fx, d.fy, d.pivotX, d.pivotY);
        }
      }
      app.scene.revision++; app.reraster();
    } else if (app.tool === 'paint') {
      const dx = p.x - p.px, dy = p.y - p.py;
      const mag = Math.hypot(dx, dy);
      if (mag > 1e-4) paintBrush(g.x, g.y, dx / mag, dy / mag, mag);
    } else if (app.tool === 'water-add' || app.tool === 'water-del') {
      // Stamp along the drag so a fast stroke does not leave gaps, the same way
      // the solid brush does.
      const dist = Math.hypot(g.x - p.px, g.y - p.py);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, app.brush * 0.4)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        app.water.paint(p.px + (g.x - p.px) * t, p.py + (g.y - p.py) * t,
          app.brush, (app.tool === 'water-add' ? WATER_RATE : -WATER_RATE) / steps);
      }
    } else if (app.tool === 'sketch' || app.tool === 'sketch-erase') {
      strokeSketch(p.px, p.py, g.x, g.y, app.tool === 'sketch-erase');
    }
    e.preventDefault();
  });

  fxCanvas.addEventListener('pointerup', e => {
    const p = app.pointer;
    if (!p.down) return;
    if (app.draft && DRAG_TOOLS.has(app.draft.kind)) commitDraft();
    else if (p.mode === 'move' || p.mode === 'handle') {
      app.commitScene(p.mode === 'move' ? 'move' : 'transform');
      app.onSelectionChanged();
    } else if (app.tool === 'inlet') {
      addInletFromDrag(p.startX, p.startY, toGrid(e).x, toGrid(e).y);
    } else if (app.tool === 'sketch' || app.tool === 'sketch-erase') {
      app.scenario = null;
      app.commitScene(app.tool === 'sketch' ? 'paint solid' : 'erase solid');
    }
    p.down = false; p.mode = null; p.handle = null;
  });

  // Double-click closes a polygon or wall.
  fxCanvas.addEventListener('dblclick', e => {
    if (app.draft && PATH_TOOLS.has(app.draft.kind)) { commitDraft(); e.preventDefault(); }
  });

  fxCanvas.addEventListener('pointercancel', () => { app.pointer.down = false; app.pointer.mode = null; });
  fxCanvas.addEventListener('pointerleave', () => { app.probe.i = -1; app.probe.j = -1; });
  fxCanvas.addEventListener('contextmenu', e => {
    // Right-click finishes a path, which is what every vector editor does.
    if (app.draft && PATH_TOOLS.has(app.draft.kind)) commitDraft();
    e.preventDefault();
  });
}

function snapshotSelection() {
  const m = new Map();
  for (const o of app.scene.selected()) m.set(o.id, { ...o.transform });
  app.pointer.snapshot = m;
}

/* ── modal transform operators (Blender G / R / S) ────────────────────── */

/* Returns false when there is nothing to transform, so the caller can fall
 * through to the tool shortcut that shares the key. G/R/S keep their Blender
 * meaning whenever a selection exists, which is the only time they are
 * ambiguous — with nothing selected they had no useful meaning anyway. */
function startOperator(kind) {
  if (app.mode2 !== 'edit' || !app.scene.selection.size) return false;
  snapshotSelection();
  const box = app.scene.selectionBounds();
  app.operator = {
    kind, box,
    origin: { x: app.pointer.x, y: app.pointer.y },
    hint: { move: 'Move — click to confirm, Esc to cancel', rotate: 'Rotate — Ctrl for 15° steps', scale: 'Scale — Shift for uniform' }[kind],
  };
}

function updateOperator(g) {
  const op = app.operator;
  if (!op) return;
  const cx = (op.box.minX + op.box.maxX) / 2, cy = (op.box.minY + op.box.maxY) / 2;
  for (const o of app.scene.selected()) {
    const base = app.pointer.snapshot.get(o.id);
    if (!base) continue;
    o.transform.x = base.x; o.transform.y = base.y;
    o.transform.rot = base.rot; o.transform.sx = base.sx; o.transform.sy = base.sy;
    if (op.kind === 'move') {
      let dx = g.x - op.origin.x, dy = g.y - op.origin.y;
      if (app.snapGrid) { dx = T.snapValue(dx, app.snapStep); dy = T.snapValue(dy, app.snapStep); }
      o.transform.x += dx; o.transform.y += dy;
    } else if (op.kind === 'rotate') {
      const a0 = Math.atan2(op.origin.y - cy, op.origin.x - cx);
      const a1 = Math.atan2(g.y - cy, g.x - cx);
      T.rotateAbout(o, (a1 - a0) * 180 / Math.PI, cx, cy);
    } else {
      const d0 = Math.hypot(op.origin.x - cx, op.origin.y - cy) || 1;
      const d1 = Math.hypot(g.x - cx, g.y - cy);
      const f = Math.max(0.05, d1 / d0);
      T.scaleAbout(o, f, f, cx, cy);
    }
  }
  app.scene.revision++;
  app.reraster();
}

function endOperator(confirm) {
  const op = app.operator;
  if (!op) return;
  if (!confirm) {
    for (const o of app.scene.selected()) {
      const base = app.pointer.snapshot.get(o.id);
      if (base) Object.assign(o.transform, base);
    }
    app.scene.revision++;
    app.reraster();
  } else {
    app.commitScene(op.kind);
  }
  app.operator = null;
  app.onSelectionChanged();
}

/* ── keymap ───────────────────────────────────────────────────────────── */

function bindKeys() {
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (ctrl) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? app.redo() : app.undo(); return; }
      if (k === 'y') { e.preventDefault(); app.redo(); return; }
      if (k === 's') { e.preventDefault(); e.shiftKey ? app.saveProjectAs() : app.saveProject(); return; }
      if (k === 'o') { e.preventDefault(); app.openProject(); return; }
      if (k === 'n') { e.preventDefault(); app.newProject(); return; }
      if (k === 'r') { e.preventDefault(); app.resetFlow(); return; }
      if (k === 'i') { e.preventDefault(); app.analyseDesign(); return; }
      return;
    }

    if (k === 'escape') {
      if (app.operator) { endOperator(false); return; }
      if (cancelDraft()) return;
      if (!helpBox.hidden) { app.toggleHelp(false); return; }
      return;
    }
    if (k === 'enter' && app.draft) { commitDraft(); return; }

    switch (k) {
      case 'tab': e.preventDefault(); app.setAppMode(app.mode2 === 'edit' ? 'simulate' : 'edit'); return;
      case ' ': e.preventDefault(); app.setRunning(!app.running); return;
      case 'g': startOperator('move'); return;
      /* R and W are claimed by BOTH a global action and a tool, and the global
       * one used to win unconditionally — so the toolbar advertised "(R)" for
       * Rectangle and "(W)" for Add water while neither key did anything of the
       * sort. Falling through to the tool dispatch when the global action does
       * not apply gives each key back to whichever owner is meaningful here:
       * rotate needs something selected, and the wind tunnel is not a thing a
       * tank has. */
      case 'r':
        if (app.mode2 === 'edit' && app.scene.selection.size) { startOperator('rotate'); return; }
        break;
      case 's': if (app.mode2 === 'edit' && app.scene.selection.size) startOperator('scale'); else app.savePNG(); return;
      case 'x': case 'delete': app.deleteSelection(); return;
      case 'd': if (e.shiftKey) { app.duplicateSelection(); } else { app.setOverlay('dyeOverlay', !app.dyeOverlay); } return;
      case 'a': e.altKey ? app.deselectAll() : app.selectAll(); return;
      case 'v': app.setOverlay('showVectors', !app.showVectors); return;
      case 'l': app.setOverlay('showStreamlines', !app.showStreamlines); return;
      case 'p': app.setOverlay('showParticles', !app.showParticles); return;
      case 'w':
        if (app.physics !== 'water') { app.setWindTunnel(!app.windTunnel); return; }
        break;
      case 't': app.togglePanels(); return;
      case 'f11': e.preventDefault(); app.toggleFullscreen(); return;
      case '?': case '/': app.toggleHelp(); return;
    }

    // Tool shortcuts come from the toolbar's own declarations.
    const toolId = shell?.toolForKey(e.key);
    if (toolId) { app.setTool(toolId); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 8) {
      app.setMode(['speed', 'pressure', 'vorticity', 'qcriterion', 'schlieren', 'dye', 'mach', 'density'][n - 1]);
    }
  });

  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    app.queueResize();
  });
  window.addEventListener('beforeunload', e => {
    if (!app.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

function restoreFromURL() {
  let stored = null;
  try { stored = localStorage.getItem('hyperfoam-theme') || localStorage.getItem('cfd-theme'); } catch {}
  const p = new URLSearchParams(location.hash.slice(1));
  app.setTheme(p.get('t') || stored || 'dark');
  if (p.has('g') && GRIDS[p.get('g')]) { app.gridKey = p.get('g'); buildSimulation(app.gridKey); }
  if (p.has('f') && FLUIDS[p.get('f')]) applyFluid(p.get('f'));
  if (p.has('s')) app.solver = p.get('s') === 'lbm' ? 'lbm' : 'ns';
  if (p.has('m') && MODES[p.get('m')] !== undefined) app.mode = p.get('m');
  if (p.has('u')) app.windSpeed = +p.get('u') || app.windSpeed;
  if (p.has('w')) app.windTunnel = p.get('w') === '1';
  app.sync();
  if (p.get('ph') === 'water') app.setPhysics('water');
  const sc = p.get('sc');
  if (sc && SCENARIO_BY_ID[sc]) app.applyScenario(sc);
  else if (!location.hash) app.applyScenario('cylinder');
  else { app.reraster(); resetFlow(); }
}

async function boot() {
  await setupRenderer();
  buildSimulation(app.gridKey);
  shell = buildShell(app);
  restoreFromURL();
  bindPointer();
  bindKeys();
  resize();
  ro.observe(stage);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));
  document.getElementById('backend').textContent = app.renderer.backend;
  app.dirty = false;
  syncAllUI();
  document.getElementById('boot-error').remove();

  /* A handle on the running app, for the console and for browser tests.
   *
   * Everything here is module-private, which is right for the app and wrong for
   * verifying it: a change to the help panel, the tab strip or the mode
   * switching can pass every Node suite and still throw on load, and without a
   * way in there is nothing to check that against. Named rather than `window.app`
   * because that name is already taken — by the #app element, via the DOM's
   * id-to-global rule, which is exactly the sort of collision that makes a
   * debug hook lie to you. */
  window.hyperfoam = app;
  app.__payload = payload;

  requestAnimationFrame(loop);
}

try {
  await boot();
} catch (err) {
  console.error(err);
  const box = document.getElementById('boot-error');
  if (box && box.firstElementChild) {
    box.firstElementChild.innerHTML =
      `<strong>The workbench failed to start.</strong><p>${String(err && err.message || err)}</p>`;
  }
}

