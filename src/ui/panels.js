/* Contents of the property tabs.
 *
 * Each builder receives the live app object and writes widgets into a root.
 * They read app state directly and write it back through the app's setters, so
 * there is no shadow copy of the settings to keep in sync — the panel is a view
 * of the app, not a second source of truth for it.
 */

import { numberField, selectField, checkField, button, group, textField, el } from './widgets.js';
import { BOUNDARIES, BOUNDARY_KEYS } from '../scene.js';
import * as T from '../transform.js';
import { PARTICLE_MODES } from '../particles.js';

const FIELD_MODES = [
  { value: 'speed', label: 'Speed  |u|' },
  { value: 'pressure', label: 'Pressure' },
  { value: 'vorticity', label: 'Vorticity' },
  { value: 'qcriterion', label: 'Q-criterion' },
  { value: 'schlieren', label: 'Schlieren' },
  { value: 'dye', label: 'Dye' },
  { value: 'mach', label: 'Mach' },
  { value: 'density', label: 'Density' },
];

export function buildToolTab(root, app) {
  const g = group(root, 'Active tool');
  selectField(g, {
    label: 'Tool', value: app.tool,
    options: [
      { value: 'select', label: 'Select' },
      { value: 'draw-rect', label: 'Rectangle' },
      { value: 'draw-circle', label: 'Circle / ellipse' },
      { value: 'draw-poly', label: 'Polygon' },
      { value: 'draw-wall', label: 'Wall' },
      { value: 'sketch', label: 'Paint solid' },
      { value: 'sketch-erase', label: 'Erase solid' },
      { value: 'fill', label: 'Fill region' },
      { value: 'erase-obj', label: 'Delete object' },
      { value: 'paint', label: 'Push fluid' },
      { value: 'inlet', label: 'Place emitter' },
      { value: 'erase-inlet', label: 'Remove emitter' },
    ],
    onChange: v => app.setTool(v),
  });
  if (app.tool === 'draw-wall') {
    g.append(el('p', 'note', 'Wall thickness follows the brush radius below.'));
  }
  numberField(g, {
    label: 'Radius', value: app.brush, min: 1, max: 60, step: 0.5, precision: 0, unit: ' cells',
    hint: 'Brush radius in grid cells. Circular in grid space because cells are square.',
    onChange: v => { app.brush = v; },
  });
  if (app.tool === 'paint') {
    numberField(g, {
      label: 'Swirl', value: app.swirl, min: 0, max: 1, step: 0.05, precision: 2,
      hint: 'Bends the push into rotation. At 0 the brush drives fluid along the '
          + 'stroke; at 1 it drives every cell around the brush centre. Cyclones '
          + 'want most of the way up but not all: a little inflow feeds the core, '
          + 'which pure rotation does not. Hold still to keep winding it up.',
      onChange: v => { app.swirl = v; app.refreshTool(); },
    });
    if (app.swirl > 0) {
      selectField(g, {
        label: 'Rotation', value: String(app.swirlDir),
        options: [{ value: '1', label: 'Clockwise' }, { value: '-1', label: 'Anticlockwise' }],
        onChange: v => { app.swirlDir = Number(v); },
      });
    }
  }
  numberField(g, {
    label: 'Strength', value: app.force, min: 5, max: 400, step: 2, precision: 0,
    hint: 'How hard the push tool drives the flow, as a fraction of the reference speed. It relaxes the flow toward a target velocity, so it cannot overshoot.',
    onChange: v => { app.force = v; },
  });

  const sn = group(root, 'Snapping', false);
  checkField(sn, {
    label: 'Snap to grid', value: app.snapGrid,
    hint: 'Round positions to whole cells while dragging.',
    onChange: v => { app.snapGrid = v; },
  });
  numberField(sn, {
    label: 'Grid step', value: app.snapStep, min: 1, max: 32, step: 1, precision: 0, unit: ' cells',
    onChange: v => { app.snapStep = v; },
  });
}

export function buildSceneTab(root, app) {
  const g = group(root, 'Domain');
  selectField(g, {
    label: 'Resolution', value: app.gridKey,
    options: Object.keys(app.GRIDS).map(k => ({ value: k, label: k })),
    hint: 'Cells across x by y. Cells are square, so this also sets the domain aspect. Cost scales with the cell count.',
    onChange: v => app.setGrid(v),
  });

  const s = group(root, 'Scenario');
  selectField(s, {
    label: 'Preset', value: app.scenario ? app.scenario.id : '',
    options: [{ value: '', label: '— none —' }, ...app.SCENARIOS.map(x => ({ value: x.id, label: x.label }))],
    hint: 'Each scenario switches the wind tunnel on or off to match the setup it demonstrates.',
    onChange: v => app.applyScenario(v),
  });
  if (app.scenario) {
    const note = el('p', 'note', app.scenario.text);
    s.append(note);
  }

  const stats = group(root, 'Statistics', false);
  const st = app.rasterStats();
  const line = (k, v) => { const r = el('div', 'kv'); r.append(el('span', null, k), el('b', null, v)); stats.append(r); };
  line('Objects', String(app.scene.objects.length));
  line('Solid cells', String(st.solid));
  line('Partial cells', String(st.partial));
  line('Non-solid BC cells', String(st.nonSolidBC));
}

export function buildPhysicsTab(root, app) {
  const g = group(root, 'Solver');
  selectField(g, {
    label: 'Method', value: app.solver,
    options: [{ value: 'ns', label: 'Navier–Stokes' }, { value: 'lbm', label: 'Lattice Boltzmann' }],
    hint: 'Navier-Stokes: pressure projection on the primitive variables. Lattice Boltzmann: a kinetic model on a D2Q9 lattice.',
    onChange: v => app.setSolver(v),
  });
  selectField(g, {
    label: 'Fluid', value: app.fluid,
    options: Object.keys(app.FLUIDS).map(k => ({ value: k, label: k })),
    onChange: v => app.applyFluid(v),
  });
  numberField(g, {
    label: 'Rate', value: app.speed, min: 0.25, max: 4, step: 0.05, precision: 2, unit: '×',
    hint: 'Simulated time per frame. Above 1 the solver sub-steps rather than taking a larger step, so accuracy is preserved and the cost rises instead.',
    onChange: v => { app.speed = v; },
  });
  numberField(g, {
    label: 'Target CFL', value: app.targetCFL, min: 0.25, max: 2.5, step: 0.05, precision: 2,
    hint: 'Cells the fastest fluid crosses per sub-step; the timestep is derived from it. Near 1 the second-order advection works as intended. Much above 2 its limiter rejects corrections and accuracy quietly drops to first order.',
    onChange: v => { app.targetCFL = v; },
  });

  if (app.physics === 'water') {
    const wt = group(root, 'Water');
    numberField(wt, {
      label: 'Gravity', value: app.water.gravity, min: 0, max: 30, step: 0.5, precision: 1,
      hint: 'Downward acceleration in cells per time squared. It sets how fast '
          + 'waves travel and how hard a splash lands.',
      onChange: v => { app.water.gravity = v; },
    });
    numberField(wt, {
      label: 'Depth', value: app.waterFill, min: 0.05, max: 0.95, step: 0.05, precision: 2,
      hint: 'Starting depth as a fraction of the domain height. Changing it '
          + 'refills the tank.',
      onChange: v => app.resetWater(v),
    });
    const row = el('div', 'sf');
    row.append(el('span', 'sf-l', 'Start from'));
    const box = el('div', 'slice-btns');
    row.append(box);
    wt.append(row);
    button(box, { label: 'Still', hint: 'A level tank at the depth above.',
      onClick: () => app.resetWater() });
    button(box, { label: 'Dam', hint: 'A column of water against the left wall, released at once.',
      onClick: () => app.waterPreset('dam') });
    button(box, { label: 'Drop', hint: 'A ball of water above a shallow pool.',
      onClick: () => app.waterPreset('drop') });
    button(wt, { label: 'Empty tank', onClick: () => { app.water.fill.fill(0); app.water.targetVolume = 0; app.water.classify(); } });
    wt.append(el('p', 'note', 'The air is not simulated — to water it is very nearly a '
      + 'constant-pressure vacuum. Use the water brushes in the toolbar to add or remove it.'));
  }

  const w = group(root, 'Wind tunnel');
  checkField(w, {
    label: 'Enabled', value: app.windTunnel,
    hint: 'Uniform inlet left, sponge outflow right, free-slip top and bottom.',
    onChange: v => app.setWindTunnel(v),
  });
  numberField(w, {
    label: 'Inlet speed', value: app.windSpeed, min: 10, max: 400, step: 2, precision: 0,
    hint: 'Freestream velocity in cells per unit time. Raising it raises the Reynolds number proportionally.',
    onChange: v => { app.windSpeed = v; app.sync(); },
  });
  numberField(w, {
    label: 'Viscosity', value: app.ns.visc, min: 0.0005, max: 0.5, step: 0.001, precision: 4, log: true,
    hint: 'Kinematic viscosity in cells squared per unit time. With the inlet speed and body size this sets the Reynolds number shown in the status bar.',
    onChange: v => { app.ns.visc = v; },
  });
  numberField(w, {
    label: 'Buoyancy', value: app.ns.gravity, min: -6, max: 6, step: 0.1, precision: 1,
    hint: 'Vertical body force proportional to local dye concentration.',
    onChange: v => { app.ns.gravity = v; },
  });
}

export function buildNumericsTab(root, app) {
  const t = group(root, 'Turbulence');
  checkField(t, {
    label: 'LES (Smagorinsky)', value: app.ns.les,
    hint: 'Sub-grid model adding turbulent viscosity from the resolved strain rate.',
    onChange: v => { app.ns.les = v; app.lbm.les = v; if (!v) app.grid.nut.fill(0); },
  });
  numberField(t, {
    label: 'Cs', value: app.ns.cs, min: 0.05, max: 0.3, step: 0.005, precision: 3,
    hint: 'Smagorinsky constant. 0.1-0.2 is the usual range.',
    onChange: v => { app.ns.cs = v; app.lbm.cs = v; },
  });
  numberField(t, {
    label: 'Vorticity conf.', value: app.ns.vorticity, min: 0, max: 6, step: 0.1, precision: 1,
    hint: 'Re-injects rotation lost to numerical diffusion. At CFL ~1 the advection keeps vorticity by itself, so very little is needed — too much amplifies cell-scale noise instead of real vortices, and above about 3 the wake starts to speckle.',
    onChange: v => { app.ns.vorticity = v; },
  });

  const d = group(root, 'Dye');
  numberField(d, {
    label: 'Diffusion', value: app.ns.diff, min: 0, max: 0.08, step: 0.001, precision: 3,
    onChange: v => { app.ns.diff = v; },
  });
  numberField(d, {
    label: 'Persistence', value: app.ns.dyeFade, min: 0.9, max: 1, step: 0.001, precision: 3,
    hint: 'Fraction of dye retained per unit time. 1.0 never fades.',
    onChange: v => { app.ns.dyeFade = v; },
  });

  const p = group(root, 'Pressure solve', false);
  checkField(p, {
    label: 'Staggered grid (MAC)', value: app.staggered,
    hint: 'Velocities on cell faces instead of cell centres. The divergence and '
      + 'the pressure gradient are then exact adjoints, so the projection removes '
      + 'the divergence it measures and extra V-cycles converge instead of '
      + 'diverging. Turning it off restores the older collocated scheme, which is '
      + 'less consistent near ragged boundaries and in sealed regions.',
    onChange: v => { app.setStaggered(v); app.resetFlow(); },
  });
  numberField(p, {
    label: 'V-cycles', value: app.ns.cycles, min: 1, max: 4, step: 1, precision: 0,
    hint: 'Multigrid cycles per projection. Two is the practical floor — at one the solve lags the flow and the scheme goes unstable within a few hundred frames.',
    onChange: v => { app.ns.cycles = Math.round(v); app.ns.preCycles = Math.round(v); },
  });
  numberField(p, {
    label: 'Diffusion sweeps', value: app.ns.iters, min: 4, max: 40, step: 1, precision: 0,
    hint: 'Ceiling on relaxation sweeps for implicit diffusion. The actual count adapts to the viscosity.',
    onChange: v => { app.ns.iters = Math.round(v); },
  });

  if (app.solver === 'lbm') {
    const l = group(root, 'Lattice Boltzmann');
    numberField(l, {
      label: 'Relaxation τ', value: app.lbm.tau, min: 0.505, max: 1.8, step: 0.005, precision: 3,
      hint: 'Sets viscosity through nu = (tau - 1/2)/3. Approaching 0.5 raises Reynolds number and shrinks the stability margin.',
      onChange: v => { app.lbm.tau = v; },
    });
    numberField(l, {
      label: 'Sub-steps', value: app.lbm.steps, min: 1, max: 24, step: 1, precision: 0,
      onChange: v => { app.lbm.steps = Math.round(v); },
    });
  }
}

export function buildViewTab(root, app) {
  const g = group(root, 'Field');
  selectField(g, {
    label: 'Show', value: app.mode, options: FIELD_MODES,
    hint: 'Which scalar the colour map shows. Evaluated per output pixel, so it stays smooth when magnified.',
    onChange: v => app.setMode(v),
  });

  const o = group(root, 'Overlays');
  const ov = [
    ['dyeOverlay', 'Dye overlay', 'Composite the dye tracer over the selected field.'],
    ['showVectors', 'Velocity vectors', 'Arrows on a regular lattice, length scaled by speed.'],
    ['showStreamlines', 'Streamlines', 'Integrated along the instantaneous velocity field.'],
    ['showContours', 'Isobars', 'Pressure contours by marching squares.'],
    ['showParticles', 'Particles', 'Massless tracers advected with RK4.'],
    ['showGizmos', 'Selection outlines', 'Show outlines and handles for scene objects.'],
  ];
  for (const [key, label, hint] of ov) {
    checkField(o, { label, value: app[key], hint, onChange: v => app.setOverlay(key, v) });
  }
  // Which scalar the tracers are coloured by — the ParaView convention, where
  // particle colour is an array you choose rather than decoration.
  if (app.showParticles) {
    selectField(o, {
      label: 'Colour by', value: app.parts.mode,
      options: PARTICLE_MODES.map(m => ({ value: m.id, label: m.label })),
      hint: 'Scalar mapped onto the tracers. Signed quantities use a diverging '
          + 'map so the neutral midpoint is exactly zero. "Uniform" is clearest '
          + 'when the field underneath is already colour-mapped.',
      onChange: v => { app.parts.mode = v; },
    });
    numberField(o, {
      label: 'Density', value: app.particleDensity, min: 0.1, max: 1, step: 0.05,
      precision: 2, unit: '×',
      hint: 'Fraction of the tracers drawn. They cost about 2 ms a frame at full '
          + 'density on a large canvas, entirely in proportion to how many there '
          + 'are, so this is the lever if the frame rate matters more than detail.',
      onChange: v => app.setParticleDensity(v),
    });
  }

  const a = group(root, 'Appearance');
  selectField(a, {
    label: 'Theme', value: app.themeName,
    options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
    onChange: v => app.setTheme(v),
  });

  const r = group(root, 'Renderer', false);
  selectField(r, {
    label: 'Backend', value: app.backendPref,
    options: app.RENDER_BACKENDS,
    hint: 'WebGL 2 is the default and works almost everywhere, including managed '
        + 'school devices. WebGPU draws the identical picture through a newer API. '
        + 'Switching takes effect on reload, because a canvas keeps whichever '
        + 'graphics context it is first given.',
    onChange: v => app.setBackend(v),
  });
  const line = (k, v) => { const row = el('div', 'kv'); row.append(el('span', null, k), el('b', null, v)); r.append(row); };
  line('Active', app.renderer.backend);
  if (app.renderer.adapterInfo) {
    const i = app.renderer.adapterInfo;
    if (i.vendor) line('Adapter', [i.vendor, i.architecture].filter(Boolean).join(' '));
  }
  if (app.backendPref === 'webgpu' && app.renderer.backend !== 'webgpu') {
    r.append(el('p', 'note', 'WebGPU was requested but could not start on this device, '
      + 'so WebGL 2 is in use.'));
  }
}

export function buildObjectTab(root, app) {
  const sel = app.scene.selected();
  if (!sel.length) {
    root.append(el('p', 'note', 'No object selected. Pick one in the viewport or the outliner.'));
    return;
  }
  if (sel.length > 1) {
    root.append(el('p', 'note', `${sel.length} objects selected. Transform tools apply to all of them; per-object fields need a single selection.`));
    return;
  }

  const o = sel[0];
  const commit = (label, key) => app.commitScene(label, key);

  const g = group(root, 'Object');
  textField(g, { label: 'Name', value: o.name, onChange: v => { o.name = v || o.name; app.scene.revision++; commit('rename'); } });
  const kind = el('div', 'kv'); kind.append(el('span', null, 'Type'), el('b', null, o.type));
  g.append(kind);

  const t = group(root, 'Transform');
  numberField(t, {
    label: 'X', value: o.transform.x, step: 0.25, precision: 2, unit: ' c',
    onChange: v => { o.transform.x = v; app.scene.revision++; app.reraster(); commit('move', `move:${o.id}`); },
  });
  numberField(t, {
    label: 'Y', value: o.transform.y, step: 0.25, precision: 2, unit: ' c',
    onChange: v => { o.transform.y = v; app.scene.revision++; app.reraster(); commit('move', `move:${o.id}`); },
  });
  numberField(t, {
    label: 'Rotation', value: o.transform.rot, step: 0.5, precision: 1, unit: '°',
    hint: 'Positive rotation lifts the leading edge of a shape lying along +x, so an aerofoil angle of attack maps straight onto it.',
    onChange: v => { o.transform.rot = v; app.scene.revision++; app.reraster(); commit('rotate', `rot:${o.id}`); },
  });

  const m = T.measure(o);
  const d = group(root, 'Dimensions');
  numberField(d, {
    label: 'Width', value: m.w, min: 0.5, step: 0.25, precision: 2, unit: ' c',
    onChange: v => { T.resizeTo(o, v, T.measure(o).h); app.scene.revision++; app.reraster(); commit('resize', `size:${o.id}`); },
  });
  numberField(d, {
    label: 'Height', value: m.h, min: 0.5, step: 0.25, precision: 2, unit: ' c',
    onChange: v => { T.resizeTo(o, T.measure(o).w, v); app.scene.revision++; app.reraster(); commit('resize', `size:${o.id}`); },
  });
  if (o.type === 'rect') {
    numberField(d, {
      label: 'Corner radius', value: o.params.radius || 0, min: 0, max: 40, step: 0.25, precision: 2, unit: ' c',
      onChange: v => { o.params.radius = v; app.scene.revision++; app.reraster(); commit('round corners', `r:${o.id}`); },
    });
  }
  if (o.type === 'naca') {
    numberField(d, {
      label: 'Camber', value: o.params.camber, min: 0, max: 0.09, step: 0.001, precision: 3,
      onChange: v => { o.params.camber = v; delete o._outline; app.scene.revision++; app.reraster(); commit('camber', `c:${o.id}`); },
    });
    numberField(d, {
      label: 'Thickness', value: o.params.thickness, min: 0.04, max: 0.3, step: 0.005, precision: 3,
      onChange: v => { o.params.thickness = v; delete o._outline; app.scene.revision++; app.reraster(); commit('thickness', `t:${o.id}`); },
    });
  }

  const b = group(root, 'Boundary');
  selectField(b, {
    label: 'Role', value: o.boundary,
    options: BOUNDARY_KEYS.map(k => ({ value: k, label: BOUNDARIES[k].label })),
    hint: 'A shape is not intrinsically a wall. The role decides whether its cells block the flow, drive it, or resist it.',
    onChange: v => { app.setBoundary(o, v); },
  });
  const bp = o.bcParams || {};
  const num = (label, key, opts) => numberField(b, {
    label, value: bp[key] ?? 0, precision: 2, step: 0.05, ...opts,
    onChange: v => { bp[key] = v; app.scene.revision++; app.reraster(); commit('boundary', `bc:${o.id}`); },
  });
  if (o.boundary === 'moving' || o.boundary === 'inlet') {
    num('Speed', 'speed', { min: -5, max: 5, hint: 'Multiple of the reference speed.' });
    num('Direction', 'direction', { min: -180, max: 180, step: 1, precision: 0, unit: '°' });
  } else if (o.boundary === 'rotating') {
    num('Angular rate', 'omega', { min: -3, max: 3, hint: 'Positive is clockwise on screen.' });
  } else if (o.boundary === 'porous') {
    num('Resistance', 'resistance', { min: 0, max: 1, hint: '0 is open, 1 is nearly solid.' });
  } else if (o.boundary === 'outlet') {
    num('Pressure', 'pressure', { min: -2, max: 2 });
  }

  const acts = group(root, 'Actions');
  const rowA = el('div', 'btn-row'); acts.append(rowA);
  button(rowA, { label: 'Duplicate', icon: 'plus', hint: 'Shift+D', onClick: () => app.duplicateSelection() });
  button(rowA, { label: 'Delete', icon: 'trash', variant: 'danger', hint: 'X', onClick: () => app.deleteSelection() });
  const rowB = el('div', 'btn-row'); acts.append(rowB);
  button(rowB, { label: 'Mirror H', onClick: () => app.mirrorSelection('h') });
  button(rowB, { label: 'Mirror V', onClick: () => app.mirrorSelection('v') });
}

export function buildArrangeTab(root, app) {
  const n = app.scene.selection.size;
  root.append(el('p', 'note',
    n < 2 ? 'Select two or more objects to align them; three or more to distribute.'
          : `${n} objects selected. Alignment uses the selection's own bounding box.`));

  const al = group(root, 'Align');
  const r1 = el('div', 'btn-row'); al.append(r1);
  button(r1, { label: 'Left', onClick: () => app.alignSelection('left') });
  button(r1, { label: 'Centre', onClick: () => app.alignSelection('cx') });
  button(r1, { label: 'Right', onClick: () => app.alignSelection('right') });
  const r2 = el('div', 'btn-row'); al.append(r2);
  button(r2, { label: 'Top', onClick: () => app.alignSelection('top') });
  button(r2, { label: 'Middle', onClick: () => app.alignSelection('cy') });
  button(r2, { label: 'Bottom', onClick: () => app.alignSelection('bottom') });

  const di = group(root, 'Distribute');
  const r3 = el('div', 'btn-row'); di.append(r3);
  button(r3, { label: 'Horizontally', onClick: () => app.distributeSelection('x') });
  button(r3, { label: 'Vertically', onClick: () => app.distributeSelection('y') });

  const sn = group(root, 'Snapping');
  checkField(sn, {
    label: 'Snap to grid', value: app.snapGrid,
    hint: 'Applies while drawing and while moving.',
    onChange: v => { app.snapGrid = v; },
  });
  numberField(sn, {
    label: 'Grid step', value: app.snapStep, min: 1, max: 32, step: 1, precision: 0, unit: ' cells',
    onChange: v => { app.snapStep = Math.round(v); },
  });
}

/* Purpose-built object creators.
 *
 * A building is a rectangle and an aerofoil is a NACA section, both of which
 * the generic tools can already draw. What these add is the vocabulary: you
 * specify a building by width, height and surface roughness, and a wing by
 * chord, camber and incidence, rather than by dragging a box to the right
 * number of cells and then working out which boundary role means "rough
 * masonry". Roughness maps to a thin porous skin, which is what a rough
 * surface does to the boundary layer.
 */
export function buildAddTab(root, app) {
  const b = group(root, 'Building');
  const bs = app.buildingSpec;
  numberField(b, {
    label: 'Width', value: bs.w, min: 2, max: 200, step: 1, precision: 0, unit: ' cells',
    onChange: v => { bs.w = v; },
  });
  numberField(b, {
    label: 'Height', value: bs.h, min: 2, max: 200, step: 1, precision: 0, unit: ' cells',
    hint: 'Height of the slice through the building, in grid cells.',
    onChange: v => { bs.h = v; },
  });
  numberField(b, {
    label: 'Roughness', value: bs.roughness, min: 0, max: 1, step: 0.02, precision: 2,
    hint: 'Surface roughness, applied as a thin porous skin. 0 is smooth glass, 1 is heavily textured masonry.',
    onChange: v => { bs.roughness = v; },
  });
  selectField(b, {
    label: 'Wall type', value: bs.wall,
    options: [
      { value: 'noslip', label: 'No-slip (solid)' },
      { value: 'porous', label: 'Porous (hedge, screen)' },
    ],
    onChange: v => { bs.wall = v; },
  });
  button(b, { label: 'Add building', icon: 'rect', variant: 'primary', onClick: () => app.addBuilding() });

  const a = group(root, 'Aerofoil');
  const as = app.foilSpec;
  selectField(a, {
    label: 'Section', value: as.preset,
    options: [
      { value: '0012', label: 'NACA 0012 — symmetric' },
      { value: '2412', label: 'NACA 2412 — cambered' },
      { value: '4412', label: 'NACA 4412 — high camber' },
      { value: '0006', label: 'NACA 0006 — thin symmetric' },
      { value: 'custom', label: 'Custom' },
    ],
    onChange: v => { app.setFoilPreset(v); },
  });
  numberField(a, {
    label: 'Chord', value: as.chord, min: 8, max: 300, step: 1, precision: 0, unit: ' cells',
    hint: 'Camber only resolves once the section is large enough. Below roughly 80 cells of chord a 2% camber line falls under one cell and the section reads as symmetric.',
    onChange: v => { as.chord = v; },
  });
  numberField(a, {
    label: 'Angle of attack', value: as.aoa, min: -20, max: 20, step: 0.5, precision: 1, unit: '°',
    onChange: v => { as.aoa = v; },
  });
  numberField(a, {
    label: 'Thickness', value: as.thickness, min: 0.04, max: 0.3, step: 0.005, precision: 3,
    hint: 'Maximum thickness as a fraction of chord. The last two digits of the NACA number.',
    onChange: v => { as.thickness = v; as.preset = 'custom'; },
  });
  numberField(a, {
    label: 'Camber', value: as.camber, min: 0, max: 0.09, step: 0.001, precision: 3,
    hint: 'Maximum camber as a fraction of chord — the first digit of the NACA number.',
    onChange: v => { as.camber = v; as.preset = 'custom'; },
  });
  numberField(a, {
    label: 'Camber position', value: as.camberPos, min: 0.1, max: 0.7, step: 0.05, precision: 2,
    hint: 'Chordwise position of maximum camber — the second digit.',
    onChange: v => { as.camberPos = v; },
  });
  const est = app.foilResolution();
  a.append(el('p', 'note', est.warn
    ? `Camber line sits ${est.camberCells.toFixed(2)} cells off the chord — below about 1.5 cells it will not resolve and the section will read as symmetric. Increase the chord.`
    : `Camber line ${est.camberCells.toFixed(2)} cells off the chord, section ${est.thickCells.toFixed(1)} cells thick. Well resolved.`));
  button(a, { label: 'Add aerofoil', icon: 'wing', variant: 'primary', onClick: () => app.addFoil() });
}

export function buildRenderTab(root, app) {
  const g = group(root, 'Image');
  button(g, { label: 'Save PNG', icon: 'output', hint: 'Export the current viewport (S)', onClick: () => app.savePNG() });

  const r = app.recordSpec;
  const v = group(root, 'Animation');

  selectField(v, {
    label: 'Format', value: r.format,
    options: app.recordFormats(),
    hint: 'MP4 and WebM encode through WebCodecs where available. A PNG sequence always works and is lossless.',
    onChange: x => { r.format = x; },
  });
  numberField(v, {
    label: 'Frame rate', value: r.fps, min: 12, max: 60, step: 1, precision: 0, unit: ' fps',
    hint: 'Output frame rate. The solver is stepped a fixed amount per frame, so this is what the file actually plays at regardless of how fast the simulation runs live.',
    onChange: x => { r.fps = Math.round(x); },
  });
  numberField(v, {
    label: 'Duration', value: r.seconds, min: 0.5, max: 60, step: 0.5, precision: 1, unit: ' s',
    onChange: x => { r.seconds = x; },
  });
  numberField(v, {
    label: 'Sim rate', value: r.scale, min: 0.1, max: 4, step: 0.05, precision: 2, unit: '×',
    hint: 'Simulated time per output frame, relative to the live rate. Below 1 gives slow motion; the flow is fully solved either way.',
    onChange: x => { r.scale = x; },
  });
  selectField(v, {
    label: 'Resolution', value: String(r.height),
    options: app.renderHeights().map(h => ({ value: String(h.value), label: h.label })),
    hint: 'Output size, taken from the domain aspect rather than the window shape. The field shader samples per output pixel, so a larger frame is genuinely sharper, not upscaled.',
    onChange: x => { r.height = parseInt(x, 10); },
  });
  numberField(v, {
    label: 'Quality', value: r.quality, min: 0.2, max: 3, step: 0.1, precision: 1,
    hint: 'Bitrate multiplier. Ignored for PNG sequences, which are lossless.',
    onChange: x => { r.quality = x; },
  });
  checkField(v, {
    label: 'Include overlays', value: r.overlays,
    hint: 'Vectors, streamlines, outlines, colour bar and probe. Off gives a clean field.',
    onChange: x => { r.overlays = x; },
  });
  checkField(v, {
    label: 'Live preview', value: r.preview,
    hint: 'Show each frame in the viewport as it is captured. Costs a little speed because the render waits for a real paint; turn it off for the fastest possible capture.',
    onChange: x => { r.preview = x; },
  });

  const est = app.recordEstimate();
  const det = app.recordDetail();
  const size = est.bytes > 1e9 ? `${(est.bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(est.bytes / 1e6))} MB`;
  v.append(el('p', 'note',
    `${est.frames} frames at ${det.w}×${det.h} (${est.mp.toFixed(1)} MP). Rough estimate: ${size}, ${est.minutes < 1 ? 'under a minute' : `about ${Math.round(est.minutes)} min`}.`));

  if (det.gridLimited) {
    v.append(el('p', 'note',
      `At this size each grid cell covers about ${det.pxPerCell.toFixed(0)} output pixels. The image will be smooth and sharp-edged, but the amount of physical detail is set by the ${app.grid.nx}×${app.grid.ny} grid — raise the grid resolution too if you want finer eddies rather than just a larger picture.`));
  }

  if (app.recording) {
    const bar = el('div', 'kv');
    bar.append(el('span', null, 'Rendering'), el('b', null, `${Math.round(app.recordProgress * 100)}%`));
    v.append(bar);
    button(v, { label: 'Cancel', variant: 'danger', onClick: () => app.cancelRecording() });
  } else {
    button(v, { label: 'Render animation', icon: 'render', variant: 'primary', onClick: () => app.startRecording() });
  }

  const caps = group(root, 'Encoder', false);
  const c = app.recordCaps();
  const line = (k, val) => { const row = el('div', 'kv'); row.append(el('span', null, k), el('b', null, val)); caps.append(row); };
  line('WebCodecs', c.webCodecs ? 'available' : 'not available');
  line('MediaRecorder', c.mediaRecorder ? 'available' : 'not available');
  line('Selected path', c.best);
  caps.append(el('p', 'note',
    'GIF is not offered. At 256 colours it reproduces a continuous field badly and the files are far larger than an equivalent WebM; a PNG sequence is provided instead for assembling elsewhere.'));
}
