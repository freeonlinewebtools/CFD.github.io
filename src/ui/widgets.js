/* Blender-style widgets.
 *
 * The defining one is the number field: label on the left, value on the right,
 * drag horizontally to scrub, click to type, arrows to step. It replaces the
 * label + slider + separate readout stack, which costs three rows of height
 * per parameter and still cannot be typed into.
 *
 * Every widget returns a handle with `set(value, silent)` so the app can push
 * state in without re-entering its own change handlers.
 */

import { icon } from './icons.js';

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let uid = 0;
const nextId = () => `w${++uid}`;

/* ── number field ───────────────────────────────────────────────────────── */

export function numberField(parent, opts) {
  const {
    label, value = 0, min = -Infinity, max = Infinity, step = 0.01,
    precision = 3, unit = '', hint = '', log = false, onChange = () => {},
  } = opts;

  const row = el('div', 'nf');
  if (hint) row.title = hint;
  /* A bounded field shows how far along its range the value sits.
   *
   * Without it these read as static rows and give no sense of scale — you
   * cannot tell whether a viscosity of 0.006 is near the bottom of its range or
   * the top without dragging to find out. Only bounded fields get a fill;
   * unbounded scrub fields have no proportion to show, and inventing one would
   * be a lie about the range. */
  const bounded = Number.isFinite(min) && Number.isFinite(max) && max > min;
  const fill = bounded ? el('span', 'nf-f') : null;
  if (bounded) row.append(fill);
  const name = el('span', 'nf-l', label);
  const val = el('span', 'nf-v');
  const input = el('input', 'nf-i');
  input.type = 'text';
  input.spellcheck = false;
  input.hidden = true;
  const dec = el('button', 'nf-a nf-dec'); dec.type = 'button'; dec.append(icon('chevron', 10));
  const inc = el('button', 'nf-a nf-inc'); inc.type = 'button'; inc.append(icon('chevron', 10));
  row.append(dec, name, val, input, inc);
  parent.append(row);

  let current = value;
  const clamp = v => Math.min(max, Math.max(min, v));
  const fmt = v => {
    const s = Math.abs(v) >= 1000 ? v.toFixed(0)
      : Math.abs(v) >= 100 ? v.toFixed(Math.min(1, precision))
      : v.toFixed(precision);
    // Trim trailing zeros but keep at least one decimal for non-integers.
    return (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s) + unit;
  };
  const clamp01 = t => Math.max(0, Math.min(1, t));
  const paint = () => {
    val.textContent = fmt(current);
    if (!fill) return;
    // Track the field's own scale: a log field's handle should sit where the
    // drag puts it, and on a four-decade range a linear fill would read as
    // pinned at zero across most of its useful span.
    let t;
    if (log && min > 0) t = Math.log(current / min) / Math.log(max / min);
    else t = (current - min) / (max - min);
    t = clamp01(t);
    // A range straddling zero fills OUT FROM zero, not from the left edge.
    // Filling from the left showed a buoyancy of 0 as a half-full bar, which
    // reads as "half of something" rather than "neutral".
    if (min < 0 && max > 0) {
      const z = clamp01(-min / (max - min));
      fill.style.left = `${Math.min(z, t) * 100}%`;
      fill.style.width = `${Math.abs(t - z) * 100}%`;
    } else {
      fill.style.left = '0%';
      fill.style.width = `${t * 100}%`;
    }
  };

  const commit = (v, silent) => {
    const nv = clamp(v);
    if (!Number.isFinite(nv)) return;
    current = nv;
    paint();
    if (!silent) onChange(current);
  };

  // Scrub. A logarithmic field multiplies rather than adds, so a viscosity
  // spanning four decades stays controllable across its whole range.
  let dragging = false, startX = 0, startVal = 0, moved = 0;
  row.addEventListener('pointerdown', e => {
    if (e.target === input || e.target.closest('.nf-a')) return;
    dragging = true; moved = 0;
    startX = e.clientX; startVal = current;
    row.setPointerCapture(e.pointerId);
    row.classList.add('is-drag');
    e.preventDefault();
  });
  row.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    const fine = e.shiftKey ? 0.15 : 1;
    if (log) {
      const lo = Math.log(Math.max(min, 1e-9)), hi = Math.log(Math.max(max, 1e-8));
      const t = (Math.log(Math.max(startVal, 1e-9)) - lo) / (hi - lo);
      commit(Math.exp(lo + Math.min(1, Math.max(0, t + (dx / 260) * fine)) * (hi - lo)));
    } else {
      commit(startVal + dx * step * 2 * fine);
    }
  });
  const endDrag = e => {
    if (!dragging) return;
    dragging = false;
    row.classList.remove('is-drag');
    // A press that never moved is a click: switch to typing.
    if (moved < 3) {
      input.hidden = false;
      input.value = String(Number(current.toFixed(6)));
      input.focus();
      input.select();
    }
  };
  row.addEventListener('pointerup', endDrag);
  row.addEventListener('pointercancel', () => { dragging = false; row.classList.remove('is-drag'); });

  input.addEventListener('keydown', e => {
    e.stopPropagation();                       // never let the global keymap see typing
    if (e.key === 'Enter') { commit(parseFloat(input.value)); input.hidden = true; }
    else if (e.key === 'Escape') { input.hidden = true; }
  });
  input.addEventListener('blur', () => {
    if (!input.hidden) { commit(parseFloat(input.value)); input.hidden = true; }
  });

  const nudge = dir => commit(log ? current * (dir > 0 ? 1.12 : 1 / 1.12) : current + dir * step);
  dec.addEventListener('click', () => nudge(-1));
  inc.addEventListener('click', () => nudge(1));

  paint();
  return {
    el: row,
    set: (v, silent = true) => commit(v, silent),
    get: () => current,
    disable: on => row.classList.toggle('is-off', !!on),
  };
}

/* ── dropdown ───────────────────────────────────────────────────────────── */

export function selectField(parent, opts) {
  const { label, options, value, hint = '', onChange = () => {} } = opts;
  const row = el('div', 'sf');
  if (hint) row.title = hint;
  if (label) row.append(el('span', 'sf-l', label));
  const sel = el('select', 'sf-s');
  sel.id = nextId();
  for (const o of options) {
    const op = el('option', null, o.label);
    op.value = o.value;
    if (o.disabled) op.disabled = true;
    sel.append(op);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(sel);
  parent.append(row);
  return {
    el: row, input: sel,
    set: (v, silent = true) => { sel.value = v; if (!silent) onChange(v); },
    get: () => sel.value,
    setOptions: list => {
      const keep = sel.value;
      sel.textContent = '';
      for (const o of list) { const op = el('option', null, o.label); op.value = o.value; sel.append(op); }
      if (list.some(o => o.value === keep)) sel.value = keep;
    },
    disable: on => { sel.disabled = !!on; row.classList.toggle('is-off', !!on); },
  };
}

/* ── checkbox ───────────────────────────────────────────────────────────── */

export function checkField(parent, opts) {
  const { label, value = false, hint = '', onChange = () => {} } = opts;
  const row = el('label', 'cf');
  if (hint) row.title = hint;
  const box = el('input');
  box.type = 'checkbox';
  box.checked = !!value;
  box.addEventListener('change', () => onChange(box.checked));
  row.append(box, el('span', null, label));
  parent.append(row);
  return {
    el: row, input: box,
    set: (v, silent = true) => { box.checked = !!v; if (!silent) onChange(box.checked); },
    get: () => box.checked,
    disable: on => { box.disabled = !!on; row.classList.toggle('is-off', !!on); },
  };
}

/* ── buttons ────────────────────────────────────────────────────────────── */

export function button(parent, opts) {
  const b = el('button', 'btn' + (opts.variant ? ' btn-' + opts.variant : ''));
  b.type = 'button';
  if (opts.icon) b.append(icon(opts.icon, opts.iconSize || 14));
  if (opts.label) b.append(el('span', null, opts.label));
  if (opts.hint) b.title = opts.hint;
  b.addEventListener('click', e => opts.onClick(b, e));
  parent.append(b);
  return b;
}

/* Segmented control — the Edit/Simulate switch and overlay groups. */
export function segmented(parent, opts) {
  const wrap = el('div', 'seg');
  const btns = new Map();
  for (const o of opts.options) {
    const b = el('button', 'seg-b');
    b.type = 'button';
    if (o.icon) b.append(icon(o.icon, 13));
    if (o.label) b.append(el('span', null, o.label));
    if (o.hint) b.title = o.hint;
    if (o.disabled) b.disabled = true;
    b.addEventListener('click', () => set(o.value, false));
    wrap.append(b);
    btns.set(o.value, b);
  }
  let current = opts.value;
  const paint = () => { for (const [v, b] of btns) b.classList.toggle('is-on', v === current); };
  const set = (v, silent = true) => {
    if (!btns.has(v)) return;
    current = v; paint();
    if (!silent) opts.onChange(v);
  };
  paint();
  parent.append(wrap);
  return { el: wrap, set, get: () => current };
}

/* Row of icon toggles, e.g. the overlay switches in the viewport header. */
export function iconToggles(parent, items) {
  const wrap = el('div', 'itg');
  const handles = new Map();
  for (const it of items) {
    const b = el('button', 'itg-b');
    b.type = 'button';
    b.title = it.hint || it.label;
    b.setAttribute('aria-label', it.label);
    b.append(icon(it.icon, 14));
    let on = !!it.value;
    const paint = () => b.classList.toggle('is-on', on);
    b.addEventListener('click', () => { on = !on; paint(); it.onChange(on); });
    paint();
    wrap.append(b);
    handles.set(it.id, { set: (v, silent = true) => { on = !!v; paint(); if (!silent) it.onChange(on); }, get: () => on, el: b });
  }
  parent.append(wrap);
  return handles;
}

/* Collapsible property group. */
export function group(parent, title, open = true) {
  const box = el('div', 'grp');
  const head = el('button', 'grp-h');
  head.type = 'button';
  const mark = icon('down', 10);
  mark.classList.add('grp-m');
  head.append(mark, el('span', null, title));
  const body = el('div', 'grp-b');
  if (!open) { body.hidden = true; box.classList.add('is-closed'); }
  head.addEventListener('click', () => {
    const willOpen = body.hidden;
    body.hidden = !willOpen;
    box.classList.toggle('is-closed', !willOpen);
  });
  box.append(head, body);
  parent.append(box);
  return body;
}

export function textField(parent, opts) {
  const row = el('div', 'sf');
  if (opts.label) row.append(el('span', 'sf-l', opts.label));
  const inp = el('input', 'tf');
  inp.type = 'text';
  inp.value = opts.value || '';
  inp.spellcheck = false;
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') inp.blur();
  });
  inp.addEventListener('change', () => opts.onChange(inp.value));
  row.append(inp);
  parent.append(row);
  return { el: row, input: inp, set: v => { inp.value = v; }, get: () => inp.value };
}
