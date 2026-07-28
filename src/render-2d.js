/* Canvas2D fallback for machines without WebGL2.
 *
 * Renders one pixel per grid cell into an ImageData and lets the canvas scale
 * it up with smoothing. Deliberately no per-cell block replication: writing
 * NxN identical pixels costs N^2 times more and carries exactly as much
 * information as one pixel does. */

import { SPEED, DIVERGING, QCRIT, VORTICITY } from './colormaps.js';

const LUTS = {
  speed: SPEED, pressure: DIVERGING, vorticity: VORTICITY,
  qcriterion: QCRIT, mach: SPEED, density: DIVERGING,
};

export class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.backend = 'canvas2d';
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
    this.img = null;
    this.buf = null;
    this.dims = [0, 0];
  }

  markGeometryDirty() {}

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  ensure(nx, ny) {
    if (this.dims[0] === nx && this.dims[1] === ny) return;
    this.dims = [nx, ny];
    this.off.width = nx;
    this.off.height = ny;
    this.img = this.offCtx.createImageData(nx, ny);
    this.buf = new Uint32Array(this.img.data.buffer);
  }

  draw(grid, opts) {
    const { nx, ny, stride: s, solid, u, v, p, rho, dR, dG, dB } = grid;
    this.ensure(nx, ny);
    const buf = this.buf;
    const st = opts.stats;
    const mode = opts.mode;
    const lut = LUTS[mode] || SPEED;
    const hasSolid = grid.hasSolid;

    const water = opts.water || null;
    const wcol = (opts.waterColour || [0.16, 0.42, 0.72]).map(c => Math.round(c * 255));
    const bg = opts.theme.bg.map(c => Math.round(c * 255));
    const body = opts.theme.body.map(c => Math.round(c * 255));
    const bgPx = 0xff000000 | (bg[2] << 16) | (bg[1] << 8) | bg[0];
    const bodyPx = 0xff000000 | (body[2] << 16) | (body[1] << 8) | body[0];

    const invSpeed = 1 / Math.max(st.speed, 1e-4);
    const invPress = 1 / Math.max(st.press, 1e-8);
    const invCurl = 1 / Math.max(st.curl, 1e-6);
    const invGrad = 1 / Math.max(st.grad, 1e-8);
    const invQ = 1 / Math.max(st.q, 1e-8);
    const sound = opts.soundSpeed || 1;

    const pack = (t) => {
      const i = (((t < 0 ? 0 : t > 1 ? 1 : t) * 255 + 0.5) | 0) * 3;
      return 0xff000000 | (lut[i + 2] << 16) | (lut[i + 1] << 8) | lut[i];
    };

    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      const row = (j - 1) * nx - 1;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        const o = row + i;
        if (hasSolid && solid[idx]) { buf[o] = bodyPx; continue; }

        switch (mode) {
          case 'pressure': buf[o] = pack(0.5 + 0.5 * p[idx] * invPress); break;
          case 'vorticity': {
            // Negated for display; see render-gl.js.
            const w = -0.5 * (v[idx + 1] - v[idx - 1] - u[idx + s] + u[idx - s]);
            buf[o] = pack(0.5 + 0.5 * w * invCurl);
            break;
          }
          case 'schlieren': {
            const gx = 0.5 * (p[idx + 1] - p[idx - 1]);
            const gy = 0.5 * (p[idx + s] - p[idx - s]);
            let t = 1 - Math.exp(-3.5 * Math.min(1, Math.sqrt(gx * gx + gy * gy) * invGrad));
            if (opts.theme.light) t = 1 - t;
            const c = (t * 255) | 0;
            buf[o] = 0xff000000 | (c << 16) | (c << 8) | c;
            break;
          }
          case 'qcriterion': {
            const dudx = 0.5 * (u[idx + 1] - u[idx - 1]);
            const dudy = 0.5 * (u[idx + s] - u[idx - s]);
            const dvdx = 0.5 * (v[idx + 1] - v[idx - 1]);
            const dvdy = 0.5 * (v[idx + s] - v[idx - s]);
            const w = 0.5 * (dvdx - dudy);
            const sq = dudx * dudx + dvdy * dvdy + 0.5 * (dudy + dvdx) * (dudy + dvdx);
            const Q = 0.5 * (2 * w * w - sq);
            const t = 1 - Math.exp(-4 * Math.min(1, Math.abs(Q) * invQ));
            buf[o] = pack(0.5 + 0.5 * (Q >= 0 ? t : -t));
            break;
          }
          case 'mach': {
            const sp = Math.sqrt(u[idx] * u[idx] + v[idx] * v[idx]);
            buf[o] = pack(sp / sound * 0.5);
            break;
          }
          case 'density': buf[o] = pack(0.5 + 0.5 * (rho[idx] - 1) * 3); break;
          case 'dye': {
            const r = dR[idx], g = dG[idx], b = dB[idx];
            const m = Math.max(r, g, b);
            if (m < 0.004) { buf[o] = bgPx; break; }
            const a = Math.sqrt(Math.min(1, m * 1.6));
            const ia = 1 - a;
            const R = (bg[0] * ia + (r / m) * 255 * a) | 0;
            const G = (bg[1] * ia + (g / m) * 255 * a) | 0;
            const B = (bg[2] * ia + (b / m) * 255 * a) | 0;
            buf[o] = 0xff000000 | (B << 16) | (G << 8) | R;
            break;
          }
          default: {
            const a = u[idx], b = v[idx];
            buf[o] = pack(Math.sqrt(a * a + b * b) * invSpeed);
          }
        }
        /* Free surface, tinting the field rather than replacing it, and
         * brightening a band across the half-full contour to draw the surface
         * line. Matches render-gl.js — the fallback showing a different picture
         * from the GPU path is how the render-flip bug survived so long. */
        if (water) {
          const wf = water[idx];
          if (wf > 0.02) {
            const px = buf[o];
            const R = px & 255, G = (px >> 8) & 255, Bc = (px >> 16) & 255;
            const bodyA = wf <= 0.42 ? 0 : wf >= 0.58 ? 1 : (wf - 0.42) / 0.16;
            const t = bodyA * 0.65;
            let nr = R * (1 - t) + wcol[0] * t;
            let ng = G * (1 - t) + wcol[1] * t;
            let nb = Bc * (1 - t) + wcol[2] * t;
            const d = Math.abs(wf - 0.5);
            const band = d >= 0.10 ? 0 : (1 - d / 0.10) * 0.55;
            nr = nr * (1 - band) + 255 * band;
            ng = ng * (1 - band) + 255 * band;
            nb = nb * (1 - band) + 255 * band;
            buf[o] = 0xff000000 | ((nb | 0) << 16) | ((ng | 0) << 8) | (nr | 0);
          }
        }
      }
    }

    this.offCtx.putImageData(this.img, 0, 0);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, 0, 0, this.canvas.width, this.canvas.height);
  }
}
