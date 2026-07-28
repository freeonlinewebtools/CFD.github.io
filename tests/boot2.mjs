/* Boot the Phase C shell against a stub DOM and exercise every control. */

let created = 0;
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.className = ''; this._text = ''; this.value = ''; this.type = '';
    this.checked = false; this.hidden = false; this.id = ''; this.disabled = false;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {}; this.children = []; this.parentNode = null;
    this.listeners = {}; this.title = ''; this.spellcheck = false;
    created++;
  }
  get textContent() { return this._text || this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = v; this.children.length = 0; }
  set innerHTML(v) { this._text = String(v).replace(/<[^>]*>/g, ''); }
  get firstElementChild() { return this.children[0] || null; }
  get classList() {
    const s = this;
    return {
      contains: c => s.className.split(/\s+/).includes(c),
      add: (...cs) => { for (const c of cs) if (!s.classList.contains(c)) s.className = (s.className + ' ' + c).trim(); },
      remove: (...cs) => { s.className = s.className.split(/\s+/).filter(x => !cs.includes(x)).join(' '); },
      toggle: (c, f) => { const has = s.classList.contains(c); const want = f === undefined ? !has : !!f; want ? s.classList.add(c) : s.classList.remove(c); },
    };
  }
  append(...ns) { for (const n of ns) { if (n && n.tagName) { n.parentNode = this; this.children.push(n); } } }
  appendChild(n) { this.append(n); return n; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener() {}
  setAttribute(k, v) { this.dataset['attr_' + k] = v; }
  getAttribute(k) { return this.dataset['attr_' + k]; }
  setPointerCapture() {} releasePointerCapture() {}
  focus() {} select() {} blur() {} click() { this.fire('click'); }
  fire(t, ev = {}) {
    for (const f of (this.listeners[t] || []).slice()) {
      f({ preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this, ...ev });
    }
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 620, right: 1200, bottom: 620 }; }
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) { let n = this; while (n) { if (n.matches?.(sel)) return n; n = n.parentNode; } return null; }
  descendants() { const o = []; const w = n => { for (const c of n.children) { o.push(c); w(c); } }; w(this); return o; }
  querySelector(sel) {
    for (const part of sel.split(',')) { const hit = this.descendants().find(n => n.matches(part.trim())); if (hit) return hit; }
    return null;
  }
  querySelectorAll(sel) { return this.descendants().filter(n => n.matches(sel)); }
  getContext(kind) {
    if (kind === 'webgl2') return null;
    const noop = () => {};
    return new Proxy({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      measureText: () => ({ width: 40 }), canvas: this,
    }, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
  }
  // A bare {} here used to satisfy the callback and then blow up inside the
  // recorder's PNG path on blob.arrayBuffer(). The throw was swallowed, so the
  // whole ZIP branch looked exercised while never running. Hand back something
  // that behaves like a Blob.
  toBlob(cb) { cb(new global.Blob([new Uint8Array(8)])); }
}

const byId = {};
const IDS = ['stage', 'field', 'fx', 'mb-menus', 'mb-modes', 'mb-project', 'backend',
  'fullscreen', 'toolbar', 'vp-mode', 'vp-field', 'vp-overlays', 'vp-transport',
  'outliner', 'otl-count', 'prop-tabs', 'prop-body', 'statusbar', 'split-right',
  'split-props', 'help', 'help-close', 'modal', 'modal-title', 'modal-body',
  'modal-foot', 'boot-error', 'backend-warn', 'toast'];
for (const id of IDS) {
  const e = new El(id === 'field' || id === 'fx' ? 'canvas' : 'div');
  e.id = id;
  if (id === 'boot-error') e.append(new El('div'));
  byId[id] = e;
}

const documentElement = new El('html');
const body = new El('body');
global.document = {
  documentElement, body,
  getElementById: id => byId[id] || null,
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
  querySelector: sel => body.querySelector(sel) || Object.values(byId).find(e => e.matches(sel)) || null,
  querySelectorAll: () => [],
  addEventListener: (t, f) => { (global.document._l[t] ||= []).push(f); },
  removeEventListener: () => {},
  _l: {},
  fullscreenElement: null,
};
global.window = { devicePixelRatio: 2, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.performance = { now: () => Date.now() };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.requestAnimationFrame = () => 0;
global.location = { hash: '', origin: 'http://x', pathname: '/' };
const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
Object.defineProperty(global, 'navigator', { value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true });
/* Enough of a Blob that code reading its bytes back works. The empty stub this
 * replaces meant any such path failed silently under test. */
global.Blob = class {
  constructor(parts = [], opts = {}) {
    this.parts = parts;
    this.type = opts.type || '';
    let n = 0;
    for (const p of parts) n += p && p.byteLength !== undefined ? p.byteLength : (p && p.length) || 0;
    this.size = n;
  }
  async arrayBuffer() {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      const b = p instanceof Uint8Array ? p : new Uint8Array(p && p.buffer ? p.buffer : 0);
      out.set(b, o); o += b.length;
    }
    return out.buffer;
  }
};
global.FileReader = class {};
global.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} };
global.HTMLElement = El;
global.structuredClone = global.structuredClone || (o => JSON.parse(JSON.stringify(o)));
global.setTimeout = (fn) => 0;
global.clearTimeout = () => {};
global.queueMicrotask = fn => fn();

let failed = false;
const fails = [];
process.on('uncaughtException', e => { console.log('UNCAUGHT: ' + e.stack); failed = true; });

console.log('booting the Phase C shell...\n');
await import('../src/main.js');

const tryIt = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); failed = true; fails.push(label); }
};

const bootErr = byId['boot-error'];
if (bootErr.parentNode || /failed to start/i.test(bootErr.textContent)) {
  console.log('BOOT FAILED: ' + bootErr.textContent);
  failed = true;
} else {
  console.log('PASS  boot completed, error panel removed');
}
console.log(`PASS  renderer: ${byId['backend'].textContent}`);
console.log(`      DOM nodes: ${created}\n`);

// ── menus ──
const menuBtns = byId['mb-menus'].children.filter(c => c.matches('.mb-t'));
console.log(`  found ${menuBtns.length} menus`);
for (const b of menuBtns) {
  tryIt(`menu "${b.textContent}" opens`, () => b.fire('pointerdown'));
  const drop = byId['mb-menus'].children.find(c => c.matches('.mb-d') && !c.hidden);
  if (drop) {
    for (const item of drop.children.filter(c => c.matches('.mb-i') && !c.disabled)) {
      const lbl = item.textContent;
      // Skip destructive / dialog-opening entries that need user input.
      if (/new|open|save as|import|clear everything/i.test(lbl)) continue;
      tryIt(`  menu item "${lbl}"`, () => item.fire('click'));
    }
  }
}

// ── toolbar ──
const tools = byId['toolbar'].children.filter(c => c.matches('.tool-b'));
console.log(`\n  found ${tools.length} tools`);
for (const t of tools) tryIt(`tool "${t.getAttribute('aria-label')}"`, () => t.fire('click'));

// ── viewport header ──
tryIt('mode switch -> edit', () => byId['vp-mode'].querySelector('.seg-b').fire('click'));
const segs = byId['vp-mode'].querySelectorAll('.seg-b');
tryIt('mode switch -> simulate', () => segs[1].fire('click'));
const fieldSel = byId['vp-field'].querySelector('select');
for (const opt of fieldSel.children) {
  tryIt(`field "${opt.textContent}"`, () => { fieldSel.value = opt.value; fieldSel.fire('change'); });
}
for (const b of byId['vp-overlays'].querySelectorAll('.itg-b')) {
  tryIt(`overlay "${b.getAttribute('aria-label')}"`, () => { b.fire('click'); b.fire('click'); });
}
for (const b of byId['vp-transport'].children) tryIt('transport button', () => b.fire('click'));

// ── property tabs, every widget in each ──
const tabs = byId['prop-tabs'].children;
console.log(`\n  found ${tabs.length} property tabs`);
for (const tab of tabs) {
  const name = tab.getAttribute('aria-label');
  tryIt(`tab "${name}"`, () => tab.fire('click'));
  const bodyEl = byId['prop-body'];
  for (const g of bodyEl.querySelectorAll('.grp-h')) tryIt(`  ${name}: collapse group`, () => { g.fire('click'); g.fire('click'); });
  for (const nf of bodyEl.querySelectorAll('.nf')) {
    const lbl = nf.querySelector('.nf-l')?.textContent || '?';
    tryIt(`  ${name}: number "${lbl}" scrub`, () => {
      nf.fire('pointerdown', { clientX: 100, pointerId: 1 });
      nf.fire('pointermove', { clientX: 160, pointerId: 1, shiftKey: false });
      nf.fire('pointerup', { clientX: 160, pointerId: 1 });
    });
    tryIt(`  ${name}: number "${lbl}" steppers`, () => {
      nf.querySelector('.nf-inc')?.fire('click');
      nf.querySelector('.nf-dec')?.fire('click');
    });
  }
  for (const s of bodyEl.querySelectorAll('.sf-s')) {
    tryIt(`  ${name}: select`, () => { for (const o of s.children) { s.value = o.value; s.fire('change'); } });
  }
  for (const c of bodyEl.querySelectorAll('.cf')) {
    const box = c.children.find(x => x.tagName === 'INPUT');
    if (box) tryIt(`  ${name}: checkbox`, () => { box.checked = !box.checked; box.fire('change'); box.checked = !box.checked; box.fire('change'); });
  }
  for (const b of bodyEl.querySelectorAll('.btn')) {
    if (b.disabled) continue;
    tryIt(`  ${name}: button "${b.textContent}"`, () => b.fire('click'));
  }
}

// ── scene editing through the app ──
console.log('');
const key = e => { for (const f of document._l.keydown || []) f({ key: e, target: body, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} }); };
const keyMod = (e, mods) => { for (const f of document._l.keydown || []) f({ key: e, target: body, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods, preventDefault() {}, stopPropagation() {} }); };

for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', 'v', 'l', 'p', 'd', 'w', 't', 'q', 'b', 'n', 'e', 'i', ' ', 'Tab', '?', 'Escape']) {
  tryIt(`key "${k}"`, () => key(k));
}
tryIt('Ctrl+Z undo', () => keyMod('z', { ctrlKey: true }));
tryIt('Ctrl+Shift+Z redo', () => keyMod('z', { ctrlKey: true, shiftKey: true }));
tryIt('Shift+D duplicate', () => keyMod('d', { shiftKey: true }));
tryIt('A select all', () => key('a'));
tryIt('Alt+A deselect', () => keyMod('a', { altKey: true }));
tryIt('G/R/S operators', () => { key('g'); key('Escape'); key('r'); key('Escape'); key('s'); key('Escape'); });
tryIt('X delete', () => key('x'));

// ── outliner ──
const rows = byId['outliner'].querySelectorAll('.otl-row');
console.log(`\n  outliner rows: ${rows.length}`);
for (const r of rows.slice(0, 3)) {
  tryIt('outliner select', () => r.fire('pointerdown', { shiftKey: false }));
  for (const b of r.querySelectorAll('.otl-b')) tryIt('outliner tool button', () => b.fire('click'));
}

// ── viewport pointer, both modes ──
const fx = byId['fx'];
for (const m of ['simulate', 'edit']) {
  tryIt(`pointer drag in ${m} mode`, () => {
    const segIdx = m === 'edit' ? 0 : 1;
    byId['vp-mode'].querySelectorAll('.seg-b')[segIdx].fire('click');
    fx.fire('pointerdown', { clientX: 300, clientY: 200, pointerId: 1 });
    fx.fire('pointermove', { clientX: 340, clientY: 230, pointerId: 1 });
    fx.fire('pointermove', { clientX: 420, clientY: 260, pointerId: 1 });
    fx.fire('pointerup', { clientX: 420, clientY: 260, pointerId: 1 });
  });
}

// ── splitters ──
for (const id of ['split-right', 'split-props']) {
  tryIt(`splitter ${id}`, () => {
    const s = byId[id];
    s.fire('pointerdown', { clientX: 900, clientY: 400, pointerId: 1 });
    s.fire('pointermove', { clientX: 860, clientY: 360, pointerId: 1 });
    s.fire('pointerup', { clientX: 860, clientY: 360, pointerId: 1 });
    s.fire('dblclick');
  });
}

// ── project round-trip through localStorage ──
console.log('');
const Projects = await import('../src/projects.js');
tryIt('save project to localStorage', () => {
  const r = Projects.saveProject('unit-test', { scene: { version: 1, domain: { nx: 256, ny: 128 }, objects: [] }, settings: { mode: 'speed' } });
  if (!r.ok) throw new Error(r.error);
});
tryIt('list projects', () => { if (!Projects.listProjects().some(p => p.name === 'unit-test')) throw new Error('not listed'); });
tryIt('load project', () => { if (!Projects.loadProject('unit-test')) throw new Error('not loaded'); });
tryIt('delete project', () => { const r = Projects.deleteProject('unit-test'); if (!r.ok) throw new Error(r.error); });
tryIt('rejects unnamed project', () => { if (Projects.saveProject('', {}).ok) throw new Error('should have refused'); });

console.log(failed ? `\nFAILURES (${fails.length}): ${fails.slice(0, 12).join(' | ')}\n` : '\nall shell checks passed\n');
process.exit(failed ? 1 : 0);
