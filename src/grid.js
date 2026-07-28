/* Grid — rectangular Nx x Ny domain with a one-cell ghost border.
 *
 * Units. Everything is expressed in CELLS and TIME-UNITS:
 *   u, v   cells / time
 *   dt     time
 *   visc   cells^2 / time
 *   CFL    max(|u|,|v|) * dt          (cells advected per step)
 *
 * Cells are square, so the domain is (nx/ny) x 1 in physical aspect and the
 * discrete operators use h = 1 throughout. This is the change that makes CFL
 * a meaningful, controllable number instead of an emergent one.
 *
 * Buffer discipline. Dye has THREE distinct sets of buffers:
 *   dR/dG/dB    the field
 *   sR/sG/sB    per-frame sources (emitters, brush) — cleared every step
 *   tR/tG/tB    advection scratch
 * Aliasing the source buffer with the scratch buffer re-injects the whole dye
 * field as a source every frame, which compounds at (1+dt) per frame.
 */

export const FLUID = 0;
export const SOLID = 1;

export class Grid {
  constructor(nx, ny) {
    this.allocate(nx, ny);
  }

  allocate(nx, ny) {
    this.nx = nx;
    this.ny = ny;
    this.stride = nx + 2;
    this.size = (nx + 2) * (ny + 2);
    const n = this.size;

    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.uPrev = new Float32Array(n);
    this.vPrev = new Float32Array(n);

    this.p = new Float32Array(n);
    /* A SECOND pressure buffer, for the pre-advection projection.
     *
     * Both projections warm-start from the previous solve, which is what makes
     * two V-cycles enough. But they solve different right-hand sides, so
     * sharing one buffer means each starts from the other's answer — far from
     * its own — and neither converges. The collocated path survived that
     * because its wide gradient (p[i+1]-p[i-1])/2 cannot see a checkerboard and
     * so filtered the leftover error away. The compact staggered gradient has
     * no such null space, which is a virtue for accuracy and means unconverged
     * pressure goes straight into the velocity: measured on an inviscid
     * Taylor-Green vortex, a shared buffer took the kinetic energy from 2048 to
     * 12217 in forty steps. With one buffer each it holds 2040 over two hundred
     * steps, and the peak divergence lands at 1.8e-5 instead of 5.2e-3. */
    this.pPre = new Float32Array(n);
    this.div = new Float32Array(n);

    this.dR = new Float32Array(n);
    this.dG = new Float32Array(n);
    this.dB = new Float32Array(n);
    this.sR = new Float32Array(n);
    this.sG = new Float32Array(n);
    this.sB = new Float32Array(n);
    this.tR = new Float32Array(n);
    this.tG = new Float32Array(n);
    this.tB = new Float32Array(n);

    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);

    this.t1 = new Float32Array(n);
    this.t2 = new Float32Array(n);

    /* Dedicated snapshot buffers for the staggered step's centred pass.
     *
     * NOT `t1`/`t2`, and the reason is worth the two arrays: `vorticityConfinement`
     * takes `t1` as its curl scratch and overwrites it on entry. Snapshotting the
     * mirror into `t1` and differencing afterwards therefore computed
     * `u - curl` and scattered that onto the faces every step — the whole
     * velocity field, not the increment. It ran away in ten steps with
     * confinement on, which is the default, while every suite that happened to
     * set `vorticity = 0` (validate.mjs, water.mjs, mac.mjs) stayed green.
     *
     * Same family as the dye aliasing noted in section 2 of CONTEXT.md: a
     * scratch buffer with two owners. */
    this.snapU = new Float32Array(n);
    this.snapV = new Float32Array(n);

    /* Staggered (MAC) face velocities — THE velocity state when `ns.mac` is on.
     *
     *   uf[i,j] lies on the LEFT face of cell (i,j),  at x = i - 1/2
     *   vf[i,j] lies on the TOP  face of cell (i,j),  at y = j - 1/2
     *
     * so a cell's divergence is (uf[i+1]-uf[i]) + (vf[j+1]-vf[j]) — compact —
     * and its adjoint gradient is (p[i]-p[i-1]) — also compact. Their
     * composition is EXACTLY the five-point Laplacian the solver inverts, which
     * the collocated centred difference is not; that inconsistency is why the
     * collocated projection never fully removes the divergence it measures and
     * why extra V-cycles could make a closed region worse rather than better.
     *
     * Index ranges: uf over i in 1..nx+1, vf over j in 1..ny+1 — one more face
     * than cells in the staggered direction, which is what makes the operators
     * line up.
     *
     * `u`/`v` remain allocated and are a DERIVED, READ-ONLY mirror of these,
     * refreshed once per step for the renderers, particles, overlays and force
     * integration. See `refreshCentred` for why that direction is safe and the
     * other is not. */
    this.uf = new Float32Array(n);
    this.vf = new Float32Array(n);
    this.ufPrev = new Float32Array(n);
    this.vfPrev = new Float32Array(n);
    this.ufTmp = new Float32Array(n);
    this.vfTmp = new Float32Array(n);

    this.solid = new Uint8Array(n);
    // Fractional solid area per cell, mirrored from the rasteriser. The solver
    // still steps on the binary mask, but the force integration reads this:
    // grad(coverage) is a smeared surface delta whose integral is the body's
    // TRUE area, whereas counting exposed staircase faces overestimates the
    // perimeter by 4/pi and by a margin that drifts with resolution.
    // Zero, with hasCoverage false, when a mask was written straight into
    // `solid` without a Raster — consumers must fall back in that case.
    this.coverage = new Float32Array(n);
    this.hasCoverage = false;
    /* Free-surface air mask. Air differs from solid in exactly one way, and it
     * is the way that matters: a solid neighbour is EXCLUDED from the pressure
     * stencil (zero normal gradient, a wall), whereas an air neighbour is
     * INCLUDED holding p = 0 (Dirichlet, a free surface). That single
     * difference is what lets water fall, splash and settle instead of being
     * contained by an invisible lid. */
    this.air = new Uint8Array(n);
    this.hasAir = false;
    // Prescribed wall velocity inside solid cells. Zero everywhere for a
    // stationary no-slip wall, non-zero for moving and rotating bodies — which
    // is the whole difference between a cylinder that sheds symmetrically and
    // one that generates Magnus lift.
    this.bcU = new Float32Array(n);
    this.bcV = new Float32Array(n);
    this.hasMovingWall = false;
    // Darcy resistance in [0,1]. Non-zero only inside porous regions, which
    // slow the flow without blocking it.
    this.porous = new Float32Array(n);
    this.hasPorous = false;
    // Per-cell boundary role code, mirrored from the rasteriser so the solver
    // can dispatch on it without reaching back into the scene.
    this.bcType = new Uint8Array(n);
    this.bcK = new Float32Array(n);
    this.hasSlip = false;
    this.hasFieldBC = false;
    this.rho = new Float32Array(n).fill(1);
    this.nut = new Float32Array(n);

    this.hasSolid = false;
    this.openX = false; // wind-tunnel: left inlet / right outflow
  }

  idx(i, j) { return i + j * this.stride; }

  clearFlow() {
    this.u.fill(0); this.v.fill(0);
    this.uPrev.fill(0); this.vPrev.fill(0);
    this.uf.fill(0); this.vf.fill(0);
    this.ufPrev.fill(0); this.vfPrev.fill(0);
    this.p.fill(0); this.pPre.fill(0); this.div.fill(0);
    this.fx.fill(0); this.fy.fill(0);
    this.rho.fill(1); this.nut.fill(0);
  }

  clearDye() {
    this.dR.fill(0); this.dG.fill(0); this.dB.fill(0);
    this.sR.fill(0); this.sG.fill(0); this.sB.fill(0);
  }

  clearSolid() {
    this.solid.fill(0);
    this.coverage.fill(0);
    this.hasSolid = false;
    this.hasCoverage = false;
  }

  refreshSolidFlag() {
    this.hasSolid = this.solid.indexOf(SOLID) !== -1;
    return this.hasSolid;
  }

  /* Ghost-cell boundaries.
   *   kind 0 = scalar, 1 = x-velocity, 2 = y-velocity
   * Top/bottom are free-slip walls. Left/right are no-slip unless openX,
   * in which case they are Neumann so the inlet/outlet conditions applied
   * afterwards actually survive the relaxation sweeps. */
  setBnd(kind, x) {
    const { nx, ny, stride: s, openX } = this;
    const flipX = kind === 1 && !openX;
    const flipY = kind === 2;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      x[jS] = flipX ? -x[1 + jS] : x[1 + jS];
      x[nx + 1 + jS] = flipX ? -x[nx + jS] : x[nx + jS];
    }
    for (let i = 1; i <= nx; i++) {
      x[i] = flipY ? -x[i + s] : x[i + s];
      x[i + (ny + 1) * s] = flipY ? -x[i + ny * s] : x[i + ny * s];
    }

    const top = 0, bot = (ny + 1) * s;
    x[top] = 0.5 * (x[1] + x[s]);
    x[nx + 1 + top] = 0.5 * (x[nx + top] + x[nx + 1 + s]);
    x[bot] = 0.5 * (x[1 + bot] + x[ny * s]);
    x[nx + 1 + bot] = 0.5 * (x[nx + bot] + x[nx + 1 + ny * s]);
  }

  /* ── staggered helpers ────────────────────────────────────────────────────
   *
   * The rule these exist to enforce, and the reason the previous attempt at a
   * staggered solver was reverted:
   *
   *   Faces are the state. Interpolate INCREMENTS and DIAGNOSTICS across the
   *   staggering as much as you like; never interpolate the state itself back
   *   into the solver.
   *
   * The earlier "minimal MAC" interpolated cell -> face, projected, and
   * interpolated back into u/v. That round trip composes to
   * (u[i-1] + 2u[i] + u[i+1]) / 4 — a low-pass filter applied twice per step to
   * the solver's own state. It halved the divergence exactly as theory says and
   * still had to be reverted, because it smoothed away the vorticity it existed
   * to protect: cylinder Cd 1.25 -> 0.59, shedding 0.90 -> 0.10.
   *
   * `refreshCentred` runs the same averaging, but one way only, into a mirror
   * nothing reads back. A filter applied to an output is just a resampling; a
   * filter applied to a state compounds every step. That is the whole
   * difference.
   */
  /* @param cap  hard magnitude ceiling for the mirror; 0 disables.
   *
   * The ceiling is applied HERE, on the way out, and that is the last line of
   * defence for the whole application. The face clamp bounds each component
   * separately, so a cell with both components on the limit reconstructs to
   * cap*sqrt(2) — which is how a tank with a ceiling of 182 displayed a peak of
   * 258. Everything downstream reads this mirror: the colour scale, the legend,
   * the probe, the diagnostics, the particles. Clamping it means no part of the
   * app can ever report or act on a speed above the cap, whatever the solver
   * does upstream, and a NaN becomes a zero rather than spreading.
   *
   * Safe precisely because the mirror is derived and never read back — see the
   * note on this method's one-way contract above. */
  refreshCentred(cap = 0) {
    const { nx, ny, stride: s, u, v, uf, vf, solid, hasSolid } = this;
    const cap2 = cap * cap;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) { u[idx] = 0; v[idx] = 0; continue; }
        let a = 0.5 * (uf[idx] + uf[idx + 1]);
        let b = 0.5 * (vf[idx] + vf[idx + s]);
        const m2 = a * a + b * b;
        // A NaN fails every comparison, so it is caught by the negation rather
        // than by a test for largeness.
        if (!(m2 >= 0)) { a = 0; b = 0; }
        else if (cap > 0 && m2 > cap2) { const k = cap / Math.sqrt(m2); a *= k; b *= k; }
        u[idx] = a; v[idx] = b;
      }
    }
    this.setBnd(1, u);
    this.setBnd(2, v);
  }

  /* Seed the faces from the cell-centred field.
   *
   * Only for initialisation and for handing over from the collocated path — it
   * is the forbidden direction if used per-step, which is why nothing in the
   * step loop calls it. */
  seedFacesFromCentred() {
    const { nx, ny, stride: s, u, v, uf, vf } = this;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx + 1; i++) {
        const idx = i + jS;
        uf[idx] = 0.5 * (u[idx - 1] + u[idx]);
      }
    }
    for (let j = 1; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        vf[idx] = 0.5 * (v[idx - s] + v[idx]);
      }
    }
    this.setBndFaces();
  }

  /* Add a cell-centred increment onto the faces that border each cell.
   *
   * Safe in a way that mirroring the state is not: an increment carries no
   * history, so smoothing it once costs a little accuracy in that one
   * contribution and cannot compound. This is how confinement, the SGS model,
   * porous drag and brush impulses reach a staggered field without any of them
   * needing to be rewritten. */
  addCentredToFaces(ax, ay) {
    const { nx, ny, stride: s, uf, vf } = this;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 2; i <= nx; i++) {
        const idx = i + jS;
        uf[idx] += 0.5 * (ax[idx - 1] + ax[idx]);
      }
      // Domain-edge faces border one interior cell, so they take it whole
      // rather than averaging in a ghost value that is only a reflection.
      uf[1 + jS] += ax[1 + jS];
      uf[nx + 1 + jS] += ax[nx + jS];
    }
    for (let j = 2; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        vf[idx] += 0.5 * (ay[idx - s] + ay[idx]);
      }
    }
    for (let i = 1; i <= nx; i++) {
      vf[i + s] += ay[i + s];
      vf[i + (ny + 1) * s] += ay[i + ny * s];
    }
  }

  /* Face boundary conditions.
   *
   * Cleaner than the collocated equivalent, and that is the point: a wall lies
   * exactly ON a face, so "no flow through it" is uf = 0 — an exact statement
   * about the unknown itself, not a reflection through a ghost cell that only
   * approximates it. Tangential faces are mirrored for free slip.
   */
  setBndFaces(uf = this.uf, vf = this.vf) {
    const { nx, ny, stride: s, openX } = this;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      // Left/right domain walls. Open (tunnel) means the normal face is free to
      // carry flow and simply copies its neighbour; closed means no through-flow.
      if (openX) {
        uf[1 + jS] = uf[2 + jS];
        uf[nx + 1 + jS] = uf[nx + jS];
      } else {
        uf[1 + jS] = 0;
        uf[nx + 1 + jS] = 0;
      }
      uf[jS] = uf[1 + jS];
      // Tangential v on the side ghost columns: free slip.
      vf[jS] = vf[1 + jS];
      vf[nx + 1 + jS] = vf[nx + jS];
    }

    for (let i = 1; i <= nx; i++) {
      // Top/bottom are solid walls: no through-flow.
      vf[i + s] = 0;
      vf[i + (ny + 1) * s] = 0;
      vf[i] = vf[i + s];
      // Tangential u on the top/bottom ghost rows: free slip.
      uf[i] = uf[i + s];
      uf[i + (ny + 1) * s] = uf[i + ny * s];
    }
    uf[nx + 1] = uf[nx + 1 + s];
    uf[nx + 1 + (ny + 1) * s] = uf[nx + 1 + ny * s];
  }

  /* Neumann on all walls — used for pressure at every multigrid level. */
  static setBndP(x, nx, ny) {
    const s = nx + 2;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      x[jS] = x[1 + jS];
      x[nx + 1 + jS] = x[nx + jS];
    }
    for (let i = 1; i <= nx; i++) {
      x[i] = x[i + s];
      x[i + (ny + 1) * s] = x[i + ny * s];
    }
    const bot = (ny + 1) * s;
    x[0] = 0.5 * (x[1] + x[s]);
    x[nx + 1] = 0.5 * (x[nx] + x[nx + 1 + s]);
    x[bot] = 0.5 * (x[1 + bot] + x[ny * s]);
    x[nx + 1 + bot] = 0.5 * (x[nx + bot] + x[nx + 1 + ny * s]);
  }

  /* Red-black SOR for (c*x - a*sum(neighbours)) = rhs.
   *
   * omega is passed in because the optimum depends on the SYSTEM, not just the
   * grid: ~1.9 for the Poisson problem (a=1, c=4), but ~1.0 for the strongly
   * diagonally-dominant Helmholtz system that implicit diffusion produces.
   * Using the Poisson optimum on the diffusion solve leaves it unconverged. */
  relax(kind, x, rhs, a, c, iters, omega) {
    const { nx, ny, stride: s, hasSolid, solid } = this;
    const cinv = 1 / c;
    for (let k = 0; k < iters; k++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let j = 1; j <= ny; j++) {
          const jS = j * s;
          const i0 = 1 + ((j + colour) & 1);
          for (let i = i0; i <= nx; i += 2) {
            const idx = i + jS;
            if (hasSolid && solid[idx]) continue;
            const gs = (rhs[idx] + a * (x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s])) * cinv;
            x[idx] += omega * (gs - x[idx]);
          }
        }
      }
      this.setBnd(kind, x);
    }
  }
}

/* Geometric multigrid V-cycle for the pressure Poisson equation.
 *
 * The stencil is  nf(i,j)*p - sum(p over FLUID neighbours) = div,  where nf is
 * the number of non-solid neighbours. Using a fixed diagonal of 4 and simply
 * skipping solid cells implies a Dirichlet p=0 inside the body, not the
 * zero-normal-gradient condition a wall actually imposes; the projection then
 * fails to remove divergence in exactly the cells next to a body, which is
 * where the interesting flow is. Solid cells are held at zero so that summing
 * all four neighbours is identical to summing only the fluid ones.
 *
 * Coarsens while both dimensions stay even, so 256x128 gives
 * 256x128 -> 128x64 -> 64x32 -> 32x16 -> 16x8 -> 8x4. */
export class Poisson {
  constructor(grid) {
    this.grid = grid;
    this.build();
  }

  build() {
    const levels = [];
    let nx = this.grid.nx, ny = this.grid.ny;
    for (;;) {
      const size = (nx + 2) * (ny + 2);
      const first = levels.length === 0;
      levels.push({
        nx, ny, s: nx + 2,
        // Poisson optimum for this level.
        omega: Math.min(1.9, 2 / (1 + Math.sin(Math.PI / Math.max(nx, ny)))),
        // Level 0 borrows the caller's arrays — allocating them here would
        // orphan ~300 KB on the first solve.
        x: first ? null : new Float32Array(size),
        b: first ? null : new Float32Array(size),
        r: new Float32Array(size),
        solid: first ? this.grid.solid : new Uint8Array(size),
        nf: new Uint8Array(size),
        // Reciprocal of the diagonal, precomputed. The smoother is the hottest
        // loop in the solver — roughly half of all frame time — and a divide
        // there costs several times a multiply.
        invNf: new Float32Array(size),
        hasSolid: false,
      });
      if ((nx & 1) || (ny & 1) || Math.min(nx, ny) <= 4) break;
      nx >>= 1; ny >>= 1;
    }
    this.levels = levels;
    this.dirty = true;
  }

  smooth(lvl, iters, deflate = false) {
    const { nx, ny, s, omega, hasSolid, invNf } = lvl;
    const x = lvl.x, b = lvl.b;
    for (let k = 0; k < iters; k++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let j = 1; j <= ny; j++) {
          const jS = j * s;
          const i0 = 1 + ((j + colour) & 1);
          if (hasSolid) {
            for (let i = i0; i <= nx; i += 2) {
              const idx = i + jS;
              // invNf is zero inside solids and in fully enclosed cells, so
              // the update is a no-op there without needing a branch.
              const inv = invNf[idx];
              if (inv === 0) continue;
              x[idx] += omega * ((b[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]) * inv - x[idx]);
            }
          } else {
            for (let i = i0; i <= nx; i += 2) {
              const idx = i + jS;
              x[idx] += omega * ((b[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]) * 0.25 - x[idx]);
            }
          }
        }
      }
      Grid.setBndP(x, nx, ny);
    }
    // Project the null space out on the COARSEST level.
    //
    // Every level solves an all-Neumann problem, which is singular. The fine
    // grid has its mean removed after the solve, but the coarse grids did not,
    // so their constant component grew each sweep and was prolongated back up.
    // The coarsest level is where it accumulates — it takes the most sweeps and
    // has the fewest cells to spread over — and deflating only there costs
    // almost nothing, whereas doing it in every smoothing call adds two full
    // passes per level per cycle.
    if (!deflate) return;
    let sum = 0, n = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && lvl.solid[idx]) continue;
        sum += x[idx]; n++;
      }
    }
    if (n) {
      const mean = sum / n;
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (hasSolid && lvl.solid[idx]) continue;
          x[idx] -= mean;
        }
      }
      Grid.setBndP(x, nx, ny);
    }
  }

  countNeighbours(lvl, air = null) {
    const { nx, ny, s, solid, hasSolid, nf, invNf } = lvl;
    if (!hasSolid && !air) { nf.fill(4); invNf.fill(0.25); return; }
    nf.fill(0); invNf.fill(0);
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) continue;
        // Air cells are not solved — they hold p = 0 — so they are skipped the
        // same way solids are. Their NEIGHBOURS, though, still count them in
        // the diagonal, which is exactly what makes the condition Dirichlet
        // rather than Neumann.
        if (air && air[idx]) continue;
        const d = 4 - (solid[idx - 1] ? 1 : 0) - (solid[idx + 1] ? 1 : 0)
                    - (solid[idx - s] ? 1 : 0) - (solid[idx + s] ? 1 : 0);
        nf[idx] = d;
        invNf[idx] = d ? 1 / d : 0;
      }
    }
  }

  /* Label connected fluid regions by flood fill.
   *
   * With Neumann conditions everywhere the Poisson problem is singular on EACH
   * connected region independently, and solvable on each only if the
   * right-hand side has zero mean THERE. Geometry that seals off a pocket —
   * the bifurcation's branch corners, or anything a user draws — leaves that
   * pocket with a non-zero mean divergence that no pressure field can satisfy,
   * and the solver diverges trying. Removing the mean per region instead of
   * globally makes every geometry well posed. */
  labelRegions() {
    const { nx, ny, stride: s, size, solid } = this.grid;
    if (!this.region || this.region.length !== size) {
      this.region = new Int32Array(size);
      this.stack = new Int32Array(size);
    }
    const region = this.region;
    const stack = this.stack;
    region.fill(-1);

    let count = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const start = i + jS;
        if (solid[start] || region[start] !== -1) continue;
        let top = 0;
        stack[top++] = start;
        region[start] = count;
        while (top > 0) {
          const idx = stack[--top];
          const ci = idx % s;
          const cj = (idx / s) | 0;
          if (ci > 1 && !solid[idx - 1] && region[idx - 1] === -1) { region[idx - 1] = count; stack[top++] = idx - 1; }
          if (ci < nx && !solid[idx + 1] && region[idx + 1] === -1) { region[idx + 1] = count; stack[top++] = idx + 1; }
          if (cj > 1 && !solid[idx - s] && region[idx - s] === -1) { region[idx - s] = count; stack[top++] = idx - s; }
          if (cj < ny && !solid[idx + s] && region[idx + s] === -1) { region[idx + s] = count; stack[top++] = idx + s; }
        }
        count++;
      }
    }
    this.regionCount = count;
    if (!this.regionSum || this.regionSum.length < count) {
      this.regionSum = new Float64Array(Math.max(count, 8));
      this.regionN = new Int32Array(Math.max(count, 8));
    }
  }

  /* Subtract each connected region's mean from `field`, over fluid cells. */
  /* Which connected fluid regions have their pressure datum PINNED.
   *
   * A region touching air contains Dirichlet cells (p = 0 there), so its
   * constant is fixed and removing its mean would destroy the free surface —
   * the water would sit under a lid. A region with NO air in it is bounded
   * entirely by solid, is all-Neumann, and is therefore singular: its pressure
   * is defined only up to a constant that nothing removes, and its divergence
   * has to be compatible or there is no solution at all.
   *
   * This used to be one GLOBAL test — `if (!hasAir)` — which is right only when
   * every region is alike. Draw a lid over part of a tank and it is not: the
   * open part is pinned, the sealed pocket is not, and the global test declared
   * the whole domain pinned and left the pocket singular. The multigrid then
   * converged on an unbounded constant and the pocket's velocity went with it.
   * Measured on a settled tank, drawing a lid took the peak from 2.7 to the
   * speed ceiling; sealing a box inside the water did the same.
   *
   * With no air anywhere, every region comes out unpinned and this behaves
   * exactly as the old global test did.
   */
  classifyRegions(air) {
    const { nx, ny, stride: s } = this.grid;
    const count = this.regionCount || 0;
    if (!this.regionPinned || this.regionPinned.length < Math.max(count, 8)) {
      this.regionPinned = new Uint8Array(Math.max(count, 8));
    }
    const pinned = this.regionPinned;
    pinned.fill(0, 0, Math.max(count, 1));
    if (!air) return pinned;
    const region = this.region;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (!air[idx]) continue;
        const r = region[idx];
        if (r >= 0) pinned[r] = 1;
      }
    }
    return pinned;
  }

  /* `onlyUnpinned` limits the correction to regions with no Dirichlet cell of
   * their own — the ones that actually need it. */
  removeRegionMeans(field, zeroSolid, onlyUnpinned = false) {
    const { nx, ny, stride: s, solid } = this.grid;
    const region = this.region;
    const sum = this.regionSum, n = this.regionN;
    const count = this.regionCount;
    if (!count) return;
    const pinned = onlyUnpinned ? (this.regionPinned || null) : null;
    sum.fill(0, 0, count);
    n.fill(0, 0, count);

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const r = region[idx];
        if (r < 0) continue;
        sum[r] += field[idx];
        n[r]++;
      }
    }
    for (let r = 0; r < count; r++) sum[r] = n[r] ? sum[r] / n[r] : 0;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const r = region[idx];
        if (r < 0) { if (zeroSolid) field[idx] = 0; continue; }
        if (pinned && pinned[r]) continue;
        field[idx] -= sum[r];
      }
    }
  }

  restrictSolid() {
    const L = this.levels;
    L[0].hasSolid = this.grid.hasSolid;
    for (let l = 1; l < L.length; l++) {
      const f = L[l - 1], c = L[l];
      const sf = f.s, sc = c.s;
      c.solid.fill(0);
      let any = false;
      for (let j = 1; j <= c.ny; j++) {
        const fj = 2 * j - 1;
        const cj = j * sc, f0 = fj * sf, f1 = (fj + 1) * sf;
        for (let i = 1; i <= c.nx; i++) {
          const fi = 2 * i - 1;
          // A coarse cell is solid if ANY child is. Requiring all four instead
          // makes thin bodies — a flat plate is three cells wide — vanish on
          // every coarse level, so the correction happily smears straight
          // through them.
          const o = f.solid[fi + f0] | f.solid[fi + 1 + f0] | f.solid[fi + f1] | f.solid[fi + 1 + f1];
          c.solid[i + cj] = o;
          if (o) any = true;
        }
      }
      c.hasSolid = any;
    }
    for (const lvl of L) this.countNeighbours(lvl);
    this.labelRegions();
  }

  vcycle(l) {
    const L = this.levels;
    const lvl = L[l];
    if (l === L.length - 1) { this.smooth(lvl, 12, true); return; }

    this.smooth(lvl, 2);

    const { nx, ny, s, solid, hasSolid, r, nf } = lvl;
    const x = lvl.x, b = lvl.b;
    if (hasSolid) {
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          // nf === 0 means the smoother never touches this cell — solid, or an
          // air cell under a free surface. Its residual must be zero, or the
          // garbage gets restricted onto the coarse grid and prolongated back
          // into the water as a correction nobody asked for.
          r[idx] = (solid[idx] || nf[idx] === 0) ? 0
            : b[idx] - nf[idx] * x[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s];
        }
      }
    } else {
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          r[idx] = b[idx] - 4 * x[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s];
        }
      }
    }

    const nxt = L[l + 1];
    const sc = nxt.s;
    for (let j = 1; j <= nxt.ny; j++) {
      const fj = 2 * j - 1;
      const cj = j * sc, f0 = fj * s, f1 = (fj + 1) * s;
      for (let i = 1; i <= nxt.nx; i++) {
        const fi = 2 * i - 1;
        nxt.b[i + cj] = 0.25 * (r[fi + f0] + r[fi + 1 + f0] + r[fi + f1] + r[fi + 1 + f1]);
      }
    }
    nxt.x.fill(0);
    this.vcycle(l + 1);

    for (let j = 1; j <= nxt.ny; j++) {
      const fj = 2 * j - 1;
      const cj = j * sc, f0 = fj * s, f1 = (fj + 1) * s;
      for (let i = 1; i <= nxt.nx; i++) {
        const fi = 2 * i - 1;
        const val = nxt.x[i + cj];
        x[fi + f0] += val; x[fi + 1 + f0] += val;
        x[fi + f1] += val; x[fi + 1 + f1] += val;
      }
    }

    this.smooth(lvl, 2);
  }

  ensureTopology() {
    if (!this.dirty && this.region) return;
    this.restrictSolid();
    this.dirty = false;
  }

  solve(p, div, cycles = 2) {
    const L = this.levels;
    if (L.length < 2) {
      this.grid.relax(0, p, div, 1, 4, 20, 1.8);
      return;
    }
    this.ensureTopology();
    L[0].x = p;
    L[0].b = div;
    L[0].hasSolid = this.grid.hasSolid;

    /* A free surface moves every step, so the finest level's stencil has to be
     * rebuilt every solve — unlike the solid mask, which only changes when the
     * geometry does. Coarse levels keep the solid-only stencil: they carry the
     * long-wavelength correction, and the surface condition is a fine-scale
     * boundary that the fine-level smoothing resolves. */
    const air = this.grid.hasAir ? this.grid.air : null;
    /* Restore the plain stencil the first solve after a surface goes away.
     *
     * With a free surface the finest level is rebuilt every solve, because the
     * surface moves. When it stops existing nothing rebuilds it, so the solver
     * would carry on using a diagonal that counts air cells that are no longer
     * there — a wrong pressure field with nothing on screen to explain it.
     * Recovered here rather than at the call site, so anything that turns a
     * surface off cannot forget. */
    if (!air && this.airStencil) {
      this.countNeighbours(L[0]);
      this.airStencil = false;
    }
    this.classifyRegions(air);
    if (air) {
      L[0].hasSolid = true;              // the smoother must take the masked path
      this.airStencil = true;
      this.countNeighbours(L[0], air);
      const { nx, ny, stride: st } = this.grid;
      for (let j = 1; j <= ny; j++) {
        const jS = j * st;
        for (let i = 1; i <= nx; i++) if (air[i + jS]) p[i + jS] = 0;
      }
    }

    // Solid cells must read as zero for the neighbour sum to equal the sum over
    // fluid neighbours only. They are never written by the smoother, so a stale
    // warm-start value would otherwise leak into every adjacent cell.
    if (this.grid.hasSolid) {
      const { nx, ny, stride: s, solid } = this.grid;
      for (let j = 1; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (solid[idx]) p[idx] = 0;
        }
      }
    }

    for (let c = 0; c < cycles; c++) this.vcycle(0);

    /* The solution is defined only up to a constant per region, and nothing
     * pins it — UNLESS the region contains air, where p = 0 is a genuine
     * Dirichlet condition that fixes the datum. Removing the mean there would
     * destroy the very thing that makes the surface free and the water would
     * sit under a lid; NOT removing it in a sealed pocket leaves that pocket's
     * pressure free to drift without bound. Both happen in the same domain the
     * moment you draw a lid over part of a tank, which is why this is decided
     * per region rather than once for the whole grid. */
    this.removeRegionMeans(p, true, true);
    this.mirrorIntoSolids(p);

    Grid.setBndP(p, this.grid.nx, this.grid.ny);
  }

  /* Give each boundary solid cell the average pressure of its fluid
   * neighbours, i.e. a discrete zero normal gradient.
   *
   * The solve holds solid cells at zero so that the neighbour sum equals the
   * sum over fluid neighbours only. But the velocity correction then reads
   * those zeros through its centred difference and interprets them as a real
   * pressure, kicking every surface cell. Mirroring afterwards lets the
   * gradient stay centred — and therefore stay consistent with the centred
   * divergence it is meant to undo — while still seeing a wall. */
  mirrorIntoSolids(p) {
    const { nx, ny, stride: s, solid, hasSolid } = this.grid;
    if (!hasSolid) return;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (!solid[idx]) continue;
        let sum = 0, n = 0;
        if (!solid[idx - 1]) { sum += p[idx - 1]; n++; }
        if (!solid[idx + 1]) { sum += p[idx + 1]; n++; }
        if (!solid[idx - s]) { sum += p[idx - s]; n++; }
        if (!solid[idx + s]) { sum += p[idx + s]; n++; }
        p[idx] = n ? sum / n : 0;
      }
    }
  }

  /* Make the right-hand side compatible: zero mean on every connected region.
   * Inflow and outflow never balance to machine precision, and a sealed pocket
   * has no reason to balance at all. */
  makeCompatible(div) {
    this.ensureTopology();
    this.removeRegionMeans(div, true);
  }

  /* Compatibility for SEALED regions only, for use when a free surface exists.
   *
   * An all-Neumann region can only be solved if its divergence sums to zero —
   * physically, incompressible fluid in a closed box cannot have net inflow.
   * When the geometry changes under it (you draw a solid into a pocket of
   * water) that condition is violated, and an incompatible singular system has
   * no solution at all: the multigrid does not fail, it runs away.
   *
   * Removing the region's mean divergence projects the RHS onto the solvable
   * subspace. The part that is discarded is exactly the volume error the
   * geometry just imposed — which cannot be satisfied by any pressure field, so
   * discarding it is the honest answer rather than an approximation.
   *
   * Regions containing air are left alone: their Dirichlet cells absorb net
   * inflow, which is what lets a tank fill and drain. */
  makeSealedCompatible(div, air) {
    this.ensureTopology();
    this.classifyRegions(air);
    this.removeRegionMeans(div, true, true);
  }

  /* RMS residual of the current solution — used by the test suite to confirm
   * the solver is actually converging rather than merely not diverging. */
  residualRMS(p, div) {
    const { nx, ny, stride: s, solid, hasSolid } = this.grid;
    const nf = this.levels[0].nf;
    let sum = 0, n = 0;
    for (let j = 2; j <= ny - 1; j++) {
      const jS = j * s;
      for (let i = 2; i <= nx - 1; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;
        const d = hasSolid ? nf[idx] : 4;
        if (!d) continue;
        const r = div[idx] - d * p[idx] + p[idx - 1] + p[idx + 1] + p[idx - s] + p[idx + s];
        sum += r * r; n++;
      }
    }
    return n ? Math.sqrt(sum / n) : 0;
  }
}
