/* Free-surface water: one fluid with a moving boundary against void.
 *
 * The air is NOT simulated. That is the whole idea, and it is what makes this
 * tractable at interactive rates: air is a thousand times lighter than water,
 * so to the water it is very nearly a constant-pressure vacuum. Modelling both
 * phases properly means resolving a density ratio of 1000 across one cell,
 * which is a different and much harder problem (that is the "coupled air-water"
 * mode, still disabled).
 *
 * So the domain carries a volume fraction:
 *
 *   fill = 1   full of water   — solved normally
 *   fill = 0   empty (air)     — not solved; pressure pinned at zero
 *   0 < fill < 1               — the surface itself
 *
 * The pressure boundary condition at the surface is what makes it a FREE
 * surface: air cells hold p = 0 (Dirichlet) instead of the zero-gradient
 * condition a wall imposes. Water next to air therefore feels no resistance to
 * moving outward, which is exactly what a free surface is, and it is why the
 * same projection machinery produces waves and splashes without further help.
 *
 * `fill` is advected by the same MacCormack scheme the dye uses, for the same
 * reason: a first-order upwind advection of the fraction smears the surface
 * over several cells within a second and the water visibly evaporates.
 *
 * Mass is not conserved exactly. Advecting a fraction never is — a proper
 * treatment reconstructs the interface geometrically (VOF/PLIC) or tracks a
 * signed distance and reinitialises it (level set). Both are substantially more
 * code and neither is free at this resolution, so instead the total is measured
 * and gently corrected each step, which holds it to a fraction of a per cent
 * over minutes rather than letting it drain away.
 */

export const AIR = 0.02;      // below this a cell is treated as empty
export const FULL = 0.5;      // at or above this it takes part in the solve

/* ── saving the field ───────────────────────────────────────────────────────
 *
 * A tank is tens of thousands of cells and nearly every one is exactly 0 or
 * exactly 1 — only the one-cell-thick interface lies in between — so a run
 * length encoding takes a 256x128 field down to a few hundred bytes, small
 * enough to sit inside a project file without thought.
 *
 * Quantising to a byte costs nothing that survives a step: `sharpen` re-forms
 * the interface from scratch every frame, so a 1/255 error in a surface cell is
 * gone before it can be measured.
 *
 * Runs are three bytes — value, then a 16-bit length, low byte first.
 */
export function encodeFill(fill) {
  const out = [];
  let prev = -1, run = 0;
  const flush = () => { if (prev >= 0) out.push(prev, run & 255, run >> 8); };
  for (let i = 0; i < fill.length; i++) {
    const q = Math.max(0, Math.min(255, Math.round((fill[i] || 0) * 255)));
    if (q === prev && run < 65535) { run++; continue; }
    flush();
    prev = q; run = 1;
  }
  flush();
  let s = '';
  for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
  return btoa(s);
}

/* Returns the number of cells written, so a caller can tell a truncated or
 * mismatched payload from a good one rather than silently half-filling a tank. */
export function decodeFill(str, fill) {
  const bin = atob(str);
  let k = 0;
  for (let i = 0; i + 3 <= bin.length; i += 3) {
    const v = bin.charCodeAt(i) / 255;
    const run = bin.charCodeAt(i + 1) | (bin.charCodeAt(i + 2) << 8);
    for (let r = 0; r < run && k < fill.length; r++) fill[k++] = v;
  }
  return k;
}

export class FreeSurface {
  constructor(grid) {
    this.g = grid;
    this.allocate();
    this.gravity = 9.0;        // cells / time^2
    this.targetVolume = 0;
    this.enabled = false;
    // Mirrors NavierStokes.mac. Gravity is the one part of the surface that
    // has to reach the solver's state directly rather than through the mirror.
    this.mac = false;
  }

  allocate() {
    const n = this.g.size;
    this.fill = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.back = new Float32Array(n);   // MacCormack forward pass
    this.phase = new Uint8Array(n);   // 0 air, 1 surface, 2 interior water
  }

  ensureSize() {
    if (this.fill.length !== this.g.size) this.allocate();
  }

  /* Fill the lower `frac` of the domain, which is the usual starting state:
   * a body of water at rest under gravity. */
  reset(frac = 0.45) {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    this.fill.fill(0);
    const surface = ny - Math.round(ny * frac);
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const idx = i + j * s;
        if (solid[idx]) continue;
        // j runs DOWNWARD, so larger j is lower and fills first.
        this.fill[idx] = j > surface ? 1 : (j === surface ? 0.5 : 0);
      }
    }
    this.targetVolume = this.volume();
    this.classify();
  }

  /* Starting states worth having.
   *
   * A still tank shows that the surface holds level, which is the thing most
   * easily got wrong, but it is not much to look at. These are the two classic
   * free-surface cases: a dam break, whose front position against time is a
   * textbook comparison, and a drop, which shows the surface reacting to an
   * impact rather than sitting there. */
  preset(name) {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill;
    f.fill(0);
    if (name === 'dam') {
      // A tall column against the left wall, released at t = 0.
      for (let j = 1; j <= ny; j++)
        for (let i = 1; i <= nx; i++)
          if (i <= nx * 0.22 && j > ny * 0.15) f[i + j * s] = 1;
    } else if (name === 'drop') {
      // A shallow pool with a ball of water above it.
      const surface = ny - Math.round(ny * 0.30);
      const cx = nx * 0.5, cy = ny * 0.22, r = Math.max(4, ny * 0.11);
      for (let j = 1; j <= ny; j++)
        for (let i = 1; i <= nx; i++) {
          const dx = i - cx, dy = j - cy;
          f[i + j * s] = (j > surface || dx * dx + dy * dy < r * r) ? 1 : 0;
        }
    } else {
      const surface = ny - Math.round(ny * 0.45);
      for (let j = 1; j <= ny; j++)
        for (let i = 1; i <= nx; i++) f[i + j * s] = j > surface ? 1 : (j === surface ? 0.5 : 0);
    }
    // Solids hold no water, and counting them would set a volume target the
    // surface can never reach — it would then pump water in forever.
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx; i++) if (solid[i + j * s]) f[i + j * s] = 0;
    this.targetVolume = this.volume();
    this.classify();
  }

  volume() {
    const { nx, ny, stride: s, solid } = this.g;
    let v = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (!solid[idx]) v += this.fill[idx];
      }
    }
    return v;
  }

  /* Label every cell air / surface / interior.
   *
   * A SURFACE cell is water with at least one air neighbour. It is the only
   * place the free-surface pressure condition applies, and separating it out
   * here keeps that test out of the projection's inner loop. */
  classify() {
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill, ph = this.phase;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) { ph[idx] = 0; continue; }
        if (f[idx] < FULL) { ph[idx] = 0; continue; }
        const air = f[idx - 1] < FULL || f[idx + 1] < FULL
                 || f[idx - s] < FULL || f[idx + s] < FULL;
        ph[idx] = air ? 1 : 2;
      }
    }
  }

  /* Gravity, applied only to water.
   *
   * Air cells must not be accelerated: their velocity is meaningless, and
   * letting it grow gives the advection of `fill` a large spurious velocity to
   * carry the surface around with. */
  applyGravity(dt) {
    const { nx, ny, stride: s, solid, v, vf } = this.g;
    const a = this.gravity * dt;

    /* On a staggered grid gravity belongs on the faces, because that is where
     * the state lives — added to the centred mirror it would be discarded by
     * the next refresh and the water would simply never fall.
     *
     * A face is accelerated when EITHER side holds water. Requiring both would
     * skip the surface face itself, which is precisely where gravity has to act
     * for the surface to move at all. */
    if (this.mac) {
      for (let j = 2; j <= ny; j++) {
        const jS = j * s;
        for (let i = 1; i <= nx; i++) {
          const idx = i + jS;
          if (solid[idx] || solid[idx - s]) continue;
          if (this.fill[idx] < FULL && this.fill[idx - s] < FULL) continue;
          vf[idx] += a;                    // +v is DOWN on screen
        }
      }
      return;
    }

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || this.fill[idx] < FULL) continue;
        v[idx] += a;                       // +v is DOWN on screen
      }
    }
  }

  /* Give air cells the velocity of the water they touch.
   *
   * Advecting the fraction needs a velocity everywhere it might move into, and
   * air cells never had one assigned — they are outside the solve. Leaving them
   * at zero makes the surface advect into a wall of stationary fluid and the
   * water refuses to rise. Extrapolating one cell out is enough, because the
   * fraction only ever moves one cell per step at CFL ~ 1. */
  extrapolateVelocity() {
    const { nx, ny, stride: s, solid, u, v } = this.g;
    const f = this.fill;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || f[idx] >= FULL) continue;
        let su = 0, sv = 0, n = 0;
        if (f[idx - 1] >= FULL) { su += u[idx - 1]; sv += v[idx - 1]; n++; }
        if (f[idx + 1] >= FULL) { su += u[idx + 1]; sv += v[idx + 1]; n++; }
        if (f[idx - s] >= FULL) { su += u[idx - s]; sv += v[idx - s]; n++; }
        if (f[idx + s] >= FULL) { su += u[idx + s]; sv += v[idx + s]; n++; }
        if (n) { u[idx] = su / n; v[idx] = sv / n; }
        else { u[idx] = 0; v[idx] = 0; }
      }
    }
  }

  /* Advect the fraction with the same MacCormack + limiter the dye uses.
   *
   * The limiter matters more here than for dye: an overshoot past 1 is water
   * appearing from nowhere and an undershoot below 0 is a hole in the middle of
   * the body, both of which the eye picks up immediately. */
  advect(dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v } = g;
    const f = this.fill, t = this.tmp, back = this.back;
    t.set(f);
    const loX = 0.5, hiX = nx + 0.5, loY = 0.5, hiY = ny + 0.5;

    /* Sample `src` at the point this cell's fluid came from `sign * dt` ago. */
    const trace = (src, i, j, idx, sign) => {
      let x = i - sign * dt * u[idx], y = j - sign * dt * v[idx];
      if (x < loX) x = loX; else if (x > hiX) x = hiX;
      if (y < loY) y = loY; else if (y > hiY) y = hiY;
      const i0 = x | 0, j0 = y | 0;
      const bx = x - i0, ax = 1 - bx, by = y - j0, ay = 1 - by;
      const a00 = i0 + j0 * s, a10 = a00 + 1, a01 = a00 + s, a11 = a01 + 1;
      return ax * ay * src[a00] + bx * ay * src[a10] + ax * by * src[a01] + bx * by * src[a11];
    };

    // Forward.
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        back[idx] = solid[idx] ? 0 : trace(t, i, j, idx, 1);
      }
    }
    /* Backward, then correct by half the round-trip error.
     *
     * A single semi-Lagrangian trace is first order, and on a body of water in
     * free fall that is not a subtle loss: measured, a dropped blob kept its
     * volume to within 1% but smeared so far that no cell held more than half
     * fill after fifty steps — the water was still there and had stopped
     * looking like water. MacCormack recovers second order for the cost of one
     * more trace, and the limiter below keeps it monotone.
     */
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) { f[idx] = 0; continue; }
        const fwd = back[idx];
        const round = trace(back, i, j, idx, -1);
        let val = fwd + 0.5 * (t[idx] - round);

        // Monotonicity: clamp to the range of the cells it actually came from.
        // Without this the correction overshoots past 1 — water appearing from
        // nowhere — and below 0, a hole inside the body.
        let x = i - dt * u[idx], y = j - dt * v[idx];
        if (x < loX) x = loX; else if (x > hiX) x = hiX;
        if (y < loY) y = loY; else if (y > hiY) y = hiY;
        const i0 = x | 0, j0 = y | 0;
        const i1 = i0 < nx + 1 ? i0 + 1 : i0, j1 = j0 < ny + 1 ? j0 + 1 : j0;
        let lo = t[i0 + j0 * s], hi = lo, q;
        q = t[i1 + j0 * s]; if (q < lo) lo = q; if (q > hi) hi = q;
        q = t[i0 + j1 * s]; if (q < lo) lo = q; if (q > hi) hi = q;
        q = t[i1 + j1 * s]; if (q < lo) lo = q; if (q > hi) hi = q;
        if (val < lo || val > hi) val = fwd;      // reject, keep first order
        f[idx] = val < 0 ? 0 : val > 1 ? 1 : val;
      }
    }
  }

  /* Push the fraction back toward 0 or 1.
   *
   * Advecting a fraction diffuses the interface — unavoidably, since bilinear
   * interpolation of a step is a ramp. Measured on a blob in free fall: volume
   * held to within 1%, but after fifty steps it was spread over twice the area
   * at half the density and not one cell was more than half full. The water was
   * all still there and had stopped being water.
   *
   * The textbook cures rebuild the interface geometrically (VOF/PLIC) or track
   * a signed distance and reinitialise it. Both are a great deal more code. The
   * standard cheap alternative — and what interFoam does — is an artificial
   * compression that steepens the profile without moving the surface. Applied
   * only where the fraction is genuinely intermediate, so a full cell and an
   * empty one are never touched, and paired with the volume correction below so
   * that steepening cannot quietly change the total.
   */
  sharpen() {
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill;
    const K = 1.08;                     // per step; gentle enough not to block
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx]) continue;
        const c = f[idx];
        if (c <= 0.001 || c >= 0.999) continue;
        const nv = 0.5 + (c - 0.5) * K;
        f[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
      }
    }
  }

  /* Nudge the total back to where it started.
   *
   * Advecting a fraction does not conserve mass, and the error is one-signed
   * often enough that a pool visibly drains over a minute. Rather than pretend
   * otherwise, the deficit is spread over the SURFACE cells only — adding it to
   * the interior would make water appear inside the body, which is both wrong
   * and invisible until it erupts. */
  /* Re-baseline the volume target against the geometry as it now is.
   *
   * MUST be called whenever the solid mask changes. This was the single worst
   * bug in water mode, and the mechanism is worth stating in full because
   * nothing about it looks like a mass-conservation problem from the outside:
   *
   *   1. You draw a solid into the tank. `advect` zeroes the fill in those
   *      cells, so that water is gone — correctly, it is inside a wall now.
   *   2. `targetVolume` still refers to the tank as it was, so it is now
   *      permanently unreachable.
   *   3. `correctVolume` sees the deficit and adds fill to every surface cell.
   *      Every step. Forever.
   *
   * That is a continuous mass source, and mass appearing at the surface under
   * gravity is a continuous ENERGY source. Measured on a settled tank, drawing
   * a lid took the peak speed from 2.7 to the ceiling and shattered the surface
   * into flying blobs; re-baselining the target on the same case leaves it at
   * 3.5. The water was not exploding, it was being inflated.
   *
   * Zeroing the fill under solids here as well means the target is measured
   * against the same field the solver will see, rather than one advect step
   * behind it.
   */
  syncGeometry() {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) if (solid[i + jS]) f[i + jS] = 0;
    }
    this.classify();
    this.targetVolume = this.volume();
  }

  correctVolume() {
    if (!this.targetVolume) return;
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill, ph = this.phase;
    const now = this.volume();
    const err = this.targetVolume - now;
    if (Math.abs(err) < this.targetVolume * 1e-5) return;

    let n = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) if (!solid[i + jS] && ph[i + jS] === 1) n++;
    }
    if (!n) return;
    /* Gently: a full correction in one step is a visible pulse across the whole
     * surface. And BOUNDED per cell, which is the safety net rather than the
     * cosmetic part — this routine adds mass, mass under gravity is energy, and
     * an unbounded correction is therefore an unbounded energy source. It was
     * exactly that when a geometry change left the target unreachable.
     *
     * The bound has to clear real work, though. Advecting a fraction loses mass
     * steadily — that is why this routine exists — and a limit tight enough to
     * look safe simply stops it doing its job: at 0.002 per cell the tank drained
     * 14 % over four hundred steps while the correction sat pinned at its own
     * ceiling, which is a leak dressed up as a safety measure. At 0.02 it keeps
     * up with ordinary drift and is still fifty times gentler than the injection
     * that shattered the surface. `syncGeometry` is what stops the target being
     * wrong; this only stops a wrong target being catastrophic. */
    const per = Math.max(-0.02, Math.min(0.02, (err / n) * 0.5));
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (solid[idx] || ph[idx] !== 1) continue;
        const nv = f[idx] + per;
        f[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
      }
    }
  }

  /* Publish the air mask the pressure solve reads.
   *
   * Kept separate from classify() because the solver needs it BEFORE the step
   * and the classification is only meaningful AFTER the fraction has moved. */
  syncAir() {
    this.ensureSize();
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const f = this.fill, air = g.air;
    let any = false;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const isAir = !solid[idx] && f[idx] < FULL;
        air[idx] = isAir ? 1 : 0;
        if (isAir) any = true;
      }
    }
    g.hasAir = any;
    this.markSealed();
  }

  /* Water with no connected path to air anywhere — and what to do about it.
   *
   * Incompressible water in a rigid container with no air in it CANNOT MOVE.
   * There is no free surface to deform, nowhere for a parcel to go, and no
   * compressibility to take up the difference. That is not an approximation, it
   * is the whole content of incompressibility in a closed rigid volume.
   *
   * The solver could not express it. A sealed pocket is all-Neumann and
   * singular, and while its pressure can be made well-posed (see
   * Poisson.classifyRegions) the fill still drifts: the moment one cell falls
   * below FULL it is reclassified as air, which is a Dirichlet p = 0 pulling
   * water towards it, which empties its neighbours, which become air in turn.
   * Measured on a box drawn inside a settled tank, all 578 cells of trapped
   * water evaporated within fifty steps and the collapse drove the peak speed
   * straight to the ceiling.
   *
   * So the pocket is frozen instead — velocity zeroed, fraction held. It is the
   * physically correct answer AND unconditionally stable, which is a rare
   * combination and worth taking. Water reconnected to air by erasing the wall
   * simply stops being sealed on the next sync and moves again.
   *
   * A flood fill outward from every air cell; whatever it does not reach is
   * sealed. One pass over the grid, the same order as syncAir itself.
   */
  markSealed() {
    const g = this.g;
    const { nx, ny, stride: s, size, solid, air } = g;
    if (!this.sealed || this.sealed.length !== size) {
      this.sealed = new Uint8Array(size);
      this.queue = new Int32Array(size);
    }
    const sealed = this.sealed, queue = this.queue;
    this.hasSealed = false;
    // No air at all means nothing is reachable, but it also means there is no
    // surface to speak of — a completely full domain is the solver's own
    // problem, not a trapped pocket. Leave everything free.
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
    for (let j = 1; j <= ny && !this.hasSealed; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) if (sealed[i + jS]) { this.hasSealed = true; break; }
    }
  }

  /* Hold frozen pockets still. Faces with sealed fluid on both sides carry no
   * flow; the fraction is simply left alone by advect and sharpen. */
  freezeSealed() {
    if (!this.hasSealed) return;
    const g = this.g;
    const { nx, ny, stride: s, uf, vf, u, v } = g;
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
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (sealed[idx]) { u[idx] = 0; v[idx] = 0; }
      }
    }
  }

  /* Add or remove water under a brush, for the paint tools. */
  paint(cx, cy, radius, amount) {
    this.ensureSize();
    const { nx, ny, stride: s, solid } = this.g;
    const f = this.fill;
    const ri = Math.ceil(radius);
    const ci = Math.round(cx), cj = Math.round(cy);
    for (let dj = -ri; dj <= ri; dj++) {
      for (let di = -ri; di <= ri; di++) {
        const d2 = di * di + dj * dj;
        if (d2 > radius * radius) continue;
        const i = ci + di, j = cj + dj;
        if (i < 1 || i > nx || j < 1 || j > ny) continue;
        const idx = i + j * s;
        if (solid[idx]) continue;
        // Soft edge, so a stroke does not leave a hard disc of water sitting
        // proud of the surface.
        const fall = 1 - Math.sqrt(d2) / (radius + 1);
        const nv = f[idx] + amount * fall;
        f[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
      }
    }
    // Painting deliberately changes how much water there is, so the target the
    // volume correction holds to has to move with it — otherwise the next few
    // steps quietly undo the stroke.
    this.targetVolume = this.volume();
    this.classify();
  }

  /* One step of the surface, around the host solver's projection.
   *
   * Order matters: gravity before the projection so the pressure answers it,
   * extrapolation before advection so the surface has a velocity to move on,
   * and classification last so the next projection sees the new surface. */
  preProject(dt) {
    this.ensureSize();
    this.applyGravity(dt);
    // Gravity must not accelerate trapped water either: there is nowhere for it
    // to fall to, and the pressure solve would have to cancel it exactly.
    this.freezeSealed();
  }

  postProject(dt) {
    this.freezeSealed();
    this.extrapolateVelocity();
    /* Hold the fraction across the transport steps for any pocket with no path
     * to air. Snapshotting and restoring is deliberately blunter than guarding
     * each loop: advect, sharpen and the volume correction all touch `fill`, and
     * a pocket that is stationary by construction must come out of all three
     * unchanged. Missing one of them is how it drained before. */
    const held = this.hasSealed ? this.holdSealed() : null;
    this.advect(dt);
    this.sharpen();
    this.classify();
    this.correctVolume();
    if (held) this.restoreSealed(held);
  }

  holdSealed() {
    const g = this.g;
    if (!this.keep || this.keep.length !== g.size) this.keep = new Float32Array(g.size);
    const keep = this.keep, f = this.fill, sealed = this.sealed;
    for (let i = 0; i < g.size; i++) if (sealed[i]) keep[i] = f[i];
    return keep;
  }

  restoreSealed(keep) {
    const g = this.g;
    const f = this.fill, sealed = this.sealed;
    for (let i = 0; i < g.size; i++) if (sealed[i]) f[i] = keep[i];
  }
}
