/* Menu bar with dropdowns.
 *
 * Menus are declared as data so the keymap and the menu can be generated from
 * one source — a shortcut printed next to an item is the shortcut that is
 * actually bound, and neither can drift from the other.
 */

import { el } from './widgets.js';
import { icon } from './icons.js';

export class MenuBar {
  constructor(root) {
    this.root = root;
    this.menus = [];
    this.open = null;
    this._onDocDown = e => { if (!this.root.contains(e.target)) this.close(); };
    document.addEventListener('pointerdown', this._onDocDown);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
  }

  /* items: [{label, shortcut, action, enabled(), checked(), separator, submenuOf}] */
  add(title, itemsFn) {
    const btn = el('button', 'mb-t', title);
    btn.type = 'button';
    const drop = el('div', 'mb-d');
    drop.hidden = true;

    const entry = { title, btn, drop, itemsFn };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.open === entry ? this.close() : this.show(entry);
    });
    // Blender behaviour: once a menu is open, hovering another opens it.
    btn.addEventListener('pointerenter', () => { if (this.open && this.open !== entry) this.show(entry); });

    this.root.append(btn, drop);
    this.menus.push(entry);
    return entry;
  }

  show(entry) {
    this.close();
    const items = entry.itemsFn();
    entry.drop.textContent = '';
    for (const it of items) {
      if (it.separator) { entry.drop.append(el('div', 'mb-sep')); continue; }
      const row = el('button', 'mb-i');
      row.type = 'button';
      const enabled = it.enabled ? it.enabled() : true;
      row.disabled = !enabled;
      const check = el('span', 'mb-c');
      if (it.checked && it.checked()) check.append(icon('select', 11));
      row.append(check, el('span', 'mb-lbl', it.label));
      if (it.shortcut) row.append(el('span', 'mb-k', it.shortcut));
      if (enabled) {
        row.addEventListener('click', () => { this.close(); it.action(); });
      }
      entry.drop.append(row);
    }
    entry.drop.hidden = false;
    entry.btn.classList.add('is-on');
    const r = entry.btn.getBoundingClientRect();
    entry.drop.style.left = `${r.left}px`;
    this.open = entry;
  }

  close() {
    if (!this.open) return;
    this.open.drop.hidden = true;
    this.open.btn.classList.remove('is-on');
    this.open = null;
  }
}
