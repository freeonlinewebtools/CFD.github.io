/* Icon-tabbed properties editor.
 *
 * Tabs declare a build function that is re-run when the tab is shown or when
 * the app marks it stale. Rebuilding beats patching for panels whose contents
 * depend on the selection: an object tab has to change shape entirely when a
 * rectangle is selected instead of an aerofoil, and diffing that is more code
 * and more ways to be wrong than simply rebuilding a few dozen nodes.
 */

import { el } from './widgets.js';
import { icon } from './icons.js';

export class Properties {
  constructor(tabsRoot, bodyRoot) {
    this.tabsRoot = tabsRoot;
    this.bodyRoot = bodyRoot;
    this.tabs = [];
    this.active = null;
  }

  addTab(id, iconName, title, build, opts = {}) {
    const btn = el('button', 'pt-b');
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.append(icon(iconName, 15));
    btn.addEventListener('click', () => this.show(id));
    this.tabsRoot.append(btn);
    const tab = { id, btn, title, build, hidden: !!opts.hidden, stale: true };
    if (tab.hidden) btn.hidden = true;
    this.tabs.push(tab);
    if (!this.active && !tab.hidden) this.show(id);
    return tab;
  }

  /* A hairline between groups of tabs.
   *
   * Nine icon buttons in an unbroken row read as one undifferentiated strip,
   * and which glyph does what has to be learned by clicking each in turn.
   * Splitting them into setup / geometry / output gives the eye somewhere to
   * start, and costs a single element per boundary. */
  addSeparator() {
    this.tabsRoot.append(el('div', 'pt-sep'));
  }

  get(id) { return this.tabs.find(t => t.id === id); }

  setTabVisible(id, visible) {
    const t = this.get(id);
    if (!t) return;
    t.hidden = !visible;
    t.btn.hidden = !visible;
    if (!visible && this.active === id) {
      const next = this.tabs.find(x => !x.hidden);
      if (next) this.show(next.id);
    }
  }

  show(id) {
    const tab = this.get(id);
    if (!tab || tab.hidden) return;
    this.active = id;
    for (const t of this.tabs) t.btn.classList.toggle('is-on', t.id === id);
    this.render();
  }

  /* Mark a tab's contents out of date. Re-renders immediately if it is the one
   * on screen, otherwise defers until it is shown. */
  invalidate(id) {
    const t = id ? this.get(id) : null;
    if (t) t.stale = true; else for (const x of this.tabs) x.stale = true;
    if (!id || this.active === id) this.render();
  }

  render() {
    const tab = this.get(this.active);
    if (!tab) return;
    this.bodyRoot.textContent = '';
    this.bodyRoot.scrollTop = 0;
    /* Name the visible tab.
     *
     * The strip is nine 15px glyphs with similar silhouettes, and which one is
     * active was carried only by a faint background change. Tooltips do not
     * help someone scanning the panel to work out where they are. This is the
     * same caps micro-label the outliner header already uses, so it reads as
     * part of the existing chrome rather than as a new kind of heading. */
    this.bodyRoot.append(el('div', 'pt-title', tab.title));
    tab.build(this.bodyRoot);
    tab.stale = false;
  }
}
