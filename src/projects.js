/* Project storage in localStorage, plus file import/export.
 *
 * localStorage is convenient but it is NOT a safe home for someone's work: it
 * is per-origin, silently capped at a few megabytes, and cleared by routine
 * "clear browsing data". So every project can also be downloaded as a
 * .hyperfoam.json file and loaded back, and the UI says which storage a project
 * lives in.
 *
 * Writes are quota-guarded. A failed save reports itself rather than
 * disappearing, because a save that looks like it worked and did not is worse
 * than no save button at all.
 *
 * The `cfd.*` keys and the `cfd-project` format tag are the names this app
 * shipped under. They are still read, and files saved under them still open —
 * renaming the product is not a reason to strand someone's saved work.
 */

const KEY = 'hyperfoam.projects.v1';
const LEGACY_KEY = 'cfd.projects.v1';
const LAST = 'hyperfoam.lastProject';
const LEGACY_LAST = 'cfd.lastProject';
const FORMAT = 'hyperfoam-project';
const LEGACY_FORMATS = ['cfd-project'];
const VERSION = 1;

function readIndex() {
  try {
    // Fall back to the pre-rename key so existing work keeps opening.
    const raw = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

function writeIndex(map) {
  const payload = JSON.stringify(map);
  try {
    localStorage.setItem(KEY, payload);
    return { ok: true, bytes: payload.length };
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
    return {
      ok: false,
      bytes: payload.length,
      error: quota
        ? 'Browser storage is full. Delete a project, or export this one to a file instead.'
        : `Could not save: ${err && err.message ? err.message : err}`,
    };
  }
}

export function listProjects() {
  const map = readIndex();
  return Object.entries(map)
    .map(([name, rec]) => ({
      name,
      saved: rec.saved || 0,
      objects: rec.data?.scene?.objects?.length || 0,
      bytes: JSON.stringify(rec).length,
    }))
    .sort((a, b) => b.saved - a.saved);
}

export function saveProject(name, payload) {
  if (!name || !name.trim()) return { ok: false, error: 'A project needs a name.' };
  const map = readIndex();
  map[name.trim()] = { saved: Date.now(), data: payload };
  const res = writeIndex(map);
  if (res.ok) {
    try { localStorage.setItem(LAST, name.trim()); } catch {}
  }
  return res;
}

export function loadProject(name) {
  const rec = readIndex()[name];
  if (!rec) return null;
  try { localStorage.setItem(LAST, name); } catch {}
  return rec.data;
}

export function deleteProject(name) {
  const map = readIndex();
  if (!(name in map)) return { ok: false, error: 'No such project.' };
  delete map[name];
  return writeIndex(map);
}

export function duplicateProject(name, newName) {
  const rec = readIndex()[name];
  if (!rec) return { ok: false, error: 'No such project.' };
  return saveProject(newName, structuredClone(rec.data));
}

export function lastProjectName() {
  try { return localStorage.getItem(LAST) || localStorage.getItem(LEGACY_LAST); } catch { return null; }
}

export function storageUsage() {
  const raw = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();
  return { bytes: raw.length, projects: Object.keys(readIndex()).length };
}

/* ── file import / export ───────────────────────────────────────────────── */

export function wrap(payload) {
  return { format: FORMAT, version: VERSION, created: new Date().toISOString(), ...payload };
}

export function download(name, payload) {
  const text = JSON.stringify(wrap(payload), null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(name || 'scene').replace(/[^\w.-]+/g, '_')}.hyperfoam.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* Prompts for a file and resolves to the parsed payload. */
export function pickFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          if (data.format && data.format !== FORMAT && !LEGACY_FORMATS.includes(data.format)) {
            reject(new Error(`Not a HyperFOAM project file (format "${data.format}").`));
            return;
          }
          resolve({ name: file.name.replace(/\.(hyperfoam|cfd)\.json$|\.json$/i, ''), data });
        } catch (err) {
          reject(new Error('That file is not valid JSON.'));
        }
      };
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsText(file);
    });
    input.click();
  });
}

/* Prompts for a file and resolves to an ArrayBuffer, for binary formats this
 * module does not own — STL, currently. */
export function pickBinary(accept) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name.replace(/\.[^.]+$/, ''), data: reader.result });
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsArrayBuffer(file);
    });
    input.click();
  });
}

/* Prompts for a file and resolves to its raw text, for formats this module
 * does not own — SVG, currently. */
export function pickText(accept) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name.replace(/\.[^.]+$/, ''), text: String(reader.result) });
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsText(file);
    });
    input.click();
  });
}
