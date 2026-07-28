/* Colour maps as 256-entry lookup tables, shared by the GPU renderer (uploaded
 * as a 256x1 texture), the Canvas2D fallback, and the colour bar. */

function ramp(stops) {
  const lut = new Uint8Array(256 * 3);
  const segs = stops.length - 1;
  for (let n = 0; n < 256; n++) {
    const f = (n / 255) * segs;
    const lo = Math.min(segs - 1, f | 0);
    const t = f - lo;
    const a = stops[lo], b = stops[lo + 1];
    lut[n * 3] = a[0] + t * (b[0] - a[0]);
    lut[n * 3 + 1] = a[1] + t * (b[1] - a[1]);
    lut[n * 3 + 2] = a[2] + t * (b[2] - a[2]);
  }
  return lut;
}

/* Perceptually smoother than a raw rainbow: monotone lightness through the
 * ramp so speed differences read correctly in greyscale too. */
export const SPEED = ramp([
  [ 12,  22,  62],
  [ 22,  78, 148],
  [ 26, 140, 162],
  [ 84, 182, 120],
  [214, 194,  74],
  [226, 122,  48],
  [186,  46,  44],
]);

/* Diverging blue-white-red, the standard convention for pressure. */
export const DIVERGING = ramp([
  [ 30,  70, 160],
  [ 96, 152, 205],
  [200, 216, 230],
  [242, 240, 236],
  [232, 190, 168],
  [206, 118,  86],
  [158,  38,  38],
]);

/* Rotation (cool) vs strain (warm) for the Q-criterion. */
export const QCRIT = ramp([
  [212, 138,  40],
  [232, 200, 148],
  [242, 240, 236],
  [140, 196, 218],
  [ 26, 122, 186],
]);

export const VORTICITY = ramp([
  [ 34,  96, 176],
  [130, 176, 214],
  [242, 240, 236],
  [222, 158, 110],
  [178,  52,  40],
]);

export const GREY = ramp([[0, 0, 0], [255, 255, 255]]);

export const MAPS = { SPEED, DIVERGING, QCRIT, VORTICITY, GREY };

/* Pack the maps into a single RGBA texture, one row per map. */
export const MAP_ROWS = ['SPEED', 'DIVERGING', 'QCRIT', 'VORTICITY', 'GREY'];

export function buildAtlas() {
  const rows = MAP_ROWS.length;
  const data = new Uint8Array(256 * rows * 4);
  for (let r = 0; r < rows; r++) {
    const lut = MAPS[MAP_ROWS[r]];
    for (let n = 0; n < 256; n++) {
      const o = (r * 256 + n) * 4;
      data[o] = lut[n * 3];
      data[o + 1] = lut[n * 3 + 1];
      data[o + 2] = lut[n * 3 + 2];
      data[o + 3] = 255;
    }
  }
  return { data, width: 256, height: rows };
}

export function sampleLUT(lut, t) {
  const i = (((t < 0 ? 0 : t > 1 ? 1 : t) * 255 + 0.5) | 0) * 3;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}

/* Dye emitter palette — muted so it reads against both themes. */
export const PALETTE = [
  [201, 107,  42],
  [ 74, 124, 153],
  [107,  76, 153],
  [ 61, 138,  92],
  [166,  61,  61],
];
