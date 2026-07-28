/* Lagrangian tracers with RK4 advection.
 *
 * Everything lives in flat typed arrays and trails are fixed-size ring
 * buffers. The obvious object-per-particle version allocates two closures per
 * particle per frame for the velocity sampler and does an O(n) Array.splice
 * per trail — at 1200 particles that is pure GC churn every single frame.
 *
 * Rendering batches every trail of one colour into a single path, so the cost
 * is ~15 draw calls per frame rather than one per trail segment.
 *
 * COLOUR CARRIES DATA. Tracers used to be tinted by `k % palette.length` — an
 * arbitrary index, so the colours were decoration and the eye spent effort on
 * a variable that meant nothing. Every serious post-processor colours particles
 * by a scalar array instead: ParaView's Lagrangian workflow for OpenFOAM
 * clouds colours by mag(U), temperature or age, and its scalar bar gives the
 * mapping. That is what MODES below do.
 *
 * The maps come from colormaps.js and are perceptually ordered, which matters
 * more here than anywhere else in the app: a rainbow ramp invents banding that
 * looks like flow structure. `SPEED` has monotone lightness, and signed
 * quantities use the diverging map so zero sits at the neutral midpoint rather
 * than somewhere arbitrary in the hue circle.
 */

/* Each mode says which LUT to use and whether it is signed. Signed quantities
 * normalise about 0.5 so the midpoint of the diverging map means zero. */
export const PARTICLE_MODES = [
  { id: 'speed', label: 'Speed', lut: 'SPEED', signed: false },
  { id: 'vorticity', label: 'Vorticity', lut: 'VORTICITY', signed: true },
  { id: 'pressure', label: 'Pressure', lut: 'DIVERGING', signed: true },
  { id: 'age', label: 'Residence time', lut: 'SPEED', signed: false },
  { id: 'uniform', label: 'Uniform', lut: null, signed: false },
];
const MODE_BY_ID = Object.fromEntries(PARTICLE_MODES.map(m => [m.id, m]));

/* Colours are quantised into bins so trails can still be batched into one path
 * per colour. Per-particle strokes would be one draw call each — at 1400
 * particles that is the difference between a few dozen calls a frame and a few
 * thousand. 24 steps is past the point where banding is visible on a trail. */
const BINS = 16;

export class Particles {
  constructor(grid, palette, max = 1400, trailLen = 14) {
    this.g = grid;
    this.palette = palette;
    this.max = max;
    this.trailLen = trailLen;
    this.count = 0;

    this.px = new Float32Array(max);
    this.py = new Float32Array(max);
    this.ci = new Uint8Array(max);
    this.bin = new Uint8Array(max);      // quantised colour index
    this.age = new Float32Array(max);    // simulated time since spawn
    this.head = new Int32Array(max);
    this.len = new Int32Array(max);
    this.trail = new Float32Array(max * trailLen * 2);
    this.windTunnel = false;
    /* Vorticity by default, not speed.
     *
     * The field underneath shows speed by default, and colouring tracers by the
     * same scalar with the same map paints each one exactly the colour it sits
     * on — informative in principle, invisible in practice. Vorticity adds what
     * the surface is not already showing, which is the whole point of a second
     * channel, and it separates the two shear layers by rotation sense. */
    this.mode = 'vorticity';
    this.uniform = [210, 216, 224];
    this.density = 1;          // fraction of `max` actually drawn
  }

  seed(windTunnel) {
    this.windTunnel = windTunnel;
    const { nx, ny } = this.g;
    const n = Math.max(1, Math.round(this.max * this.density));
    this.count = n;
    this.head.fill(0);
    this.len.fill(0);
    if (windTunnel) {
      for (let k = 0; k < n; k++) {
        this.px[k] = 2 + Math.random() * 4;
        this.py[k] = 1 + Math.random() * (ny - 1);
        this.ci[k] = k % this.palette.length;
      }
    } else {
      const cols = Math.ceil(Math.sqrt(n * nx / ny));
      const rows = Math.ceil(n / cols);
      let k = 0;
      for (let j = 0; j < rows && k < n; j++) {
        for (let i = 0; i < cols && k < n; i++) {
          this.px[k] = 1 + (i + 0.2 + Math.random() * 0.6) * (nx / cols);
          this.py[k] = 1 + (j + 0.2 + Math.random() * 0.6) * (ny / rows);
          this.ci[k] = k % this.palette.length;
          k++;
        }
      }
      this.count = k;
    }
  }

  /* Trade tracer count for frame time.
   *
   * Drawing tracers costs about 2 ms a frame at full density on a 2400x1200
   * canvas — real, against a ~16 ms budget, and entirely proportional to how
   * many there are. Particles past `count` are simply not visited, so this is
   * a live control and not a reallocation; ones brought back are respawned
   * because their stored positions are stale. */
  setCount(n) {
    const next = Math.max(0, Math.min(this.max, Math.round(n)));
    for (let k = this.count; k < next; k++) this.respawn(k);
    this.count = next;
  }

  respawn(k) {
    const { nx, ny } = this.g;
    if (this.windTunnel) {
      this.px[k] = 1 + Math.random() * 3;
      this.py[k] = 1 + Math.random() * (ny - 1);
    } else {
      this.px[k] = 1 + Math.random() * (nx - 1);
      this.py[k] = 1 + Math.random() * (ny - 1);
    }
    this.len[k] = 0;
    this.head[k] = 0;
    this.age[k] = 0;
  }

  /* Scalar at a particle, normalised to 0..1 for the colour map.
   *
   * Signed quantities are centred on 0.5 so the diverging map's neutral
   * midpoint means zero — offsetting that turns "no rotation" into a colour,
   * which is exactly the misreading diverging maps exist to prevent. */
  scalarAt(k, mode, norm) {
    const g = this.g;
    const x = this.px[k], y = this.py[k];
    if (mode.id === 'age') {
      // Ten time units of residence saturates the ramp; long enough to show a
      // recirculation holding onto fluid, short enough to still vary.
      return Math.min(1, this.age[k] / 10);
    }
    if (mode.id === 'pressure') {
      const ref = Math.max(norm.press || 0.01, 1e-6);
      return 0.5 + 0.5 * Math.max(-1, Math.min(1, this.sample(g.p, x, y) / ref));
    }
    if (mode.id === 'vorticity') {
      const { nx, ny, stride: s, u, v } = g;
      const i = Math.max(1, Math.min(nx, x | 0));
      const j = Math.max(1, Math.min(ny, y | 0));
      const idx = i + j * s;
      // Negated: j runs downward, so the raw expression is positive for
      // CLOCKWISE rotation. See render-gl.js for the full note.
      const w = -0.5 * (v[idx + 1] - v[idx - 1] - u[idx + s] + u[idx - s]);
      const ref = Math.max(norm.curl || 0.01, 1e-6);
      return 0.5 + 0.5 * Math.max(-1, Math.min(1, w / ref));
    }
    const su = this.sample(g.u, x, y), sv = this.sample(g.v, x, y);
    const ref = Math.max(norm.speed || 1, 1e-6);
    return Math.min(1, Math.hypot(su, sv) / ref);
  }

  sample(field, x, y) {
    const { nx, ny, stride: s } = this.g;
    if (x < 1) x = 1; else if (x > nx) x = nx;
    if (y < 1) y = 1; else if (y > ny) y = ny;
    const i0 = x | 0, j0 = y | 0;
    const i1 = i0 < nx ? i0 + 1 : i0, j1 = j0 < ny ? j0 + 1 : j0;
    const b = x - i0, a = 1 - b, d = y - j0, c = 1 - d;
    return a * c * field[i0 + j0 * s] + b * c * field[i1 + j0 * s]
         + a * d * field[i0 + j1 * s] + b * d * field[i1 + j1 * s];
  }

  blocked(x, y) {
    const { nx, ny, stride: s, solid } = this.g;
    if (x < 1 || x > nx || y < 1 || y > ny) return true;
    return solid[(x | 0) + (y | 0) * s] !== 0;
  }

  advect(dt, norm = {}) {
    const g = this.g;
    const { nx, ny, u, v } = g;
    const hasSolid = g.hasSolid;
    const tl = this.trailLen;
    const mode = MODE_BY_ID[this.mode] || MODE_BY_ID.speed;
    const colouring = mode.lut !== null;

    for (let k = 0; k < this.count; k++) {
      const x = this.px[k], y = this.py[k];
      if (x < 1 || x > nx || y < 1 || y > ny || (hasSolid && this.blocked(x, y))) {
        this.respawn(k);
        continue;
      }

      const k1x = this.sample(u, x, y) * dt;
      const k1y = this.sample(v, x, y) * dt;
      const ax = x + 0.5 * k1x, ay = y + 0.5 * k1y;
      const k2x = this.sample(u, ax, ay) * dt;
      const k2y = this.sample(v, ax, ay) * dt;
      const bx = x + 0.5 * k2x, by = y + 0.5 * k2y;
      const k3x = this.sample(u, bx, by) * dt;
      const k3y = this.sample(v, bx, by) * dt;
      const cx = x + k3x, cy = y + k3y;
      const k4x = this.sample(u, cx, cy) * dt;
      const k4y = this.sample(v, cx, cy) * dt;

      const nxp = x + (k1x + 2 * k2x + 2 * k3x + k4x) / 6;
      const nyp = y + (k1y + 2 * k2y + 2 * k3y + k4y) / 6;

      if (hasSolid) {
        // March the cells between old and new position so thin walls are not
        // stepped over at high speed.
        const i0 = x | 0, j0 = y | 0, i1 = nxp | 0, j1 = nyp | 0;
        if (i0 !== i1 || j0 !== j1) {
          const di = i1 - i0, dj = j1 - j0;
          const steps = Math.max(Math.abs(di), Math.abs(dj));
          let hit = false;
          for (let t = 1; t <= steps; t++) {
            const mi = i0 + Math.round(di * t / steps);
            const mj = j0 + Math.round(dj * t / steps);
            if (this.blocked(mi, mj)) { hit = true; break; }
          }
          if (hit) { this.respawn(k); continue; }
        }
      }

      const base = k * tl * 2;
      const h = this.head[k];
      this.trail[base + h * 2] = x;
      this.trail[base + h * 2 + 1] = y;
      this.head[k] = (h + 1) % tl;
      if (this.len[k] < tl) this.len[k]++;

      this.px[k] = nxp;
      this.py[k] = nyp;
      this.age[k] += dt;
      // Sampled after the move, so the colour matches where the head is drawn.
      if (colouring) {
        const t = this.scalarAt(k, mode, norm);
        this.bin[k] = Math.max(0, Math.min(BINS - 1, (t * (BINS - 1) + 0.5) | 0));
      }
    }
  }

  /* Two overlapping passes per colour: the whole trail faint and thin, then
   * the newest few samples redrawn brighter to taper the streak.
   *
   * Both passes start at a real sample and finish at the live head, so neither
   * can emit a segment that leaps across the trail. Splitting the ring into
   * disjoint old/new halves — the obvious way to get a taper — does exactly
   * that: while a trail is shorter than half the buffer, which is true for the
   * first several frames of every particle and again after every respawn, the
   * old half joins straight to the head and draws a long stray line. That was
   * the flicker, and it affected every particle on screen. */
  render(ctx, sx, sy, light, maps = null) {
    if (!this.count) return;
    const tl = this.trailLen;
    const RECENT = Math.min(5, tl);
    const mode = MODE_BY_ID[this.mode] || MODE_BY_ID.speed;

    /* Colour table for this frame: either the mode's LUT sampled at each bin,
     * or a single colour repeated. Building it here keeps the inner loops
     * indexing a plain array rather than branching on the mode per particle. */
    const lut = mode.lut && maps ? maps[mode.lut] : null;
    const bins = lut ? BINS : 1;
    const table = new Array(bins);
    for (let c = 0; c < bins; c++) {
      if (!lut) { table[c] = this.uniform; continue; }
      const i = ((c / (BINS - 1)) * 255 + 0.5 | 0) * 3;
      table[c] = [lut[i], lut[i + 1], lut[i + 2]];
    }

    /* Bucket the particles by bin ONCE, with a counting sort, instead of
     * rescanning all of them per bin. At 1536 particles and 16 bins that is
     * 24k predicate tests a frame replaced by two linear passes. */
    if (!this.order || this.order.length !== this.max) {
      this.order = new Int32Array(this.max);
      this.binStart = new Int32Array(BINS + 1);
      this.binFill = new Int32Array(BINS + 1);
    }
    const order = this.order, start = this.binStart, fill = this.binFill;
    start.fill(0);
    const binOf = lut ? this.bin : null;
    for (let k = 0; k < this.count; k++) {
      if (this.len[k] < 1) continue;
      start[(binOf ? binOf[k] : 0) + 1]++;
    }
    for (let c = 0; c < bins; c++) start[c + 1] += start[c];
    for (let c = 0; c <= bins; c++) fill[c] = start[c];
    for (let k = 0; k < this.count; k++) {
      if (this.len[k] < 1) continue;
      order[fill[binOf ? binOf[k] : 0]++] = k;
    }

    const casing = light ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    /* One path per bin, stroked TWICE — wide and dark, then thin and coloured.
     *
     * The casing matters because a tracer coloured by the field's own scalar is
     * otherwise invisible: same value, same map, so it is painted exactly the
     * colour it sits on. Building the path once and stroking it twice is what
     * makes that affordable — the previous version walked every trail a second
     * time for a separate global casing pass, which was 40% of all the path
     * operations in the frame for a picture that looks the same.
     */
    for (let c = 0; c < bins; c++) {
      const lo = start[c], hi = start[c + 1];
      if (lo === hi) continue;
      const col = table[c];
      const rgb = `${col[0]},${col[1]},${col[2]}`;

      ctx.beginPath();
      for (let m = lo; m < hi; m++) {
        const k = order[m];
        const n = this.len[k];
        const base = k * tl * 2;
        const first = (this.head[k] - n + tl * 2) % tl;
        for (let t = 0; t < n; t++) {
          const q = (first + t) % tl;
          const X = this.trail[base + q * 2] * sx;
          const Y = this.trail[base + q * 2 + 1] * sy;
          if (t === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.lineTo(this.px[k] * sx, this.py[k] * sy);
      }
      ctx.strokeStyle = casing;
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${rgb},0.6)`;
      ctx.lineWidth = 0.9;
      ctx.stroke();

      // The newest few samples again, brighter, to taper the streak. Starts at
      // a real sample and ends at the live head, so it cannot emit a segment
      // that leaps across the ring buffer.
      ctx.beginPath();
      for (let m = lo; m < hi; m++) {
        const k = order[m];
        const n = this.len[k];
        const take = n < RECENT ? n : RECENT;
        const base = k * tl * 2;
        const first = (this.head[k] - take + tl * 2) % tl;
        for (let t = 0; t < take; t++) {
          const q = (first + t) % tl;
          const X = this.trail[base + q * 2] * sx;
          const Y = this.trail[base + q * 2 + 1] * sy;
          if (t === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.lineTo(this.px[k] * sx, this.py[k] * sy);
      }
      ctx.strokeStyle = `rgba(${rgb},0.95)`;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      ctx.beginPath();
      for (let m = lo; m < hi; m++) {
        const k = order[m];
        const X = this.px[k] * sx, Y = this.py[k] * sy;
        ctx.moveTo(X + 1.6, Y);
        ctx.arc(X, Y, 1.6, 0, 6.283185307);
      }
      ctx.fillStyle = `rgba(${rgb},1)`;
      ctx.fill();
    }
  }
}
