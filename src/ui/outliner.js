/* Object tree.
 *
 * Rebuilds from the scene whenever its revision changes rather than trying to
 * patch rows in place — the list is tens of entries and a full rebuild removes
 * a whole class of desync between what the tree shows and what the scene holds.
 * Inline rename is preserved across rebuilds by re-focusing the edited row.
 */

import { el } from './widgets.js';
import { icon, objectIcon } from './icons.js';
import { BOUNDARIES } from '../scene.js';

export class Outliner {
  constructor(root, opts) {
    this.root = root;
    this.scene = opts.scene;
    this.onChange = opts.onChange || (() => {});     // scene mutated -> re-raster
    this.onSelect = opts.onSelect || (() => {});
    this.commit = opts.commit || (() => {});         // push an undo step
    this.revision = -1;
    this.renaming = null;

    this.list = el('div', 'otl-list');
    this.root.append(this.list);
  }

  /* Called every frame; cheap when nothing changed. */
  sync(force = false) {
    const rev = this.scene.revision + (this.scene.selection.size * 1e-6);
    if (!force && rev === this.revision) return;
    this.revision = rev;
    this.build();
  }

  build() {
    const scene = this.scene;
    this.list.textContent = '';

    if (!scene.objects.length) {
      this.list.append(el('div', 'otl-empty', 'No objects. Draw one, or load a scenario.'));
      return;
    }

    // Later objects rasterise last, so show them at the top the way a layer
    // list does.
    for (let i = scene.objects.length - 1; i >= 0; i--) {
      const o = scene.objects[i];
      const row = el('div', 'otl-row');
      row.dataset.id = o.id;
      if (scene.selection.has(o.id)) row.classList.add('is-sel');
      if (!o.visible) row.classList.add('is-hidden');

      const ico = el('span', 'otl-ico');
      ico.append(objectIcon(o.type));
      row.append(ico);

      if (this.renaming === o.id) {
        const inp = el('input', 'otl-name-edit');
        inp.value = o.name;
        inp.spellcheck = false;
        row.append(inp);
        queueMicrotask(() => { inp.focus(); inp.select(); });
        const finish = save => {
          if (save && inp.value.trim()) { o.name = inp.value.trim(); scene.revision++; this.commit('rename'); }
          this.renaming = null;
          this.sync(true);
        };
        inp.addEventListener('keydown', e => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        });
        inp.addEventListener('blur', () => finish(true));
      } else {
        const name = el('span', 'otl-name', o.name);
        name.addEventListener('dblclick', e => { e.stopPropagation(); this.renaming = o.id; this.sync(true); });
        row.append(name);
        const role = BOUNDARIES[o.boundary];
        if (role && o.boundary !== 'noslip') row.append(el('span', 'otl-role', o.boundary));
      }

      const tools = el('span', 'otl-tools');
      this.toolBtn(tools, o.visible ? 'eye' : 'eyeOff', o.visible ? 'Hide' : 'Show', () => {
        o.visible = !o.visible; scene.revision++;
        this.commit('visibility'); this.onChange(); this.sync(true);
      });
      this.toolBtn(tools, o.locked ? 'lock' : 'unlock', o.locked ? 'Unlock' : 'Lock', () => {
        o.locked = !o.locked; scene.revision++;
        this.commit('lock'); this.sync(true);
      });
      this.toolBtn(tools, 'trash', 'Delete', () => {
        scene.remove(o.id);
        this.commit('delete object'); this.onChange(); this.onSelect(); this.sync(true);
      });
      row.append(tools);

      row.addEventListener('pointerdown', e => {
        if (e.target.closest('.otl-tools') || e.target.closest('.otl-name-edit')) return;
        scene.select(o.id, e.shiftKey || e.ctrlKey || e.metaKey);
        this.onSelect(o);
        this.sync(true);
      });

      // Drag to reorder. The list is shown top-down but the scene rasterises
      // in array order, so a drop index has to be mirrored back.
      row.draggable = true;
      row.addEventListener('dragstart', e => {
        this.dragId = o.id;
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('is-drag');
      });
      row.addEventListener('dragend', () => { this.dragId = null; row.classList.remove('is-drag'); this.sync(true); });
      row.addEventListener('dragover', e => {
        if (!this.dragId || this.dragId === o.id) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        row.classList.toggle('drop-above', e.clientY < r.top + r.height / 2);
        row.classList.toggle('drop-below', e.clientY >= r.top + r.height / 2);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drop-above', 'drop-below');
        if (!this.dragId || this.dragId === o.id) return;
        const targetIdx = scene.objects.findIndex(x => x.id === o.id);
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        scene.reorder(this.dragId, above ? targetIdx + 1 : targetIdx);
        this.commit('reorder');
        this.onChange();
        this.sync(true);
      });

      this.list.append(row);
    }
  }

  toolBtn(parent, name, hint, onClick) {
    const b = el('button', 'otl-b');
    b.type = 'button';
    b.title = hint;
    b.setAttribute('aria-label', hint);
    b.append(icon(name, 13));
    b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    parent.append(b);
    return b;
  }
}
