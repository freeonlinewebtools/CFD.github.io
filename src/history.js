/* Undo / redo over the scene document.
 *
 * Snapshot-based rather than per-operation inverse commands. Scenes are tens
 * of objects of plain data, so a snapshot is a few kilobytes, and the approach
 * cannot drift out of sync the way hand-written revert functions do when a new
 * operation forgets to record part of what it touched. That failure mode is
 * subtle, appears only after several undos, and corrupts the user's work —
 * which is not a good trade for the memory saved.
 *
 * Consecutive edits of the same kind to the same object coalesce, so dragging
 * a slider or a handle produces one undo step rather than several hundred.
 */

import { objectsFromJSON } from './scene.js';

const LIMIT = 100;
const COALESCE_MS = 600;

export class History {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.limit = opts.limit || LIMIT;
    this.now = () => (opts.now ? opts.now() : Date.now());
    this.stack = [{ label: 'initial', data: scene.toJSON(), key: null, t: 0 }];
    this.index = 0;
    this.onChange = opts.onChange || null;
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get undoLabel() { return this.canUndo ? this.stack[this.index].label : null; }
  get redoLabel() { return this.canRedo ? this.stack[this.index + 1].label : null; }

  /* Record the scene's CURRENT state as a new step. Call after mutating.
   *
   * `key` identifies a coalescable run — pass something like
   * `move:o3` while dragging, and null for discrete actions. */
  commit(label, key = null) {
    const t = this.now();
    const top = this.stack[this.index];

    if (key && top && top.key === key && (t - top.t) < COALESCE_MS) {
      top.data = this.scene.toJSON();
      top.t = t;
      this.notify();
      return false;
    }

    // A new edit after undoing discards the redo tail.
    this.stack.length = this.index + 1;
    this.stack.push({ label, data: this.scene.toJSON(), key, t });
    if (this.stack.length > this.limit + 1) {
      this.stack.shift();
    }
    this.index = this.stack.length - 1;
    this.notify();
    return true;
  }

  /* Run a mutation and record it in one call. */
  run(label, fn, key = null) {
    const result = fn(this.scene);
    this.commit(label, key);
    return result;
  }

  undo() {
    if (!this.canUndo) return false;
    this.index--;
    this.restore();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.index++;
    this.restore();
    return true;
  }

  /* Restore in place: the caller holds a reference to the Scene, so replacing
   * the instance would leave every holder pointing at a stale document. */
  restore() {
    const data = this.stack[this.index].data;
    const s = this.scene;
    const keep = new Set(s.selection);
    s.objects.length = 0;
    const restored = sceneFromJSON(data);
    for (const o of restored) s.objects.push(o);
    s.nx = data.domain?.nx ?? s.nx;
    s.ny = data.domain?.ny ?? s.ny;
    s.selection.clear();
    for (const id of keep) if (s.objects.some(o => o.id === id)) s.selection.add(id);
    s.revision++;
    this.notify();
  }

  reset(label = 'initial') {
    this.stack = [{ label, data: this.scene.toJSON(), key: null, t: this.now() }];
    this.index = 0;
    this.notify();
  }

  notify() { if (this.onChange) this.onChange(this); }
}

const sceneFromJSON = objectsFromJSON;
