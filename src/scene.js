/* The scene document.
 *
 * Geometry lives here as editable vector objects; the solver's cell masks are
 * DERIVED from it by the rasteriser and are never edited directly. That split
 * is what makes selection, numeric editing, undo, save/load and SVG import
 * possible at all — a painted Uint8Array has no notion of "the third
 * building", so none of those operations can be expressed against it.
 *
 * An object carries geometry AND a boundary role. A rectangle is not
 * intrinsically a wall: the same shape can be a no-slip obstacle, a velocity
 * inlet or a porous region, and only the role decides how the solver treats
 * its cells.
 */

import { makeTransform, bounds, contains, sdf, outlineWorld } from './geometry.js';

/* Boundary roles. `solid` marks the ones that occupy cells as an obstacle;
 * the rest modify the flow without blocking it. */
export const BOUNDARIES = {
  noslip:   { label: 'no-slip wall',   solid: true,  code: 1 },
  slip:     { label: 'slip wall',      solid: true,  code: 2 },
  moving:   { label: 'moving wall',    solid: true,  code: 3 },
  rotating: { label: 'rotating',       solid: true,  code: 4 },
  porous:   { label: 'porous region',  solid: false, code: 5 },
  inlet:    { label: 'velocity inlet', solid: false, code: 6 },
  outlet:   { label: 'pressure outlet',solid: false, code: 7 },
  symmetry: { label: 'symmetry',       solid: false, code: 8 },
};
export const BOUNDARY_KEYS = Object.keys(BOUNDARIES);

const DEFAULT_BC_PARAMS = {
  noslip: {},
  slip: {},
  moving: { speed: 1, direction: 0 },       // multiples of reference speed, degrees
  rotating: { omega: 1 },                   // rad per unit time, + is clockwise on screen
  porous: { resistance: 0.5 },              // 0 open, 1 nearly solid
  inlet: { speed: 1, direction: 0 },
  outlet: { pressure: 0 },
  symmetry: {},
};

let nextId = 1;
export function resetIds(n = 1) { nextId = n; }

export function makeObject(type, params, opts = {}) {
  const boundary = opts.boundary || 'noslip';
  return {
    id: opts.id || `o${nextId++}`,
    name: opts.name || defaultName(type),
    type,
    params,
    transform: opts.transform || makeTransform(0, 0, 0, 1, 1),
    boundary,
    bcParams: { ...DEFAULT_BC_PARAMS[boundary], ...(opts.bcParams || {}) },
    visible: opts.visible !== false,
    locked: !!opts.locked,
  };
}

function defaultName(type) {
  return { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', polyline: 'Wall', naca: 'Aerofoil' }[type] || 'Object';
}

/* ── convenience constructors ───────────────────────────────────────────── */

export const Shapes = {
  rect(x, y, w, h, opts = {}) {
    return makeObject('rect', { w, h, radius: opts.radius || 0 },
      { ...opts, transform: makeTransform(x, y, opts.rot || 0) });
  },
  circle(x, y, r, opts = {}) {
    return makeObject('ellipse', { rx: r, ry: r }, { ...opts, transform: makeTransform(x, y, opts.rot || 0) });
  },
  ellipse(x, y, rx, ry, opts = {}) {
    return makeObject('ellipse', { rx, ry }, { ...opts, transform: makeTransform(x, y, opts.rot || 0) });
  },
  polygon(x, y, points, opts = {}) {
    return makeObject('polygon', { points: Array.from(points) },
      { ...opts, transform: makeTransform(x, y, opts.rot || 0) });
  },
  wall(x, y, points, thickness, opts = {}) {
    return makeObject('polyline', { points: Array.from(points), thickness },
      { ...opts, transform: makeTransform(x, y, opts.rot || 0) });
  },
  /* aoa maps directly onto rotation: positive rotation lifts the leading edge
   * of a section lying along +x. */
  naca(x, y, chord, { camber = 0, camberPos = 0.4, thickness = 0.12, aoa = 0 } = {}, opts = {}) {
    return makeObject('naca', { chord, camber, camberPos, thickness },
      { ...opts, name: opts.name || 'Aerofoil', transform: makeTransform(x, y, aoa) });
  },
  /* Polygon given in WORLD coordinates. Re-centred on its own centroid so the
   * transform origin sits inside the shape — otherwise rotation swings it
   * around the domain corner, which is never what anyone means. */
  polygonAbs(points, opts = {}) {
    let cx = 0, cy = 0;
    const n = points.length / 2;
    for (let i = 0; i < points.length; i += 2) { cx += points[i]; cy += points[i + 1]; }
    cx /= n; cy /= n;
    const rel = new Array(points.length);
    for (let i = 0; i < points.length; i += 2) { rel[i] = points[i] - cx; rel[i + 1] = points[i + 1] - cy; }
    return makeObject('polygon', { points: rel }, { ...opts, transform: makeTransform(cx, cy, opts.rot || 0) });
  },
  /* Freehand paint layer covering the whole domain. Not transformable: a
   * bitmap has no parametric form to rotate, and baking a rotation into it
   * would destroy what the user painted. */
  sketch(nx, ny, opts = {}) {
    return makeObject('sketch', { w: nx, h: ny, data: new Uint8Array(nx * ny) },
      { ...opts, name: opts.name || 'Sketch', transform: makeTransform(0, 0, 0, 1, 1) });
  },
};

/* Single deserialiser for object arrays, shared by Scene.fromJSON and the undo
 * history. Two copies of this would drift, and the one that forgot to unpack a
 * sketch bitmap would silently restore an empty paint layer on undo. */
export function objectsFromJSON(data) {
  const out = [];
  let maxId = 0;
  for (const o of data?.objects || []) {
    out.push({
      id: o.id, name: o.name, type: o.type,
      params: o.type === 'sketch'
        ? { w: o.params.w, h: o.params.h, data: unpackBits(o.params.bits || '', o.params.w * o.params.h) }
        : structuredClone(o.params),
      transform: { ...o.transform },
      boundary: o.boundary in BOUNDARIES ? o.boundary : 'noslip',
      bcParams: { ...(DEFAULT_BC_PARAMS[o.boundary] || {}), ...(o.bcParams || {}) },
      visible: o.visible !== false, locked: !!o.locked,
    });
    const n = parseInt(String(o.id).replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > maxId) maxId = n;
  }
  resetIds(maxId + 1);
  return out;
}

/* Sketch bitmaps serialise as base64 rather than a JSON number array, which
 * for a 256x128 layer is ~44 kB instead of ~90 kB of "0,0,0,…". */
function packBits(data) {
  const bytes = new Uint8Array(Math.ceil(data.length / 8));
  for (let i = 0; i < data.length; i++) if (data[i]) bytes[i >> 3] |= 128 >> (i & 7);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unpackBits(b64, len) {
  const out = new Uint8Array(len);
  try {
    const s = atob(b64);
    for (let i = 0; i < len; i++) {
      const byte = s.charCodeAt(i >> 3);
      if (byte & (128 >> (i & 7))) out[i] = 1;
    }
  } catch { /* corrupt layer: leave it empty rather than refusing the file */ }
  return out;
}

/* ── the document ───────────────────────────────────────────────────────── */

export class Scene {
  constructor(nx = 256, ny = 128) {
    this.nx = nx;
    this.ny = ny;
    this.objects = [];
    this.selection = new Set();
    this.revision = 0;
  }

  add(obj, index = -1) {
    if (index < 0 || index >= this.objects.length) this.objects.push(obj);
    else this.objects.splice(index, 0, obj);
    this.revision++;
    return obj;
  }

  remove(id) {
    const i = this.objects.findIndex(o => o.id === id);
    if (i < 0) return null;
    const [obj] = this.objects.splice(i, 1);
    this.selection.delete(id);
    this.revision++;
    return obj;
  }

  get(id) { return this.objects.find(o => o.id === id) || null; }

  clear() {
    this.objects.length = 0;
    this.selection.clear();
    this.revision++;
  }

  /* Reorder for the outliner. Later entries rasterise last, so they win where
   * objects overlap. */
  reorder(id, toIndex) {
    const from = this.objects.findIndex(o => o.id === id);
    if (from < 0) return;
    const [obj] = this.objects.splice(from, 1);
    this.objects.splice(Math.max(0, Math.min(toIndex, this.objects.length)), 0, obj);
    this.revision++;
  }

  duplicate(id, offset = 4) {
    const src = this.get(id);
    if (!src) return null;
    const copy = structuredClone({ ...src, _outline: undefined });
    copy.id = `o${nextId++}`;
    copy.name = `${src.name} copy`;
    copy.transform = { ...src.transform, x: src.transform.x + offset, y: src.transform.y + offset };
    delete copy._outline;
    return this.add(copy);
  }

  /* Topmost visible, unlocked object under a point. Iterating backwards makes
   * the object drawn last the one you pick, matching what is on screen. */
  pick(x, y) {
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const o = this.objects[i];
      if (!o.visible || o.locked) continue;
      if (contains(o, x, y)) return o;
    }
    return null;
  }

  pickAll(x, y) {
    return this.objects.filter(o => o.visible && !o.locked && contains(o, x, y));
  }

  select(id, additive = false) {
    if (!additive) this.selection.clear();
    if (id) this.selection.add(id);
  }

  selected() { return this.objects.filter(o => this.selection.has(o.id)); }

  /* World-space bounds of a selection, for gizmos. */
  selectionBounds() {
    const sel = this.selected();
    if (!sel.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of sel) {
      const b = bounds(o);
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
    }
    return { minX, minY, maxX, maxY };
  }

  outline(id) {
    const o = this.get(id);
    return o ? outlineWorld(o) : null;
  }

  distanceTo(id, x, y) {
    const o = this.get(id);
    return o ? sdf(o, x, y) : Infinity;
  }

  /* ── serialisation ─────────────────────────────────────────────────────
   * _outline is a derived cache and must never be written out, or a saved
   * file would pin geometry that its own parameters no longer produce. */
  toJSON() {
    return {
      version: 1,
      domain: { nx: this.nx, ny: this.ny },
      objects: this.objects.map(o => ({
        id: o.id, name: o.name, type: o.type,
        params: o.type === 'sketch'
          ? { w: o.params.w, h: o.params.h, bits: packBits(o.params.data) }
          : structuredClone(o.params),
        transform: { ...o.transform },
        boundary: o.boundary,
        bcParams: { ...o.bcParams },
        visible: o.visible, locked: o.locked,
      })),
    };
  }

  static fromJSON(data) {
    const s = new Scene(data?.domain?.nx || 256, data?.domain?.ny || 128);
    for (const o of objectsFromJSON(data)) s.objects.push(o);
    s.revision++;
    return s;
  }

  clone() { return Scene.fromJSON(this.toJSON()); }
}
