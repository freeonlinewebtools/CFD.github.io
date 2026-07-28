/* Draggable pane dividers.
 *
 * Writes a CSS custom property rather than inline width/height so the layout
 * stays declared in one place — the grid template reads the variable and the
 * responsive breakpoint can override it without fighting inline styles.
 *
 * Sizes persist per-key in localStorage; a layout the user has adjusted should
 * survive a reload.
 */

const STORE = 'cfd.layout.v1';

function readSizes() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; }
}
function writeSizes(map) {
  try { localStorage.setItem(STORE, JSON.stringify(map)); } catch {}
}

export function makeSplitter(handle, opts) {
  const {
    key, axis = 'x', target = document.documentElement, varName,
    min = 120, max = 720, invert = false, onResize = () => {},
  } = opts;

  const sizes = readSizes();
  let size = Number.isFinite(sizes[key]) ? sizes[key] : opts.initial;
  const clamp = v => Math.min(max, Math.max(min, v));

  const apply = (v, persist) => {
    size = clamp(v);
    target.style.setProperty(varName, `${Math.round(size)}px`);
    if (persist) { const m = readSizes(); m[key] = size; writeSizes(m); }
    onResize(size);
  };
  apply(size, false);

  let dragging = false, startPos = 0, startSize = 0;

  handle.addEventListener('pointerdown', e => {
    dragging = true;
    startPos = axis === 'x' ? e.clientX : e.clientY;
    startSize = size;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-drag');
    document.body.classList.add('is-resizing');
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const now = axis === 'x' ? e.clientX : e.clientY;
    const d = (now - startPos) * (invert ? -1 : 1);
    apply(startSize + d, false);
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('is-drag');
    document.body.classList.remove('is-resizing');
    apply(size, true);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  // Double-click resets to the default, which is the usual escape hatch when a
  // pane has been dragged somewhere useless.
  handle.addEventListener('dblclick', () => apply(opts.initial, true));

  return { get: () => size, set: v => apply(v, true), reset: () => apply(opts.initial, true) };
}
