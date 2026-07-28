/* Monochrome line icons, inline SVG.
 *
 * Inline rather than a sprite sheet or an icon font: the page must make no
 * external requests, and `currentColor` lets a single definition follow every
 * hover, disabled and selected state without a second asset.
 *
 * All paths are drawn on a 16x16 grid with a 1.5px stroke so they stay crisp
 * at the sizes the toolbar and outliner use.
 */

const P = {
  // tools
  select:   'M3 2l9 6-4 1 2.5 4.5-1.7 1L6.3 9 3.6 11z',
  move:     'M8 1.5v13M1.5 8h13M8 1.5L6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2',
  rotate:   'M13 8a5 5 0 1 1-1.8-3.8M13 1.5v3.2h-3.2',
  scale:    'M2.5 13.5h5m-5 0v-5m0 5L8 8M13.5 2.5h-4m4 0v4m0-4L10 6',
  brush:    'M11.5 2.2l2.3 2.3-6.4 6.4-3 .7.7-3zM4 11.6c-1 1-.9 2.2-2.5 2.9 1.8.5 3.4-.2 3.9-1.4',
  eraser:   'M6.5 13.5H13M2.8 10.2l4.6-4.6 4 4-3.4 3.4H4.9zM6.4 6.4l4 4',
  rect:     'M2.5 3.5h11v9h-11z',
  circle:   'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  polygon:  'M8 2l5.5 4-2.1 6.5h-6.8L2.5 6z',
  line:     'M2.5 12.5L13.5 3.5M2.5 12.5h2m9-9v2',
  fill:     'M7 2.5l5.5 5.5-4.5 4.5L2.5 7zM13.5 10c.8 1.2 1 1.9 1 2.4a1 1 0 0 1-2 0c0-.5.2-1.2 1-2.4z',
  emitter:  'M2.5 8h7M9.5 8L7 5.5M9.5 8L7 10.5M12 4.5v7',
  probe:    'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 5.5A2.5 2.5 0 1 0 8 10.5a2.5 2.5 0 0 0 0-5z',

  // outliner / object types
  eye:      'M8 4C4.5 4 2 8 2 8s2.5 4 6 4 6-4 6-4-2.5-4-6-4zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  eyeOff:   'M3 3l10 10M6.2 6.3A1.8 1.8 0 0 0 8 9.8c.5 0 .9-.2 1.3-.5M4.6 4.9C3 6.2 2 8 2 8s2.5 4 6 4c1 0 1.9-.3 2.7-.7M7 4.1A6 6 0 0 1 8 4c3.5 0 6 4 6 4s-.5.9-1.5 1.8',
  lock:     'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  unlock:   'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 3.9-.5',
  trash:    'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9M7 7v4M9 7v4',
  wing:     'M2 10.5c4-.5 8-2.5 12-6.5-1 5-5 7.5-12 6.5z',
  folder:   'M2 4.5h4l1.2 1.5H14v7.5H2z',
  dot:      'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',

  // property tabs
  tool:     'M10.5 2.5a3.2 3.2 0 0 0-3 4.2L3 11.2v2.3h2.3l4.5-4.5a3.2 3.2 0 1 0 .7-6.5z',
  scene:    'M2.5 12.5l4-6 2.8 4 2-2.8 2.2 4.8zM11 3.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
  physics:  'M8 3.2c3.6 0 6.3 1 6.3 2.2S11.6 7.6 8 7.6 1.7 6.6 1.7 5.4 4.4 3.2 8 3.2zM8 3.2v9.6M4 5.4c0 3 1.8 7.4 4 7.4s4-4.4 4-7.4',
  view:     'M2 13V3h5M14 3v10H9M4.5 10.5l3-3 2 2 2.5-3.5',
  object:   'M8 1.8l5.5 3.2v6L8 14.2 2.5 11V5zM8 1.8v12.4M2.5 5L8 8l5.5-3',
  render:   'M2.5 3.5h11v9h-11zM6 6.5l4 2.5-4 2.5z',
  output:   'M8 2v7M8 9L5.5 6.5M8 9l2.5-2.5M2.5 11v2.5h11V11',

  // misc
  play:     'M4.5 2.8l8 5.2-8 5.2z',
  pause:    'M5 3h2.2v10H5zM8.8 3H11v10H8.8z',
  expand:   'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  chevron:  'M5.5 3.5L10 8l-4.5 4.5',
  down:     'M3.5 5.5L8 10l4.5-4.5',
  plus:     'M8 3v10M3 8h10',
  undo:     'M4 7.5h6.2a3 3 0 0 1 0 6H7M4 7.5l2.8-2.8M4 7.5l2.8 2.8',
  redo:     'M12 7.5H5.8a3 3 0 0 0 0 6H9M12 7.5L9.2 4.7M12 7.5L9.2 10.3',
};

export const ICON_NAMES = Object.keys(P);

/* Returns an <svg> element. Filled icons (solid glyphs) are listed explicitly;
 * everything else strokes. */
const FILLED = new Set(['play', 'pause', 'select', 'dot', 'wing']);

export function icon(name, size = 16) {
  const d = P[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icn');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d || P.dot);
  if (FILLED.has(name)) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

/* Icon for a scene object, chosen from its shape type. */
export function objectIcon(type) {
  return icon({ rect: 'rect', ellipse: 'circle', polygon: 'polygon', polyline: 'line', naca: 'wing' }[type] || 'dot', 14);
}
