/* Object transforms and the selection gizmo.
 *
 * Operations act on the transform, not on the underlying geometry, so a shape
 * stays parametric: an ellipse scaled and rotated is still an ellipse with
 * known radii, not a baked outline. Numeric editing and re-export depend on
 * that staying true.
 *
 * Mirroring is the exception worth noting: a negative scale factor is the only
 * representation that survives round-tripping through the transform, so mirror
 * flips the sign of sx or sy rather than reversing point lists.
 */

import { toLocal, toWorld, bounds } from './geometry.js';

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot'];

export function move(obj, dx, dy) {
  obj.transform.x += dx;
  obj.transform.y += dy;
}

export function moveTo(obj, x, y) {
  obj.transform.x = x;
  obj.transform.y = y;
}

export function rotate(obj, deg) { obj.transform.rot += deg; }
export function rotateTo(obj, deg) { obj.transform.rot = deg; }

export function scale(obj, fx, fy) {
  obj.transform.sx *= fx;
  obj.transform.sy *= fy;
}

export function mirror(obj, axis) {
  if (axis === 'h') obj.transform.sx *= -1;
  else obj.transform.sy *= -1;
}

/* Rotate an object about an arbitrary world pivot, keeping its own spin
 * consistent — used when rotating a multi-object selection. */
export function rotateAbout(obj, deg, px, py) {
  const a = deg * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = obj.transform.x - px, dy = obj.transform.y - py;
  obj.transform.x = px + dx * c - dy * s;
  obj.transform.y = py + dx * s + dy * c;
  obj.transform.rot += deg;
}

export function scaleAbout(obj, fx, fy, px, py) {
  obj.transform.x = px + (obj.transform.x - px) * fx;
  obj.transform.y = py + (obj.transform.y - py) * fy;
  obj.transform.sx *= fx;
  obj.transform.sy *= fy;
}

/* Human-facing size in cells, derived from parameters and scale. Numeric
 * fields read and write through here so the two stay consistent. */
export function measure(obj) {
  const P = obj.params, t = obj.transform;
  const sx = Math.abs(t.sx), sy = Math.abs(t.sy);
  switch (obj.type) {
    case 'rect': return { w: P.w * sx, h: P.h * sy };
    case 'ellipse': return { w: P.rx * 2 * sx, h: P.ry * 2 * sy };
    case 'naca': return { w: P.chord * sx, h: P.chord * P.thickness * sy };
    default: {
      const b = bounds(obj);
      return { w: b.maxX - b.minX - 2, h: b.maxY - b.minY - 2 };
    }
  }
}

export function resizeTo(obj, w, h) {
  const P = obj.params, t = obj.transform;
  const sgnX = Math.sign(t.sx) || 1, sgnY = Math.sign(t.sy) || 1;
  switch (obj.type) {
    case 'rect': t.sx = sgnX * (w / P.w); t.sy = sgnY * (h / P.h); break;
    case 'ellipse': t.sx = sgnX * (w / (P.rx * 2)); t.sy = sgnY * (h / (P.ry * 2)); break;
    case 'naca': t.sx = sgnX * (w / P.chord); t.sy = sgnY * (h / (P.chord * P.thickness)); break;
    default: {
      const m = measure(obj);
      if (m.w > 1e-6) t.sx = sgnX * Math.abs(t.sx) * (w / m.w);
      if (m.h > 1e-6) t.sy = sgnY * Math.abs(t.sy) * (h / m.h);
    }
  }
}

/* ── gizmo ──────────────────────────────────────────────────────────────
 * Handle positions are given in world (grid) space; the caller scales them to
 * pixels. The rotate handle sits outside the top edge by a fixed pixel-ish
 * offset expressed in cells by the caller. */
export function gizmoHandles(box, rotOffset = 6) {
  if (!box) return [];
  const { minX, minY, maxX, maxY } = box;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return [
    { id: 'nw', x: minX, y: minY }, { id: 'n', x: cx, y: minY }, { id: 'ne', x: maxX, y: minY },
    { id: 'e', x: maxX, y: cy }, { id: 'se', x: maxX, y: maxY }, { id: 's', x: cx, y: maxY },
    { id: 'sw', x: minX, y: maxY }, { id: 'w', x: minX, y: cy },
    { id: 'rot', x: cx, y: minY - rotOffset },
  ];
}

export function hitHandle(box, x, y, tol = 3, rotOffset = 6) {
  let best = null, bestD = tol;
  for (const h of gizmoHandles(box, rotOffset)) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < bestD) { bestD = d; best = h.id; }
  }
  return best;
}

/* Scale factors for dragging a handle, with the opposite corner as pivot. */
export function handleDrag(box, handle, x, y, opts = {}) {
  const { minX, minY, maxX, maxY } = box;
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
  const west = handle.includes('w'), east = handle.includes('e');
  const north = handle.includes('n') && handle !== 'rot', south = handle.includes('s');

  const pivotX = east ? minX : west ? maxX : (minX + maxX) / 2;
  const pivotY = south ? minY : north ? maxY : (minY + maxY) / 2;

  let fx = 1, fy = 1;
  if (east) fx = (x - pivotX) / w;
  else if (west) fx = (pivotX - x) / w;
  if (south) fy = (y - pivotY) / h;
  else if (north) fy = (pivotY - y) / h;

  if (opts.uniform && east !== west && south !== north) {
    const f = Math.max(Math.abs(fx), Math.abs(fy));
    fx = Math.sign(fx) * f; fy = Math.sign(fy) * f;
  }
  // Guard the degenerate drag through the pivot, which would collapse the
  // object to zero size and make it unrecoverable by dragging back.
  const MIN = 0.02;
  if (Math.abs(fx) < MIN) fx = Math.sign(fx || 1) * MIN;
  if (Math.abs(fy) < MIN) fy = Math.sign(fy || 1) * MIN;
  return { fx, fy, pivotX, pivotY };
}

/* ── snapping ───────────────────────────────────────────────────────────── */

export function snapValue(v, step) {
  return step > 0 ? Math.round(v / step) * step : v;
}

export function snapPoint(x, y, step) {
  return [snapValue(x, step), snapValue(y, step)];
}

/* Snap a moving box's edges to other objects' edges within a tolerance. */
export function snapToEdges(box, others, tol = 1.5) {
  let dx = 0, dy = 0, bestX = tol, bestY = tol;
  const xs = [box.minX, (box.minX + box.maxX) / 2, box.maxX];
  const ys = [box.minY, (box.minY + box.maxY) / 2, box.maxY];
  for (const o of others) {
    const b = bounds(o);
    const ox = [b.minX, (b.minX + b.maxX) / 2, b.maxX];
    const oy = [b.minY, (b.minY + b.maxY) / 2, b.maxY];
    for (const a of xs) for (const c of ox) {
      const d = c - a;
      if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; }
    }
    for (const a of ys) for (const c of oy) {
      const d = c - a;
      if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; }
    }
  }
  return { dx, dy };
}

export { toLocal, toWorld, bounds };
