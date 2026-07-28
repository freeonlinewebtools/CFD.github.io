/* Lattice Boltzmann D2Q9 with TRT collision and an optional Smagorinsky SGS.
 *
 *     6  2  5      0:( 0, 0) w=4/9    5:(+1,+1) w=1/36
 *      \ | /       1:(+1, 0) w=1/9    6:(-1,+1) w=1/36
 *   3 --0-- 1      2:( 0,+1) w=1/9    7:(-1,-1) w=1/36
 *      / | \       3:(-1, 0) w=1/9    8:(+1,-1) w=1/36
 *     7  4  8      4:( 0,-1) w=1/9
 *
 * TRT relaxes the symmetric and antisymmetric parts of f separately, with the
 * magic parameter Lambda = (tau-1/2)(tau_a-1/2) = 1/4. That fixes the
 * bounce-back wall at the lattice mid-link and removes the viscosity-dependent
 * slip that plain BGK suffers from.
 *
 * Units: one sub-step advances the fluid by one lattice time. Velocity is
 * therefore already in cells-per-lattice-step, and a frame of `steps`
 * sub-steps advances the flow by `u * steps` cells. The driver passes that
 * same `steps` as the dye timestep so smoke traces the fluid rather than
 * outrunning it.
 *
 * Refs: Ginzburg & d'Humieres (2003); Kupershtokh et al. (2009) for the
 * Exact Difference Method forcing used below.
 */

const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const MAX_U = 0.2;   // Ma ~ 0.35

export class LatticeBoltzmann {
  constructor(grid) {
    this.g = grid;
    this.tau = 0.55;
    this.steps = 8;
    this.les = true;
    this.cs = 0.15;
    this.gravity = 0;
    this.windTunnel = false;
    this.inletSpeed = 0.09;   // lattice units
    this.meanNut = 0;
    this.ready = false;
    this.allocate();
  }

  allocate() {
    const n = this.g.size;
    this.f = [];
    for (let d = 0; d < 9; d++) this.f[d] = new Float32Array(n);
    this.ready = false;
  }

  reset() { this.ready = false; }

  initEquilibrium() {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const f = this.f;
    const seed = this.windTunnel ? this.inletSpeed : 0;
    for (let j = 0; j <= ny + 1; j++) {
      const jS = j * s;
      for (let i = 0; i <= nx + 1; i++) {
        const idx = i + jS;
        const ux = solid[idx] ? 0 : seed;
        const uy = 0;
        const u15 = 1.5 * (ux * ux + uy * uy);
        for (let d = 0; d < 9; d++) {
          const eu = EX[d] * ux + EY[d] * uy;
          f[d][idx] = W[d] * (1 + 3 * eu + 4.5 * eu * eu - u15);
        }
        g.u[idx] = ux; g.v[idx] = uy; g.rho[idx] = 1;
      }
    }
    this.ready = true;
  }

  collide() {
    const g = this.g;
    const { nx, ny, stride: s, solid } = g;
    const hasSolid = g.hasSolid;
    const f = this.f;
    const f0a = f[0], f1a = f[1], f2a = f[2], f3a = f[3], f4a = f[4];
    const f5a = f[5], f6a = f[6], f7a = f[7], f8a = f[8];

    const tau0 = this.tau;
    const sPlus0 = 1 / tau0;
    const sMinus0 = 1 / (0.5 + 1 / (4 * Math.max(tau0 - 0.5, 1e-6)));
    const useLes = this.les;
    const cs2 = this.cs * this.cs;
    const SQRT2 = 1.4142135623730951;
    let nutSum = 0;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;

        const f0 = f0a[idx], f1 = f1a[idx], f2 = f2a[idx], f3 = f3a[idx], f4 = f4a[idx];
        const f5 = f5a[idx], f6 = f6a[idx], f7 = f7a[idx], f8 = f8a[idx];

        let rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
        if (rho < 0.01) rho = 0.01; else if (rho > 5) rho = 5;
        const inv = 1 / rho;
        let ux = (f1 - f3 + f5 - f6 - f7 + f8) * inv;
        let uy = (f2 - f4 + f5 + f6 - f7 - f8) * inv;
        const m2 = ux * ux + uy * uy;
        if (m2 > MAX_U * MAX_U) { const k = MAX_U / Math.sqrt(m2); ux *= k; uy *= k; }

        const u15 = 1.5 * (ux * ux + uy * uy);
        const e0 = 4 / 9 * rho, e1 = 1 / 9 * rho, e2 = 1 / 36 * rho;
        let eu;
        const q0 = e0 * (1 - u15);
        const q1 = e1 * (1 + 3 * ux + 4.5 * ux * ux - u15);
        const q2 = e1 * (1 + 3 * uy + 4.5 * uy * uy - u15);
        const q3 = e1 * (1 - 3 * ux + 4.5 * ux * ux - u15);
        const q4 = e1 * (1 - 3 * uy + 4.5 * uy * uy - u15);
        eu = ux + uy;  const q5 = e2 * (1 + 3 * eu + 4.5 * eu * eu - u15);
        eu = -ux + uy; const q6 = e2 * (1 + 3 * eu + 4.5 * eu * eu - u15);
        eu = -ux - uy; const q7 = e2 * (1 + 3 * eu + 4.5 * eu * eu - u15);
        eu = ux - uy;  const q8 = e2 * (1 + 3 * eu + 4.5 * eu * eu - u15);

        let sp = sPlus0, sm = sMinus0;
        if (useLes) {
          // The non-equilibrium stress tensor is a direct LBM observable —
          // no finite-difference stencil needed.
          const n1 = f1 - q1, n2 = f2 - q2, n3 = f3 - q3, n4 = f4 - q4;
          const n5 = f5 - q5, n6 = f6 - q6, n7 = f7 - q7, n8 = f8 - q8;
          const pxx = n1 + n3 + n5 + n6 + n7 + n8;
          const pyy = n2 + n4 + n5 + n6 + n7 + n8;
          const pxy = n5 - n6 + n7 - n8;
          const Q = Math.sqrt(pxx * pxx + 2 * pxy * pxy + pyy * pyy);
          const tauE = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + 18 * SQRT2 * cs2 * Q * inv));
          sp = 1 / tauE;
          sm = 1 / (0.5 + 1 / (4 * Math.max(tauE - 0.5, 1e-6)));
          nutSum += (tauE - tau0) / 3;
        }

        f0a[idx] = f0 - sp * (f0 - q0);
        let dp, dm;
        dp = sp * (0.5 * (f1 + f3) - 0.5 * (q1 + q3));
        dm = sm * (0.5 * (f1 - f3) - 0.5 * (q1 - q3));
        f1a[idx] = f1 - dp - dm; f3a[idx] = f3 - dp + dm;
        dp = sp * (0.5 * (f2 + f4) - 0.5 * (q2 + q4));
        dm = sm * (0.5 * (f2 - f4) - 0.5 * (q2 - q4));
        f2a[idx] = f2 - dp - dm; f4a[idx] = f4 - dp + dm;
        dp = sp * (0.5 * (f5 + f7) - 0.5 * (q5 + q7));
        dm = sm * (0.5 * (f5 - f7) - 0.5 * (q5 - q7));
        f5a[idx] = f5 - dp - dm; f7a[idx] = f7 - dp + dm;
        dp = sp * (0.5 * (f6 + f8) - 0.5 * (q6 + q8));
        dm = sm * (0.5 * (f6 - f8) - 0.5 * (q6 - q8));
        f6a[idx] = f6 - dp - dm; f8a[idx] = f8 - dp + dm;

        for (let d = 1; d < 9; d++) if (f[d][idx] < 0) f[d][idx] = 0;
      }
    }
    if (useLes) this.meanNut = nutSum / (nx * ny);
  }

  /* In-place streaming; sweep direction chosen so upstream is read before
   * it is overwritten. */
  stream() {
    const { nx, ny, stride: s } = this.g;
    const f = this.f;
    const iHi = nx + 1, jHi = ny + 1;

    for (let j = 0; j <= jHi; j++) { const jS = j * s; const a = f[1];
      for (let i = iHi; i >= 1; i--) a[i + jS] = a[i - 1 + jS]; }
    for (let j = jHi; j >= 1; j--) { const jS = j * s, jm = (j - 1) * s; const a = f[2];
      for (let i = 0; i <= iHi; i++) a[i + jS] = a[i + jm]; }
    for (let j = 0; j <= jHi; j++) { const jS = j * s; const a = f[3];
      for (let i = 0; i < iHi; i++) a[i + jS] = a[i + 1 + jS]; }
    for (let j = 0; j < jHi; j++) { const jS = j * s, jp = (j + 1) * s; const a = f[4];
      for (let i = 0; i <= iHi; i++) a[i + jS] = a[i + jp]; }
    for (let j = jHi; j >= 1; j--) { const jS = j * s, jm = (j - 1) * s; const a = f[5];
      for (let i = iHi; i >= 1; i--) a[i + jS] = a[i - 1 + jm]; }
    for (let j = jHi; j >= 1; j--) { const jS = j * s, jm = (j - 1) * s; const a = f[6];
      for (let i = 0; i < iHi; i++) a[i + jS] = a[i + 1 + jm]; }
    for (let j = 0; j < jHi; j++) { const jS = j * s, jp = (j + 1) * s; const a = f[7];
      for (let i = 0; i < iHi; i++) a[i + jS] = a[i + 1 + jp]; }
    for (let j = 0; j < jHi; j++) { const jS = j * s, jp = (j + 1) * s; const a = f[8];
      for (let i = iHi; i >= 1; i--) a[i + jS] = a[i - 1 + jp]; }
  }

  bounceBack() {
    const g = this.g;
    if (!g.hasSolid) return;
    const { nx, ny, stride: s, solid } = g;
    const f = this.f;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (!solid[idx]) continue;
        let t;
        t = f[1][idx]; f[1][idx] = f[3][idx]; f[3][idx] = t;
        t = f[2][idx]; f[2][idx] = f[4][idx]; f[4][idx] = t;
        t = f[5][idx]; f[5][idx] = f[7][idx]; f[7][idx] = t;
        t = f[6][idx]; f[6][idx] = f[8][idx]; f[8][idx] = t;
      }
    }
  }

  boundaries() {
    const { nx, ny, stride: s } = this.g;
    const f = this.f;
    const iHi = nx + 1, jHi = ny + 1;

    if (this.windTunnel) {
      // Zou-He velocity inlet at i = 1.
      const spd = this.inletSpeed;
      for (let j = 1; j <= ny; j++) {
        const idx = 1 + j * s;
        const rho = (f[0][idx] + f[2][idx] + f[4][idx]
          + 2 * (f[3][idx] + f[6][idx] + f[7][idx])) / (1 - spd);
        const ru = rho * spd;
        f[1][idx] = f[3][idx] + (2 / 3) * ru;
        f[5][idx] = f[7][idx] + ru / 6 + 0.5 * (f[4][idx] - f[2][idx]);
        f[8][idx] = f[6][idx] + ru / 6 - 0.5 * (f[4][idx] - f[2][idx]);
        const ig = j * s;
        for (let d = 0; d < 9; d++) f[d][ig] = f[d][idx];
      }
      // Zero-gradient outflow at i = nx.
      for (let j = 0; j <= jHi; j++) {
        const jS = j * s;
        f[3][nx + jS] = f[3][nx - 1 + jS];
        f[6][nx + jS] = f[6][nx - 1 + jS];
        f[7][nx + jS] = f[7][nx - 1 + jS];
        for (let d = 0; d < 9; d++) f[d][iHi + jS] = f[d][nx + jS];
      }
    } else {
      for (let j = 0; j <= jHi; j++) {
        const jS = j * s;
        f[1][jS] = f[3][jS]; f[5][jS] = f[7][jS]; f[8][jS] = f[6][jS];
        f[3][iHi + jS] = f[1][iHi + jS];
        f[7][iHi + jS] = f[5][iHi + jS];
        f[6][iHi + jS] = f[8][iHi + jS];
      }
    }

    for (let i = 0; i <= iHi; i++) {
      f[2][i] = f[4][i]; f[5][i] = f[7][i]; f[6][i] = f[8][i];
      const b = i + jHi * s;
      f[4][b] = f[2][b]; f[7][b] = f[5][b]; f[8][b] = f[6][b];
    }
  }

  extract() {
    const g = this.g;
    const { nx, ny, stride: s, solid, u, v, rho, p } = g;
    const hasSolid = g.hasSolid;
    const f = this.f;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) {
          u[idx] = 0; v[idx] = 0; rho[idx] = 1; p[idx] = 0;
          continue;
        }
        const f0 = f[0][idx], f1 = f[1][idx], f2 = f[2][idx], f3 = f[3][idx], f4 = f[4][idx];
        const f5 = f[5][idx], f6 = f[6][idx], f7 = f[7][idx], f8 = f[8][idx];
        let r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
        if (r < 1e-3) r = 1e-3;
        const inv = 1 / r;
        u[idx] = (f1 - f3 + f5 - f6 - f7 + f8) * inv;
        v[idx] = (f2 - f4 + f5 + f6 - f7 - f8) * inv;
        rho[idx] = r;
        p[idx] = (r - 1) / 3;
      }
    }
    g.setBnd(1, u); g.setBnd(2, v);
  }

  /* Exact Difference Method forcing: df_i = feq_i(rho, u+F/rho) - feq_i(rho, u).
   * Exact to all orders in u, unlike the 2nd-order Guo scheme.
   *
   * Called once per frame with the frame's accumulated impulse. There is no
   * division by the sub-step count — the buffers already hold a per-frame
   * quantity, and dividing here would silently weaken every interaction by
   * the sub-step count. */
  applyForces() {
    const g = this.g;
    const { nx, ny, stride: s, solid, fx, fy, u, v, rho, dR, dG, dB } = g;
    const hasSolid = g.hasSolid;
    const f = this.f;
    const grav = this.gravity;
    const hasGrav = Math.abs(grav) > 1e-5;
    const LIMIT = 0.1;

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;
        let ax = fx[idx], ay = fy[idx];
        if (hasGrav) ay += grav * (dR[idx] + dG[idx] + dB[idx]) * (1 / 3);
        const m2 = ax * ax + ay * ay;
        if (m2 < 1e-14) continue;
        if (m2 > LIMIT * LIMIT) { const k = LIMIT / Math.sqrt(m2); ax *= k; ay *= k; }

        const r = rho[idx] > 1e-3 ? rho[idx] : 1;
        const inv = 1 / r;
        const ux = u[idx], uy = v[idx];
        const nx2 = ux + ax * inv, ny2 = uy + ay * inv;
        const a15 = 1.5 * (ux * ux + uy * uy);
        const b15 = 1.5 * (nx2 * nx2 + ny2 * ny2);
        for (let d = 0; d < 9; d++) {
          const e0 = EX[d] * ux + EY[d] * uy;
          const e1 = EX[d] * nx2 + EY[d] * ny2;
          const val = W[d] * r * ((3 * e1 + 4.5 * e1 * e1 - b15) - (3 * e0 + 4.5 * e0 * e0 - a15));
          const nv = f[d][idx] + val;
          f[d][idx] = nv < 0 ? 0 : nv;
        }
      }
    }
    fx.fill(0); fy.fill(0);
  }

  /* Outlet dye sponge plus inlet stripes, mirroring the NS wind tunnel. */
  injectDye(palette) {
    const g = this.g;
    const { nx, ny, stride: s, solid, dR, dG, dB, sR, sG, sB } = g;
    const width = Math.max(6, nx >> 5);
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let k = 0; k < width; k++) {
        const i = nx - k;
        if (i < 1) break;
        const idx = i + jS;
        if (solid[idx]) continue;
        const xi = (width - k) / width;
        const decay = 1 - 0.35 * xi * xi;
        dR[idx] *= decay; dG[idx] *= decay; dB[idx] *= decay;
      }
    }
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
        sR[idx] = col[0] / 255 * 3;
        sG[idx] = col[1] / 255 * 3;
        sB[idx] = col[2] / 255 * 3;
      }
    }
  }

  /* One frame. Returns the elapsed time in cell-units so the dye step can be
   * advanced consistently with the fluid. */
  step(palette) {
    if (!this.ready) this.initEquilibrium();
    this.applyForces();
    const n = this.steps;
    for (let k = 0; k < n; k++) {
      this.collide();
      this.stream();
      this.bounceBack();
      this.boundaries();
    }
    this.extract();
    if (this.windTunnel) this.injectDye(palette);
    return n;
  }

  get viscosity() { return (this.tau - 0.5) / 3; }
}
