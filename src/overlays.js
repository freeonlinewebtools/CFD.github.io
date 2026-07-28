/* Vector, streamline, contour, probe and legend overlays.
 *
 * These draw onto a separate 2D canvas stacked over the field canvas, so the
 * field renderer never has to read pixels back.
 *
 * Two things here were rewritten for cost rather than correctness:
 *  - Contours visit each cell ONCE and emit only the levels that actually
 *    cross it, instead of running a full marching-squares sweep per level.
 *  - The colour bar is rasterised into an offscreen canvas and blitted; it is
 *    static between mode and theme changes, so redrawing its gradient strip
 *    scanline-by-scanline every frame is wasted work.
 */

import { MAPS, sampleLUT } from './colormaps.js';
import { outlineWorld } from './geometry.js';

const LUT_FOR = {
  speed: 'SPEED', pressure: 'DIVERGING', vorticity: 'VORTICITY',
  qcriterion: 'QCRIT', mach: 'SPEED', density: 'DIVERGING', schlieren: 'GREY',
};

const LEGEND = {
  speed: { title: 'speed', unit: '|u| cells/t' },
  pressure: { title: 'pressure', unit: 'p' },
  vorticity: { title: 'vorticity', unit: 'w = dv/dx - du/dy' },
  schlieren: { title: 'schlieren', unit: '|grad p|' },
  qcriterion: { title: 'Q-criterion', unit: 'rotation vs strain' },
  mach: { title: 'Mach', unit: '|u| / c' },
  density: { title: 'density', unit: 'rho / rho0' },
  dye: { title: 'dye', unit: 'tracer' },
};

export class Overlays {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.barCanvas = document.createElement('canvas');
    this.barKey = '';
  }

  resize(w, h, dpr) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  begin() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(this.dpr, this.dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  get width() { return this.canvas.width / this.dpr; }
  get height() { return this.canvas.height / this.dpr; }

  vectors(grid, sx, sy, theme) {
    const { nx, ny, stride: s, u, v, solid } = grid;
    const ctx = this.ctx;
    const target = 26;                      // approximate arrow spacing, px
    const step = Math.max(4, Math.round(target / sx));
    const scale = Math.min(sx, sy) * step * 0.4;
    const inv = 1 / Math.max(1e-4, this._maxSpeed || 1);

    ctx.strokeStyle = theme.vector;
    ctx.fillStyle = theme.vector;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    const heads = [];
    for (let j = step; j <= ny; j += step) {
      const jS = j * s;
      for (let i = step; i <= nx; i += step) {
        const idx = i + jS;
        if (solid[idx]) continue;
        const a = u[idx], b = v[idx];
        const m = Math.sqrt(a * a + b * b);
        if (m < 1e-3) continue;
        const t = Math.min(1, m * inv);
        const len = scale * (0.25 + 0.75 * t);
        const px = (i - 0.5) * sx, py = (j - 0.5) * sy;
        const dx = a / m, dy = b / m;
        const ex = px + dx * len, ey = py + dy * len;
        ctx.moveTo(px, py);
        ctx.lineTo(ex, ey);
        heads.push(ex, ey, dx, dy);
      }
    }
    ctx.stroke();

    ctx.beginPath();
    const hs = 3.2;
    for (let k = 0; k < heads.length; k += 4) {
      const ex = heads[k], ey = heads[k + 1], dx = heads[k + 2], dy = heads[k + 3];
      const px = -dy, py = dx;
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - dx * hs + px * hs * 0.45, ey - dy * hs + py * hs * 0.45);
      ctx.lineTo(ex - dx * hs - px * hs * 0.45, ey - dy * hs - py * hs * 0.45);
      ctx.closePath();
    }
    ctx.fill();
  }

  streamlines(grid, sx, sy, theme, windTunnel) {
    const { nx, ny, stride: s, u, v, solid } = grid;
    const ctx = this.ctx;
    const inv = 1 / Math.max(1e-4, this._maxSpeed || 1);
    const stepLen = 0.9;
    const maxSteps = Math.round(nx * 1.2);

    const seeds = [];
    const rows = windTunnel ? 30 : 22;
    for (let k = 1; k <= rows; k++) {
      const y = (ny / (rows + 1)) * k;
      seeds.push([windTunnel ? 2 : nx * 0.06, y]);
      if (windTunnel && k % 2 === 0) seeds.push([nx * 0.45, y]);
    }

    for (const [x0, y0] of seeds) {
      let x = x0, y = y0, peak = 0;
      ctx.beginPath();
      ctx.moveTo((x - 0.5) * sx, (y - 0.5) * sy);
      for (let k = 0; k < maxSteps; k++) {
        const i = x | 0, j = y | 0;
        if (i < 1 || i >= nx || j < 1 || j >= ny) break;
        const idx = i + j * s;
        if (solid[idx]) break;
        const a = u[idx], b = v[idx];
        const m = Math.sqrt(a * a + b * b);
        if (m < 1e-5) break;
        if (m > peak) peak = m;
        // RK2 midpoint on the normalised field: even arc-length spacing.
        const hx = x + 0.5 * (a / m) * stepLen, hy = y + 0.5 * (b / m) * stepLen;
        const hi = hx | 0, hj = hy | 0;
        let dx = a / m, dy = b / m;
        if (hi >= 1 && hi < nx && hj >= 1 && hj < ny) {
          const h = hi + hj * s;
          if (!solid[h]) {
            const a2 = u[h], b2 = v[h];
            const m2 = Math.sqrt(a2 * a2 + b2 * b2);
            if (m2 > 1e-5) { dx = a2 / m2; dy = b2 / m2; }
          }
        }
        x += dx * stepLen; y += dy * stepLen;
        ctx.lineTo((x - 0.5) * sx, (y - 0.5) * sy);
      }
      const t = Math.min(1, peak * inv);
      ctx.lineWidth = 0.5 + t * 1.5;
      ctx.strokeStyle = theme.stream(0.08 + t * 0.24);
      ctx.stroke();
    }
  }

  /* Single-pass multi-level marching squares. */
  contours(grid, sx, sy, theme, levels = 11) {
    const { nx, ny, stride: s, p, solid } = grid;
    const hasSolid = grid.hasSolid;
    const ctx = this.ctx;

    let lo = Infinity, hi = -Infinity;
    for (let j = 1; j <= ny; j++) {
      const jS = j * s;
      for (let i = 1; i <= nx; i++) {
        const idx = i + jS;
        if (hasSolid && solid[idx]) continue;
        const val = p[idx];
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    }
    const range = hi - lo;
    if (!(range > 1e-9)) return;
    const dl = range / (levels + 1);

    ctx.lineWidth = 0.6;
    ctx.strokeStyle = theme.contour;
    ctx.beginPath();

    for (let j = 1; j < ny; j++) {
      const jS = j * s;
      const y0 = (j - 0.5) * sy, y1 = (j + 0.5) * sy;
      for (let i = 1; i < nx; i++) {
        const idx = i + jS;
        if (hasSolid && (solid[idx] || solid[idx + 1] || solid[idx + s] || solid[idx + 1 + s])) continue;
        const a = p[idx], b = p[idx + 1], c = p[idx + s], d = p[idx + 1 + s];
        let cmin = a, cmax = a;
        if (b < cmin) cmin = b; if (b > cmax) cmax = b;
        if (c < cmin) cmin = c; if (c > cmax) cmax = c;
        if (d < cmin) cmin = d; if (d > cmax) cmax = d;

        // Only the levels bracketed by this cell's corner values can cross it.
        const kLo = Math.max(1, Math.ceil((cmin - lo) / dl));
        const kHi = Math.min(levels, Math.floor((cmax - lo) / dl));
        if (kHi < kLo) continue;

        const x0 = (i - 0.5) * sx, x1 = (i + 0.5) * sx;
        for (let k = kLo; k <= kHi; k++) {
          const lv = lo + k * dl;
          const pa = a - lv, pb = b - lv, pc = c - lv, pd = d - lv;
          const cs = (pa > 0 ? 1 : 0) | (pb > 0 ? 2 : 0) | (pc > 0 ? 4 : 0) | (pd > 0 ? 8 : 0);
          if (cs === 0 || cs === 15) continue;
          const tT = pa / (pa - pb), tB = pc / (pc - pd);
          const tL = pa / (pa - pc), tR = pb / (pb - pd);
          const xT = x0 + (x1 - x0) * tT, xB = x0 + (x1 - x0) * tB;
          const yL = y0 + (y1 - y0) * tL, yR = y0 + (y1 - y0) * tR;
          switch (cs) {
            case 1: case 14: ctx.moveTo(xT, y0); ctx.lineTo(x0, yL); break;
            case 2: case 13: ctx.moveTo(xT, y0); ctx.lineTo(x1, yR); break;
            case 4: case 11: ctx.moveTo(x0, yL); ctx.lineTo(xB, y1); break;
            case 8: case 7: ctx.moveTo(x1, yR); ctx.lineTo(xB, y1); break;
            case 3: case 12: ctx.moveTo(x0, yL); ctx.lineTo(x1, yR); break;
            case 5: case 10: ctx.moveTo(xT, y0); ctx.lineTo(xB, y1); break;
            default:
              ctx.moveTo(xT, y0); ctx.lineTo(x0, yL);
              ctx.moveTo(x1, yR); ctx.lineTo(xB, y1);
          }
        }
      }
    }
    ctx.stroke();
  }

  inlets(list, sx, sy) {
    if (!list.length) return;
    const ctx = this.ctx;
    for (const src of list) {
      const x = (src.i - 0.5) * sx, y = (src.j - 0.5) * sy;
      const r = Math.max(4, src.radius * sx);
      const m = Math.hypot(src.ux, src.uy) || 1;
      const dx = src.ux / m, dy = src.uy / m;
      const len = Math.max(14, r * 1.7);
      const rgb = `${src.col[0]},${src.col[1]},${src.col[2]}`;

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = `rgba(${rgb},0.5)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.283185307);
      ctx.stroke();
      ctx.setLineDash([]);

      const ex = x + dx * len, ey = y + dy * len;
      ctx.strokeStyle = `rgba(${rgb},0.8)`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      const px = -dy, py = dx;
      ctx.fillStyle = `rgba(${rgb},0.8)`;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - dx * 6 + px * 3, ey - dy * 6 + py * 3);
      ctx.lineTo(ex - dx * 6 - px * 3, ey - dy * 6 - py * 3);
      ctx.closePath(); ctx.fill();
    }
  }

  /* Text drawn directly over the field.
   *
   * The field is whatever colour the colormap produces, so a flat fill has no
   * guaranteed contrast — the drag readout sat on the warm side of the speed
   * map and could not be read at all, and the scale bar disappeared entirely
   * against mid-green. Outlining in the opposite tone first makes the label
   * legible over anything underneath it, which a drop shadow does not: a shadow
   * fails against a background that already matches it.
   *
   * Panels that draw their own background (the colour bar, the probe) do not
   * need this and do not use it. */
  /* Rounded rect path — ctx.roundRect is not assumed, since the overlay context
   * is also constructed against a stub in the headless tests. */
  roundRectPath(x, y, w, h, r) {
    const ctx = this.ctx;
    const k = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.lineTo(x + w - k, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + k);
    ctx.lineTo(x + w, y + h - k);
    ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
    ctx.lineTo(x + k, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - k);
    ctx.lineTo(x, y + k);
    ctx.quadraticCurveTo(x, y, x + k, y);
    ctx.closePath();
  }

  /* A readout sitting on its own small panel.
   *
   * Outlining text straight onto the field was legible but looked crude: a 3px
   * stroke around 10px glyphs reads as a smudge, not a label. Everything the
   * HUD writes over the field now sits on the same quiet panel the colour bar
   * uses, so the readouts belong to one instrument instead of being scribbled
   * on top of the picture.
   *
   * `accent` draws a small colour key, which is what ties a number to the arrow
   * it belongs to without repeating the colour in the text.
   */
  badge(text, x, y, theme, opts = {}) {
    const { anchor = 'center', accent = null, size = 10 } = opts;
    const ctx = this.ctx;
    ctx.font = `${size}px ui-monospace, monospace`;
    const padX = 6, keyW = accent ? 9 : 0;
    const w = Math.ceil(ctx.measureText(text).width) + padX * 2 + keyW;
    const h = size + 8;
    let bx = anchor === 'center' ? x - w / 2 : anchor === 'right' ? x - w : x;
    let by = y - h / 2;
    // Keep it on screen; a readout clipped by the viewport edge is no readout.
    bx = Math.max(3, Math.min(bx, this.width - w - 3));
    by = Math.max(3, Math.min(by, this.height - h - 3));

    this.roundRectPath(bx + 0.5, by + 0.5, w, h, 3);
    ctx.fillStyle = theme.panelBg;
    ctx.fill();
    ctx.strokeStyle = theme.panelLine;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (accent) {
      ctx.fillStyle = accent;
      this.roundRectPath(bx + padX, by + h / 2 - 3.5, 3, 7, 1.5);
      ctx.fill();
    }
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX + keyW, by + h / 2 + 0.5);
    return { x: bx, y: by, w, h };
  }

  label(text, x, y, colour, opts = {}) {
    const { align = 'center', baseline = 'middle', size = 10,
            halo = 'rgba(0,0,0,0.66)' } = opts;
    const ctx = this.ctx;
    ctx.font = `${size}px ui-monospace, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = 3;
    ctx.strokeStyle = halo || 'rgba(0,0,0,0.66)';
    ctx.strokeText(text, x, y);
    ctx.restore();
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  /* Drag and lift, as two arrows from the body's centroid with their values on
   * small panels at the tips.
   *
   * Length encodes magnitude linearly, but is floored and capped: a coefficient
   * near zero still needs a visible stub to hang its readout on, and one from a
   * transient must not shoot a hundred cells across the domain. The clamp is
   * wide enough that ordinary values stay in the linear range.
   *
   * A soft shadow separates the arrows from the field instead of the heavy
   * outline this used to carry — at 2px wide, a 4px dark under-stroke turned
   * every arrow into a smudge.
   */
  /* The radius the active tool will actually affect, drawn at the cursor.
   *
   * Without it the brush tools are guesswork — you find the size by painting
   * something the wrong size and undoing. The ring is the tool's TRUE reach,
   * not the raw `brush` setting, because several tools scale it (a wall uses
   * half, an emitter three fifths) and a cursor that disagrees with what the
   * click does is worse than none.
   *
   * A dark ring under a light one, rather than a single colour, so it stays
   * visible over any part of the field and over solids.
   */
  brushCursor(gx, gy, radius, sx, sy, theme, opts = {}) {
    const { dashed = false, label = null } = opts;
    const ctx = this.ctx;
    const cx = (gx - 0.5) * sx, cy = (gy - 0.5) * sy;
    const r = Math.max(2, radius * sx);

    ctx.save();
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = theme.light ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();

    // Centre mark, so the anchor point is unambiguous on a large radius.
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();

    if (label) this.badge(label, cx, cy - r - 12, theme, { anchor: 'center', size: 9 });
  }

  forceArrows(diag, sx, sy, theme) {
    const b = diag.bounds;
    if (!b) return;
    const ctx = this.ctx;
    const cx = (b.cx - 0.5) * sx, cy = (b.cy - 0.5) * sy;
    const SCALE = 62, MIN = 20, MAX = 108;

    const arrow = (ux, uy, value, colour, name, badgeAt) => {
      const raw = Math.abs(value) * SCALE;
      const len = Math.max(MIN, Math.min(MAX, raw));
      const dx = ux * len, dy = uy * len;
      const headX = cx + dx, headY = cy + dy;
      const px = -uy, py = ux;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(headX - ux * 8, headY - uy * 8);   // stop short of the head
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(headX, headY);
      ctx.lineTo(headX - ux * 9 + px * 4.5, headY - uy * 9 + py * 4.5);
      ctx.lineTo(headX - ux * 9 - px * 4.5, headY - uy * 9 - py * 4.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // A small hub where the two arrows meet, so they read as one measurement
      // taken at a point rather than two unrelated marks.
      ctx.fillStyle = theme.panelBg;
      ctx.strokeStyle = theme.panelLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      this.badge(`${name} ${value.toFixed(2)}`, badgeAt.x(headX), badgeAt.y(headY),
        theme, { anchor: badgeAt.anchor, accent: colour });
    };

    // Drag runs along the flow, lift across it. Signs pick the side each arrow
    // points to, and the badge sits clear of the arrowhead on that side.
    const cdDir = diag.cd < 0 ? -1 : 1;
    const clDir = diag.cl < 0 ? 1 : -1;          // +lift is up, which is -y
    arrow(cdDir, 0, diag.cd, theme.drag, 'Cd',
      { x: hx => hx + cdDir * 8, y: hy => hy, anchor: cdDir > 0 ? 'left' : 'right' });
    arrow(0, clDir, diag.cl, theme.lift, 'Cl',
      { x: hx => hx, y: hy => hy + clDir * 12, anchor: 'center' });
  }

  probe(grid, pi, pj, sx, sy, theme, extra) {
    const { nx, ny, stride: s, u, v, p, solid } = grid;
    if (pi < 1 || pi > nx || pj < 1 || pj > ny) return;
    const idx = pi + pj * s;
    if (solid[idx]) return;
    const ctx = this.ctx;
    const x = (pi - 0.5) * sx, y = (pj - 0.5) * sy;
    const a = u[idx], b = v[idx];
    const m = Math.hypot(a, b);
    const w = 0.5 * (v[idx + 1] - v[idx - 1] - u[idx + s] + u[idx - s]);

    ctx.strokeStyle = theme.probeLine;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y);
    ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9);
    ctx.stroke();

    if (m > 1e-3) {
      const len = Math.min(22, 6 + m * 4);
      const ux = a / m, uy = b / m;
      ctx.strokeStyle = theme.probeArrow;
      ctx.fillStyle = theme.probeArrow;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + ux * len, y + uy * len);
      ctx.stroke();
      const px = -uy, py = ux;
      ctx.beginPath();
      ctx.moveTo(x + ux * len, y + uy * len);
      ctx.lineTo(x + ux * (len - 5) + px * 2.4, y + uy * (len - 5) + py * 2.4);
      ctx.lineTo(x + ux * (len - 5) - px * 2.4, y + uy * (len - 5) - py * 2.4);
      ctx.closePath(); ctx.fill();
    }

    const rows = [
      ['cell', `${pi}, ${pj}`],
      ['|u|', m.toFixed(3)],
      ['u, v', `${a.toFixed(2)}, ${b.toFixed(2)}`],
      ['theta', `${(Math.atan2(b, a) * 180 / Math.PI).toFixed(0)} deg`],
      ['p', p[idx].toFixed(4)],
      ['w', w.toFixed(4)],
    ];
    if (extra) for (const r of extra(idx)) rows.push(r);

    const lh = 13, padX = 7, padY = 6;
    const bw = 146, bh = rows.length * lh + padY * 2;
    let bx = x + 14, by = y - 12;
    if (bx + bw > this.width - 4) bx = x - bw - 14;
    if (by + bh > this.height - 4) by = this.height - bh - 4;
    if (by < 4) by = 4;

    ctx.fillStyle = theme.panelBg;
    ctx.strokeStyle = theme.panelLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx + 0.5, by + 0.5, bw, bh);
    ctx.fill(); ctx.stroke();

    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < rows.length; k++) {
      const ty = by + padY + lh * k + lh / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = theme.textDim;
      ctx.fillText(rows[k][0], bx + padX, ty);
      ctx.textAlign = 'right';
      ctx.fillStyle = theme.text;
      ctx.fillText(rows[k][1], bx + bw - padX, ty);
    }
  }

  scaleBar(sx, theme, nx) {
    const ctx = this.ctx;
    const cells = nx >= 200 ? 50 : 20;
    const w = cells * sx;
    const x = 12, y = this.height - 16;
    // A one-pixel dark surround, centred on the rule rather than sitting above
    // it — the same dim grey that reads clearly against a panel disappears
    // against mid-green field colours. An offset backing reads as a slab; this
    // reads as an edge.
    // Rule with end ticks, given separation by a shadow rather than the slab of
    // dark pixels that used to sit behind it, and its label on a panel.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = theme.text;
    ctx.fillRect(x, y, w, 1.5);
    ctx.fillRect(x, y - 3.5, 1.5, 8);
    ctx.fillRect(x + w - 1.5, y - 3.5, 1.5, 8);
    ctx.restore();
    this.badge(`${cells} cells`, x, y - 13, theme, { anchor: 'left', size: 9 });
  }

  colourBar(mode, stats, theme) {
    const meta = LEGEND[mode];
    if (!meta) return;
    const key = `${mode}|${theme.name}|${Math.round(this.height)}`;
    const barH = Math.min(160, Math.max(80, this.height * 0.4)) | 0;
    const barW = 10;

    if (this.barKey !== key) {
      this.barKey = key;
      const c = this.barCanvas;
      c.width = barW;
      c.height = barH;
      const bc = c.getContext('2d');
      const name = LUT_FOR[mode];
      if (name) {
        const lut = MAPS[name];
        for (let y = 0; y < barH; y++) {
          bc.fillStyle = sampleLUT(lut, 1 - y / (barH - 1));
          bc.fillRect(0, y, barW, 1);
        }
      } else {
        bc.fillStyle = theme.panelBg;
        bc.fillRect(0, 0, barW, barH);
      }
    }

    const ctx = this.ctx;
    const bx = this.width - 26, by = (this.height - barH) / 2;
    const labelW = 46;
    const px = bx - labelW - 8, py = by - 20;
    const pw = labelW + barW + 16, ph = barH + 34;

    ctx.fillStyle = theme.panelBg;
    ctx.strokeStyle = theme.panelLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(px + 0.5, py + 0.5, pw, ph);
    ctx.fill(); ctx.stroke();

    ctx.drawImage(this.barCanvas, bx, by, barW, barH);
    ctx.strokeStyle = theme.panelLine;
    ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);

    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(meta.title, px + pw / 2, py + 5);

    const ticks = this.ticksFor(mode, stats);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.textDim;
    for (let k = 0; k < ticks.length; k++) {
      const ty = by + (barH - 1) * (k / (ticks.length - 1));
      ctx.fillText(ticks[k], bx - 4, ty);
      ctx.strokeStyle = theme.panelLine;
      ctx.beginPath();
      ctx.moveTo(bx - 3, ty + 0.5); ctx.lineTo(bx, ty + 0.5);
      ctx.stroke();
    }
  }

  ticksFor(mode, s) {
    const f = (v) => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(3);
    switch (mode) {
      case 'speed': return [f(s.speed), f(s.speed / 2), '0'];
      case 'pressure': return [`+${f(s.press)}`, '0', `-${f(s.press)}`];
      case 'vorticity': return ['ccw', '0', 'cw'];
      case 'schlieren': return ['high', '', 'low'];
      case 'qcriterion': return ['vortex', '0', 'strain'];
      case 'mach': return ['2.0', '1.0', '0'];
      case 'density': return ['>1', '1', '<1'];
      default: return ['', '', ''];
    }
  }

  setMaxSpeed(v) { this._maxSpeed = v; }

  /* Scene object outlines and the selection gizmo.
   *
   * Drawn from the object's own outline rather than its bounding box, so a
   * rotated aerofoil reads as the shape you can actually click. The handle box
   * is axis-aligned because that is what the resize maths operates on, and
   * showing anything else would misrepresent what dragging will do. */
  selection(scene, sx, sy, theme, opts = {}) {
    const ctx = this.ctx;
    const handleSize = opts.handleSize ?? 4;

    for (const o of scene.objects) {
      if (!o.visible) continue;
      const sel = scene.selection.has(o.id);
      const pts = outlineFor(o);
      if (!pts || pts.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0] * sx, pts[1] * sy);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * sx, pts[i + 1] * sy);
      ctx.closePath();
      ctx.lineWidth = sel ? 1.6 : 1;
      ctx.strokeStyle = sel ? theme.selected : (o.locked ? theme.lockedEdge : theme.objectEdge);
      ctx.stroke();
    }

    const box = scene.selectionBounds();
    if (!box || !opts.handles) return;

    const x0 = box.minX * sx, y0 = box.minY * sy;
    const x1 = box.maxX * sx, y1 = box.maxY * sy;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.gizmo;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);

    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const spots = [
      [x0, y0], [cx, y0], [x1, y0], [x1, cy],
      [x1, y1], [cx, y1], [x0, y1], [x0, cy],
    ];
    ctx.fillStyle = theme.gizmoFill;
    ctx.strokeStyle = theme.gizmo;
    for (const [hx, hy] of spots) {
      ctx.beginPath();
      ctx.rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      ctx.fill(); ctx.stroke();
    }

    const rotY = y0 - (opts.rotOffset ?? 6) * sy;
    ctx.beginPath();
    ctx.moveTo(cx, y0); ctx.lineTo(cx, rotY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, rotY, handleSize * 0.8, 0, 6.283185307);
    ctx.fill(); ctx.stroke();
  }

  /* In-progress drawing. Dashed so it reads as provisional rather than as an
   * object that already exists. */
  draft(d, sx, sy, theme) {
    if (!d) return;
    const ctx = this.ctx;
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = theme.selected;

    if (d.kind === 'draw-rect') {
      const x = Math.min(d.x0, d.x1) * sx, y = Math.min(d.y0, d.y1) * sy;
      ctx.strokeRect(x, y, Math.abs(d.x1 - d.x0) * sx, Math.abs(d.y1 - d.y0) * sy);
    } else if (d.kind === 'draw-circle') {
      const cx = (d.x0 + d.x1) / 2 * sx, cy = (d.y0 + d.y1) / 2 * sy;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(d.x1 - d.x0) / 2 * sx, Math.abs(d.y1 - d.y0) / 2 * sy, 0, 0, 6.283185307);
      ctx.stroke();
    } else if (d.pts && d.pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(d.pts[0] * sx, d.pts[1] * sy);
      for (let i = 2; i < d.pts.length; i += 2) ctx.lineTo(d.pts[i] * sx, d.pts[i + 1] * sy);
      if (d.cx !== undefined) ctx.lineTo(d.cx * sx, d.cy * sy);
      if (d.kind === 'draw-poly') ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.gizmoFill;
      for (let i = 0; i < d.pts.length; i += 2) {
        ctx.beginPath();
        ctx.rect(d.pts[i] * sx - 2.5, d.pts[i + 1] * sy - 2.5, 5, 5);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  /* Status text pinned to the viewport, used by modal transform operators. */
  operatorHint(text, theme) {
    if (!text) return;
    const ctx = this.ctx;
    ctx.font = '12px ui-monospace, monospace';
    const w = ctx.measureText(text).width + 16;
    const x = 10, y = 10;
    ctx.fillStyle = theme.panelBg;
    ctx.strokeStyle = theme.panelLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x + 0.5, y + 0.5, w, 22);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 8, y + 11);
  }
}

/* Cached per-object outline in world space. Recomputed when the object's
 * transform or parameters change, keyed on a cheap signature. */
function outlineFor(o) {
  const t = o.transform;
  const sig = `${t.x},${t.y},${t.rot},${t.sx},${t.sy},${o.type},${JSON.stringify(o.params)}`;
  if (o._olSig !== sig) {
    o._olSig = sig;
    o._olPts = outlineWorld(o);
  }
  return o._olPts;
}
