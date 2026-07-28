/* Shape maths for the scene editor.
 *
 * Every primitive is defined by a SIGNED DISTANCE FUNCTION in its own object
 * space: negative inside, zero on the surface, positive outside, in grid cells.
 *
 * One function then serves three jobs that would otherwise each need their own
 * code and could disagree with each other:
 *   - hit testing            sdf(p) <= 0
 *   - rasterising            sdf(p) <= 0 per cell
 *   - anti-aliased coverage  smoothstep across the surface (planned item 15)
 *
 * Coordinates are grid cells throughout, with j increasing DOWNWARD to match
 * the field arrays and the canvas. Rotation is in degrees and positive
 * rotation lifts the leading edge of a shape lying along +x, so an aerofoil's
 * angle of attack maps straight onto it.
 */

export const SHAPE_TYPES = ['rect', 'ellipse', 'polygon', 'polyline', 'naca'];

const DEG = Math.PI / 180;

export function makeTransform(x = 0, y = 0, rot = 0, sx = 1, sy = 1) {
  return { x, y, rot, sx, sy };
}

/* World point -> object space. */
export function toLocal(t, x, y) {
  const dx = x - t.x, dy = y - t.y;
  const a = -t.rot * DEG;
  const c = Math.cos(a), s = Math.sin(a);
  return [(dx * c - dy * s) / (t.sx || 1), (dx * s + dy * c) / (t.sy || 1)];
}

/* Object point -> world. */
export function toWorld(t, x, y) {
  const px = x * (t.sx || 1), py = y * (t.sy || 1);
  const a = t.rot * DEG;
  const c = Math.cos(a), s = Math.sin(a);
  return [t.x + px * c - py * s, t.y + px * s + py * c];
}

/* ── primitive distance functions, object space, centred on the origin ── */

function sdRoundRect(px, py, hw, hh, r) {
  r = Math.min(r, hw, hh);
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/* Well-behaved ellipse approximation. The exact distance needs an iterative
 * root find, which is not worth it when the result is consumed at cell
 * resolution. */
function sdEllipse(px, py, rx, ry) {
  rx = Math.max(rx, 1e-6); ry = Math.max(ry, 1e-6);
  const k1 = Math.hypot(px / rx, py / ry);
  if (k1 < 1e-9) return -Math.min(rx, ry);
  const k2 = Math.hypot(px / (rx * rx), py / (ry * ry));
  if (k2 < 1e-12) return k1 - 1;
  return (k1 - 1) * k1 / k2;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 1e-12 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/* Distance to a closed polygon, negative inside. pts is a flat [x0,y0,x1,y1,…]. */
function sdPolygon(px, py, pts) {
  const n = pts.length >> 1;
  if (n < 3) return 1e9;
  let d = Infinity, inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1];
    const xj = pts[j * 2], yj = pts[j * 2 + 1];
    const seg = sdSegment(px, py, xj, yj, xi, yi);
    if (seg < d) d = seg;
    // Ray crossing test, ray along +x.
    if ((yi > py) !== (yj > py)) {
      const xInt = xi + ((py - yi) / (yj - yi)) * (xj - xi);
      if (px < xInt) inside = !inside;
    }
  }
  return inside ? -d : d;
}

function sdPolyline(px, py, pts, half) {
  const n = pts.length >> 1;
  if (n < 2) return n === 1 ? Math.hypot(px - pts[0], py - pts[1]) - half : 1e9;
  let d = Infinity;
  for (let i = 1; i < n; i++) {
    const seg = sdSegment(px, py, pts[(i - 1) * 2], pts[(i - 1) * 2 + 1], pts[i * 2], pts[i * 2 + 1]);
    if (seg < d) d = seg;
  }
  return d - half;
}

/* ── NACA 4-digit outline, generated once into a polygon ────────────────
 * Built in aerodynamic axes (y up) and flipped on output, because grid j runs
 * downward. Skipping the flip mirrors the camber line and the section then
 * generates lift the wrong way. */
export function nacaOutline(chord, m, p, thick, samples = 96) {
  const upper = [], lower = [];
  for (let k = 0; k <= samples; k++) {
    const xc = k / samples;
    const yt = 5 * thick * (0.2969 * Math.sqrt(xc) - 0.1260 * xc - 0.3516 * xc * xc
      + 0.2843 * xc * xc * xc - 0.1015 * xc * xc * xc * xc);
    let yc = 0, dyc = 0;
    if (m > 0 && p > 0) {
      if (xc <= p) { yc = (m / (p * p)) * (2 * p * xc - xc * xc); dyc = (2 * m / (p * p)) * (p - xc); }
      else { const q = 1 - p; yc = (m / (q * q)) * ((1 - 2 * p) + 2 * p * xc - xc * xc); dyc = (2 * m / (q * q)) * (p - xc); }
    }
    const th = Math.atan(dyc);
    const ct = Math.cos(th), st = Math.sin(th);
    const x = (xc - 0.5) * chord;
    upper.push(x - yt * st * chord, -(yc + yt * ct) * chord);
    lower.push(x + yt * st * chord, -(yc - yt * ct) * chord);
  }
  const pts = upper.slice();
  for (let k = lower.length - 2; k >= 0; k -= 2) pts.push(lower[k], lower[k + 1]);
  return pts;
}

/* ── dispatch ──────────────────────────────────────────────────────────── */

/* Signed distance from a world point to an object, in cells. */
export function sdf(obj, wx, wy) {
  const t = obj.transform;
  const [x, y] = toLocal(t, wx, wy);
  const P = obj.params;
  let d;
  switch (obj.type) {
    case 'rect': d = sdRoundRect(x, y, P.w * 0.5, P.h * 0.5, P.radius || 0); break;
    case 'ellipse': d = sdEllipse(x, y, P.rx, P.ry); break;
    case 'polygon': d = sdPolygon(x, y, P.points); break;
    case 'polyline': d = sdPolyline(x, y, P.points, (P.thickness || 2) * 0.5); break;
    case 'naca': d = sdPolygon(x, y, obj._outline || (obj._outline = nacaOutline(P.chord, P.camber, P.camberPos, P.thickness))); break;
    case 'sketch': {
      // Freehand paint layer: a domain-aligned bitmap, so there is no analytic
      // surface to measure a distance to. Returning +/- half a cell is enough
      // for hit testing and rasterising, which are the only consumers.
      const i = Math.round(x) - 1, j = Math.round(y) - 1;
      if (i < 0 || j < 0 || i >= P.w || j >= P.h) return 1e9;
      return P.data[i + j * P.w] ? -0.5 : 0.5;
    }
    default: return 1e9;
  }
  // Non-uniform scale makes the distance inexact; the smaller axis is the
  // conservative choice and keeps the sign correct, which is what matters.
  return d * Math.min(Math.abs(t.sx) || 1, Math.abs(t.sy) || 1);
}

export function contains(obj, wx, wy) { return sdf(obj, wx, wy) <= 0; }

/* Axis-aligned world bounds — TIGHT, no padding.
 *
 * Padding belongs to the rasteriser, which needs a safety margin. Baking it in
 * here leaks a cell of slack into everything else that asks for bounds: the
 * selection gizmo draws oversized and edge snapping aligns to a box that is
 * not where the object actually is. */
export function bounds(obj) {
  const P = obj.params;
  let hw, hh;
  switch (obj.type) {
    case 'sketch': return { minX: 1, minY: 1, maxX: P.w, maxY: P.h };
    case 'rect': hw = P.w * 0.5; hh = P.h * 0.5; break;
    case 'ellipse': hw = P.rx; hh = P.ry; break;
    case 'polygon': case 'naca': {
      const pts = obj.type === 'naca'
        ? (obj._outline || (obj._outline = nacaOutline(P.chord, P.camber, P.camberPos, P.thickness)))
        : P.points;
      let mx = 0, my = 0;
      for (let i = 0; i < pts.length; i += 2) {
        mx = Math.max(mx, Math.abs(pts[i]));
        my = Math.max(my, Math.abs(pts[i + 1]));
      }
      hw = mx; hh = my; break;
    }
    case 'polyline': {
      const pts = P.points;
      let mx = 0, my = 0;
      for (let i = 0; i < pts.length; i += 2) {
        mx = Math.max(mx, Math.abs(pts[i]));
        my = Math.max(my, Math.abs(pts[i + 1]));
      }
      const h = (P.thickness || 2) * 0.5;
      hw = mx + h; hh = my + h; break;
    }
    default: hw = hh = 0;
  }
  const t = obj.transform;
  const a = Math.abs(t.rot * DEG);
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const sw = hw * Math.abs(t.sx || 1), sh = hh * Math.abs(t.sy || 1);
  const ex = sw * c + sh * s;
  const ey = sw * s + sh * c;
  return { minX: t.x - ex, maxX: t.x + ex, minY: t.y - ey, maxY: t.y + ey };
}

/* Outline in world space, for selection highlights and gizmos. */
export function outlineWorld(obj, steps = 64) {
  const P = obj.params, t = obj.transform;
  let pts;
  switch (obj.type) {
    // A paint layer spans the whole domain; drawing a box round it would just
    // trace the viewport border and tell the user nothing.
    case 'sketch': return [];
    case 'rect': {
      const hw = P.w * 0.5, hh = P.h * 0.5;
      pts = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
      break;
    }
    case 'ellipse': {
      pts = [];
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        pts.push(Math.cos(a) * P.rx, Math.sin(a) * P.ry);
      }
      break;
    }
    case 'naca':
      pts = obj._outline || (obj._outline = nacaOutline(P.chord, P.camber, P.camberPos, P.thickness));
      break;
    default:
      pts = P.points || [];
  }
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const [wx, wy] = toWorld(t, pts[i], pts[i + 1]);
    out[i] = wx; out[i + 1] = wy;
  }
  return out;
}
