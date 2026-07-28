/* Scene -> solver masks.
 *
 * Produces, for every cell:
 *   solid     0/1 obstacle mask, what the current solver consumes
 *   coverage  fractional SOLID area in [0,1]
 *   bcType    boundary role code from BOUNDARIES, 0 for plain fluid
 *   bcU/bcV   prescribed velocity for moving walls, rotating bodies and inlets
 *   bcK       scalar parameter (porous resistance, outlet pressure)
 *
 * Coverage accumulates only for roles that actually block flow, so it is a
 * fractional indicator of the SAME body the `solid` mask describes. Letting
 * porous regions, inlets and outlets contribute would make grad(coverage) — the
 * smeared surface delta the force integration uses — report a surface where
 * there is no wall, and put drag on a body that is not there.
 *
 * The solver still steps on the binary mask; coverage feeds the force integral,
 * where it replaces a staircase perimeter that overestimates the true one by
 * 4/pi and drifts with resolution. It comes from supersampling the signed
 * distance, which every primitive already provides.
 *
 * Rasterising is bounded to each object's world bounds rather than sweeping
 * the domain per object, so a scene with fifty small buildings costs about as
 * much as one.
 */

import { BOUNDARIES } from './scene.js';
import { sdf, toLocal } from './geometry.js';

/* 4x4 supersampling gives 17 distinct coverage levels. At 2x2 there are only
 * five, and since anything at or above half claims the cell outright, the
 * fractional rim collapses to a single usable level — too coarse to drive the
 * anti-aliased boundary treatment this field exists to feed. */
const SUB = 4;
const DEG = Math.PI / 180;

export class Raster {
  constructor(nx, ny) { this.resize(nx, ny); }

  resize(nx, ny) {
    this.nx = nx; this.ny = ny;
    this.stride = nx + 2;
    const n = (nx + 2) * (ny + 2);
    this.solid = new Uint8Array(n);
    this.coverage = new Float32Array(n);
    this.bcType = new Uint8Array(n);
    this.bcU = new Float32Array(n);
    this.bcV = new Float32Array(n);
    this.bcK = new Float32Array(n);
    this.owner = new Int32Array(n);    // index into scene.objects, -1 for none
    this.revision = -1;
  }

  clear() {
    this.solid.fill(0);
    this.coverage.fill(0);
    this.bcType.fill(0);
    this.bcU.fill(0);
    this.bcV.fill(0);
    this.bcK.fill(0);
    this.owner.fill(-1);
  }

  /* Rebuild from the scene. Returns true if anything changed. */
  build(scene, opts = {}) {
    if (!opts.force && this.revision === scene.revision) return false;
    if (scene.nx !== this.nx || scene.ny !== this.ny) this.resize(scene.nx, scene.ny);
    this.clear();

    const { nx, ny, stride: s } = this;
    const inv = 1 / SUB;

    for (let oi = 0; oi < scene.objects.length; oi++) {
      const obj = scene.objects[oi];
      if (!obj.visible) continue;
      const role = BOUNDARIES[obj.boundary] || BOUNDARIES.noslip;

      const b = objBounds(obj);
      const i0 = Math.max(1, Math.floor(b.minX));
      const i1 = Math.min(nx, Math.ceil(b.maxX));
      const j0 = Math.max(1, Math.floor(b.minY));
      const j1 = Math.min(ny, Math.ceil(b.maxY));
      if (i1 < i0 || j1 < j0) continue;

      const bc = obj.bcParams || {};
      const t = obj.transform;
      const isRot = obj.boundary === 'rotating';
      // Normalise spin by the body's own radius so `omega` reads as tip speed
      // relative to the freestream. Expressing it as radians per unit time
      // instead would make the same slider value mean something different for
      // every size of body.
      const radius = isRot ? Math.max(1, 0.5 * Math.min(b.maxX - b.minX, b.maxY - b.minY)) : 1;
      const omega = isRot ? (bc.omega || 0) / radius : 0;
      let vx = 0, vy = 0;
      if (obj.boundary === 'moving' || obj.boundary === 'inlet') {
        const a = (bc.direction || 0) * DEG;
        vx = Math.cos(a) * (bc.speed ?? 1);
        vy = Math.sin(a) * (bc.speed ?? 1);
      }
      const k = obj.boundary === 'porous' ? (bc.resistance ?? 0.5)
        : obj.boundary === 'outlet' ? (bc.pressure ?? 0) : 0;

      // A paint layer is already cell-aligned, so supersampling it would take
      // sixteen samples per cell to reproduce the one bit that is there.
      if (obj.type === 'sketch') {
        const { w, h, data } = obj.params;
        for (let j = 1; j <= Math.min(ny, h); j++) {
          const jS = j * s, row = (j - 1) * w;
          for (let i = 1; i <= Math.min(nx, w); i++) {
            if (!data[row + i - 1]) continue;
            const idx = i + jS;
            if (role.solid) this.coverage[idx] = 1;
            this.owner[idx] = oi;
            this.bcType[idx] = role.code;
            this.solid[idx] = role.solid ? 1 : 0;
          }
        }
        continue;
      }

      for (let j = j0; j <= j1; j++) {
        const jS = j * s;
        for (let i = i0; i <= i1; i++) {
          // Fractional coverage by supersampling the distance field.
          let hits = 0;
          for (let sy = 0; sy < SUB; sy++) {
            for (let sx = 0; sx < SUB; sx++) {
              const px = i + (sx + 0.5) * inv - 0.5;
              const py = j + (sy + 0.5) * inv - 0.5;
              if (sdf(obj, px, py) <= 0) hits++;
            }
          }
          if (!hits) continue;
          const cov = hits / (SUB * SUB);
          const idx = i + jS;

          if (role.solid && cov > this.coverage[idx]) this.coverage[idx] = cov;
          // Majority coverage claims the cell. Later objects win ties, which
          // matches the outliner's top-of-list-draws-last ordering.
          if (cov < 0.5) continue;

          this.owner[idx] = oi;
          this.bcType[idx] = role.code;
          this.solid[idx] = role.solid ? 1 : 0;

          if (isRot) {
            // Rigid rotation about the object's origin. Screen y is down, so a
            // positive omega reads as clockwise.
            const rx = i - t.x, ry = j - t.y;
            this.bcU[idx] = -omega * ry;
            this.bcV[idx] = omega * rx;
          } else {
            this.bcU[idx] = vx;
            this.bcV[idx] = vy;
          }
          this.bcK[idx] = k;
        }
      }
    }

    this.revision = scene.revision;
    return true;
  }

  /* Copy the obstacle mask and wall velocities into a Grid.
   * `scale` converts the stored dimensionless velocities (multiples of the
   * reference speed) into the solver's units. */
  applyTo(grid, scale = 1, extraSolid = null) {
    const solid = grid.solid;
    const cov = grid.coverage;
    let moving = false, porousAny = false, slipAny = false, fieldAny = false;
    let covAny = false;
    for (let i = 0; i < solid.length; i++) {
      const s = extraSolid ? (this.solid[i] | extraSolid[i]) : this.solid[i];
      solid[i] = s ? 1 : 0;
      // An extraSolid cell has no fractional area of its own — it comes from a
      // cell-aligned mask — so it counts as fully covered. Leaving it at zero
      // would punch a hole in the surface delta and lose the force on it.
      const c = (extraSolid && extraSolid[i]) ? 1 : this.coverage[i];
      cov[i] = c;
      if (c > 0) covAny = true;
      if (s && this.bcType[i] >= 3 && this.bcType[i] <= 4) {
        grid.bcU[i] = this.bcU[i] * scale;
        grid.bcV[i] = this.bcV[i] * scale;
        if (grid.bcU[i] || grid.bcV[i]) moving = true;
      } else {
        grid.bcU[i] = 0;
        grid.bcV[i] = 0;
      }
      // Porous cells stay fluid; only their resistance is recorded.
      grid.bcType[i] = this.bcType[i];
      grid.bcK[i] = this.bcK[i];
      if (s && this.bcType[i] === BOUNDARIES.slip.code) slipAny = true;
      if (!s && (this.bcType[i] === BOUNDARIES.outlet.code || this.bcType[i] === BOUNDARIES.symmetry.code)) fieldAny = true;
      const k = (!s && this.bcType[i] === BOUNDARIES.porous.code) ? this.bcK[i] : 0;
      grid.porous[i] = k;
      if (k > 0) porousAny = true;
    }
    // Slivers first: sealing a notch can complete the wall round a pocket, and
    // the pocket test should see the finished geometry.
    sealSlivers(grid);
    fillEnclosedPockets(grid);
    grid.hasMovingWall = moving;
    grid.hasCoverage = covAny;
    grid.hasPorous = porousAny;
    grid.hasSlip = slipAny;
    grid.hasFieldBC = fieldAny;
    grid.refreshSolidFlag();
    return grid.hasSolid;
  }

  stats() {
    let solid = 0, partial = 0, bc = 0;
    for (let i = 0; i < this.solid.length; i++) {
      if (this.solid[i]) solid++;
      else if (this.coverage[i] > 0) partial++;
      if (this.bcType[i] && !this.solid[i]) bc++;
    }
    return { solid, partial, nonSolidBC: bc };
  }
}

/* Fill fluid that is completely walled in.
 *
 * A pocket enclosed by solid exchanges nothing with the rest of the domain: no
 * mass, no momentum, and the outer flow sees the same boundary whether it is
 * there or not. It is, for every purpose this app serves, part of the obstacle.
 *
 * Leaving it as fluid is actively harmful. Its pressure problem is all-Neumann
 * and singular, and the projection is not exactly consistent (limitation 3), so
 * the divergence it cannot remove has nowhere to flush and compounds instead.
 * Measured: painting a closed ring around moving fluid in a tunnel amplified it
 * about 1.35x per step — 0.7 to the speed ceiling within fifteen steps — and no
 * damping gentle enough to look like fluid can beat that. Meshers discard
 * disconnected fluid zones for the same reason.
 *
 * The test is reachability from the domain border, NOT from an outlet, so this
 * behaves in a closed box too: there the bulk fluid touches the border and is
 * kept, while a pocket someone draws inside it is filled.
 */
function fillEnclosedPockets(grid) {
  const { nx, ny, stride: s, size, solid, coverage } = grid;
  const seen = new Uint8Array(size);
  const stack = new Int32Array(size);
  let top = 0;

  const push = idx => { if (!solid[idx] && !seen[idx]) { seen[idx] = 1; stack[top++] = idx; } };
  for (let i = 1; i <= nx; i++) { push(i + s); push(i + ny * s); }
  for (let j = 1; j <= ny; j++) { push(1 + j * s); push(nx + j * s); }

  while (top > 0) {
    const idx = stack[--top];
    const i = idx % s, j = (idx / s) | 0;
    if (i > 1) push(idx - 1);
    if (i < nx) push(idx + 1);
    if (j > 1) push(idx - s);
    if (j < ny) push(idx + s);
  }

  let filled = 0;
  for (let j = 1; j <= ny; j++) {
    const jS = j * s;
    for (let i = 1; i <= nx; i++) {
      const idx = i + jS;
      if (solid[idx] || seen[idx]) continue;
      solid[idx] = 1;
      if (coverage[idx] < 1) coverage[idx] = 1;
      filled++;
    }
  }
  return filled;
}

/* Fill one-cell notches and enclosed pockets in the solid mask.
 *
 * A fluid cell with three or four solid neighbours is a sliver: there is no
 * flow through it, and the pressure solve cannot handle it. Its Poisson row
 * reduces to `1*p - p_neighbour = div`, which is far stiffer than the
 * five-point stencil the multigrid is tuned for, and — worse — a coarse level
 * marks a cell solid if ANY of its four children is, so the notch DISAPPEARS on
 * every coarse grid. The correction that would relax it does not exist, and two
 * V-cycles of fine-level smoothing cannot converge it alone.
 *
 * Measured: painting a wall across a running tunnel with the round brush left a
 * ragged face — solid reaching i=112 under each disc centre and only i=113
 * between them — and the divergence at those notches grew from 0.4 to 2e5 in
 * fifty steps, taking the whole field with it. Every "drawing broke everything"
 * report traces back to this shape.
 *
 * Sealing costs at most a one-cell change to geometry that was already
 * unresolvable: a channel one cell wide carries no meaningful flow on this
 * grid. Iterated twice because sealing one notch can create another; more
 * passes than that would start eating genuine narrow gaps.
 */
function sealSlivers(grid) {
  const { nx, ny, stride: s, solid, coverage } = grid;
  for (let pass = 0; pass < 2; pass++) {
    let changed = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) continue;
        const n = solid[idx - 1] + solid[idx + 1] + solid[idx - s] + solid[idx + s];
        if (n < 3) continue;
        solid[idx] = 1;
        // Keep coverage consistent with the mask, or the force integral would
        // see a surface where the solver sees none.
        if (coverage[idx] < 1) coverage[idx] = 1;
        changed++;
      }
    }
    if (!changed) break;
  }
}

/* Local copy of geometry.bounds to avoid a circular import through scene.js. */
function objBounds(obj) {
  const P = obj.params, t = obj.transform;
  let hw = 0, hh = 0;
  if (obj.type === 'rect') { hw = P.w * 0.5; hh = P.h * 0.5; }
  else if (obj.type === 'ellipse') { hw = P.rx; hh = P.ry; }
  else {
    const pts = obj.type === 'naca' ? nacaPts(obj) : (P.points || []);
    for (let i = 0; i < pts.length; i += 2) {
      hw = Math.max(hw, Math.abs(pts[i]));
      hh = Math.max(hh, Math.abs(pts[i + 1]));
    }
    if (obj.type === 'polyline') { const h = (P.thickness || 2) * 0.5; hw += h; hh += h; }
  }
  const a = Math.abs((t.rot || 0) * DEG);
  const c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const sw = hw * Math.abs(t.sx || 1), sh = hh * Math.abs(t.sy || 1);
  const ex = sw * c + sh * sn + 1.5;
  const ey = sw * sn + sh * c + 1.5;
  return { minX: t.x - ex, maxX: t.x + ex, minY: t.y - ey, maxY: t.y + ey };
}

function nacaPts(obj) {
  if (obj._outline) return obj._outline;
  // Force the cache through the shared code path so the two never diverge.
  sdf(obj, obj.transform.x, obj.transform.y);
  return obj._outline || [];
}
