/* STL → a 2D cross-section you can put in the tunnel.
 *
 * The gap this closes: you can only test what you can get in, and most people's
 * geometry lives in a CAD file, not in a drawing tool. This takes an STL, cuts
 * it with an axis-aligned plane, and hands back closed outlines ready to become
 * scene polygons — which is exactly the workflow of slicing a model to look at
 * a section, just aimed at a 2D solver instead of a printer.
 *
 * Three steps, each of which can fail in its own way and so is tested on its
 * own:
 *
 *   parseSTL      bytes            -> triangles
 *   sliceMesh     triangles, plane -> unordered line segments
 *   stitchLoops   segments         -> ordered closed rings
 *
 * The stitching is the part worth care. A slice produces segments in whatever
 * order the triangles happened to be stored, and a solver needs rings: an
 * outline whose points are in sequence. Endpoints that should coincide rarely
 * match exactly, because they come from interpolating along two different
 * edges, so they are welded on a tolerance derived from the model's own size
 * rather than an absolute epsilon — a 3 mm bracket and a 30 m hull cannot share
 * a fixed one.
 */

/* ── parsing ──────────────────────────────────────────────────────────── */

/* Binary STL: 80-byte header, uint32 count, then 50 bytes per triangle
 * (12 floats + a 2-byte attribute). ASCII STL is a keyword soup.
 *
 * Detection does NOT trust the leading "solid": plenty of binary exporters
 * write that word into the header, which is the classic way STL readers get it
 * wrong. The length arithmetic is decisive, so it is checked first. */
export function parseSTL(input) {
  if (typeof input === 'string') return parseAscii(input);
  const buf = input instanceof ArrayBuffer ? input : input.buffer;
  const view = new DataView(buf);
  if (buf.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (84 + count * 50 === buf.byteLength && count > 0) return parseBinary(view, count);
  }
  const text = new TextDecoder().decode(new Uint8Array(buf));
  if (/^\s*solid/i.test(text) && /facet/i.test(text)) return parseAscii(text);
  throw new Error('Not a readable STL file.');
}

function parseBinary(view, count) {
  const tris = new Float32Array(count * 9);
  let o = 84, k = 0;
  for (let t = 0; t < count; t++) {
    o += 12;                                  // skip the stored normal
    for (let v = 0; v < 9; v++, o += 4) tris[k++] = view.getFloat32(o, true);
    o += 2;                                   // attribute byte count
  }
  return finish(tris, count);
}

function parseAscii(text) {
  const nums = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  if (nums.length < 9) throw new Error('No triangles found in that STL.');
  const count = Math.floor(nums.length / 9);
  return finish(Float32Array.from(nums.slice(0, count * 9)), count);
}

function finish(tris, count) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) throw new Error('That STL has no usable geometry.');
  return { tris, count, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/* ── slicing ──────────────────────────────────────────────────────────── */

/* Cut with the plane axis = position. Returns flat segments [x1,y1,x2,y2,...]
 * in the two coordinates that remain, in the mesh's own units.
 *
 * A triangle lying exactly IN the plane is skipped rather than contributing its
 * three edges. Such a triangle is always accompanied by its neighbours, which
 * cross the plane and produce the same boundary; adding it too would lay a
 * duplicate segment on top and give the stitcher a junction of degree four to
 * misroute at.
 */
export function sliceMesh(mesh, axis, position) {
  const A = axis | 0;                          // 0 = x, 1 = y, 2 = z
  const U = (A + 1) % 3, V = (A + 2) % 3;
  const t = mesh.tris;
  const out = [];
  const d = [0, 0, 0];

  for (let i = 0; i < t.length; i += 9) {
    d[0] = t[i + A] - position;
    d[1] = t[i + 3 + A] - position;
    d[2] = t[i + 6 + A] - position;
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;   // coplanar

    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      const da = d[a], db = d[b];
      if (da === 0) pts.push(t[i + a * 3 + U], t[i + a * 3 + V]);
      // A vertex exactly on the plane is emitted once, by the edge that starts
      // there; emitting it from both edges would duplicate the point.
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const f = da / (da - db);
        pts.push(t[i + a * 3 + U] + (t[i + b * 3 + U] - t[i + a * 3 + U]) * f,
                 t[i + a * 3 + V] + (t[i + b * 3 + V] - t[i + a * 3 + V]) * f);
      }
    }
    if (pts.length >= 4) out.push(pts[0], pts[1], pts[2], pts[3]);
  }
  return out;
}

/* ── stitching ────────────────────────────────────────────────────────── */

/* Order loose segments into rings.
 *
 * Endpoints that ought to be the same point come from interpolating along two
 * different triangle edges and so differ in the last bits. They are welded on a
 * grid whose spacing scales with the model, and each welded node keeps the list
 * of segment ends that landed on it; walking from an unused segment and hopping
 * to whatever else shares its node traces the ring.
 *
 * Open chains are returned too, marked `closed: false`. A watertight mesh gives
 * only closed rings, but real files are often not watertight, and a chain is
 * still useful as a wall — dropping it silently would lose geometry the user
 * can see in the preview.
 */
export function stitchLoops(seg, tol) {
  const n = seg.length / 4;
  if (!n) return [];
  if (!(tol > 0)) tol = 1e-6;
  const inv = 1 / tol;
  const key = (x, y) => `${Math.round(x * inv)},${Math.round(y * inv)}`;

  // node key -> list of (segment index * 2 + end)
  const nodes = new Map();
  const add = (k, ref) => {
    const list = nodes.get(k);
    if (list) list.push(ref); else nodes.set(k, [ref]);
  };
  const keys = new Array(n * 2);
  for (let s = 0; s < n; s++) {
    const k0 = key(seg[s * 4], seg[s * 4 + 1]);
    const k1 = key(seg[s * 4 + 2], seg[s * 4 + 3]);
    keys[s * 2] = k0; keys[s * 2 + 1] = k1;
    add(k0, s * 2); add(k1, s * 2 + 1);
  }

  const used = new Uint8Array(n);
  const loops = [];

  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const pts = [seg[s0 * 4], seg[s0 * 4 + 1], seg[s0 * 4 + 2], seg[s0 * 4 + 3]];
    const startKey = keys[s0 * 2];
    let endKey = keys[s0 * 2 + 1];
    let closed = false;

    // Walk forward until the ring closes or the chain runs out.
    for (;;) {
      if (endKey === startKey) { closed = true; break; }
      const cand = nodes.get(endKey);
      let next = -1;
      if (cand) {
        for (const ref of cand) {
          const si = ref >> 1;
          if (!used[si]) { next = ref; break; }
        }
      }
      if (next < 0) break;
      const si = next >> 1, atEnd = next & 1;
      used[si] = 1;
      // Append the segment's OTHER end, so the chain keeps its direction.
      const ox = atEnd ? seg[si * 4] : seg[si * 4 + 2];
      const oy = atEnd ? seg[si * 4 + 1] : seg[si * 4 + 3];
      pts.push(ox, oy);
      endKey = keys[si * 2 + (atEnd ? 0 : 1)];
    }
    if (pts.length >= 6) loops.push({ pts, closed });
  }
  return loops;
}

/* ── orientation ──────────────────────────────────────────────────────── */

/* Flip and quarter-turn a section before it is fitted.
 *
 * Which way a slice comes out is not a free choice: cutting across X leaves
 * (Y,Z), across Y leaves (Z,X), across Z leaves (X,Y), and those pairs do not
 * all have the same handedness. So a wing sliced on one axis faces into the
 * flow and on another faces away, through no fault of the model. Rather than
 * guess an orientation per axis — which would be wrong for half of all models,
 * since nothing says which way a given file considers "forward" — the section
 * is shown and the user turns it to suit.
 *
 * Applied BEFORE fitting, so a quarter turn swaps the extents that the blockage
 * cap is computed from. Doing it afterwards would size the section by its old
 * bounding box and then rotate it out of the tunnel.
 */
export function orientPoints(pts, { flipX = false, flipY = false, turns = 0 } = {}) {
  const t = ((turns % 4) + 4) % 4;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    let x = pts[i], y = pts[i + 1];
    if (flipX) x = -x;
    if (flipY) y = -y;
    // Screen y runs down, so (x,y) -> (-y,x) is a quarter turn clockwise.
    for (let k = 0; k < t; k++) { const nx = -y; y = x; x = nx; }
    out[i] = x; out[i + 1] = y;
  }
  return out;
}

/* Which model axes survive a cut, for labelling the preview. */
export function planeAxes(axis) {
  const N = ['X', 'Y', 'Z'];
  const A = axis | 0;
  return { across: N[(A + 1) % 3], up: N[(A + 2) % 3], cut: N[A] };
}

/* Slice, stitch and orient — everything before the fit.
 *
 * Shared so the dialog's preview and the object it finally adds cannot come
 * from different code and disagree, which is the classic way a preview lies. */
export function sliceLoops(mesh, axis, position, orient = null) {
  const seg = sliceMesh(mesh, axis | 0, position);
  if (!seg.length) throw new Error('That plane misses the model — move the slice.');
  // Weld tolerance from the model's own scale, not an absolute epsilon.
  const span = Math.max(mesh.size[0], mesh.size[1], mesh.size[2]) || 1;
  const loops = stitchLoops(seg, span * 1e-5);
  if (!orient) return loops;
  return loops.map(l => ({ pts: orientPoints(l.pts, orient), closed: l.closed }));
}

/* ── the whole job ────────────────────────────────────────────────────── */

/* Slice a mesh and fit the result into an nx x ny domain.
 *
 * Sizing follows the same blockage reasoning as the SVG import: capped at a
 * quarter of the tunnel height and just under half its length, placed a third
 * of the way in. A section that fills the tunnel accelerates the flow past
 * itself and every coefficient it produces is meaningless.
 */
export function sliceToScene(mesh, { axis = 2, position = null, nx, ny,
                                     orient = null,
                                     maxStreamwise = 0.45, maxBlockage = 0.25,
                                     minCellStep = 0.4 } = {}) {
  const A = axis | 0;
  const pos = position === null ? (mesh.min[A] + mesh.max[A]) / 2 : position;
  const loops = sliceLoops(mesh, A, pos, orient);
  if (!loops.length) throw new Error('The slice produced no usable outline.');

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) {
    for (let i = 0; i < l.pts.length; i += 2) {
      if (l.pts[i] < minX) minX = l.pts[i];
      if (l.pts[i] > maxX) maxX = l.pts[i];
      if (l.pts[i + 1] < minY) minY = l.pts[i + 1];
      if (l.pts[i + 1] > maxY) maxY = l.pts[i + 1];
    }
  }
  const w = maxX - minX, h = maxY - minY;
  const scale = Math.min(nx * maxStreamwise / (w || 1), ny * maxBlockage / (h || 1));
  const ox = nx * 0.35 - (minX + w / 2) * scale;
  const oy = ny / 2 - (minY + h / 2) * scale;

  const out = [];
  for (const l of loops) {
    const pts = [];
    let lx = NaN, ly = NaN;
    for (let i = 0; i < l.pts.length; i += 2) {
      const X = l.pts[i] * scale + ox, Y = l.pts[i + 1] * scale + oy;
      // Drop points a grid cell could not tell apart; sub-cell detail costs
      // SDF evaluations for something the solver cannot see.
      if (Number.isFinite(lx) && Math.hypot(X - lx, Y - ly) < minCellStep) continue;
      pts.push(X, Y); lx = X; ly = Y;
    }
    if (pts.length < 6) continue;
    out.push({ pts, closed: l.closed, area: Math.abs(area2(pts)) });
  }
  if (!out.length) throw new Error('The slice is too small for this grid.');
  // Largest ring first, so the outer boundary leads and the outliner reads
  // sensibly when a section has several parts.
  out.sort((a, b) => b.area - a.area);
  return { shapes: out, position: pos, axis: A, scale };
}

function area2(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return s / 2;
}

export const AXES = [
  { value: '0', label: 'X  (slice across width)' },
  { value: '1', label: 'Y  (slice across depth)' },
  { value: '2', label: 'Z  (slice across height)' },
];
