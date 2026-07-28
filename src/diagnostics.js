/* Derived quantities: forces on immersed bodies, integral flow measures, and
 * vortex-shedding frequency.
 *
 * Force convention. For a solid cell face whose outward normal n points from
 * the solid into the fluid, the pressure force on the body is dF = -p*n. So a
 * fluid neighbour on the LEFT (n = -x) contributes +p to Fx. Getting this
 * backwards flips the sign of drag and puts spurious lift on symmetric bodies.
 *
 * Pressure units. The projection's p absorbs the timestep: the velocity
 * correction is u -= grad_h(p), while physically u -= (dt/rho) grad(P). With
 * rho = 1 that gives P = p/dt, which is the conversion applied below.
 *
 * Surface measure. Summing over the exposed faces of a voxelised body measures
 * the STAIRCASE, not the body: for a circle that is 4/pi too much perimeter,
 * and the excess drifts with resolution (1.35x at D=8 down to 1.28x at D=64),
 * so refining the mesh moved the answer instead of converging it.
 *
 * Both integrals below are therefore weighted by grad(coverage) instead, using
 * the fractional solid area the rasteriser already supersamples. Writing the
 * indicator function as X, the identity  n dS = -grad(X)  turns a surface
 * integral into a volume one over a smeared, sub-cell-accurate surface:
 *
 *     F = closed-integral sigma.n dS  =  -integral sigma.grad(X) dV
 *
 * Measured: sum|grad X| recovers pi*D to within 1.5% at every resolution, and
 * the projected width (1/2)sum|dX/dx| comes out at exactly D. That is the
 * difference between a perimeter that is 28% wrong in a resolution-dependent
 * way and one that is right.
 *
 * Still a coarse-grid estimate — the wall shear is a half-cell finite
 * difference — but the geometry it integrates over is no longer the error.
 */

export class Diagnostics {
  constructor(grid) {
    this.g = grid;
    this.cl = 0;
    this.cd = 0;
    this.re = 0;
    this.ke = 0;
    this.enstrophy = 0;
    this.cfl = 0;
    this.strouhal = 0;
    this.regime = 'free';
    this.effVisc = 0;
    this.machMax = 0;

    this.bounds = null;
    this.simTime = 0;
    this._shed = { mean: 0, lastSign: 0, cross: [], primed: false };

    /* Running statistics over a window of recent samples.
     *
     * A shedding body's instantaneous Cd swings by tens of percent within one
     * cycle, so the live number is close to meaningless as a design figure —
     * reading it off at the wrong instant is how you conclude one aerofoil beats
     * another. The design report quotes these instead, with the spread shown so
     * an unconverged or still-oscillating answer is visible as one. */
    this._hist = { cd: [], cl: [], cap: 600, warmup: 0 };
  }

  /* Feed the current coefficients into the rolling window. */
  sample() {
    const h = this._hist;
    if (!isFinite(this.cd) || !isFinite(this.cl)) return;
    // A body appearing or changing shape produces a large pressure transient
    // while the flow reorganises around it. Those frames are not the design's
    // drag, and a single spike of 13 drags the mean of a few hundred samples
    // well off, so let them pass before recording.
    if (h.warmup > 0) { h.warmup--; return; }
    h.cd.push(this.cd); h.cl.push(this.cl);
    if (h.cd.length > h.cap) { h.cd.shift(); h.cl.shift(); }
  }

  resetStats(warmup = 120) {
    this._hist.cd.length = 0;
    this._hist.cl.length = 0;
    this._hist.warmup = warmup;
  }

  /* mean / rms-about-the-mean / min / max over the window. */
  stats(key) {
    const a = this._hist[key];
    const n = a.length;
    if (!n) return null;
    let sum = 0, lo = Infinity, hi = -Infinity;
    for (const v of a) { sum += v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const mean = sum / n;
    let sq = 0;
    for (const v of a) sq += (v - mean) * (v - mean);
    return { mean, rms: Math.sqrt(sq / n), min: lo, max: hi, n };
  }

  /* Bounding box, plus a sub-cell frontal extent from the coverage field.
   *
   * The bounding box counts CELLS, so a circle of diameter D measures D+1 —
   * a 1/D error that divides straight into every coefficient: 12.5% at D=8,
   * 4.2% at D=24, 1.6% at D=64. Because it shrinks with refinement it looks
   * exactly like convergence, which is why it survived so long.
   *
   * Integrating the coverage gradient gives the silhouette instead. Summing
   * |dX/dx| along a row totals 2 wherever the row crosses the body, so
   * (1/2)sum|dX/dx| is the extent in Y, and vice versa. Measured against a
   * circle this returns D exactly at every resolution tested (D = 8...64).
   *
   * This is a total variation, so it is the silhouette only for a CONVEX body.
   * A ring, or two bodies stacked across the flow, sums each crossing — but a
   * single lumped Cd over disjoint bodies is not a meaningful number anyway,
   * and the bounding box handles that case no better.
   */
  bodyBounds() {
    const { nx, ny, stride: s, solid, coverage, hasCoverage } = this.g;
    let minX = nx, maxX = 0, minY = ny, maxY = 0, count = 0, cx = 0, cy = 0;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        if (!solid[i + jS]) continue;
        count++; cx += i; cy += j;
        if (i < minX) minX = i;
        if (i > maxX) maxX = i;
        if (j < minY) minY = j;
        if (j > maxY) maxY = j;
      }
    }
    if (!count) { this.bounds = null; return null; }

    let height = maxY - minY + 1, width = maxX - minX + 1;
    if (hasCoverage) {
      let gx = 0, gy = 0;
      const jLo = Math.max(1, minY - 2), jHi = Math.min(ny, maxY + 2);
      const iLo = Math.max(1, minX - 2), iHi = Math.min(nx, maxX + 2);
      for (let j = jLo; j <= jHi; j++) {
        const jS = j * s;
        for (let i = iLo; i <= iHi; i++) {
          const idx = i + jS;
          gx += Math.abs(coverage[idx + 1] - coverage[idx - 1]);
          gy += Math.abs(coverage[idx + s] - coverage[idx - s]);
        }
      }
      // 0.25 = the 0.5 of the centred difference times the 0.5 above.
      const h = 0.25 * gx, w = 0.25 * gy;
      if (h > 0.5) height = h;
      if (w > 0.5) width = w;
    }

    this.bounds = {
      minX, maxX, minY, maxY, count,
      cx: cx / count, cy: cy / count,
      height, width,
    };
    return this.bounds;
  }

  /* Extend pressure into the solid band.
   *
   * The Poisson solve holds solid cells at zero, but grad(coverage) is non-zero
   * up to one cell INSIDE the surface, so the integral needs a wall pressure
   * there. Sweeping outward from the fluid and averaging already-filled
   * neighbours is a discrete zero normal gradient — the condition a wall
   * actually imposes. Two passes reach every cell that can carry a non-zero
   * coverage gradient: deeper than that the coverage is a flat 1 and its
   * gradient vanishes, so the value left behind is never read.
   *
   * `fill` doubles as the pass number a cell was filled on, and a pass only
   * reads neighbours from STRICTLY EARLIER passes. Without that the result
   * would depend on the order cells happen to be visited in.
   */
  _extendWallPressure(i0, i1, j0, j1) {
    const { size, stride: s, solid, p } = this.g;
    if (!this._pw || this._pw.length !== size) {
      this._pw = new Float32Array(size);
      this._fill = new Uint8Array(size);
    }
    const pw = this._pw, fill = this._fill;

    for (let j = j0; j <= j1; j++) {
      const jS = j * s;
      for (let i = i0; i <= i1; i++) {
        const idx = i + jS;
        const fluid = !solid[idx];
        fill[idx] = fluid ? 1 : 0;
        pw[idx] = fluid ? p[idx] : 0;
      }
    }
    for (let pass = 1; pass <= 2; pass++) {
      for (let j = j0 + 1; j < j1; j++) {
        const jS = j * s;
        for (let i = i0 + 1; i < i1; i++) {
          const idx = i + jS;
          if (fill[idx]) continue;
          let sum = 0, n = 0;
          const a = fill[idx - 1], bb = fill[idx + 1];
          const c = fill[idx - s], d = fill[idx + s];
          if (a && a <= pass) { sum += pw[idx - 1]; n++; }
          if (bb && bb <= pass) { sum += pw[idx + 1]; n++; }
          if (c && c <= pass) { sum += pw[idx - s]; n++; }
          if (d && d <= pass) { sum += pw[idx + s]; n++; }
          if (n) { pw[idx] = sum / n; fill[idx] = pass + 1; }
        }
      }
    }
    return pw;
  }

  /* uRef: freestream speed, viscRef: kinematic viscosity, both in cell units.
   * dt is needed only to convert the projection pressure to physical units;
   * pass 1 for solvers whose pressure is already physical (LBM). */
  forces(uRef, viscRef, dt) {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v, p, coverage } = g;
    const b = this.bodyBounds();
    if (!b || uRef < 1e-6) { this.cd = 0; this.cl = 0; this.re = 0; return; }

    const pScale = dt > 1e-9 ? 1 / dt : 1;
    const shear = 2 * viscRef;   // du/dn across the half-cell to the wall
    let fx = 0, fy = 0;

    // Pad by two so the whole smeared surface, and its stencil, are inside the
    // window: coverage reaches one cell past `solid`, and its gradient one more.
    const i0 = Math.max(1, b.minX - 2), i1 = Math.min(nx, b.maxX + 2);
    const j0 = Math.max(1, b.minY - 2), j1 = Math.min(ny, b.maxY + 2);

    // Skin friction keeps the half-cell wall-gradient estimate, summed over
    // exposed faces, but is rescaled to the true wetted area. `faces` counts the
    // staircase perimeter and `wet` measures the real one, so the ratio removes
    // exactly the geometric excess without disturbing the shear model itself.
    let faces = 0, wet = 0, sx = 0, sy = 0;

    for (let j = Math.max(1, b.minY - 1); j <= Math.min(ny, b.maxY + 1); j++) {
      const jS = j * s;
      for (let i = Math.max(1, b.minX - 1); i <= Math.min(nx, b.maxX + 1); i++) {
        const idx = i + jS;
        if (!solid[idx]) continue;
        const oL = !solid[idx - 1], oR = !solid[idx + 1];
        const oD = !solid[idx - s], oU = !solid[idx + s];
        if (!(oL || oR || oD || oU)) continue;
        faces += (oL ? 1 : 0) + (oR ? 1 : 0) + (oD ? 1 : 0) + (oU ? 1 : 0);

        // Skin friction: the fluid drags the wall along its own direction.
        if (oL) { sx += shear * u[idx - 1]; sy += shear * v[idx - 1]; }
        if (oR) { sx += shear * u[idx + 1]; sy += shear * v[idx + 1]; }
        if (oD) { sx += shear * u[idx - s]; sy += shear * v[idx - s]; }
        if (oU) { sx += shear * u[idx + s]; sy += shear * v[idx + s]; }
      }
    }

    if (g.hasCoverage) {
      const pw = this._extendWallPressure(i0, i1, j0, j1);

      // The pressure datum is arbitrary — the projection removes a mean per
      // connected region — so subtract a local reference. The weights sum to
      // zero over a closed surface, which makes this exactly a no-op there; it
      // only bites when a body runs off the edge of the window, where it
      // removes what would otherwise be a force proportional to the datum.
      let pRef = 0, nRef = 0;
      for (let j = j0; j <= j1; j++) {
        const jS = j * s;
        for (let i = i0; i <= i1; i++) {
          const idx = i + jS;
          if (!solid[idx]) { pRef += pw[idx]; nRef++; }
        }
      }
      pRef = nRef ? pRef / nRef : 0;

      for (let j = j0 + 1; j < j1; j++) {
        const jS = j * s;
        for (let i = i0 + 1; i < i1; i++) {
          const idx = i + jS;
          const cx = 0.5 * (coverage[idx + 1] - coverage[idx - 1]);
          const cy = 0.5 * (coverage[idx + s] - coverage[idx - s]);
          if (cx === 0 && cy === 0) continue;
          // F = -integral p*n dS = +integral p*grad(X) dV
          const pv = (pw[idx] - pRef) * pScale;
          fx += pv * cx;
          fy += pv * cy;
          wet += Math.sqrt(cx * cx + cy * cy);
        }
      }
      const areaScale = faces > 0 && wet > 0 ? wet / faces : 1;
      fx += sx * areaScale;
      fy += sy * areaScale;
    } else {
      // No rasteriser behind this grid — a mask was written straight into
      // `solid`. Fall back to the staircase surface.
      for (let j = Math.max(1, b.minY - 1); j <= Math.min(ny, b.maxY + 1); j++) {
        const jS = j * s;
        for (let i = Math.max(1, b.minX - 1); i <= Math.min(nx, b.maxX + 1); i++) {
          const idx = i + jS;
          if (!solid[idx]) continue;
          // Pressure: dF = -p * n, n pointing solid -> fluid.
          if (!solid[idx - 1]) fx += p[idx - 1] * pScale;
          if (!solid[idx + 1]) fx -= p[idx + 1] * pScale;
          if (!solid[idx - s]) fy += p[idx - s] * pScale;
          if (!solid[idx + s]) fy -= p[idx + s] * pScale;
        }
      }
      fx += sx;
      fy += sy;
    }

    // Reference length: the larger bounding-box dimension. For a cylinder that
    // is the diameter, for an aerofoil the chord, for a plate normal to the
    // flow its height — which matches the convention each of those shapes is
    // normally quoted against. Using the frontal height alone would divide an
    // aerofoil's coefficients by its thickness and inflate them by the
    // thickness-to-chord ratio, roughly a factor of eight.
    const L = Math.max(1, b.height, b.width);
    const q = 0.5 * uRef * uRef * L;              // rho = 1
    this.cd = fx / q;
    this.cl = -fy / q;                            // +lift is up on screen (-y)
    this.re = viscRef > 1e-9 ? (uRef * L) / viscRef : Infinity;
  }

  integrals(dt, viscRef, meanNut, soundSpeed) {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v } = g;
    const hasSolid = g.hasSolid;
    let ke = 0, ens = 0, maxU = 0, cells = 0;

    for (let j = 2; j <= ny - 1; j++) {
      const jS = j * s;
      for (let i = 2; i <= nx - 1; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;
        const a = u[idx], b = v[idx];
        ke += a * a + b * b;
        const w = 0.5 * (v[idx + 1] - v[idx - 1] - u[idx + s] + u[idx - s]);
        ens += w * w;
        const m = Math.max(a < 0 ? -a : a, b < 0 ? -b : b);
        if (m > maxU) maxU = m;
        cells++;
      }
    }
    const inv = cells > 0 ? 1 / cells : 0;
    this.ke = 0.5 * ke * inv;
    this.enstrophy = ens * inv;
    this.cfl = maxU * dt;
    this.effVisc = viscRef + meanNut;
    this.machMax = soundSpeed > 0 ? maxU / soundSpeed : 0;

    const re = this.re;
    if (!isFinite(re) || re <= 0) this.regime = 'free';
    else if (re < 5) this.regime = 'creeping';
    else if (re < 47) this.regime = 'laminar, attached';
    else if (re < 190) this.regime = 'laminar vortex street';
    else if (re < 1000) this.regime = 'transitional';
    else this.regime = 'turbulent';
  }

  /* Strouhal from zero crossings of the fluctuating lift, measured in
   * SIMULATION time. Deriving it from wall-clock, as is tempting, makes the
   * answer depend on the frame rate. */
  trackShedding(dtElapsed, uRef) {
    this.simTime += dtElapsed;
    const b = this.bounds;
    const sh = this._shed;
    if (!b || uRef < 1e-6) { this.strouhal = 0; return; }

    sh.mean = sh.primed ? sh.mean * 0.99 + this.cl * 0.01 : this.cl;
    sh.primed = true;
    const dev = this.cl - sh.mean;
    if (Math.abs(dev) < 1e-5) return;

    const sign = dev > 0 ? 1 : -1;
    if (sh.lastSign !== 0 && sign !== sh.lastSign) {
      sh.cross.push(this.simTime);
      if (sh.cross.length > 24) sh.cross.shift();
    }
    sh.lastSign = sign;

    if (sh.cross.length >= 6) {
      const c = sh.cross;
      let total = 0, n = 0;
      for (let i = 2; i < c.length; i += 2) { total += c[i] - c[i - 2]; n++; }
      if (n > 0 && total > 1e-6) {
        const period = total / n;                 // full period, sim-time units
        // b.height is the sub-cell frontal extent where coverage is available,
        // so St is not inflated by the bounding box's extra cell — that alone
        // was worth 4% at D = 24, enough to push Re 100 out of its band.
        const raw = (b.height) / (period * uRef); // St = f*D/U
        this.strouhal = this.strouhal > 0 ? this.strouhal * 0.8 + raw * 0.2 : raw;
      }
    }
  }

  resetShedding() {
    this._shed = { mean: 0, lastSign: 0, cross: [], primed: false };
    this.strouhal = 0;
    this.simTime = 0;
    this.resetStats();
  }

  /* A design report: geometry, averaged coefficients, and — the part that stops
   * the numbers being misread — how far to trust them.
   *
   * The confidence rules come from the validation in CONTEXT.md section 3. In
   * the steady regime this integral is good to a few per cent; once a wake
   * sheds, the drag runs ~30% low and the error grows with Re. Reporting a bare
   * number without that context invites quoting it. */
  report(uRef, viscRef) {
    const b = this.bounds || this.bodyBounds();
    if (!b) return null;
    const cd = this.stats('cd'), cl = this.stats('cl');
    const L = Math.max(1, b.height, b.width);

    let confidence, note;
    if (!cd || cd.n < 60) {
      confidence = 'warming up';
      note = 'Not enough samples yet — let it run for a few seconds.';
    } else if (this.re < 47) {
      confidence = 'good';
      note = 'Steady attached flow. Validated to 4-7% against published cylinder drag.';
    } else if (cl.rms > 0.02) {
      confidence = 'indicative';
      note = 'Shedding wake: drag runs about 30% low on this grid, and the deficit '
           + 'grows with Reynolds number. Comparisons between designs are more '
           + 'reliable than the absolute value.';
    } else {
      confidence = 'indicative';
      note = 'Transitional. Let it settle, or refine the grid, before comparing.';
    }

    // Spread across the window relative to the mean: large means it has not
    // converged, or is genuinely oscillating.
    const steadiness = cd && Math.abs(cd.mean) > 1e-9 ? cd.rms / Math.abs(cd.mean) : 0;

    /* Strouhal is only meaningful when the lift signal is actually periodic.
     *
     * It comes from zero crossings of the fluctuating lift, and in a noisy or
     * turbulent wake the signal crosses constantly — which the detector reads
     * as a very short period and reports as a huge St. Bluff-body shedding
     * lives around 0.1-0.3 and nothing physical here reaches 1, so treat
     * anything outside a generous band as "no clean shedding" rather than
     * printing a number that looks authoritative and is noise. */
    const stOK = this.strouhal > 0.02 && this.strouhal < 1;

    return {
      cd, cl, confidence, note, steadiness,
      re: this.re, regime: this.regime,
      strouhal: stOK ? this.strouhal : 0,
      strouhalNoisy: this.strouhal > 0 && !stOK,
      refLength: L,
      frontalHeight: b.height,
      frontalWidth: b.width,
      cells: b.count,
      liftToDrag: cd && Math.abs(cd.mean) > 1e-9 ? cl.mean / cd.mean : 0,
      // Shedding frequency in sim-time units, from St = f L / U.
      sheddingFreq: this.strouhal > 0 && L > 0 ? (this.strouhal * uRef) / L : 0,
      uRef, viscRef,
    };
  }
}
