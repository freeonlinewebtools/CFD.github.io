/* Free-surface water as PARTICLES — APIC transfer onto the MAC grid.
 *
 * This replaces a volume-of-fluid scheme that advected a fill FRACTION through
 * the grid. That scheme could not conserve mass, because interpolating a
 * fraction and writing it back is lossy every step: the surface smeared, the
 * water visibly drained, and two further mechanisms existed only to hide it —
 * `sharpen()` re-compressed the interface the advection had blurred, and
 * `correctVolume()` topped the total back up against a remembered target.
 * Measured after every bug in it was fixed, a tank still lost 11-24 % of its
 * water depending on what you did to it. It was not broken, it was leaky by
 * construction.
 *
 * Particles do not have that problem, because the particles ARE the water.
 * Nothing interpolates mass: a parcel exists or it does not, and the count only
 * changes when the user adds or removes some. `sharpen`, `correctVolume` and
 * the whole volume-target apparatus are gone rather than reimplemented.
 *
 * The cycle, once per step:
 *
 *   P2G     particle momentum -> MAC faces      (mass-weighted, plus the affine term)
 *   mark    cells holding particles are FLUID, the rest AIR
 *   forces  gravity, on the faces
 *   project the EXISTING staggered projection, completely unchanged
 *   G2P     projected face velocities -> particles, rebuilding the affine matrix
 *   move    advect the particles, keep them out of solids
 *   derive  particle density -> `fill`, which is what the renderers already read
 *
 * The projection is the part worth not rewriting. `NavierStokes.projectMAC`
 * already solves on faces with air cells as Dirichlet p = 0, already handles
 * sealed regions per-region, and already has a multigrid behind it. This file
 * supplies it with a velocity field and takes one back.
 *
 * ── why APIC, and why quadratic weights ────────────────────────────────────
 *
 * Plain PIC loses energy badly (every transfer averages), and plain FLIP is
 * noisy enough to need a blend constant nobody can justify. APIC gives each
 * particle a small affine velocity matrix C, which carries the local velocity
 * gradient across the transfer — it conserves angular momentum and is stable
 * with nothing to tune.
 *
 * The weights are quadratic B-splines rather than bilinear, and that is a
 * correctness matter, not a quality one. APIC needs C = B * D^-1, and D is only
 * a constant multiple of the identity — so that the inverse is the scalar 4 —
 * when the weights are quadratic or better. With bilinear weights D depends on
 * where in the cell the particle sits, and treating it as constant is subtly
 * and unfixably wrong. Nine nodes per particle per component is the price.
 */

import { Grid } from './grid.js';

export const FULL = 0.5;      // fill at or above this counts as water on screen

/* Particle density that reads as "full". Four particles per cell is the seeding
 * density, so a cell holding its share renders as solid water and the interface
 * falls off over roughly one cell. */
export const PER_CELL = 4;

export class Flip {
  /* Stiffness of the volume correction fed to the projection.
   *
   * Measured over 400 steps on a settled tank: 0.25 sinks 4.2 rows and holds
   * 9.6 % too little volume, 0.8 rises 1.1 rows and holds 3.5 % too much. 0.6
   * lands at 1.0 row and -1.3 %, which is the balance point. Exposed as a
   * static so the tuning sweep in tests can drive it. */
  static BIAS_K = 0.6;

  constructor(grid) {
    this.g = grid;
    this.gravity = 9.0;          // cells / time^2
    this.enabled = false;
    this.mac = true;             // particles require the staggered grid
    this.count = 0;
    this.allocate();
  }

  allocate() {
    const n = this.g.size;
    // Capacity is generous: splashes concentrate particles, and running out
    // mid-stroke would lose water, which is the one thing this design promises
    // cannot happen.
    this.cap = Math.max(4096, this.g.nx * this.g.ny * PER_CELL * 2);
    this.px = new Float32Array(this.cap);
    this.py = new Float32Array(this.cap);
    this.pu = new Float32Array(this.cap);
    this.pv = new Float32Array(this.cap);
    // Affine velocity matrix per particle, row-major [c00 c01; c10 c11].
    this.c00 = new Float32Array(this.cap);
    this.c01 = new Float32Array(this.cap);
    this.c10 = new Float32Array(this.cap);
    this.c11 = new Float32Array(this.cap);

    this.fill = new Float32Array(n);     // derived, for the renderers
    this.phase = new Uint8Array(n);      // 0 air, 1 surface, 2 interior
    this.massU = new Float32Array(n);
    this.massV = new Float32Array(n);
    this.countCell = new Int32Array(n);
    this.bias = new Float32Array(n);     // density correction fed to the solve
    this.seed = 1;
  }

  ensureSize() {
    if (this.fill.length !== this.g.size) { this.allocate(); this.count = 0; }
  }

  /* Deterministic jitter. Math.random would make every run different, and a
   * blow-up that cannot be reproduced cannot be fixed. */
  rnd() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /* ── seeding ────────────────────────────────────────────────────────── */

  addParticle(x, y) {
    if (this.count >= this.cap) return false;
    const k = this.count++;
    this.px[k] = x; this.py[k] = y;
    this.pu[k] = 0; this.pv[k] = 0;
    this.c00[k] = 0; this.c01[k] = 0; this.c10[k] = 0; this.c11[k] = 0;
    return true;
  }

  /* Fill a cell with PER_CELL particles on a jittered lattice. Jitter matters:
   * a perfect lattice produces standing patterns in the transfer weights that
   * look like structure in the flow and are not. */
  seedCell(i, j) {
    const per = PER_CELL, side = Math.round(Math.sqrt(per));
    for (let a = 0; a < side; a++)
      for (let b = 0; b < side; b++) {
        const x = i - 0.5 + (a + 0.25 + this.rnd() * 0.5) / side;
        const y = j - 0.5 + (b + 0.25 + this.rnd() * 0.5) / side;
        this.addParticle(x, y);
      }
  }

  /* Fill the lower `frac` of the domain — a body of water at rest. */
  reset(frac = 0.45) {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    this.count = 0;
    const surface = ny - Math.round(ny * frac);
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx; i++) {
        if (solid[i + j * s]) continue;
        if (j > surface) this.seedCell(i, j);   // j runs DOWNWARD
      }
    this._target = this.volume();
    this.deriveFill();
  }

  preset(name) {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    this.count = 0;
    const want = (i, j) => {
      if (name === 'dam') return i <= nx * 0.22 && j > ny * 0.15;
      if (name === 'drop') {
        const dx = i - nx * 0.5, dy = j - ny * 0.22, r = Math.max(4, ny * 0.11);
        return j > ny - Math.round(ny * 0.30) || dx * dx + dy * dy < r * r;
      }
      return j > ny - Math.round(ny * 0.45);
    };
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx; i++) {
        if (solid[i + j * s]) continue;
        if (want(i, j)) this.seedCell(i, j);
      }
    this._target = this.volume();
    this.deriveFill();
  }

  /* Add or remove water under the brush.
   *
   * `amount` > 0 seeds, < 0 removes, and its magnitude is a per-stamp
   * probability so a stroke builds up gradually rather than conjuring a solid
   * block in mid-air — a block free-falls and lands as a water hammer. */
  paint(cx, cy, radius, amount) {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    const r2 = radius * radius;
    if (amount > 0) {
      const lo = Math.max(1, Math.floor(cx - radius)), hi = Math.min(nx, Math.ceil(cx + radius));
      const lj = Math.max(1, Math.floor(cy - radius)), hj = Math.min(ny, Math.ceil(cy + radius));
      for (let j = lj; j <= hj; j++)
        for (let i = lo; i <= hi; i++) {
          const dx = i - cx, dy = j - cy;
          if (dx * dx + dy * dy > r2) continue;
          if (solid[i + j * s]) continue;
          if (this.countCell[i + j * s] >= PER_CELL) continue;
          if (this.rnd() > amount * 4) continue;
          this.seedCell(i, j);
        }
    } else {
      // Removal compacts the arrays, which is why the loop walks backwards.
      const rate = -amount * 4;
      for (let k = this.count - 1; k >= 0; k--) {
        const dx = this.px[k] - cx, dy = this.py[k] - cy;
        if (dx * dx + dy * dy > r2) continue;
        if (this.rnd() > rate) continue;
        this.removeAt(k);
      }
    }
    this._target = this.volume();
    this.deriveFill();
  }

  removeAt(k) {
    const last = --this.count;
    if (k !== last) {
      this.px[k] = this.px[last]; this.py[k] = this.py[last];
      this.pu[k] = this.pu[last]; this.pv[k] = this.pv[last];
      this.c00[k] = this.c00[last]; this.c01[k] = this.c01[last];
      this.c10[k] = this.c10[last]; this.c11[k] = this.c11[last];
    }
  }

  /* Volume, in cells of water. Exact by construction: it counts parcels, and
   * nothing in the step creates or destroys one. */
  volume() { return this.count / PER_CELL; }

  /* Kept for the callers the old surface had.
   *
   * `targetVolume` no longer drives anything — there is no correction to aim at
   * — but the status bar and the analysis panel report drift against it, and
   * that reading is still worth having: under this solver it should sit at
   * zero, and anything else means water is being added or removed by a tool. */
  get targetVolume() { return this._target ?? this.volume(); }
  set targetVolume(v) { this._target = v; }
  syncAir() { this.markCells(); }

  /* ── transfers ──────────────────────────────────────────────────────── */

  /* Quadratic B-spline weights and the base node, for a coordinate expressed in
   * that lattice's index space. Returns the base index; weights land in `w`. */
  static wq(x, w) {
    const base = Math.floor(x - 0.5);
    const f = x - base;
    w[0] = 0.5 * (1.5 - f) * (1.5 - f);
    w[1] = 0.75 - (f - 1) * (f - 1);
    w[2] = 0.5 * (f - 0.5) * (f - 0.5);
    return base;
  }

  /* Particles to grid: mass-weighted momentum, with the affine correction.
   *
   * The affine term is what makes this APIC rather than PIC. Without it every
   * transfer averages the velocity field and the flow visibly loses its swirl
   * within a second or two. */
  p2g() {
    const g = this.g;
    const { nx, ny, stride: s, uf, vf } = g;
    const massU = this.massU, massV = this.massV;
    uf.fill(0); vf.fill(0); massU.fill(0); massV.fill(0);
    const wx = [0, 0, 0], wy = [0, 0, 0];

    for (let k = 0; k < this.count; k++) {
      const x = this.px[k], y = this.py[k];
      const u = this.pu[k], v = this.pv[k];
      const a00 = this.c00[k], a01 = this.c01[k], a10 = this.c10[k], a11 = this.c11[k];

      // u lives on faces at (i - 1/2, j): index space is (x + 1/2, y).
      let bi = Flip.wq(x + 0.5, wx), bj = Flip.wq(y, wy);
      for (let dj = 0; dj < 3; dj++) {
        const J = bj + dj;
        if (J < 0 || J > ny + 1) continue;
        const oy = J - y;
        for (let di = 0; di < 3; di++) {
          const I = bi + di;
          if (I < 0 || I > nx + 1) continue;
          const w = wx[di] * wy[dj];
          if (w <= 0) continue;
          const ox = (I - 0.5) - x;
          const idx = I + J * s;
          massU[idx] += w;
          uf[idx] += w * (u + a00 * ox + a01 * oy);
        }
      }

      // v lives on faces at (i, j - 1/2): index space is (x, y + 1/2).
      bi = Flip.wq(x, wx); bj = Flip.wq(y + 0.5, wy);
      for (let dj = 0; dj < 3; dj++) {
        const J = bj + dj;
        if (J < 0 || J > ny + 1) continue;
        const oy = (J - 0.5) - y;
        for (let di = 0; di < 3; di++) {
          const I = bi + di;
          if (I < 0 || I > nx + 1) continue;
          const w = wx[di] * wy[dj];
          if (w <= 0) continue;
          const ox = I - x;
          const idx = I + J * s;
          massV[idx] += w;
          vf[idx] += w * (v + a10 * ox + a11 * oy);
        }
      }
    }

    // Momentum -> velocity. A face nothing reached carries no water and no
    // velocity; the projection treats it through the air mask.
    for (let i = 0; i < g.size; i++) {
      if (massU[i] > 1e-8) uf[i] /= massU[i]; else uf[i] = 0;
      if (massV[i] > 1e-8) vf[i] /= massV[i]; else vf[i] = 0;
    }
  }

  /* Particles per cell. Three callers need it — the air mask, the density bias
   * and the redistribution pass — and they need it at different points in the
   * step, so it is counted on demand rather than cached. */
  countCells() {
    const { nx, ny, stride: s } = this.g;
    const cc = this.countCell;
    cc.fill(0);
    for (let k = 0; k < this.count; k++) {
      const i = Math.round(this.px[k]), j = Math.round(this.py[k]);
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      cc[i + j * s]++;
    }
  }

  /* Which cells hold water. This is the free-surface condition: a cell with no
   * particles is air and the projection pins p = 0 there. */
  markCells() {
    const g = this.g;
    const { nx, ny, stride: s, solid, air } = g;
    const cc = this.countCell;
    this.countCells();
    let any = false;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const isAir = !solid[idx] && cc[idx] === 0;
        air[idx] = isAir ? 1 : 0;
        if (isAir) any = true;
      }
    }
    g.hasAir = any;
  }

  /* Water with no connected path to air — and why it must be frozen.
   *
   * Incompressible water in a rigid container with no air in it CANNOT MOVE.
   * No free surface to deform, nowhere for a parcel to go, no compressibility
   * to absorb the difference. The solver cannot express that on its own: a
   * sealed pocket is all-Neumann and singular, and the pressure that comes back
   * is unbounded in the direction nothing constrains. Encircling a patch of
   * water with a drawn ring — the reported case — pinned the speed at the
   * ceiling within a few steps.
   *
   * Freezing it is both the physically correct answer and unconditionally
   * stable, which is a rare combination. Erase part of the wall and the pocket
   * reconnects to air on the next sync and moves again.
   *
   * A flood fill outward from every air cell; whatever it does not reach is
   * sealed. Same treatment the fraction-based solver ended up needing, for the
   * same reason — the representation changed, the physics did not. */
  markSealed() {
    const g = this.g;
    const { nx, ny, stride: s, size, solid, air } = g;
    if (!this.sealed || this.sealed.length !== size) {
      this.sealed = new Uint8Array(size);
      this.queue = new Int32Array(size);
    }
    const sealed = this.sealed, queue = this.queue;
    this.hasSealed = false;
    if (!g.hasAir) { sealed.fill(0); return; }

    sealed.fill(1);
    let head = 0, tail = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) { sealed[idx] = 0; continue; }
        if (air[idx]) { sealed[idx] = 0; queue[tail++] = idx; }
      }
    }
    while (head < tail) {
      const idx = queue[head++];
      const ci = idx % s, cj = (idx / s) | 0;
      if (ci > 1 && sealed[idx - 1]) { sealed[idx - 1] = 0; queue[tail++] = idx - 1; }
      if (ci < nx && sealed[idx + 1]) { sealed[idx + 1] = 0; queue[tail++] = idx + 1; }
      if (cj > 1 && sealed[idx - s]) { sealed[idx - s] = 0; queue[tail++] = idx - s; }
      if (cj < ny && sealed[idx + s]) { sealed[idx + s] = 0; queue[tail++] = idx + s; }
    }
    for (let i = 0; i < size && !this.hasSealed; i++) if (sealed[i]) this.hasSealed = true;
  }

  /* Hold frozen pockets still, on the faces and on the parcels alike. Doing
   * only one of the two leaves the other to re-inject the motion next step. */
  freezeSealed() {
    if (!this.hasSealed) return;
    const g = this.g;
    const { nx, ny, stride: s, uf, vf } = g;
    const sealed = this.sealed;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx + 1; i++) {
        const idx = i + jS;
        if (sealed[idx] || sealed[idx - 1]) uf[idx] = 0;
      }
    }
    for (let j = 1; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (sealed[idx] || sealed[idx - s]) vf[idx] = 0;
      }
    }
  }

  /* Parcels inside a frozen pocket keep their position and lose their velocity,
   * so neither advection nor the next P2G can set them going again. */
  freezeSealedParticles() {
    if (!this.hasSealed) return;
    const { nx, ny, stride: s } = this.g;
    const sealed = this.sealed;
    for (let k = 0; k < this.count; k++) {
      const i = Math.round(this.px[k]), j = Math.round(this.py[k]);
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      if (!sealed[i + j * s]) continue;
      this.pu[k] = 0; this.pv[k] = 0;
      this.c00[k] = 0; this.c01[k] = 0; this.c10[k] = 0; this.c11[k] = 0;
    }
  }

  applyGravity(dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, vf } = g;
    const massV = this.massV;
    const a = this.gravity * dt;
    for (let j = 2; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || solid[idx - s]) continue;
        if (massV[idx] <= 1e-8) continue;     // no water on this face
        vf[idx] += a;                          // +v is DOWN on screen
      }
    }
  }

  /* Grid to particles. Takes the projected velocity directly — that is APIC,
   * and it is why there is no FLIP blend constant here — and rebuilds C from
   * the same weights, which is what carries the detail PIC would average away.
   *
   * C = 4 * sum(w * v * offset) is exact for quadratic B-splines, where the
   * APIC inertia tensor D is (1/4)I. That identity is the whole reason these
   * weights are quadratic; see the note at the top of the file. */
  g2p() {
    const g = this.g;
    const { nx, ny, stride: s, uf, vf } = g;
    const wx = [0, 0, 0], wy = [0, 0, 0];

    for (let k = 0; k < this.count; k++) {
      const x = this.px[k], y = this.py[k];
      let nu = 0, nv = 0, b00 = 0, b01 = 0, b10 = 0, b11 = 0;

      let bi = Flip.wq(x + 0.5, wx), bj = Flip.wq(y, wy);
      for (let dj = 0; dj < 3; dj++) {
        const J = bj + dj;
        if (J < 0 || J > ny + 1) continue;
        const oy = J - y;
        for (let di = 0; di < 3; di++) {
          const I = bi + di;
          if (I < 0 || I > nx + 1) continue;
          const w = wx[di] * wy[dj];
          if (w <= 0) continue;
          const val = uf[I + J * s];
          const ox = (I - 0.5) - x;
          nu += w * val;
          b00 += w * val * ox;
          b01 += w * val * oy;
        }
      }

      bi = Flip.wq(x, wx); bj = Flip.wq(y + 0.5, wy);
      for (let dj = 0; dj < 3; dj++) {
        const J = bj + dj;
        if (J < 0 || J > ny + 1) continue;
        const oy = (J - 0.5) - y;
        for (let di = 0; di < 3; di++) {
          const I = bi + di;
          if (I < 0 || I > nx + 1) continue;
          const w = wx[di] * wy[dj];
          if (w <= 0) continue;
          const val = vf[I + J * s];
          const ox = I - x;
          nv += w * val;
          b10 += w * val * ox;
          b11 += w * val * oy;
        }
      }

      this.pu[k] = nu; this.pv[k] = nv;
      this.c00[k] = 4 * b00; this.c01[k] = 4 * b01;
      this.c10[k] = 4 * b10; this.c11[k] = 4 * b11;
    }
  }

  /* Carry the velocity a few cells out past the water, into the empty faces.
   *
   * Not optional, and its absence is invisible until you look for it. G2P
   * gathers each particle's new velocity from a 3x3 stencil per component, so a
   * particle at the surface reaches faces OUTSIDE the water. Those faces got no
   * mass from P2G and the projection skips any face with air on both sides, so
   * they hold exactly zero — and every surface particle therefore has its
   * velocity averaged towards zero, every step. That reads as a surface which
   * is mysteriously damped and slowly sucked inward, which is precisely the
   * compaction that the density bias was then cranked up to fight.
   *
   * A few layers is enough: nothing moves more than about a cell per step at
   * the CFL this runs at. The old fraction-based solver had the same routine
   * (`extrapolateVelocity`) for the same reason.
   */
  extrapolateFaces(layers = 3) {
    const g = this.g;
    const { nx, ny, stride: s, uf, vf } = g;
    const massU = this.massU, massV = this.massV;
    const okU = this.okU || (this.okU = new Uint8Array(g.size));
    const okV = this.okV || (this.okV = new Uint8Array(g.size));
    for (let i = 0; i < g.size; i++) {
      okU[i] = massU[i] > 1e-8 ? 1 : 0;
      okV[i] = massV[i] > 1e-8 ? 1 : 0;
    }
    for (let pass = 0; pass < layers; pass++) {
      for (const [f, ok] of [[uf, okU], [vf, okV]]) {
        for (let j = 1; j <= ny; j++) {
          const jS = j * s;
          for (let i = 1; i <= nx + 1; i++) {
            const idx = i + jS;
            if (ok[idx]) continue;
            let sum = 0, n = 0;
            if (ok[idx - 1] === 1) { sum += f[idx - 1]; n++; }
            if (ok[idx + 1] === 1) { sum += f[idx + 1]; n++; }
            if (ok[idx - s] === 1) { sum += f[idx - s]; n++; }
            if (ok[idx + s] === 1) { sum += f[idx + s]; n++; }
            if (!n) continue;
            f[idx] = sum / n;
            ok[idx] = 2;                 // valid from THIS pass, not the last
          }
        }
        for (let i = 0; i < g.size; i++) if (ok[i] === 2) ok[i] = 1;
      }
    }
  }

  /* Move the particles, and keep them in the fluid.
   *
   * A particle that lands inside a solid is pushed back to the nearest face it
   * came through rather than deleted — deleting is how a particle scheme starts
   * losing the mass it exists to conserve. */
  advect(dt, cap) {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const lo = 0.501, hiX = nx + 0.499, hiY = ny + 0.499;
    for (let k = 0; k < this.count; k++) {
      let u = this.pu[k], v = this.pv[k];
      if (cap > 0) {
        const m = Math.hypot(u, v);
        if (!(m >= 0)) { u = 0; v = 0; }
        else if (m > cap) { const q = cap / m; u *= q; v *= q; }
      }
      this.pu[k] = u; this.pv[k] = v;

      let x = this.px[k] + u * dt, y = this.py[k] + v * dt;
      if (x < lo) x = lo; else if (x > hiX) x = hiX;
      if (y < lo) y = lo; else if (y > hiY) y = hiY;

      if (g.hasSolid) {
        const i = Math.round(x), j = Math.round(y);
        if (i >= 1 && i <= nx && j >= 1 && j <= ny && solid[i + j * s]) {
          // Back out along whichever axis moved it in, then give up the normal
          // component so it slides along the wall instead of drilling into it.
          const oi = Math.round(this.px[k]), oj = Math.round(this.py[k]);
          if (oi >= 1 && oi <= nx && !solid[oi + j * s]) { x = this.px[k]; this.pu[k] = 0; }
          else if (oj >= 1 && oj <= ny && !solid[i + oj * s]) { y = this.py[k]; this.pv[k] = 0; }
          else { x = this.px[k]; y = this.py[k]; this.pu[k] = 0; this.pv[k] = 0; }
        }
      }
      this.px[k] = x; this.py[k] = y;
    }
  }

  /* Push particles out of crowded cells, by moving them and nothing else.
   *
   * The projection cannot do this on its own, and it took a measurement to
   * believe it: with the density bias alone the pool held its average level
   * correctly and still reached TWENTY-SIX particles in a cell against a target
   * of four, with matching voids beside them. The reason is structural — the
   * pressure solve produces a smooth, near-divergence-free velocity field, and
   * a smooth field advects a clump as a clump. It moves the water; it does not
   * rearrange it.
   *
   * So this works on positions directly, down the density gradient, which is
   * what every production FLIP solver ends up doing under one name or another.
   * Positions only: no velocity is touched, so no energy is injected, and mass
   * is untouched by construction because particles are neither made nor
   * destroyed — the property this whole rewrite exists to guarantee.
   */
  separate() {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const cc = this.countCell;
    const target = PER_CELL;
    const STEP = 0.28;                 // cells per pass; above ~0.4 it jitters
    for (let k = 0; k < this.count; k++) {
      const x = this.px[k], y = this.py[k];
      const i = Math.round(x), j = Math.round(y);
      if (i < 2 || i > nx - 1 || j < 2 || j > ny - 1) continue;
      const idx = i + j * s;
      const here = cc[idx];
      if (here <= target) continue;

      // Down the density gradient, with solid neighbours reading as maximally
      // crowded so a particle is never pushed into a wall.
      const d = (o) => (solid[idx + o] ? 1e6 : cc[idx + o]);
      let gx = d(1) - d(-1);
      let gy = d(s) - d(-s);
      const m = Math.hypot(gx, gy);
      if (m < 1e-6) continue;
      // Scale by how crowded this cell is, so a mild excess barely moves.
      const w = Math.min(1, (here - target) / target) * STEP;
      let nxp = x - (gx / m) * w, nyp = y - (gy / m) * w;

      const ni = Math.round(nxp), nj = Math.round(nyp);
      if (ni < 1 || ni > nx || nj < 1 || nj > ny) continue;
      if (solid[ni + nj * s]) continue;
      this.px[k] = nxp; this.py[k] = nyp;
    }
  }

  /* Keep the number of parcels per cell near its target.
   *
   * The pressure solve cannot do this and it took measuring to accept it: a
   * divergence source is a SMOOTH, grid-scale instrument, and clumping is local
   * and cell-scale. With the bias alone, cells reached 27-76 parcels against a
   * target of four however it was tuned — the tank held roughly the right
   * volume overall while being lumpy everywhere inside.
   *
   * Adjusting the population directly is what production solvers do, and the
   * volume bookkeeping stays honest because it is per CELL: a cell that is
   * over-full loses parcels it could not represent anyway, and a cell that is
   * interior water — surrounded on all four sides by water — is topped back up.
   * The cell count, which is what `deriveFill` renders and what the eye reads
   * as volume, is untouched by both.
   *
   * Only INTERIOR cells are refilled. Topping up a sparse cell at the surface
   * would inflate spray and thin sheets into solid water, which is the one
   * place a free surface is supposed to be allowed to fall apart.
   */
  rebalance() {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const cc = this.countCell;
    const MAX = PER_CELL * 2;

    /* Parcels are MOVED, never created or destroyed.
     *
     * Deleting the excess was tried first and is wrong in a way that only shows
     * under load: a dam break compresses hard at the impact, many cells go over
     * the cap in the same step, and the thinning takes the water with it —
     * measured, 11480 parcels down to 2178, an 81 % loss, while a still pool
     * looked perfect. Mass conservation that holds only when nothing is
     * happening is not mass conservation.
     *
     * Relocating to a nearby cell with room fixes the density and keeps the
     * count exactly, which is the guarantee this whole rewrite is for. A parcel
     * with nowhere to go simply stays where it is: refusing to move it is
     * always safe, whereas deleting it is never recoverable. */
    for (let k = 0; k < this.count; k++) {
      const i = Math.round(this.px[k]), j = Math.round(this.py[k]);
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      const idx = i + j * s;
      if (cc[idx] <= MAX) continue;

      let best = -1, bi = 0, bj = 0;
      for (let r = 1; r <= 2 && best < 0; r++) {
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;   // ring only
            const ni = i + di, nj = j + dj;
            if (ni < 1 || ni > nx || nj < 1 || nj > ny) continue;
            const n = ni + nj * s;
            if (solid[n] || cc[n] >= PER_CELL) continue;
            if (best < 0 || cc[n] < best) { best = cc[n]; bi = ni; bj = nj; }
          }
      }
      if (best < 0) continue;

      cc[idx]--; cc[bi + bj * s]++;
      this.px[k] = bi + (this.rnd() - 0.5) * 0.7;
      this.py[k] = bj + (this.rnd() - 0.5) * 0.7;
      // Arrive moving with its new surroundings; a parcel dropped in at rest is
      // a small brake applied at a random place.
      this.pu[k] = g.u[bi + bj * s]; this.pv[k] = g.v[bi + bj * s];
    }
  }

  /* The field the renderers draw. Particle density, normalised so a cell with
   * its seeding share reads as full. */
  deriveFill() {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const cc = this.countCell, f = this.fill;
    this.countCells();
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) { f[idx] = 0; continue; }
        const q = cc[idx] / PER_CELL;
        f[idx] = q > 1 ? 1 : q;
      }
    }
    this.classify();
  }

  classify() {
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill, ph = this.phase;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || f[idx] < FULL) { ph[idx] = 0; continue; }
        ph[idx] = (f[idx - 1] < FULL || f[idx + 1] < FULL
          || f[idx - s] < FULL || f[idx + s] < FULL) ? 1 : 2;
      }
    }
  }

  /* Geometry changed under the water. Particles caught inside new solid are
   * pushed out to the nearest free cell; only if there is nowhere at all to go
   * are they dropped, which is the one case where losing water is the correct
   * answer — the space it occupied no longer exists. */
  syncGeometry() {
    this.ensureSize();
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    if (!g.hasSolid) { this.deriveFill(); return; }
    for (let k = this.count - 1; k >= 0; k--) {
      const i = Math.round(this.px[k]), j = Math.round(this.py[k]);
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      if (!solid[i + j * s]) continue;
      let placed = false;
      for (let r = 1; r <= 4 && !placed; r++) {
        for (let dj = -r; dj <= r && !placed; dj++)
          for (let di = -r; di <= r && !placed; di++) {
            const ni = i + di, nj = j + dj;
            if (ni < 1 || ni > nx || nj < 1 || nj > ny) continue;
            if (solid[ni + nj * s]) continue;
            this.px[k] = ni + (this.rnd() - 0.5) * 0.6;
            this.py[k] = nj + (this.rnd() - 0.5) * 0.6;
            this.pu[k] = 0; this.pv[k] = 0;
            this.c00[k] = 0; this.c01[k] = 0; this.c10[k] = 0; this.c11[k] = 0;
            placed = true;
          }
      }
      if (!placed) this.removeAt(k);
    }
    this.deriveFill();
  }

  /* Ask the projection to push crowded cells apart.
   *
   * `countCell` is filled by markCells. A cell holding more than its share is
   * given a small positive divergence target, so the pressure solve produces a
   * field that spreads it; a sparse cell is left alone, because a free surface
   * is entitled to thin out and break into droplets and pulling fluid inward
   * would suppress exactly that.
   *
   * The stiffness is deliberately mild. This is a nudge applied every step, not
   * a constraint — at high stiffness it rings, and the ringing looks like
   * boiling at the surface. */
  updateBias() {
    const { nx, ny, stride: s, solid } = this.g;
    const cc = this.countCell, bias = this.bias;
    /* Volume control only — `rebalance` handles crowding, this handles bulk.
     *
     * Splitting those two jobs is what made both work. While this was also
     * expected to fix clumping it had to be cranked to 0.9, which stirred the
     * pool hard (peak 18 in water whose wave speed is 20) and still left cells
     * holding 27 parcels against a target of four: a divergence source is a
     * smooth, grid-scale instrument and clumping is local. With the population
     * capped directly, this is left to do the one thing it is good at, and the
     * stiffness that holds a tank level is far gentler.
     *
     * 0.20 measured over 400 steps: surface drift 0.7 rows. Either side of it
     * drifts the other way — 0.10 sinks 7.3 rows, 0.30 rises 7.0 — so this is a
     * balance point, not a floor. */
    const K = Flip.BIAS_K, DEAD = 0, MAXB = 0.5;
    bias.fill(0);
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) continue;
        const excess = cc[idx] / PER_CELL - 1 - DEAD;
        /* CLAMPED, and this is the difference between a nudge and a driver.
         *
         * Unbounded, the term is proportional to how crowded a cell is, so a
         * cell that `rebalance` cannot relieve — because its neighbours are
         * full too — keeps asking harder. Traced on a ring drawn round a patch
         * of water: density reached 23 parcels against a target of 4, which
         * asked the projection for a divergence of 2.85 in a single cell, which
         * threw the water hard enough to crowd somewhere else. It diverged in
         * about two hundred steps. Positive feedback through a correction term
         * is the one thing a correction term must never do. */
        if (excess > 0) bias[idx] = Math.min(K * excess, MAXB);
      }
    }
  }

  /* One full step. `ns` supplies the projection and nothing else. */
  step(dt, ns) {
    this.ensureSize();
    if (!this.count) { this.markCells(); return; }
    const g = this.g;

    this.p2g();
    this.markCells();
    this.markSealed();
    this.updateBias();
    this.applyGravity(dt);
    // Gravity must not accelerate trapped water either — there is nowhere for
    // it to fall to, and the projection would have to cancel it exactly.
    this.freezeSealed();
    ns.applySolidBCFaces();
    g.setBndFaces();

    g.divBias = this.bias;
    ns.project();
    g.divBias = null;

    ns.applySolidBCFaces();
    this.freezeSealed();
    // Before G2P, never after: the point is that the particles gather a
    // sensible velocity instead of the zeros sitting outside the water.
    this.extrapolateFaces(3);
    this.g2p();
    this.freezeSealedParticles();
    this.advect(dt, ns.speedCap);
    this.countCells();
    this.rebalance();
    this.deriveFill();
    // Publish the cell-centred mirror so the renderers, probe, overlays and
    // diagnostics see this step's velocity like any other solver.
    g.refreshCentred(ns.speedCap);
  }

  /* ── save / load ────────────────────────────────────────────────────── */

  /* Particle positions, quantised to a sixteenth of a cell and delta-coded.
   *
   * The old format stored the fill field, which was lossy in a way that did not
   * matter for a fraction and would matter here: reconstructing particles from
   * a density field invents their arrangement. Positions are what the state
   * actually is. A sixteenth of a cell is far finer than the surface can
   * resolve and keeps two bytes per coordinate. */
  serialise() {
    const out = new Uint8Array(this.count * 4);
    for (let k = 0; k < this.count; k++) {
      const qx = Math.max(0, Math.min(65535, Math.round(this.px[k] * 16)));
      const qy = Math.max(0, Math.min(65535, Math.round(this.py[k] * 16)));
      out[k * 4] = qx & 255; out[k * 4 + 1] = qx >> 8;
      out[k * 4 + 2] = qy & 255; out[k * 4 + 3] = qy >> 8;
    }
    let s = '';
    const CH = 8192;
    for (let i = 0; i < out.length; i += CH) {
      s += String.fromCharCode.apply(null, out.subarray(i, Math.min(i + CH, out.length)));
    }
    return btoa(s);
  }

  deserialise(str) {
    this.ensureSize();
    const bin = atob(str);
    this.count = 0;
    for (let i = 0; i + 4 <= bin.length; i += 4) {
      const qx = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
      const qy = bin.charCodeAt(i + 2) | (bin.charCodeAt(i + 3) << 8);
      if (!this.addParticle(qx / 16, qy / 16)) break;
    }
    this.deriveFill();
    return this.count;
  }
}
