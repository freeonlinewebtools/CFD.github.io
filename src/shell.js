/* Assembles the workbench interface and binds it to the app.
 *
 * Kept apart from main.js so the controller stays about simulation and the
 * shell stays about DOM. Everything here reads and writes through the app
 * object, which is the single source of truth for settings.
 */

import { el, button, segmented, iconToggles, selectField, textField } from './ui/widgets.js';
import { icon } from './ui/icons.js';
import { MenuBar } from './ui/menu.js';
import { Outliner } from './ui/outliner.js';
import { Properties } from './ui/properties.js';
import { makeSplitter } from './ui/splitter.js';
import * as Panels from './ui/panels.js';
import * as Projects from './projects.js';

const TOOLS = [
  { id: 'select', icon: 'select', label: 'Select', key: 'Q', modes: ['edit'] },
  { sep: true },
  { id: 'draw-rect', icon: 'rect', label: 'Rectangle', key: 'R', modes: ['edit'] },
  { id: 'draw-circle', icon: 'circle', label: 'Circle / ellipse', key: 'C', modes: ['edit'] },
  { id: 'draw-poly', icon: 'polygon', label: 'Polygon', key: 'Y', modes: ['edit'] },
  { id: 'draw-wall', icon: 'line', label: 'Wall', key: 'K', modes: ['edit'] },
  { sep: true },
  { id: 'sketch', icon: 'brush', label: 'Paint solid', key: 'N', modes: ['edit', 'simulate'] },
  { id: 'sketch-erase', icon: 'eraser', label: 'Erase solid', key: 'E', modes: ['edit', 'simulate'] },
  { id: 'fill', icon: 'fill', label: 'Fill enclosed region', key: 'F', modes: ['edit', 'simulate'] },
  { id: 'erase-obj', icon: 'trash', label: 'Delete object', key: null, modes: ['edit'] },
  { sep: true },
  { id: 'paint', icon: 'move', label: 'Push fluid', key: 'B', modes: ['simulate'] },
  { id: 'water-add', icon: 'fill', label: 'Add water', key: 'W', modes: ['edit', 'simulate'], physics: 'water' },
  { id: 'water-del', icon: 'eraser', label: 'Remove water', key: null, modes: ['edit', 'simulate'], physics: 'water' },
  { id: 'inlet', icon: 'emitter', label: 'Place emitter', key: 'I', modes: ['edit', 'simulate'] },
  { id: 'erase-inlet', icon: 'probe', label: 'Remove emitter', key: null, modes: ['edit', 'simulate'] },
];

export const STATUS_FIELDS = [
  { id: 'fps', label: 'fps' },
  { id: 'ms', label: 'ms' },
  { id: 'grid', label: 'grid' },
  { id: 'dt', label: 'dt' },
  { id: 'cfl', label: 'CFL' },
  { id: 'umax', label: '|u|max' },
  { id: 're', label: 'Re' },
  { id: 'cl', label: 'Cl' },
  { id: 'cd', label: 'Cd' },
  { id: 'st', label: 'St' },
  /* Water's counterparts to the four above, shown in their place. Cd and St
   * describe a body in a free stream and mean nothing in a tank; volume drift
   * and the Froude number are what actually tell you whether the surface is
   * behaving. */
  { id: 'vol', label: 'vol' },
  { id: 'fr', label: 'Fr' },
  { id: 'ke', label: 'KE' },
  { id: 'regime', label: '' },
];

export class StatusBar {
  constructor(root, fields) {
    this.slots = new Map();
    for (const f of fields) {
      const wrap = el('div', 'stat');
      const v = el('span', 'stat-v', '—');
      if (f.label) wrap.append(el('span', 'stat-k', f.label));
      wrap.append(v);
      root.append(wrap);
      this.slots.set(f.id, { wrap, v, last: null, tone: null });
    }
    this.msg = el('span', 'status-msg');
    root.append(el('div', 'mb-spacer'), this.msg);
  }
  set(id, text, tone) {
    const s = this.slots.get(id);
    if (!s) return;
    if (s.last !== text) { s.v.textContent = text; s.last = text; }
    if (s.tone !== tone) { s.v.dataset.tone = tone || ''; s.tone = tone; }
  }
  show(id, on) { const s = this.slots.get(id); if (s) s.wrap.hidden = !on; }
  message(text) { this.msg.textContent = text || ''; }
}

/* ── modal dialog ───────────────────────────────────────────────────────── */

export function modal({ title, build, buttons }) {
  const host = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  const foot = document.getElementById('modal-foot');
  document.getElementById('modal-title').textContent = title;
  body.textContent = '';
  foot.textContent = '';

  return new Promise(resolve => {
    const close = value => {
      host.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && !e.target.closest('textarea')
               // A number field's inline editor commits on Enter itself. This
               // listener is on document with capture, so without the exception
               // it swallowed that Enter and submitted the whole dialog —
               // typing a value into a modal closed it instead of setting it.
               && !e.target.closest('.nf')) {
        const primary = buttons.find(b => b.primary);
        if (primary) { e.stopPropagation(); close(primary.value ?? api.value()); }
      }
    };
    const api = build ? build(body) : { value: () => null };
    for (const b of buttons) {
      button(foot, {
        label: b.label,
        variant: b.primary ? 'primary' : b.danger ? 'danger' : null,
        onClick: () => close(b.value !== undefined ? b.value : (api.value ? api.value() : null)),
      });
    }
    host.hidden = false;
    document.addEventListener('keydown', onKey, true);
    queueMicrotask(() => { const f = body.querySelector('input,select'); if (f) { f.focus(); f.select?.(); } });
  });
}

export function buildShell(app) {
  const shell = {};

  /* ── menu bar ─────────────────────────────────────────────────────── */
  const bar = new MenuBar(document.getElementById('mb-menus'));
  shell.menu = bar;

  bar.add('File', () => [
    { label: 'New', shortcut: 'Ctrl N', action: () => app.newProject() },
    { label: 'Open…', shortcut: 'Ctrl O', action: () => app.openProject() },
    { separator: true },
    { label: 'Save', shortcut: 'Ctrl S', action: () => app.saveProject() },
    { label: 'Save As…', shortcut: 'Ctrl Shift S', action: () => app.saveProjectAs() },
    { separator: true },
    { label: 'Import from file…', action: () => app.importFile() },
    { label: 'Import SVG…', action: () => app.importSVG() },
    { label: 'Import 3D model (STL)…', action: () => app.importSTL() },
    { label: 'Export to file…', action: () => app.exportFile() },
    { separator: true },
    { label: 'Save image', shortcut: 'S', action: () => app.savePNG() },
    { label: 'Copy shareable link', action: () => app.copyLink() },
  ]);

  bar.add('Edit', () => [
    { label: app.history.undoLabel ? `Undo ${app.history.undoLabel}` : 'Undo', shortcut: 'Ctrl Z', enabled: () => app.history.canUndo, action: () => app.undo() },
    { label: app.history.redoLabel ? `Redo ${app.history.redoLabel}` : 'Redo', shortcut: 'Ctrl Shift Z', enabled: () => app.history.canRedo, action: () => app.redo() },
    { separator: true },
    { label: 'Duplicate', shortcut: 'Shift D', enabled: () => app.scene.selection.size > 0, action: () => app.duplicateSelection() },
    { label: 'Delete', shortcut: 'X', enabled: () => app.scene.selection.size > 0, action: () => app.deleteSelection() },
    { separator: true },
    { label: 'Select all', shortcut: 'A', action: () => app.selectAll() },
    { label: 'Deselect all', shortcut: 'Alt A', action: () => app.deselectAll() },
  ]);

  bar.add('Add', () => [
    { label: 'Rectangle', action: () => app.addShape('rect') },
    { label: 'Circle', action: () => app.addShape('circle') },
    { label: 'Aerofoil (NACA)', action: () => app.addShape('naca') },
    { separator: true },
    { label: 'Building…', action: () => { shell.props.show('add'); } },
    { label: 'Aerofoil…', action: () => { shell.props.show('add'); } },
  ]);

  bar.add('View', () => [
    { label: 'Toggle side panels', shortcut: 'T', checked: () => !document.body.classList.contains('panel-hidden'), action: () => app.togglePanels() },
    { label: 'Fullscreen', shortcut: 'F11', checked: () => !!document.fullscreenElement, action: () => app.toggleFullscreen() },
    { separator: true },
    { label: 'Reset panel sizes', action: () => app.resetLayout() },
    { separator: true },
    { label: 'Dark theme', checked: () => app.themeName === 'dark', action: () => app.setTheme('dark') },
    { label: 'Light theme', checked: () => app.themeName === 'light', action: () => app.setTheme('light') },
  ]);

  bar.add('Simulation', () => [
    { label: app.running ? 'Pause' : 'Resume', shortcut: 'Space', action: () => app.setRunning(!app.running) },
    { label: 'Reset flow', shortcut: 'Ctrl R', action: () => app.resetFlow() },
    { label: 'Clear everything', action: () => app.clearAll() },
    { separator: true },
    { label: 'Wind tunnel', checked: () => app.windTunnel, action: () => app.setWindTunnel(!app.windTunnel) },
    { separator: true },
    { label: 'Analyse design…', shortcut: 'Ctrl I', action: () => app.analyseDesign() },
  ]);

  bar.add('Help', () => [
    { label: 'Keyboard shortcuts', shortcut: '?', action: () => app.toggleHelp() },
  ]);

  /* ── physics mode tabs ────────────────────────────────────────────── */
  const modes = document.getElementById('mb-modes');
  const MODES = [
    { id: 'air', label: 'Airflow', ready: true,
      hint: 'Single-phase incompressible airflow.' },
    { id: 'water', label: 'Free-surface water', ready: true,
      hint: 'Water with a free surface against void. The air is not simulated — '
          + 'to water it is very nearly a constant-pressure vacuum.' },
    { id: 'coupled', label: 'Coupled air–water', ready: false,
      hint: 'Both phases at once. Not built: it means resolving a density ratio '
          + 'of a thousand across one cell, which is a different problem.' },
  ];
  const modeButtons = new Map();
  for (const m of MODES) {
    const b = el('button', 'mb-mode' + (m.id === app.physics ? ' is-on' : ''), m.label);
    b.type = 'button';
    b.disabled = !m.ready;
    b.title = m.hint;
    if (m.ready) b.addEventListener('click', () => app.setPhysics(m.id));
    modes.append(b);
    modeButtons.set(m.id, b);
  }
  shell.modeTabs = {
    set(id) {
      for (const [k, b] of modeButtons) b.classList.toggle('is-on', k === id);
    },
  };

  /* ── toolbar ──────────────────────────────────────────────────────── */
  const toolbar = document.getElementById('toolbar');
  shell.toolButtons = new Map();
  shell.toolDefs = TOOLS.filter(t => !t.sep);
  for (const t of TOOLS) {
    if (t.sep) { toolbar.append(el('div', 'tool-sep')); continue; }
    const b = el('button', 'tool-b');
    b.type = 'button';
    b.title = t.key ? `${t.label}  (${t.key})` : t.label;
    b.setAttribute('aria-label', t.label);
    b.append(icon(t.icon, 17));
    b.addEventListener('click', () => app.setTool(t.id));
    toolbar.append(b);
    shell.toolButtons.set(t.id, { el: b, def: t });
  }
  shell.syncTools = () => {
    for (const [id, h] of shell.toolButtons) {
      h.el.classList.toggle('is-on', app.tool === id);
      // A tool tied to a physics mode is HIDDEN outside it, not merely
      // disabled: a permanently greyed water brush in an airflow session is
      // clutter, whereas a greyed drawing tool in simulate mode is a reminder
      // that it exists in edit mode.
      const rightPhysics = !h.def.physics || h.def.physics === app.physics;
      h.el.hidden = !rightPhysics;
      const usable = rightPhysics && h.def.modes.includes(app.mode2);
      h.el.disabled = !usable;
      h.el.style.opacity = usable ? '' : '.35';
    }
  };
  /* Tool shortcuts are declared once, beside the tool, so the tooltip and the
   * binding cannot disagree. */
  shell.toolForKey = key => {
    const k = key.toUpperCase();
    const t = shell.toolDefs.find(x => x.key === k && x.modes.includes(app.mode2)
      && (!x.physics || x.physics === app.physics));
    return t ? t.id : null;
  };

  /* ── viewport header ──────────────────────────────────────────────── */
  shell.modeSwitch = segmented(document.getElementById('vp-mode'), {
    value: app.mode2,
    options: [
      { value: 'edit', label: 'Edit', hint: 'Build and arrange geometry. The solver holds still.' },
      { value: 'simulate', label: 'Simulate', hint: 'Run the flow. Geometry is locked.' },
    ],
    onChange: v => app.setAppMode(v),
  });

  shell.fieldSelect = selectField(document.getElementById('vp-field'), {
    value: app.mode,
    options: [
      { value: 'speed', label: 'Speed' }, { value: 'pressure', label: 'Pressure' },
      { value: 'vorticity', label: 'Vorticity' }, { value: 'qcriterion', label: 'Q-criterion' },
      { value: 'schlieren', label: 'Schlieren' }, { value: 'dye', label: 'Dye' },
      { value: 'mach', label: 'Mach' }, { value: 'density', label: 'Density' },
    ],
    onChange: v => app.setMode(v),
  });

  shell.overlayToggles = iconToggles(document.getElementById('vp-overlays'), [
    { id: 'dyeOverlay', icon: 'fill', label: 'Dye overlay', hint: 'Dye overlay (D)', value: app.dyeOverlay, onChange: v => app.setOverlay('dyeOverlay', v) },
    { id: 'showVectors', icon: 'move', label: 'Vectors', hint: 'Velocity vectors (V)', value: app.showVectors, onChange: v => app.setOverlay('showVectors', v) },
    { id: 'showStreamlines', icon: 'line', label: 'Streamlines', hint: 'Streamlines (L)', value: app.showStreamlines, onChange: v => app.setOverlay('showStreamlines', v) },
    { id: 'showContours', icon: 'circle', label: 'Isobars', hint: 'Pressure contours', value: app.showContours, onChange: v => app.setOverlay('showContours', v) },
    { id: 'showParticles', icon: 'probe', label: 'Particles', hint: 'Particle tracers (P)', value: app.showParticles, onChange: v => app.setOverlay('showParticles', v) },
    { id: 'showGizmos', icon: 'object', label: 'Outlines', hint: 'Object outlines and handles', value: app.showGizmos, onChange: v => app.setOverlay('showGizmos', v) },
  ]);

  const transport = document.getElementById('vp-transport');
  shell.playBtn = button(transport, {
    icon: 'pause', iconSize: 13, hint: 'Pause or resume (space)',
    onClick: () => app.setRunning(!app.running),
  });
  shell.syncPlay = () => {
    shell.playBtn.textContent = '';
    shell.playBtn.append(icon(app.running ? 'pause' : 'play', 13));
  };
  button(transport, { icon: 'undo', iconSize: 13, hint: 'Reset flow (Ctrl R)', onClick: () => app.resetFlow() });

  /* ── outliner ─────────────────────────────────────────────────────── */
  shell.outliner = new Outliner(document.getElementById('outliner'), {
    scene: app.scene,
    onChange: () => app.reraster(),
    onSelect: () => app.onSelectionChanged(),
    commit: label => app.commitScene(label),
  });
  shell.outlinerCount = document.getElementById('otl-count');

  /* ── properties ───────────────────────────────────────────────────── */
  const props = new Properties(document.getElementById('prop-tabs'), document.getElementById('prop-body'));
  shell.props = props;
  props.addTab('tool', 'tool', 'Active tool', root => Panels.buildToolTab(root, app));
  props.addTab('scene', 'scene', 'Scene', root => Panels.buildSceneTab(root, app));
  props.addTab('physics', 'physics', 'Physics', root => Panels.buildPhysicsTab(root, app));
  props.addTab('numerics', 'object', 'Numerics', root => Panels.buildNumericsTab(root, app));
  props.addSeparator();                     // ── setup above, geometry below
  props.addTab('object', 'wing', 'Object', root => Panels.buildObjectTab(root, app));
  props.addTab('arrange', 'move', 'Align & snap', root => Panels.buildArrangeTab(root, app));
  props.addTab('add', 'plus', 'Add geometry', root => Panels.buildAddTab(root, app));
  props.addSeparator();                     // ── geometry above, output below
  props.addTab('view', 'view', 'View', root => Panels.buildViewTab(root, app));
  props.addTab('render', 'render', 'Render', root => Panels.buildRenderTab(root, app));
  props.show('physics');

  /* ── status bar ───────────────────────────────────────────────────── */
  shell.status = new StatusBar(document.getElementById('statusbar'), STATUS_FIELDS);

  /* ── splitters ────────────────────────────────────────────────────── */
  shell.splitRight = makeSplitter(document.getElementById('split-right'), {
    key: 'right', axis: 'x', varName: '--w-right', initial: 300, min: 220, max: 620,
    invert: true, onResize: () => app.queueResize(),
  });
  shell.splitProps = makeSplitter(document.getElementById('split-props'), {
    key: 'outliner', axis: 'y', varName: '--h-outliner', initial: 240, min: 90, max: 600,
    onResize: () => {},
  });

  document.getElementById('fullscreen').append(icon('expand', 13));
  document.getElementById('fullscreen').addEventListener('click', () => app.toggleFullscreen());
  document.getElementById('help-close').addEventListener('click', () => app.toggleHelp(false));
  buildHelp(app);

  shell.projectLabel = document.getElementById('mb-project');
  return shell;
}

/* Build the keyboard help from the tool declarations.
 *
 * Generated rather than written out, because the hand-written version had
 * drifted badly: it listed none of the eleven tool shortcuts the toolbar
 * advertises in its own tooltips, and still claimed W toggled the wind tunnel
 * after W had become Add water. A panel whose job is to tell you what the keys
 * do is worse than useless when it is wrong, and the only way to keep it honest
 * is to read the same array the toolbar is built from.
 *
 * Tools with no key, and the separators, are skipped. Water tools are labelled
 * rather than hidden — the panel is where you find out a mode exists. */
function buildHelp(app) {
  const host = document.getElementById('help-cols');
  if (!host) return;
  const dl = list => {
    const d = el('dl');
    for (const [k, v] of list) { d.append(el('dt', '', k), el('dd', '', v)); }
    return d;
  };

  const tools = TOOLS
    .filter(t => t.key)
    .map(t => [t.key, t.physics === 'water' ? `${t.label} (water mode)` : t.label]);

  host.textContent = '';
  host.append(
    dl([
      ['Tab', 'Edit / Simulate'],
      ['Space', 'Pause or resume'],
      ['G', 'Grab (move) selection'],
      ['R', 'Rotate selection, or Rectangle'],
      ['S', 'Scale selection, or save PNG'],
      ['X', 'Delete selection'],
      ['Shift+D', 'Duplicate'],
      ['A', 'Select all'],
      ['Alt+A', 'Deselect all'],
      ['Esc', 'Cancel current action'],
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z', 'Redo'],
      ['Ctrl+S', 'Save project'],
      ['Ctrl+I', 'Analyse design'],
    ]),
    dl(tools),
    dl([
      ['1 – 8', 'Field: speed, pressure, vorticity, Q, schlieren, dye, Mach, density'],
      ['V', 'Velocity vectors'],
      ['L', 'Streamlines'],
      ['P', 'Particles'],
      ['D', 'Dye overlay'],
      ['W', 'Wind tunnel (airflow mode)'],
      ['T', 'Show / hide panels'],
      ['F11', 'Fullscreen'],
      ['?', 'This panel'],
    ]),
  );
}

/* ── project dialogs ────────────────────────────────────────────────────── */

export async function promptName(title, initial) {
  return modal({
    title,
    build(body) {
      body.append(el('p', 'note', 'Projects are stored in this browser. Export to a file for anything you want to keep.'));
      const f = textField(body, { label: 'Name', value: initial, onChange: () => {} });
      return { value: () => f.get().trim() || null };
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true }],
  });
}

export async function pickProject() {
  const list = Projects.listProjects();
  return modal({
    title: 'Open project',
    build(body) {
      if (!list.length) {
        body.append(el('p', 'note', 'No saved projects yet. Use File ▸ Save, or import a .hyperfoam.json file.'));
        return { value: () => null };
      }
      const usage = Projects.storageUsage();
      const box = el('div', 'proj-list');
      let chosen = list[0].name;
      const rows = [];
      for (const p of list) {
        const row = el('div', 'proj-row');
        row.append(el('span', 'proj-name', p.name));
        const when = new Date(p.saved);
        row.append(el('span', 'proj-meta', `${p.objects} obj · ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
        row.addEventListener('click', () => {
          chosen = p.name;
          for (const r of rows) r.classList.toggle('is-sel', r === row);
        });
        row.addEventListener('dblclick', () => {
          chosen = p.name;
          document.querySelector('#modal-foot .btn-primary')?.click();
        });
        rows.push(row);
        box.append(row);
      }
      rows[0].classList.add('is-sel');
      body.append(box);
      body.append(el('p', 'note', `${usage.projects} project(s), about ${(usage.bytes / 1024).toFixed(0)} kB of browser storage used.`));
      return { value: () => chosen };
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Open', primary: true }],
  });
}
