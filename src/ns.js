/* Incompressible Navier-Stokes (Stam splitting) in cell units.
 *
 *   add forces -> diffuse -> project -> advect -> project
 *
 * Advection is MacCormack with an RK2 back-trace and a monotonicity limiter.
 * That limiter only earns its keep when the Courant number is near 1: above
 * ~5 it rejects essentially every correction and the scheme silently degrades
 * to first-order upwind. The driver picks dt to hold CFL near 1 so the
 * second-order path is actually taken. */

import { Grid, Poisson } from './grid.js';

export class NavierStokes {
  constructor(grid) {
    this.g = grid;
    this.poisson = new Poisson(grid);

    this.visc = 0.02;          // cells^2 / time
    this.diff = 0.0;           // dye diffusion
    this.dyeFade = 0.997;      // per unit time
    this.vorticity = 1.0;      // confinement, scaled by CONF_SCALE below
    this.gravity = 0;
    this.iters = 12;           // diffusion relaxation sweep ceiling
    // Two V-cycles per projection is the floor: at one the pressure solve
    // lags the flow enough that the scheme goes unstable within a few hundred
    // frames. Three costs 40% more for no measurable gain.
    this.cycles = 2;
    // Both projections need the full budget. Halving the pre-advection one is
    // tempting — it only has to make the field fit to advect — but it goes
    // unstable just as fast as halving the other, because the advection then
    // transports a divergent field that the second projection has to fix from
    // scratch every step instead of warm-starting from a good solution.
    this.preCycles = 2;
    this.preProject = true;

    this.les = true;
    this.cs = 0.15;            // Smagorinsky constant
    this.meanNut = 0;

    /* Staggered (MAC) mode: face velocities are the state.
     *
     * Off by default until the validation suite says otherwise — the previous
     * attempt at this passed its divergence test and still had to be reverted
     * because it destroyed the drag and the shedding, so "the residual improved"
     * is not evidence here. `tests/validate.mjs` is. */
    this.mac = false;

    this.windTunnel = false;
    this.inletSpeed = 2.4;     // cells / time

    this.maxSpeed = 0;
    this.speedCap = 0;         // 0 disables; set from the reference speed
    this.capped = 0;           // cells clamped by it on the last step

    // Recomputed on the next tunnel step after any geometry change.
    this.tunnelDirty = true;
    this.inletOpen = null;
    this.canExit = null;
  }

  onGeometryChanged() { this.poisson.dirty = true; this.tunnelDirty = true; }

  /* Which fluid can actually discharge downstream.
   *
   * The inlet HARD-PRESCRIBES u = U every step. If the fluid it drives into has
   * no path to the outlet, that is incompressible flow into a sealed box: no
   * pressure field satisfies it, and the projection diverges trying. Painting a
   * wall across the channel while the solver ran took the peak speed from 4.5
   * to 2.3e6 within fifty steps — the reported "drawing breaks everything".
   *
   * Nothing is wrong with the geometry; a blocked tunnel is a legitimate thing
   * to draw. What is wrong is continuing to inject mass into it. So each
   * connected fluid region is asked whether it reaches the outlet column, and
   * the inlet and the outlet sponge only drive the ones that do. A blocked
   * tunnel then simply goes still, which is the physical answer.
   *
   * `Poisson.labelRegions` already computes the labels for the pressure solve,
   * so this rides along on work that was happening anyway. */
  refreshTunnelOpenness() {
    const g = this.g;
    const { nx, ny, stride: s, solid, size } = g;
    if (!this.inletOpen || this.inletOpen.length !== ny + 2) this.inletOpen = new Uint8Array(ny + 2);
    if (!this.canExit || this.canExit.length !== size) this.canExit = new Uint8Array(size);
    this.tunnelDirty = false;

    if (!g.hasSolid) { this.inletOpen.fill(1); this.canExit.fill(1); return; }

    this.poisson.ensureTopology();
    const region = this.poisson.region;
    const count = this.poisson.regionCount || 0;
    const exits = new Uint8Array(Math.max(count, 1));
    for (let j = 1; j <= ny; j++) {
      const idx = nx + j * s;
      const r = region[idx];
      if (!solid[idx] && r >= 0) exits[r] = 1;
    }
    for (let i = 0; i < size; i++) {
      const r = region[i];
      this.canExit[i] = (r >= 0 && exits[r]) ? 1 : 0;
    }
    for (let j = 1; j <= ny; j++) {
      const idx = 1 + j * s;
      this.inletOpen[j] = (!solid[idx] && this.canExit[idx]) ? 1 : 0;
    }
  }

  /* Seed the domain with the uniform freestream.
   *
   * Starting a wind tunnel from rest leaves the interior at zero while the
   * inlet condition prescribes u = U. That is a step discontinuity, and now
   * that the boundary conditions are applied BEFORE the final projection the
   * solver sees it and answers with an enormous pressure spike. Physically the
   * right initial condition for a tunnel is uniform flow everywhere, which
   * also happens to be what the sponge layer relaxes towards. */
  seedFreestream() {
    if (!this.windTunnel) return;
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v } = g;
    const uIn = this.inletSpeed;
    const hasSolid = g.hasSolid;
    for (let j = 0; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 0; i <= nx + 1; i++) {
        const idx = i + jS;
        const blocked = hasSolid && solid[idx];
        u[idx] = blocked ? 0 : uIn;
        v[idx] = 0;
      }
    }
    g.p.fill(0);
    // The faces are the state in MAC mode, so seeding only the mirror would
    // start the tunnel from rest and hand the solver a step discontinuity —
    // exactly what this function exists to avoid.
    if (this.mac) { g.seedFacesFromCentred(); this.applySolidBCFaces(); }
  }

  /* Optimal SOR factor for the implicit-diffusion system
   * (1+4a)x - a*sum(x_nb) = b.  Jacobi radius rho = 4a/(1+4a). */
  static diffusionOmega(a) {
    const rho = (4 * a) / (1 + 4 * a);
    return 2 / (1 + Math.sqrt(Math.max(1e-9, 1 - rho * rho)));
  }

  /* Sweeps needed to drive the error below ~1e-6, from the same Jacobi radius.
   * At the viscosities that matter here `a` is tiny and the system is very
   * nearly the identity, so a fixed sweep count spends most of its budget
   * re-converging an already-converged solve — this was the single largest
   * cost in the step. The user's setting acts as a ceiling. */
  static diffusionSweeps(a, cap) {
    const rho = (4 * a) / (1 + 4 * a);
    if (rho < 1e-6) return 1;
    const need = Math.ceil(-13.8 / Math.log(rho));
    return Math.max(1, Math.min(cap, need));
  }

  /* Callers always pass x already holding a copy of x0 (that copy is what makes
   * x0 a valid right-hand side), so no initial-guess copy is made here. */
  diffuse(kind, x, x0, coeff, dt) {
    if (coeff <= 1e-9) return;
    const a = coeff * dt;
    this.g.relax(kind, x, x0, a, 1 + 4 * a,
      NavierStokes.diffusionSweeps(a, this.iters), NavierStokes.diffusionOmega(a));
  }

  /* Staggered projection: compact divergence, compact adjoint gradient.
   *
   * The operators here are exact adjoints, so their composition IS the
   * five-point Laplacian the multigrid solves. One consequence is worth stating
   * plainly, because it is the bug this was written for: with a consistent
   * operator pair, converging the pressure solve harder makes the answer
   * BETTER. Under the collocated form it did not — a ragged imported outline
   * could take the residual from 5.5 to 594 by adding V-cycles, which is the
   * signature of converging accurately onto the wrong operator.
   *
   * Walls need no special pleading either. A solid boundary lies exactly on a
   * face, so "no flow through it" is uf = 0, and that face simply drops out of
   * both the divergence and the stencil. The collocated path had to mirror the
   * pressure across solids and read reflected values; none of that is here.
   */
  projectMAC(cycles, pre) {
    const g = this.g;
    const { nx, ny, stride: s, solid, uf, vf, div } = g;
    // Each projection warm-starts from its OWN previous solve; see Grid.pPre.
    // `g.p` stays the post-advection pressure, which is the physical one the
    // renderer draws and the force integration reads.
    const p = pre ? g.pPre : g.p;
    const hasSolid = g.hasSolid;
    const air = g.hasAir ? g.air : null;

    /* Zero every face that touches a solid before measuring anything.
     *
     * A face carrying flow into a wall is not a small error to be relaxed away
     * later — it is mass appearing inside the body, and the pressure solve
     * would dutifully try to find a field that permits it. */
    if (hasSolid) {
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx + 1; i++) {
          const idx = i + jS;
          if (solid[idx] || solid[idx - 1]) uf[idx] = 0;
        }
      }
      for (let j = 1; j <= ny + 1; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (solid[idx] || solid[idx - s]) vf[idx] = 0;
        }
      }
    }

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { div[idx] = 0; continue; }
        // Stored negated, matching the solver's (nf*p - sum p_nb) = div form.
        div[idx] = -((uf[idx + 1] - uf[idx]) + (vf[idx + s] - vf[idx]));
      }
    }

    /* Optional density bias, used by the particle solver.
     *
     * A divergence-free GRID velocity does not stop PARTICLES clumping: nothing
     * in the projection knows how many parcels sit in a cell, so they drift into
     * piles and the free surface sinks even though no mass is lost. Measured on
     * a still pool, the surface fell thirteen rows in three hundred steps with
     * the particle count unchanged to the digit.
     *
     * Asking the projection for a small outflow from over-full cells fixes it at
     * source, because the pressure field then pushes them apart. Only crowding
     * is corrected, never sparsity — pulling fluid INTO thin regions would fight
     * the free surface, which is supposed to be able to thin out and break up.
     *
     * The sign is worth deriving rather than guessing, because getting it
     * backwards does not look like a sign error — it looks like gravity. `div`
     * is stored NEGATED, so the solve yields Laplacian(p) = -div_stored and the
     * correction leaves D_new = D - Laplacian(p). Writing div_stored = -D + bias
     * therefore leaves D_new = +bias: outflow, which is what a crowded cell
     * needs. Subtracting instead gives D_new = -bias, and the projection then
     * actively sucks particles into the very cells that are already too full —
     * measured, the pool compacted into the bottom seven rows and stopped dead. */
    const bias = g.divBias;
    if (bias) {
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (hasSolid && solid[idx]) continue;
          div[idx] += bias[idx];
        }
      }
    }
    /* Compatibility, decided per region rather than for the whole grid.
     *
     * With no surface every region is sealed and the old global call is right.
     * With one, a region touching air can absorb net inflow through its
     * Dirichlet cells — but a pocket sealed off by solid cannot, and leaving its
     * divergence incompatible gives a singular system with no solution, which
     * the multigrid answers by running away. Drawing a lid across a tank makes
     * both kinds at once. */
    if (!g.hasAir) this.poisson.makeCompatible(div);
    else this.poisson.makeSealedCompatible(div, g.air);
    g.setBnd(0, div);
    Grid.setBndP(p, nx, ny);          // warm start from the previous solve
    this.poisson.solve(p, div, cycles || this.cycles);

    /* The adjoint gradient. A face between two fluid cells is corrected by the
     * pressure difference across it; a face against a wall carries no flow and
     * so takes no correction, which is the discrete form of dp/dn = 0. */
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 2; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx - 1])) continue;
        if (air && air[idx] && air[idx - 1]) continue;
        uf[idx] -= p[idx] - p[idx - 1];
      }
    }
    for (let j = 2; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx - s])) continue;
        if (air && air[idx] && air[idx - s]) continue;
        vf[idx] -= p[idx] - p[idx - s];
      }
    }
    g.setBndFaces();
  }

  project(cycles, pre) {
    if (this.mac) return this.projectMAC(cycles, pre);
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v, p, div } = g;
    const hasSolid = g.hasSolid;

    /* Centred (collocated) divergence.
     *
     * This composes a WIDE divergence with the COMPACT Laplacian the solver
     * inverts, so the projection does not exactly remove the divergence it
     * measures. Two remedies were built and measured here:
     *
     *  - Rhie-Chow deferred correction: a positive feedback loop at full
     *    strength; the closed case failed three times sooner.
     *  - A staggered (MAC) projection, interpolating cell -> face -> cell
     *    around a compact, adjoint operator pair. It HALVED the divergence
     *    (0.324% -> 0.171% of inlet), confirming the diagnosis — but the
     *    round-trip u -> uf -> u composes to (u[i-1] + 2u[i] + u[i+1])/4, a
     *    low-pass filter applied twice per step. It smoothed away the very
     *    vorticity it was meant to protect: cylinder drag 1.25 -> 0.59 and
     *    shedding amplitude 0.90 -> 0.10.
     *
     * A real MAC solver avoids that by keeping TRANSPORT on faces too, so
     * nothing is ever interpolated back. That is a full solver rewrite rather
     * than a change to the projection, and until it exists the collocated form
     * is kept: it is less consistent but demonstrably more accurate here.
     */
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { div[idx] = 0; continue; }
        div[idx] = -0.5 * (u[idx + 1] - u[idx - 1] + v[idx + s] - v[idx - s]);
      }
    }
    // Compatibility is an all-Neumann requirement, and whether a region is
    // all-Neumann is a per-region question once a free surface exists: one
    // touching air has Dirichlet cells that absorb any imbalance, one sealed off
    // by solid does not. See projectMAC and Poisson.makeSealedCompatible.
    if (!g.hasAir) this.poisson.makeCompatible(div);
    else this.poisson.makeSealedCompatible(div, g.air);
    g.setBnd(0, div);
    Grid.setBndP(p, nx, ny);          // warm start from the previous solve
    this.poisson.solve(p, div, cycles || this.cycles);

    // Centred gradient, with a solid neighbour REFLECTED to the centre value
    // rather than read directly. A wall can separate two disconnected fluid
    // regions, and each region's pressure constant is removed independently;
    // reading across one compares unrelated datums.
    if (!hasSolid) {
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          u[idx] -= 0.5 * (p[idx + 1] - p[idx - 1]);
          v[idx] -= 0.5 * (p[idx + s] - p[idx - s]);
        }
      }
    } else {
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (solid[idx]) continue;
          const pc = p[idx];
          const pr = solid[idx + 1] ? pc : p[idx + 1];
          const pl = solid[idx - 1] ? pc : p[idx - 1];
          const pu = solid[idx + s] ? pc : p[idx + s];
          const pd = solid[idx - s] ? pc : p[idx - s];
          /* Under-relaxing this correction at wall-adjacent cells was tried, at
           * 0.75 and 0.5, on exactly the ragged-boundary case it was meant to
           * stabilise. It changed nothing measurable — the residual still grew
           * to 2.5e9 over six hundred steps — so it was removed rather than
           * left in as a tuning knob that does not tune anything. */
          u[idx] -= 0.5 * (pr - pl);
          v[idx] -= 0.5 * (pu - pd);
        }
      }
    }
    g.setBnd(1, u);
    g.setBnd(2, v);
  }

  /* MacCormack advection ON THE FACES.
   *
   * This is the half of a staggered solver that the reverted attempt left out,
   * and leaving it out is precisely what killed that attempt: if transport stays
   * cell-centred then the state has to be carried to the faces and back every
   * step, and that round trip is a low-pass filter. Here nothing goes back. A
   * face value is traced, sampled, and written to a face.
   *
   * Each component samples its OWN lattice. The transporting velocity is
   * interpolated across the staggering — a u-face needs a v, and the four
   * v-faces around it are averaged to get one — but that is a velocity used to
   * trace a path, not the quantity being transported, so it never filters the
   * state it moves. That distinction is the whole design.
   */
  advectVelocityMAC(dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, uf, vf,
      ufPrev: u0, vfPrev: v0, ufTmp: uh, vfTmp: vh } = g;
    const hasSolid = g.hasSolid;

    /* Samplers. `uf` sits at x = i - 1/2 and integer j, so a physical x maps to
     * face coordinate x + 1/2; `vf` is the mirror image. Bounds are clamped so
     * the bilinear stencil always lands on allocated cells, ghost rows
     * included — those are set by setBndFaces and carry the slip condition.
     *
     * Written as plain functions taking the source array rather than as
     * closures over it: both are called with two different arrays (the previous
     * field and the pass-1 field), and keeping the call sites monomorphic on
     * Float32Array is what lets them inline. Advection is the single most
     * expensive part of the staggered step, so this is where it is worth
     * caring. */
    const uLoX = 1, uHiX = nx + 0.999, uLoY = 0.5, uHiY = ny + 0.5;
    const vLoX = 0.5, vHiX = nx + 0.5, vLoY = 1, vHiY = ny + 0.999;
    const sampleU = (src, x, y) => {
      let a = x + 0.5, b = y;
      if (a < uLoX) a = uLoX; else if (a > uHiX) a = uHiX;
      if (b < uLoY) b = uLoY; else if (b > uHiY) b = uHiY;
      const i0 = a | 0, j0 = b | 0;
      const fa = a - i0, fb = b - j0, ga = 1 - fa, gb = 1 - fb;
      const k = i0 + j0 * s;
      return ga * (gb * src[k] + fb * src[k + s])
        + fa * (gb * src[k + 1] + fb * src[k + s + 1]);
    };
    const sampleV = (src, x, y) => {
      let a = x, b = y + 0.5;
      if (a < vLoX) a = vLoX; else if (a > vHiX) a = vHiX;
      if (b < vLoY) b = vLoY; else if (b > vHiY) b = vHiY;
      const i0 = a | 0, j0 = b | 0;
      const fa = a - i0, fb = b - j0, ga = 1 - fa, gb = 1 - fb;
      const k = i0 + j0 * s;
      return ga * (gb * src[k] + fb * src[k + s])
        + fa * (gb * src[k + 1] + fb * src[k + s + 1]);
    };
    // The transporting velocity at a face, gathered from the other component.
    const vAtU = (idx) => 0.25 * (v0[idx] + v0[idx - 1] + v0[idx + s] + v0[idx - 1 + s]);
    const uAtV = (idx) => 0.25 * (u0[idx] + u0[idx + 1] + u0[idx - s] + u0[idx + 1 - s]);

    const half = 0.5 * dt;

    // Pass 1 — plain semi-Lagrangian with an RK2 back-trace, into uh/vh.
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx + 1; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx - 1])) { uh[idx] = 0; continue; }
        const x = i - 0.5, y = j;
        const xm = x - half * u0[idx], ym = y - half * vAtU(idx);
        const xb = x - dt * sampleU(u0, xm, ym), yb = y - dt * sampleV(v0, xm, ym);
        uh[idx] = sampleU(u0, xb, yb);
      }
    }
    for (let j = 1; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx - s])) { vh[idx] = 0; continue; }
        const x = i, y = j - 0.5;
        const xm = x - half * uAtV(idx), ym = y - half * v0[idx];
        const xb = x - dt * sampleU(u0, xm, ym), yb = y - dt * sampleV(v0, xm, ym);
        vh[idx] = sampleV(v0, xb, yb);
      }
    }
    /* The correction pass samples uh/vh at a FORWARD-traced point, which can
     * land on a ghost face. Leaving those unset meant pass 2 read whatever the
     * scratch buffers held from the previous step — stale values that fed
     * straight into the correction and grew. */
    g.setBndFaces(uh, vh);

    /* Pass 2 — the MacCormack correction, with the monotonicity limiter.
     *
     * Trace FORWARD from the face and sample the pass-1 field there; the
     * difference from where we started estimates the error pass 1 made, and
     * half of it is the second-order correction. The limiter then refuses any
     * corrected value that lies outside the range of the four donors it came
     * from, which is what keeps the scheme from ringing at sharp shears. */
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx + 1; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx - 1])) { uf[idx] = 0; continue; }
        const x = i - 0.5, y = j;
        const uc = u0[idx], vc = vAtU(idx);
        const rev = sampleU(uh, x + dt * uc, y + dt * vc);
        const corrected = uh[idx] + 0.5 * (uc - rev);

        let a = (x - dt * uc) + 0.5, b = y - dt * vc;
        if (a < 1) a = 1; else if (a > nx + 0.999) a = nx + 0.999;
        if (b < 0.5) b = 0.5; else if (b > ny + 0.5) b = ny + 0.5;
        const i0 = a | 0, j0 = b | 0, k = i0 + j0 * s;
        let lo = u0[k], hi = lo, t;
        t = u0[k + 1]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = u0[k + s]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = u0[k + s + 1]; if (t < lo) lo = t; if (t > hi) hi = t;
        uf[idx] = (corrected >= lo && corrected <= hi) ? corrected : uh[idx];
      }
    }
    for (let j = 1; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx - s])) { vf[idx] = 0; continue; }
        const x = i, y = j - 0.5;
        const uc = uAtV(idx), vc = v0[idx];
        const rev = sampleV(vh, x + dt * uc, y + dt * vc);
        const corrected = vh[idx] + 0.5 * (vc - rev);

        let a = x - dt * uc, b = (y - dt * vc) + 0.5;
        if (a < 0.5) a = 0.5; else if (a > nx + 0.5) a = nx + 0.5;
        if (b < 1) b = 1; else if (b > ny + 0.999) b = ny + 0.999;
        const i0 = a | 0, j0 = b | 0, k = i0 + j0 * s;
        let lo = v0[k], hi = lo, t;
        t = v0[k + 1]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = v0[k + s]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = v0[k + s + 1]; if (t < lo) lo = t; if (t > hi) hi = t;
        vf[idx] = (corrected >= lo && corrected <= hi) ? corrected : vh[idx];
      }
    }
    g.setBndFaces();
  }

  /* Fused MacCormack advection of both velocity components. */
  advectVelocity(dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v, uPrev: u0, vPrev: v0, t1: uh, t2: vh } = g;
    const hasSolid = g.hasSolid;
    const loX = 0.5, hiX = nx + 0.5, loY = 0.5, hiY = ny + 0.5;
    const half = 0.5 * dt;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { uh[idx] = 0; vh[idx] = 0; continue; }
        let xh = i - half * u0[idx], yh = j - half * v0[idx];
        if (xh < loX) xh = loX; else if (xh > hiX) xh = hiX;
        if (yh < loY) yh = loY; else if (yh > hiY) yh = hiY;
        const mi = xh | 0, mj = yh | 0;
        const mb = xh - mi, ma = 1 - mb, nb = yh - mj, na = 1 - nb;
        const m00 = mi + mj * s, m10 = m00 + 1, m01 = m00 + s, m11 = m01 + 1;
        const w00 = ma * na, w10 = mb * na, w01 = ma * nb, w11 = mb * nb;
        const um = w00 * u0[m00] + w10 * u0[m10] + w01 * u0[m01] + w11 * u0[m11];
        const vm = w00 * v0[m00] + w10 * v0[m10] + w01 * v0[m01] + w11 * v0[m11];

        let xx = i - dt * um, yy = j - dt * vm;
        if (xx < loX) xx = loX; else if (xx > hiX) xx = hiX;
        if (yy < loY) yy = loY; else if (yy > hiY) yy = hiY;
        const i0 = xx | 0, j0 = yy | 0;
        const b = xx - i0, a = 1 - b, d = yy - j0, c = 1 - d;
        const a00 = i0 + j0 * s, a10 = a00 + 1, a01 = a00 + s, a11 = a01 + 1;
        const q00 = a * c, q10 = b * c, q01 = a * d, q11 = b * d;
        uh[idx] = q00 * u0[a00] + q10 * u0[a10] + q01 * u0[a01] + q11 * u0[a11];
        vh[idx] = q00 * v0[a00] + q10 * v0[a10] + q01 * v0[a01] + q11 * v0[a11];
      }
    }
    g.setBnd(1, uh);
    g.setBnd(2, vh);

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { u[idx] = 0; v[idx] = 0; continue; }

        let rx = i + dt * u0[idx], ry = j + dt * v0[idx];
        if (rx < loX) rx = loX; else if (rx > hiX) rx = hiX;
        if (ry < loY) ry = loY; else if (ry > hiY) ry = hiY;
        const ri = rx | 0, rj = ry | 0;
        const rb = rx - ri, ra = 1 - rb, rd = ry - rj, rc = 1 - rd;
        const r00 = ri + rj * s, r10 = r00 + 1, r01 = r00 + s, r11 = r01 + 1;
        const p00 = ra * rc, p10 = rb * rc, p01 = ra * rd, p11 = rb * rd;
        const uRev = p00 * uh[r00] + p10 * uh[r10] + p01 * uh[r01] + p11 * uh[r11];
        const vRev = p00 * vh[r00] + p10 * vh[r10] + p01 * vh[r01] + p11 * vh[r11];

        const uC = uh[idx] + 0.5 * (u0[idx] - uRev);
        const vC = vh[idx] + 0.5 * (v0[idx] - vRev);

        let xx = i - dt * u0[idx], yy = j - dt * v0[idx];
        if (xx < loX) xx = loX; else if (xx > hiX) xx = hiX;
        if (yy < loY) yy = loY; else if (yy > hiY) yy = hiY;
        const ci = xx | 0, cj = yy | 0;
        const ci1 = ci < nx ? ci + 1 : ci, cj1 = cj < ny ? cj + 1 : cj;
        const c00 = ci + cj * s, c10 = ci1 + cj * s, c01 = ci + cj1 * s, c11 = ci1 + cj1 * s;

        let lo = u0[c00], hi = lo, t;
        t = u0[c10]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = u0[c01]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = u0[c11]; if (t < lo) lo = t; if (t > hi) hi = t;
        u[idx] = (uC >= lo && uC <= hi) ? uC : uh[idx];

        lo = v0[c00]; hi = lo;
        t = v0[c10]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = v0[c01]; if (t < lo) lo = t; if (t > hi) hi = t;
        t = v0[c11]; if (t < lo) lo = t; if (t > hi) hi = t;
        v[idx] = (vC >= lo && vC <= hi) ? vC : vh[idx];
      }
    }
    g.setBnd(1, u);
    g.setBnd(2, v);
  }

  /* Dye: RK2 back-trace shared across all three channels, fade folded in.
   * Reads the tR/tG/tB scratch copies, never the source buffers. */
  advectDye(dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v, dR, dG, dB, tR, tG, tB } = g;
    const hasSolid = g.hasSolid;
    const loX = 0.5, hiX = nx + 0.5, loY = 0.5, hiY = ny + 0.5;
    const half = 0.5 * dt;
    const fade = Math.pow(this.dyeFade, dt);

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { dR[idx] = 0; dG[idx] = 0; dB[idx] = 0; continue; }
        let xh = i - half * u[idx], yh = j - half * v[idx];
        if (xh < loX) xh = loX; else if (xh > hiX) xh = hiX;
        if (yh < loY) yh = loY; else if (yh > hiY) yh = hiY;
        const mi = xh | 0, mj = yh | 0;
        const mb = xh - mi, ma = 1 - mb, nb = yh - mj, na = 1 - nb;
        const m00 = mi + mj * s, m10 = m00 + 1, m01 = m00 + s, m11 = m01 + 1;
        const w00 = ma * na, w10 = mb * na, w01 = ma * nb, w11 = mb * nb;
        const um = w00 * u[m00] + w10 * u[m10] + w01 * u[m01] + w11 * u[m11];
        const vm = w00 * v[m00] + w10 * v[m10] + w01 * v[m01] + w11 * v[m11];

        let xx = i - dt * um, yy = j - dt * vm;
        if (xx < loX) xx = loX; else if (xx > hiX) xx = hiX;
        if (yy < loY) yy = loY; else if (yy > hiY) yy = hiY;
        const i0 = xx | 0, j0 = yy | 0;
        const b = xx - i0, a = 1 - b, d = yy - j0, c = 1 - d;
        const a00 = i0 + j0 * s, a10 = a00 + 1, a01 = a00 + s, a11 = a01 + 1;
        const q00 = a * c, q10 = b * c, q01 = a * d, q11 = b * d;
        // Clamp folded in here rather than in a separate sweep over the field.
        let r = (q00 * tR[a00] + q10 * tR[a10] + q01 * tR[a01] + q11 * tR[a11]) * fade;
        let gq = (q00 * tG[a00] + q10 * tG[a10] + q01 * tG[a01] + q11 * tG[a11]) * fade;
        let bq = (q00 * tB[a00] + q10 * tB[a10] + q01 * tB[a01] + q11 * tB[a11]) * fade;
        dR[idx] = r > 1 ? 1 : r < 0 ? 0 : r;
        dG[idx] = gq > 1 ? 1 : gq < 0 ? 0 : gq;
        dB[idx] = bq > 1 ? 1 : bq < 0 ? 0 : bq;
      }
    }
    g.setBnd(0, dR); g.setBnd(0, dG); g.setBnd(0, dB);
  }

  dyeStep(dt) {
    const g = this.g;
    const { dR, dG, dB, sR, sG, sB, tR, tG, tB } = g;
    const n = g.size;

    for (let i = 0; i < n; i++) {
      dR[i] += dt * sR[i]; sR[i] = 0;
      dG[i] += dt * sG[i]; sG[i] = 0;
      dB[i] += dt * sB[i]; sB[i] = 0;
    }

    if (this.diff > 1e-9) {
      tR.set(dR); this.diffuse(0, dR, tR, this.diff, dt);
      tG.set(dG); this.diffuse(0, dG, tG, this.diff, dt);
      tB.set(dB); this.diffuse(0, dB, tB, this.diff, dt);
    }

    tR.set(dR); tG.set(dG); tB.set(dB);
    this.advectDye(dt);
  }

  vorticityConfinement(dt) {
    if (this.vorticity < 0.01) return;
    const g = this.g;
    const { nx, ny, stride: s, u, v, t1: curl } = g;
    const iMin = this.windTunnel ? 4 : 2;
    const iMax = this.windTunnel ? nx - 3 : nx - 1;

    curl.fill(0);
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = iMin - 1; i <= iMax + 1; i++) {
        const idx = i + jS;
        curl[idx] = 0.5 * (v[idx + 1] - v[idx - 1] - u[idx + s] + u[idx - s]);
      }
    }
    // CONF_SCALE converts the slider into a physical force coefficient. Losing
    // it in the rewrite left confinement 40x too strong, and confinement
    // amplifies EVERY local vorticity extremum — including grid-scale ones —
    // so it pumped energy straight into cell-sized noise. That noise filled
    // the domain, drove peak speed to 7x the inlet (potential flow says 2x),
    // and destroyed the drag integral (Cd 0.02 against a textbook 1.0-1.2).
    //
    // Measured usable range is 0-0.12; past ~0.2 the oscillation metric climbs
    // sharply. Note the solver barely needs confinement now: at CFL ~1 the
    // second-order advection retains vorticity on its own, whereas the old
    // build ran at CFL ~30 where it was genuinely first-order and needed the
    // help.
    const CONF_SCALE = 0.02;
    const eps = this.vorticity * CONF_SCALE * (this.les ? 0.7 : 1.0);
    for (let j = 2; j <= ny - 1; j++) {
      const jS = j * s;
      for (let i = iMin; i <= iMax; i++) {
        const idx = i + jS;
        const cr = curl[idx + 1], cl = curl[idx - 1];
        const cu = curl[idx + s], cd = curl[idx - s];
        const gx = (cr < 0 ? -cr : cr) - (cl < 0 ? -cl : cl);
        const gy = (cu < 0 ? -cu : cu) - (cd < 0 ? -cd : cd);
        const inv = 1 / (Math.sqrt(gx * gx + gy * gy) + 1e-8);
        const f = dt * eps * curl[idx];
        u[idx] += f * gy * inv;
        v[idx] -= f * gx * inv;
      }
    }
    g.setBnd(1, u); g.setBnd(2, v);
  }

  /* Smagorinsky sub-grid model: nu_t = (Cs*delta)^2 |S|, applied as explicit
   * turbulent diffusion in conservative form with face-averaged viscosity. */
  smagorinsky(dt) {
    if (!this.les) { this.meanNut = 0; return; }
    const g = this.g;
    const { nx, ny, stride: s, u, v, solid, nut } = g;
    const hasSolid = g.hasSolid;
    const cd2 = this.cs * this.cs;             // delta = 1 cell
    const nutMax = 0.2 / (4 * dt);             // explicit stability bound
    let sum = 0;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { nut[idx] = 0; continue; }
        const s11 = 0.5 * (u[idx + 1] - u[idx - 1]);
        const s22 = 0.5 * (v[idx + s] - v[idx - s]);
        const s12 = 0.25 * ((u[idx + s] - u[idx - s]) + (v[idx + 1] - v[idx - 1]));
        const mag = Math.sqrt(2 * (s11 * s11 + s22 * s22 + 2 * s12 * s12));
        const val = cd2 * mag;
        nut[idx] = val < nutMax ? val : nutMax;
        sum += nut[idx];
      }
    }
    this.meanNut = sum / (nx * ny);

    for (let j = 2; j <= ny - 1; j++) {
      const jS = j * s;
      for (let i = 2; i <= nx - 1; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;
        const nc = nut[idx];
        if (nc < 1e-10) continue;
        const nR = 0.5 * (nc + nut[idx + 1]), nL = 0.5 * (nc + nut[idx - 1]);
        const nU = 0.5 * (nc + nut[idx + s]), nD = 0.5 * (nc + nut[idx - s]);
        u[idx] += dt * (nR * (u[idx + 1] - u[idx]) - nL * (u[idx] - u[idx - 1])
                      + nU * (u[idx + s] - u[idx]) - nD * (u[idx] - u[idx - s]));
        v[idx] += dt * (nR * (v[idx + 1] - v[idx]) - nL * (v[idx] - v[idx - 1])
                      + nU * (v[idx + s] - v[idx]) - nD * (v[idx] - v[idx - s]));
      }
    }
    g.setBnd(1, u); g.setBnd(2, v);
  }

  /* No-slip means the fluid matches the WALL's velocity, not zero. For a
   * stationary body those are the same thing, which is why zeroing worked;
   * for a moving or spinning body they are not, and zeroing is what makes a
   * rotating cylinder behave like a stationary one. */
  applySolidBC() {
    const g = this.g;
    if (!g.hasSolid) return;
    const { nx, ny, stride: s, solid, u, v, dR, dG, dB, bcU, bcV, bcType } = g;
    const moving = g.hasMovingWall;
    const slip = g.hasSlip;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (!solid[idx]) continue;

        /* A SLIP wall stops flow through itself but not along itself, so the
         * solid cell mirrors its fluid neighbour's TANGENTIAL velocity and
         * cancels only the normal component. Setting the whole velocity to
         * zero — the no-slip treatment — would impose a boundary layer that a
         * slip wall by definition does not have. */
        if (slip && bcType[idx] === 2) {
          let tu = 0, tv = 0, n = 0;
          // Horizontal faces: neighbour above/below contributes its u.
          if (!solid[idx - s]) { tu += u[idx - s]; n++; }
          if (!solid[idx + s]) { tu += u[idx + s]; n++; }
          // Vertical faces: neighbour left/right contributes its v.
          let m = 0;
          if (!solid[idx - 1]) { tv += v[idx - 1]; m++; }
          if (!solid[idx + 1]) { tv += v[idx + 1]; m++; }
          u[idx] = n ? tu / n : 0;
          v[idx] = m ? tv / m : 0;
        } else {
          u[idx] = moving ? bcU[idx] : 0;
          v[idx] = moving ? bcV[idx] : 0;
        }
        dR[idx] = 0; dG[idx] = 0; dB[idx] = 0;
      }
    }
  }

  /* Pressure outlets and symmetry planes, applied to fluid cells.
   *
   * An OUTLET holds pressure and lets flow leave: the cells are relaxed toward
   * a zero-gradient state so a wake can pass out without reflecting. A
   * SYMMETRY plane mirrors the tangential flow and cancels the normal
   * component, which is how a half-domain stands in for a whole one. */
  applyFieldBC(dt) {
    const g = this.g;
    if (!g.hasFieldBC) return;
    const { nx, ny, stride: s, u, v, p, bcType, bcK, solid } = g;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) continue;
        const t = bcType[idx];

        if (t === 7) {
          // Outlet: pin pressure, relax velocity toward its upstream value so
          // the region behaves as an opening rather than a wall.
          p[idx] = bcK[idx];
          const decay = 1 / (1 + 2 * dt);
          u[idx] = u[idx - 1] + (u[idx] - u[idx - 1]) * decay;
          v[idx] = v[idx] * decay;
        } else if (t === 8) {
          // Symmetry: no flow through, free along.
          v[idx] = 0;
        }
      }
    }
    g.setBnd(1, u); g.setBnd(2, v);
  }

  /* Porous media: Darcy drag applied implicitly, so a high resistance cannot
   * overshoot past zero and oscillate.
   *
   * A porous region does NOT block its cells — flow passes through, slowed.
   * That is the difference between a hedge or a windbreak and a solid fence,
   * and it is why porosity is a boundary role rather than a kind of wall. */
  porousDrag(dt) {
    const g = this.g;
    if (!g.hasPorous) return;
    const { nx, ny, stride: s, u, v, porous } = g;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const k = porous[idx];
        if (k <= 0) continue;
        // Maps resistance 0..1 onto a drag rate with a usable spread: 1 stops
        // the flow within a few steps without ever reversing it.
        const damp = 1 / (1 + (k / Math.max(1e-3, 1 - k)) * dt * 4);
        u[idx] *= damp;
        v[idx] *= damp;
      }
    }
    g.setBnd(1, u); g.setBnd(2, v);
  }

  /* Local limiter for cells where the projection demonstrably failed.
   *
   * After a projection the divergence should be near zero — measured, about
   * 0.3% of the inlet speed across a healthy domain. At a ragged wall face it
   * is not. The divergence operator is a WIDE centred difference that reads the
   * zero velocity inside the solid, while the pressure gradient MIRRORS across
   * that same wall; the two are not adjoint, so their composition is not the
   * Laplacian being inverted (limitation 3). At a smooth boundary that is an
   * inaccuracy. In a one-cell groove — where a cell has walls on two sides — it
   * is an instability, and the residual grows without bound.
   *
   * Solving harder makes it worse, twice measured: six V-cycles instead of two
   * took the residual from 5.5 to 594. That is the signature of converging onto
   * an operator that is itself wrong, and it rules out the linear solve as the
   * culprit.
   *
   * Until the staggered rewrite lands, this catches the failure where it
   * happens. Divergence far above anything a working projection produces means
   * that cell's answer is not trustworthy, so it is blended toward its fluid
   * neighbours — which is what the pressure solve would have done had it
   * worked. It is a limiter, not a model: healthy flow never crosses the
   * threshold, so nothing that currently converges is touched, and the
   * validation numbers are unchanged.
   */
  limitProjectionFailure() {
    const g = this.g;
    if (!g.hasSolid) return;
    const { nx, ny, stride: s, solid, u, v } = g;
    /* Scale from the DRIVING speed, never from the current peak.
     *
     * Using max|u| looks natural and is self-defeating: as the instability
     * grows it raises its own threshold, so the limiter quietly stops firing
     * exactly when it is needed. Measured with max|u| in the threshold, the
     * runaway still reached the speed ceiling. The inlet speed is a constant of
     * the experiment and is the right yardstick.
     *
     * A healthy projection leaves divergence around 0.3% of the inlet, so this
     * is more than a hundred times anything normal — it cannot fire on flow
     * that is merely fast. */
    const ref = Math.max(this.inletSpeed, 1e-6);
    const thresh = 0.35 * ref;
    /* Two passes. A failing cell's neighbours are usually failing too, so one
     * pass blends bad values into bad values; the second sees the first's
     * result. More than two starts visibly smearing the wake next to any body. */
    for (let pass = 0; pass < 2; pass++) {
      let hits = 0;
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (solid[idx]) continue;
          const d = 0.5 * (u[idx + 1] - u[idx - 1] + v[idx + s] - v[idx - s]);
          const m = d < 0 ? -d : d;
          if (m <= thresh) continue;
          hits++;
          // Blend proportionally to the overshoot, capped, so a marginal cell is
          // nudged and a hopeless one is replaced outright.
          const a = Math.min(0.95, (m / thresh - 1) * 0.6);
          let su = 0, sv = 0, n = 0;
          if (!solid[idx - 1]) { su += u[idx - 1]; sv += v[idx - 1]; n++; }
          if (!solid[idx + 1]) { su += u[idx + 1]; sv += v[idx + 1]; n++; }
          if (!solid[idx - s]) { su += u[idx - s]; sv += v[idx - s]; n++; }
          if (!solid[idx + s]) { su += u[idx + s]; sv += v[idx + s]; n++; }
          if (!n) { u[idx] = 0; v[idx] = 0; continue; }
          u[idx] += (su / n - u[idx]) * a;
          v[idx] += (sv / n - v[idx]) * a;
        }
      }
      this.limiterHits = hits;
      if (!hits) break;
    }
  }

  /* Bring sealed pockets to rest.
   *
   * Fluid in a region with no path to the outlet is in a closed cavity. That is
   * well posed on paper, but not for this solver: the divergence operator is a
   * wide stencil and the Laplacian it inverts is compact (limitation 3), so
   * every projection leaves a little divergence behind. An open domain flushes
   * that out through the outlet. A sealed one accumulates it — measured, a ring
   * painted round moving fluid in a tunnel went from 3.1 to 233,000 in
   * twenty-five steps.
   *
   * Physically a sealed pocket of viscous fluid ends up at rest, so damping it
   * toward rest is the right answer rather than a fudge; the only judgement is
   * the rate. This is slow enough to watch a trapped swirl wind down over a
   * second or two, and fast enough to beat the accumulation.
   *
   * Only fluid that CANNOT reach the outlet is touched, so open flow — the
   * overwhelmingly common case — is untouched.
   */
  dampSealedRegions(dt) {
    const g = this.g;
    if (!g.hasSolid) return;
    if (this.tunnelDirty) this.refreshTunnelOpenness();
    const canExit = this.canExit;
    if (!canExit) return;
    const { nx, ny, stride: s, solid, u, v } = g;
    const decay = 1 / (1 + 6 * dt);
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || canExit[idx]) continue;
        u[idx] *= decay;
        v[idx] *= decay;
      }
    }
  }

  /* Rayleigh sponge at the outlet. This damps INTERIOR cells, so it has to run
   * before the final projection — otherwise it injects divergence into the
   * last few columns after the solver has just removed it. */
  windTunnelSponge(dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v } = g;
    const uIn = this.inletSpeed;
    const width = Math.max(6, nx >> 5);
    const sigmaMax = 3.0;
    if (this.tunnelDirty) this.refreshTunnelOpenness();
    const canExit = g.hasSolid ? this.canExit : null;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let k = 0; k < width; k++) {
        const i = nx - k;
        if (i < 1) break;
        const idx = i + jS;
        if (solid[idx]) continue;
        const xi = (width - k) / width;
        const decay = 1 / (1 + sigmaMax * xi * xi * dt);
        // A pocket sealed off inside the sponge must not be relaxed toward the
        // freestream — that drives it just as hard as the inlet would, into
        // fluid with nowhere to go.
        if (canExit && !canExit[idx]) { u[idx] *= decay; v[idx] *= decay; continue; }
        u[idx] = uIn + (u[idx] - uIn) * decay;
        v[idx] *= decay;
        g.dR[idx] *= decay; g.dG[idx] *= decay; g.dB[idx] *= decay;
      }
    }
  }

  /* Boundary-only conditions: prescribed inlet, Neumann outflow, free-slip top
   * and bottom. Touches ghost cells and the inlet column only, so it can be
   * re-applied after the projection without disturbing the interior. */
  windTunnelBC() {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v } = g;
    const uIn = this.inletSpeed;
    const hasSolid = g.hasSolid;

    if (this.tunnelDirty) this.refreshTunnelOpenness();
    const open = this.inletOpen;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      // Do not drive the inlet through a wall: a scenario whose duct is
      // narrower than the domain has solid cells on the inlet plane, and
      // prescribing flow into them injects divergence its fluid neighbours
      // then have to absorb.
      //
      // Nor into fluid that cannot reach the outlet — see
      // refreshTunnelOpenness. That is the sealed-channel case, and it is the
      // difference between a blocked tunnel going quiet and the solver
      // exploding.
      if (!(hasSolid && (solid[1 + jS] || (open && !open[j])))) {
        u[jS] = uIn; u[1 + jS] = uIn;
        v[jS] = 0; v[1 + jS] = 0;
      } else {
        u[jS] = 0; u[1 + jS] = 0;
        v[jS] = 0; v[1 + jS] = 0;
      }
      const out = nx + 1 + jS;
      u[out] = u[nx - 1 + jS];
      v[out] = v[nx - 1 + jS];
      g.dR[out] = 0; g.dG[out] = 0; g.dB[out] = 0;
    }
    for (let i = 1; i <= nx; i++) {
      u[i] = u[i + s];
      u[i + (ny + 1) * s] = u[i + ny * s];
      v[i] = 0;
      v[i + (ny + 1) * s] = 0;
    }
  }

  /* Inlet dye stripes so the wake is legible. */
  injectDye(palette) {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const stripes = 9;
    const gap = ny / (stripes + 1);
    for (let k = 0; k < stripes; k++) {
      const col = palette[k % palette.length];
      const jc = Math.round((k + 1) * gap);
      for (let dj = -1; dj <= 1; dj++) {
        const j = jc + dj;
        if (j < 1 || j > ny) continue;
        const idx = 1 + j * s;
        if (solid[idx]) continue;
        g.sR[idx] = col[0] / 255 * 3;
        g.sG[idx] = col[1] / 255 * 3;
        g.sB[idx] = col[2] / 255 * 3;
      }
    }
  }

  measureMaxSpeed() {
    const g = this.g;
    const { nx, ny, stride: s, u, v, solid } = g;
    const hasSolid = g.hasSolid;
    let m = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;
        const a = u[idx] < 0 ? -u[idx] : u[idx];
        const b = v[idx] < 0 ? -v[idx] : v[idx];
        const c = a > b ? a : b;
        if (c > m) m = c;
      }
    }
    this.maxSpeed = m;
    return m;
  }

  /* ── staggered counterparts of the boundary and safety passes ───────────── */

  /* No-slip and moving walls, stated on the faces where the wall actually is.
   *
   * A wall between two cells IS a face, so the condition is uf = 0 for a
   * stationary wall and uf = wall velocity for a moving one — exact, with no
   * ghost-cell reflection standing in for it. */
  applySolidBCFaces() {
    const g = this.g;
    if (!g.hasSolid) return;
    const { nx, ny, stride: s, solid, uf, vf, bcU, bcV, dR, dG, dB } = g;
    const moving = g.hasMovingWall;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx + 1; i++) {
        const idx = i + jS;
        const a = solid[idx - 1], b = solid[idx];
        if (!a && !b) continue;
        // Between two solids there is no flow to speak of; on a wall face the
        // fluid takes the wall's own normal motion.
        uf[idx] = moving ? (a && b ? 0 : (a ? bcU[idx - 1] : bcU[idx])) : 0;
      }
    }
    for (let j = 1; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const a = solid[idx - s], b = solid[idx];
        if (!a && !b) continue;
        vf[idx] = moving ? (a && b ? 0 : (a ? bcV[idx - s] : bcV[idx])) : 0;
      }
    }
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) { dR[idx] = 0; dG[idx] = 0; dB[idx] = 0; }
      }
    }
  }

  windTunnelBCFaces() {
    const g = this.g;
    const { nx, ny, stride: s, solid, uf, vf } = g;
    const uIn = this.inletSpeed;
    const hasSolid = g.hasSolid;

    if (this.tunnelDirty) this.refreshTunnelOpenness();
    const open = this.inletOpen;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      // Same reasoning as the collocated inlet: do not drive flow into a wall,
      // nor into fluid with no path to the outlet. That is the difference
      // between a blocked tunnel going quiet and the solver diverging.
      const blocked = hasSolid && (solid[1 + jS] || (open && !open[j]));
      uf[1 + jS] = blocked ? 0 : uIn;
      uf[jS] = uf[1 + jS];
      vf[1 + jS] = 0;
      // Zero-gradient outflow on the last face.
      uf[nx + 1 + jS] = uf[nx + jS];
      g.dR[nx + 1 + jS] = 0; g.dG[nx + 1 + jS] = 0; g.dB[nx + 1 + jS] = 0;
    }
    for (let i = 1; i <= nx; i++) {
      vf[i + s] = 0;
      vf[i + (ny + 1) * s] = 0;
      uf[i] = uf[i + s];
      uf[i + (ny + 1) * s] = uf[i + ny * s];
    }
  }

  /* Implicit diffusion on the faces.
   *
   * `Grid.relax` cannot be borrowed here: it re-applies the CELL boundary
   * routine after every sweep, which would overwrite the face ghosts with
   * reflections that mean something different. The system is very nearly the
   * identity at the viscosities in play, so a short red-black SOR is plenty. */
  diffuseFaces(dt) {
    const coeff = this.visc;
    if (coeff <= 1e-9) return;
    const g = this.g;
    const { nx, ny, stride: s, solid, uf, vf, ufPrev: u0, vfPrev: v0 } = g;
    const hasSolid = g.hasSolid;
    const a = coeff * dt, c = 1 + 4 * a, cinv = 1 / c;
    const iters = NavierStokes.diffusionSweeps(a, this.iters);
    const omega = NavierStokes.diffusionOmega(a);
    u0.set(uf); v0.set(vf);

    /* Only the FREE faces are relaxed. The faces lying on the domain boundary
     * are prescribed — the inlet, or a wall with no flow through it — so
     * sweeping them would fight the boundary condition, and running the loops
     * out to nx+1 / ny+1 also walked off the end of the array, where a
     * Float32Array read returns undefined and quietly poisons the field with
     * NaN. Both problems have the same fix. */
    for (let k = 0; k < iters; k++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let j = 1; j <= ny; j++) {
          const jS = j * s;
          for (let i = 2 + ((j + colour) & 1); i <= nx; i += 2) {
            const idx = i + jS;
            if (hasSolid && (solid[idx] || solid[idx - 1])) continue;
            const gs = (u0[idx] + a * (uf[idx - 1] + uf[idx + 1] + uf[idx - s] + uf[idx + s])) * cinv;
            uf[idx] += omega * (gs - uf[idx]);
          }
        }
        for (let j = 2; j <= ny; j++) {
          const jS = j * s;
          for (let i = 1 + ((j + colour) & 1); i <= nx; i += 2) {
            const idx = i + jS;
            if (hasSolid && (solid[idx] || solid[idx - s])) continue;
            const gs = (v0[idx] + a * (vf[idx - 1] + vf[idx + 1] + vf[idx - s] + vf[idx + s])) * cinv;
            vf[idx] += omega * (gs - vf[idx]);
          }
        }
      }
      g.setBndFaces();
    }
  }

  /* The speed ceiling, applied to the faces because they are the state.
   *
   * A HARD per-component clamp, deliberately. Each face carries one component,
   * so both saturating reconstructs a cell magnitude of cap*sqrt(2) — the
   * reported peak can therefore reach about 1.41x the ceiling, which is a known
   * and bounded overshoot rather than a leak.
   *
   * A cell-magnitude version was written and measured and is NOT used: scaling
   * the four faces of every over-cap cell by that cell's factor is a single
   * Jacobi-like pass, not a projection, so when a large fraction of the domain
   * is over the limit at once it does not converge in one sweep and values well
   * above the ceiling survive it — measured, a peak of 604 under a cap of 60,
   * against 84.9 for the hard clamp. A safety net has to hold unconditionally;
   * being 41 % loose and always true beats being exact and occasionally false.
   */
  capFaces() {
    if (!(this.speedCap > 0)) return 0;
    const g = this.g;
    const { uf, vf } = g;
    const cap = this.speedCap;
    const n = g.size;
    let clamped = 0;
    for (let i = 0; i < n; i++) {
      const a = uf[i];
      if (a > cap) { uf[i] = cap; clamped++; }
      else if (a < -cap) { uf[i] = -cap; clamped++; }
      else if (!(a === a)) { uf[i] = 0; clamped++; }   // NaN fails every compare
      const b = vf[i];
      if (b > cap) { vf[i] = cap; clamped++; }
      else if (b < -cap) { vf[i] = -cap; clamped++; }
      else if (!(b === b)) { vf[i] = 0; clamped++; }
    }
    return clamped;
  }

  /* The divergence safety net, measuring what the projection actually solves.
   *
   * Under the collocated path this measured the WIDE divergence — a different
   * operator from the one being inverted, so it could read large in a perfectly
   * healthy field. Here it reads the compact face divergence, which the
   * projection drives to zero by construction, so a hit means something has
   * genuinely gone wrong rather than that the two stencils disagree. In a
   * healthy staggered run this should essentially never fire. */
  limitProjectionFailureMAC() {
    const g = this.g;
    if (!g.hasSolid) return;
    const { nx, ny, stride: s, solid, uf, vf } = g;
    const thresh = 0.35 * Math.max(this.inletSpeed, 1e-6);
    let hits = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) continue;
        const d = (uf[idx + 1] - uf[idx]) + (vf[idx + s] - vf[idx]);
        if ((d < 0 ? -d : d) <= thresh) continue;
        hits++;
        // Bleed the excess symmetrically into the four faces of the cell, which
        // removes the divergence without inventing a direction for it.
        const q = 0.25 * d;
        uf[idx] += q; uf[idx + 1] -= q;
        vf[idx] += q; vf[idx + s] -= q;
      }
    }
    this.limiterHits = hits;
  }

  /* The staggered step.
   *
   * Same Stam splitting as the collocated path, with one structural difference:
   * everything that is not advection or projection stays cell-centred and
   * reaches the faces as an INCREMENT. Confinement, the SGS model, porous drag,
   * the sponge and the field BCs are therefore unchanged — they read the mirror,
   * write the mirror, and the difference is scattered. That is safe for the
   * reason set out on `Grid.refreshCentred`: smoothing a one-step increment
   * loses a little of that contribution, while smoothing the state compounds
   * every step until the vorticity is gone.
   */
  stepMAC(dt, palette) {
    const g = this.g;
    const { uf, vf, ufPrev: u0, vfPrev: v0, u, v, snapU, snapV, fx, fy } = g;
    const n = g.size;

    // Brush impulses, per-frame and deliberately not scaled by dt.
    g.addCentredToFaces(fx, fy);
    fx.fill(0); fy.fill(0);
    this.capFaces();

    if (Math.abs(this.gravity) > 1e-4) {
      const { nx, ny, stride: s, solid, dR, dG, dB } = g;
      const grav = this.gravity, hasSolid = g.hasSolid;
      for (let j = 2; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (hasSolid && (solid[idx] || solid[idx - s])) continue;
          // Dye buoyancy averaged onto the face between the two cells.
          const a = (dR[idx] + dG[idx] + dB[idx]) * (1 / 3);
          const b = (dR[idx - s] + dG[idx - s] + dB[idx - s]) * (1 / 3);
          vf[idx] += dt * grav * 0.5 * (a + b);
        }
      }
    }

    this.diffuseFaces(dt);
    if (this.preProject) this.project(this.preCycles, true);

    u0.set(uf); v0.set(vf);
    this.advectVelocityMAC(dt);

    /* Hand the cell-centred passes a current mirror, let them work as they
     * always have, then scatter what they changed back onto the faces.
     *
     * All five are commonly switched off at once — water mode turns off
     * confinement and the SGS model, and a tank has no tunnel, no porous media
     * and no field BCs — and when none of them will run there is nothing to
     * scatter, so the snapshot and the difference pass are skipped entirely. */
    const centredWork = this.vorticity > 0 || this.les || g.hasPorous
      || g.hasFieldBC || this.windTunnel;
    g.refreshCentred();
    if (centredWork) {
      // snapU/snapV, never t1/t2 — vorticityConfinement claims t1 for its curl.
      snapU.set(u); snapV.set(v);
      this.vorticityConfinement(dt);
      this.smagorinsky(dt);
      this.porousDrag(dt);
      this.applyFieldBC(dt);
      if (this.windTunnel) this.windTunnelSponge(dt);
      for (let i = 0; i < n; i++) { snapU[i] = u[i] - snapU[i]; snapV[i] = v[i] - snapV[i]; }
      g.addCentredToFaces(snapU, snapV);
    } else {
      this.meanNut = 0;
    }

    this.applySolidBCFaces();
    if (this.windTunnel) this.windTunnelBCFaces();

    this.project();

    if (this.windTunnel) this.dampSealedRegionsFaces(dt);
    this.limitProjectionFailureMAC();
    this.capped = this.capFaces();

    this.applySolidBCFaces();
    if (this.windTunnel) this.windTunnelBCFaces();
    /* The published mirror, with the hard magnitude ceiling applied.
     *
     * The face clamp above bounds each component on its own, which leaves the
     * reconstruction free to reach cap*sqrt(2) — a tank with a ceiling of 182
     * displayed a peak of 258 that way, and the number on the legend is what a
     * user reads as "it exploded". Everything downstream reads this array, so
     * clamping it here is the guarantee that no part of the app can report or
     * act on a speed above the cap, whatever happens upstream. */
    g.refreshCentred(this.speedCap);
    if (this.windTunnel) this.injectDye(palette);
  }

  dampSealedRegionsFaces(dt) {
    const g = this.g;
    if (!g.hasSolid) return;
    if (this.tunnelDirty) this.refreshTunnelOpenness();
    const canExit = this.canExit;
    if (!canExit) return;
    const { nx, ny, stride: s, solid, uf, vf } = g;
    const decay = 1 / (1 + 6 * dt);
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx + 1; i++) {
        const idx = i + jS;
        if (solid[idx] || solid[idx - 1]) continue;
        if (canExit[idx] || canExit[idx - 1]) continue;
        uf[idx] *= decay;
      }
    }
    for (let j = 1; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || solid[idx - s]) continue;
        if (canExit[idx] || canExit[idx - s]) continue;
        vf[idx] *= decay;
      }
    }
  }

  step(dt, palette) {
    if (this.mac) return this.stepMAC(dt, palette);
    const g = this.g;
    const { u, v, uPrev: u0, vPrev: v0, fx, fy } = g;
    const n = g.size;

    // fx/fy are per-frame velocity IMPULSES, not forces — they are not scaled
    // by dt. Scaling them made every interaction's strength depend on the
    // current timestep, and since dt is itself derived from the peak speed,
    // a firm brush stroke fed back into itself: bigger impulse -> higher peak
    // -> smaller dt -> ... Gravity below is a genuine force and does take dt.
    for (let i = 0; i < n; i++) { u[i] += fx[i]; v[i] += fy[i]; }
    fx.fill(0); fy.fill(0);

    // Safety net against genuine pathologies (a lone staircase corner, a
    // pasted scene with absurd parameters). Set well above anything the flow
    // reaches on its own — measured peaks run 5-8x the reference speed — so it
    // never touches normal operation.
    if (this.speedCap > 0) {
      const cap = this.speedCap, cap2 = cap * cap;
      for (let i = 0; i < n; i++) {
        const a = u[i], b = v[i];
        const m2 = a * a + b * b;
        if (m2 > cap2) { const k = cap / Math.sqrt(m2); u[i] = a * k; v[i] = b * k; }
      }
    }

    if (Math.abs(this.gravity) > 1e-4) {
      const { nx, ny, stride: s, solid, dR, dG, dB } = g;
      const grav = this.gravity;
      const hasSolid = g.hasSolid;
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (hasSolid && solid[idx]) continue;
          v[idx] += dt * grav * (dR[idx] + dG[idx] + dB[idx]) * (1 / 3);
        }
      }
    }

    if (this.visc > 1e-9) {
      u0.set(u); this.diffuse(1, u, u0, this.visc, dt);
      v0.set(v); this.diffuse(2, v, v0, this.visc, dt);
    }

    // Advecting a divergent field smears mass around, so make it solenoidal
    // first. This projection is cheap because it warm-starts from the last one.
    if (this.preProject) this.project(this.preCycles);

    u0.set(u); v0.set(v);
    this.advectVelocity(dt);

    // Confinement and the SGS model both add a non-solenoidal component, and
    // the sponge damps interior cells. All of them belong BEFORE the final
    // projection — running them after leaves the divergence they introduce in
    // the field that gets rendered and measured.
    this.vorticityConfinement(dt);
    this.smagorinsky(dt);
    this.porousDrag(dt);
    this.applyFieldBC(dt);
    this.applySolidBC();
    if (this.windTunnel) {
      this.windTunnelSponge(dt);
      this.windTunnelBC();
    }

    this.project();

    // AFTER the projection, not before: the projection is what amplifies a
    // sealed pocket, so damping its input just loses the race against it.
    if (this.windTunnel) this.dampSealedRegions(dt);
    this.limitProjectionFailure();

    /* Ceiling AFTER the projection, not only before it.
     *
     * The cap at the top of the step bounds what goes IN, but the pressure
     * solve can produce anything on the way out, and a geometry the solve
     * cannot satisfy — a tunnel squeezed down to a few cells, where continuity
     * demands a speed the grid cannot carry — walks away inside a single step.
     * Clamping here turns that into saturation instead of a blow-up, which is
     * wrong in a visible, recoverable way rather than wrong in a way that
     * destroys the field and needs a reset. */
    if (this.speedCap > 0) {
      // Over the WHOLE array, ghost cells included. Restricting it to the
      // interior left the boundary rows holding values the interior no longer
      // had, and setBnd fed them straight back in next step.
      const cap = this.speedCap, cap2 = cap * cap;
      const { u, v } = g;
      let clamped = 0;
      for (let i = 0; i < n; i++) {
        const a = u[i], b = v[i];
        const m2 = a * a + b * b;
        // A NaN fails every comparison, so it has to be caught explicitly or it
        // survives the clamp and spreads.
        if (m2 > cap2) { const k = cap / Math.sqrt(m2); u[i] = a * k; v[i] = b * k; clamped++; }
        else if (!(m2 >= 0)) { u[i] = 0; v[i] = 0; clamped++; }
      }
      /* Reported, because a clamped field and a broken one look identical.
       *
       * Squeezing a tunnel down to a few cells demands, by continuity alone, a
       * speed the grid cannot carry — measured against a flat-walled control,
       * peaks of 30-40 through a narrowed channel are entirely physical. But
       * pinned at the ceiling it reads as "the simulation exploded", and there
       * was no way to tell that from an actual instability. Now there is. */
      this.capped = clamped;
    }

    // Boundary-only re-assertion: keeps the inlet exact and the bodies solid
    // without touching interior divergence.
    this.applySolidBC();
    if (this.windTunnel) {
      this.windTunnelBC();
      this.injectDye(palette);
    }
  }
}
