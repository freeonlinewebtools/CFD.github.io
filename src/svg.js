/* SVG → scene polygons.
 *
 * The point of this is to let someone draw a section in Illustrator, Inkscape
 * or a CAD tool and put it straight in the tunnel. So it has to cope with what
 * those actually emit: nested <g> transforms, paths made of Béziers and arcs,
 * and a viewBox that bears no relation to the domain size.
 *
 * No DOMParser. The rest of the test suite runs headless in Node, and a parser
 * that needs a browser could only be tested in one — which is how a "works on
 * my machine" importer happens. This is a self-contained scanner instead, so
 * `tests/svg.mjs` exercises the real code path.
 *
 * Everything is flattened to polygons, because that is what the rasteriser
 * consumes. Curves are subdivided; the tolerance is in SVG user units and is
 * chosen against the final cell size, since sub-cell precision is invisible to
 * a solver working on a grid.
 *
 * Known limits, all deliberate:
 *   - fill-rule holes are not cut. Each subpath becomes its own solid polygon,
 *     so a letter 'O' imports as a filled disc. Cutting holes would need the
 *     rasteriser to support negative objects, which it does not.
 *   - <text>, <image>, <use> and CSS styling are ignored. Convert text to
 *     outlines before exporting.
 *   - stroke width is ignored on closed shapes; open paths become walls with a
 *     thickness instead.
 */

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/* ── transforms: 2x3 affine as [a, b, c, d, e, f] ─────────────────────── */

const IDENT = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* Parse the SVG transform attribute: translate/scale/rotate/matrix/skew. */
export function parseTransform(str) {
  if (!str) return IDENT.slice();
  let m = IDENT.slice();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let g;
  while ((g = re.exec(str))) {
    const v = (g[2].match(NUM) || []).map(Number);
    const rad = d => d * Math.PI / 180;
    let t;
    switch (g[1]) {
      case 'matrix': t = v.length >= 6 ? v.slice(0, 6) : IDENT.slice(); break;
      case 'translate': t = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'skewX': t = [1, 0, Math.tan(rad(v[0] || 0)), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(rad(v[0] || 0)), 0, 1, 0, 0]; break;
      case 'rotate': {
        const a = rad(v[0] || 0), c = Math.cos(a), s = Math.sin(a);
        const r = [c, s, -s, c, 0, 0];
        // rotate(angle cx cy) rotates about a point, not the origin.
        t = (v.length >= 3)
          ? mul(mul([1, 0, 0, 1, v[1], v[2]], r), [1, 0, 0, 1, -v[1], -v[2]])
          : r;
        break;
      }
      default: t = IDENT.slice();
    }
    m = mul(m, t);
  }
  return m;
}

/* ── path data ────────────────────────────────────────────────────────── */

/* Split `d` into [command, ...numbers] steps. */
function tokenizePath(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let g;
  while ((g = re.exec(d))) {
    out.push({ cmd: g[1], args: (g[2].match(NUM) || []).map(Number) });
  }
  return out;
}

function sampleCubic(pts, x0, y0, x1, y1, x2, y2, x3, y3, steps) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    pts.push(a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3);
  }
}

/* Endpoint-parameterised elliptical arc, per the SVG implementation notes. */
function sampleArc(pts, x0, y0, rx, ry, rot, largeArc, sweep, x1, y1, steps) {
  if (rx === 0 || ry === 0) { pts.push(x1, y1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = rot * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;

  // Scale the radii up if they cannot span the endpoints.
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = co * (rx * y1p) / ry, cyp = co * -(ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x1) / 2;
  const cy = sp * cxp + cp * cyp + (y0 + y1) / 2;

  const ang = (ux, uy, vx, vy) => {
    const d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (d || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;

  for (let i = 1; i <= steps; i++) {
    const t = t1 + dt * (i / steps);
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push(cp * ex - sp * ey + cx, sp * ex + cp * ey + cy);
  }
}

/* Flatten a path `d` into subpaths: [{ pts:[x,y,...], closed:boolean }]. */
export function flattenPath(d, curveSteps = 16) {
  const steps = tokenizePath(d);
  const subs = [];
  let cur = null;
  let x = 0, y = 0, startX = 0, startY = 0;
  let lastC = null, lastQ = null;   // reflection points for S / T

  const begin = () => { cur = { pts: [], closed: false }; subs.push(cur); };

  for (const { cmd, args } of steps) {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'Z') {
      if (cur && cur.pts.length) { cur.closed = true; x = startX; y = startY; }
      cur = null; lastC = lastQ = null;
      continue;
    }
    // Each command may carry repeated argument groups.
    const size = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[C];
    const groups = size ? Math.max(1, Math.floor(args.length / size)) : 0;

    for (let g = 0; g < groups; g++) {
      const a = args.slice(g * size, g * size + size);
      if (a.length < size) break;

      if (C === 'M') {
        x = rel ? x + a[0] : a[0];
        y = rel ? y + a[1] : a[1];
        // Subsequent pairs after a moveto are implicit linetos.
        if (g === 0) { begin(); startX = x; startY = y; cur.pts.push(x, y); }
        else cur.pts.push(x, y);
        lastC = lastQ = null;
        continue;
      }
      if (!cur) { begin(); startX = x; startY = y; cur.pts.push(x, y); }

      if (C === 'L') { x = rel ? x + a[0] : a[0]; y = rel ? y + a[1] : a[1]; cur.pts.push(x, y); lastC = lastQ = null; }
      else if (C === 'H') { x = rel ? x + a[0] : a[0]; cur.pts.push(x, y); lastC = lastQ = null; }
      else if (C === 'V') { y = rel ? y + a[0] : a[0]; cur.pts.push(x, y); lastC = lastQ = null; }
      else if (C === 'C' || C === 'S') {
        let c1x, c1y, c2x, c2y, ex, ey;
        if (C === 'C') {
          c1x = rel ? x + a[0] : a[0]; c1y = rel ? y + a[1] : a[1];
          c2x = rel ? x + a[2] : a[2]; c2y = rel ? y + a[3] : a[3];
          ex = rel ? x + a[4] : a[4]; ey = rel ? y + a[5] : a[5];
        } else {
          // S reflects the previous cubic's second control point.
          c1x = lastC ? 2 * x - lastC[0] : x; c1y = lastC ? 2 * y - lastC[1] : y;
          c2x = rel ? x + a[0] : a[0]; c2y = rel ? y + a[1] : a[1];
          ex = rel ? x + a[2] : a[2]; ey = rel ? y + a[3] : a[3];
        }
        sampleCubic(cur.pts, x, y, c1x, c1y, c2x, c2y, ex, ey, curveSteps);
        lastC = [c2x, c2y]; lastQ = null; x = ex; y = ey;
      } else if (C === 'Q' || C === 'T') {
        let qx, qy, ex, ey;
        if (C === 'Q') {
          qx = rel ? x + a[0] : a[0]; qy = rel ? y + a[1] : a[1];
          ex = rel ? x + a[2] : a[2]; ey = rel ? y + a[3] : a[3];
        } else {
          qx = lastQ ? 2 * x - lastQ[0] : x; qy = lastQ ? 2 * y - lastQ[1] : y;
          ex = rel ? x + a[0] : a[0]; ey = rel ? y + a[1] : a[1];
        }
        // Raise the quadratic to a cubic rather than write a second sampler.
        sampleCubic(cur.pts, x, y,
          x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey),
          ex, ey, curveSteps);
        lastQ = [qx, qy]; lastC = null; x = ex; y = ey;
      } else if (C === 'A') {
        const ex = rel ? x + a[5] : a[5], ey = rel ? y + a[6] : a[6];
        sampleArc(cur.pts, x, y, a[0], a[1], a[2], !!a[3], !!a[4], ex, ey, curveSteps * 2);
        x = ex; y = ey; lastC = lastQ = null;
      }
    }
  }
  return subs.filter(s => s.pts.length >= 4);
}

/* ── element scanning ─────────────────────────────────────────────────── */

const attrs = tag => {
  const out = {};
  const re = /([:\w-]+)\s*=\s*"([^"]*)"|([:\w-]+)\s*=\s*'([^']*)'/g;
  let g;
  while ((g = re.exec(tag))) out[(g[1] || g[3]).toLowerCase()] = g[2] !== undefined ? g[2] : g[4];
  return out;
};
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

function ellipsePts(cx, cy, rx, ry, steps = 48) {
  const p = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    p.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }
  return p;
}

/* Walk the markup, tracking <g> transforms, and return every shape as a
 * subpath in root user space. */
export function extractSubpaths(svg, curveSteps = 16) {
  const shapes = [];
  const stack = [IDENT.slice()];
  const re = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)([^>]*?)(\/?)\s*>/g;
  let g;

  while ((g = re.exec(svg))) {
    const closing = g[1] === '/';
    const name = g[2].toLowerCase().replace(/^svg:/, '');
    const selfClose = g[4] === '/';
    const raw = g[3] || '';

    if (closing) {
      if ((name === 'g' || name === 'svg') && stack.length > 1) stack.pop();
      continue;
    }

    const a = attrs(raw);
    const local = parseTransform(a.transform);
    const here = mul(stack[stack.length - 1], local);

    if (name === 'g' || name === 'svg') {
      if (!selfClose) stack.push(here);
      continue;
    }
    // Anything invisible should not become a wall.
    if (a.display === 'none' || a.visibility === 'hidden') continue;
    if ((a.fill === 'none' || a.fill === 'transparent') && !a.stroke && name !== 'line' && name !== 'polyline') continue;

    let subs = [];
    if (name === 'path' && a.d) subs = flattenPath(a.d, curveSteps);
    else if (name === 'rect') {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      if (w > 0 && h > 0) subs = [{ pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true }];
    } else if (name === 'circle') {
      const r = num(a.r);
      if (r > 0) subs = [{ pts: ellipsePts(num(a.cx), num(a.cy), r, r), closed: true }];
    } else if (name === 'ellipse') {
      const rx = num(a.rx), ry = num(a.ry);
      if (rx > 0 && ry > 0) subs = [{ pts: ellipsePts(num(a.cx), num(a.cy), rx, ry), closed: true }];
    } else if (name === 'polygon' || name === 'polyline') {
      const p = (a.points || '').match(NUM);
      if (p && p.length >= 6) subs = [{ pts: p.map(Number), closed: name === 'polygon' }];
    } else if (name === 'line') {
      subs = [{ pts: [num(a.x1), num(a.y1), num(a.x2), num(a.y2)], closed: false }];
    }

    for (const s of subs) {
      const pts = new Array(s.pts.length);
      for (let i = 0; i < s.pts.length; i += 2) {
        const [px, py] = apply(here, s.pts[i], s.pts[i + 1]);
        pts[i] = px; pts[i + 1] = py;
      }
      shapes.push({ pts, closed: s.closed, strokeWidth: num(a['stroke-width'], 1) });
    }
  }
  return shapes;
}

/* Drop points that a grid cell could not tell apart. Sub-cell detail costs
 * rasterising time and SDF evaluations for something the solver cannot see. */
function decimate(pts, minStep) {
  if (pts.length <= 6) return pts;
  const out = [pts[0], pts[1]];
  const m2 = minStep * minStep;
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - out[out.length - 2], dy = pts[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= m2) out.push(pts[i], pts[i + 1]);
  }
  return out.length >= 6 ? out : pts;
}

/* Signed area; used to reject degenerate slivers. */
function area2(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(a) / 2;
}

/* Parse an SVG document and fit its geometry into an nx x ny domain.
 *
 * Returns { shapes, width, height, source } in DOMAIN cell coordinates, ready
 * for Shapes.polygonAbs / Shapes.wall. `margin` is the fraction of the domain
 * left clear around the import.
 */
/* Default sizing is a wind-tunnel judgement, not a layout one.
 *
 * Fitting the drawing to the domain with a small margin looks right and is
 * wrong: a shape spanning 70% of the tunnel height blocks it, the walls
 * accelerate the flow past the body, and every coefficient comes out
 * meaningless. Blockage is the binding constraint, so cap the CROSS-STREAM
 * extent at a quarter of the tunnel and the streamwise extent at just under
 * half its length, then take whichever scale is smaller.
 *
 * A circle imported this way lands at ~D = ny/4, which at 128 cells tall is the
 * 32-cell diameter the validation in CONTEXT.md section 3 is quoted at. The
 * import arrives selected, so anyone who wants it bigger can scale it. */
const MAX_STREAMWISE = 0.45;    // of nx
const MAX_BLOCKAGE = 0.25;      // of ny

export function importSVG(text, { nx, ny, curveSteps = 16, minCellStep = 0.4,
                                  maxStreamwise = MAX_STREAMWISE,
                                  maxBlockage = MAX_BLOCKAGE } = {}) {
  if (!text || !/<\s*svg/i.test(text)) throw new Error('That file does not look like an SVG.');

  const shapes = extractSubpaths(text, curveSteps);
  if (!shapes.length) throw new Error('No shapes found. Convert text to outlines and try again.');

  // Fit by the drawing's own extent. A viewBox only describes the canvas, and
  // artwork rarely fills it — fitting to the viewBox usually imports something
  // much smaller than intended.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    for (let i = 0; i < s.pts.length; i += 2) {
      if (s.pts[i] < minX) minX = s.pts[i];
      if (s.pts[i] > maxX) maxX = s.pts[i];
      if (s.pts[i + 1] < minY) minY = s.pts[i + 1];
      if (s.pts[i + 1] > maxY) maxY = s.pts[i + 1];
    }
  }
  const w = maxX - minX, h = maxY - minY;
  if (!(w > 0) && !(h > 0)) throw new Error('The SVG geometry has no extent.');

  const scale = Math.min(nx * maxStreamwise / (w || 1), ny * maxBlockage / (h || 1));
  // Placed a third of the way in, not centred: the interesting part of the
  // result is downstream, and a body in the middle of the tunnel leaves only
  // half the domain for its wake before the outlet sponge starts damping it.
  // Centred across the flow, since that is where the tunnel is uniform.
  //
  // SVG y runs down and so does the grid's j, so no flip is needed — the two
  // conventions agree, which is easy to "fix" into being wrong.
  const ox = nx * 0.35 - (minX + w / 2) * scale;
  const oy = ny / 2 - (minY + h / 2) * scale;

  const out = [];
  for (const s of shapes) {
    const pts = new Array(s.pts.length);
    for (let i = 0; i < s.pts.length; i += 2) {
      pts[i] = s.pts[i] * scale + ox;
      pts[i + 1] = s.pts[i + 1] * scale + oy;
    }
    const thin = decimate(pts, minCellStep);
    if (thin.length < 6) continue;
    if (s.closed && area2(thin) < 1.5) continue;      // smaller than a cell or two
    out.push({ pts: thin, closed: s.closed, thickness: Math.max(1.5, s.strokeWidth * scale) });
  }
  if (!out.length) throw new Error('Everything in that SVG was too small for this grid.');

  return { shapes: out, width: w * scale, height: h * scale, scale };
}
