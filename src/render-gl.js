/* WebGL2 field renderer.
 *
 * The grid is uploaded as a set of single-channel float textures and the
 * fragment shader evaluates the visualisation at EVERY OUTPUT PIXEL, sampling
 * the field bilinearly. That is the whole point: visual resolution becomes the
 * canvas resolution rather than the grid resolution, so a 256x128 simulation
 * fills a 2560x1280 device-pixel canvas with a smooth field instead of visible
 * cells. Replicating each cell into a block of identical pixels on the CPU —
 * the obvious approach — costs more and adds no information.
 *
 * Derived quantities (vorticity, Q-criterion, schlieren) are differenced in
 * the shader from bilinear samples, so they stay smooth under magnification.
 *
 * Textures are single-channel to avoid a per-frame interleave pass, and each
 * one is uploaded only when the active mode actually reads it. The solid mask
 * is uploaded only when the geometry changes.
 */

import { buildAtlas, MAP_ROWS } from './colormaps.js';

export const MODES = {
  speed: 0, pressure: 1, vorticity: 2, schlieren: 3,
  qcriterion: 4, mach: 5, density: 6, dye: 7,
};

/* Which colour map each mode uses, and the floors that keep a normalisation
 * from dividing by ~zero on a still field.
 *
 * Exported because the WebGPU backend needs exactly these values. Two copies
 * would be two renderers that agree today and disagree after the next mode is
 * added — the kind of drift tests/orient.mjs exists to catch, found the hard
 * way. Shared here so there is nothing to keep in sync. */
export const ROW_FOR_MODE = {
  0: 'SPEED', 1: 'DIVERGING', 2: 'VORTICITY', 3: 'GREY',
  4: 'QCRIT', 5: 'SPEED', 6: 'DIVERGING', 7: 'SPEED',
};
export const NORM_FLOOR = {
  speed: 1e-4, press: 1e-8, curl: 1e-6, grad: 1e-8, q: 1e-8,
};

const VERT = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  // Full-screen triangle. GLSL ES 3.00 has no implicit int->float conversion,
  // so the components must be cast explicitly.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));

  // FLIP Y. Clip space runs +y UP, while the grid arrays and the 2D overlay
  // canvas both run +y DOWN. Passing p through unflipped maps the top of the
  // screen to grid row ny instead of row 1, so the whole field renders
  // upside down while the overlays sit the right way up — geometry appears
  // mirrored about the horizontal centreline relative to where it was drawn.
  // Symmetric scenarios hide it completely, which is how it survived this
  // long. Guarded by a test; see phaseC orientation checks.
  vUV = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uU, uV, uP, uRho;
uniform sampler2D uSolid;
uniform sampler2D uWater;
uniform sampler2D uDye;
uniform sampler2D uLUT;

uniform ivec2 uDims;        // padded texture size (nx+2, ny+2)
uniform vec2  uGrid;        // (nx, ny)
uniform int   uMode;
uniform int   uLutRow;
uniform float uInvSpeed, uInvPress, uInvCurl, uInvGrad, uInvQ, uSound;
uniform vec3  uBg, uBody;
uniform float uDyeOverlay;
uniform float uLight;
uniform float uWaterOn;
uniform vec3 uWaterCol;

vec2 toTexel(vec2 uv) { return vec2(0.5) + uv * uGrid; }

float fetch1(sampler2D t, vec2 q) {
  vec2 i0 = floor(q);
  vec2 f  = q - i0;
  ivec2 hi = uDims - ivec2(1);
  ivec2 b  = clamp(ivec2(i0), ivec2(0), hi - ivec2(1));
  float s00 = texelFetch(t, b, 0).r;
  float s10 = texelFetch(t, b + ivec2(1, 0), 0).r;
  float s01 = texelFetch(t, b + ivec2(0, 1), 0).r;
  float s11 = texelFetch(t, b + ivec2(1, 1), 0).r;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

vec3 fetch3(sampler2D t, vec2 q) {
  vec2 i0 = floor(q);
  vec2 f  = q - i0;
  ivec2 hi = uDims - ivec2(1);
  ivec2 b  = clamp(ivec2(i0), ivec2(0), hi - ivec2(1));
  vec3 s00 = texelFetch(t, b, 0).rgb;
  vec3 s10 = texelFetch(t, b + ivec2(1, 0), 0).rgb;
  vec3 s01 = texelFetch(t, b + ivec2(0, 1), 0).rgb;
  vec3 s11 = texelFetch(t, b + ivec2(1, 1), 0).rgb;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

vec3 lut(float t) {
  t = clamp(t, 0.0, 1.0);
  float row = (float(uLutRow) + 0.5) / float(textureSize(uLUT, 0).y);
  return texture(uLUT, vec2(t, row)).rgb;
}

void main() {
  vec2 q = toTexel(vUV);
  vec3 col;

  if (uMode == 0) {                       // speed
    float u = fetch1(uU, q), v = fetch1(uV, q);
    col = lut(length(vec2(u, v)) * uInvSpeed);

  } else if (uMode == 1) {                // pressure
    col = lut(0.5 + 0.5 * clamp(fetch1(uP, q) * uInvPress, -1.0, 1.0));

  } else if (uMode == 2) {                // vorticity
    float dvdx = 0.5 * (fetch1(uV, q + vec2(1.0, 0.0)) - fetch1(uV, q - vec2(1.0, 0.0)));
    float dudy = 0.5 * (fetch1(uU, q + vec2(0.0, 1.0)) - fetch1(uU, q - vec2(0.0, 1.0)));
    // NEGATED. j runs downward, so dv/dx - du/dy is positive for CLOCKWISE
    // rotation here; every reader expects positive vorticity to turn
    // anticlockwise, so the sign is flipped for display. The solver's own
    // vorticityConfinement keeps the raw sign, needing only self-consistency.
    col = lut(0.5 + 0.5 * clamp((dudy - dvdx) * uInvCurl, -1.0, 1.0));

  } else if (uMode == 3) {                // schlieren
    float gx = 0.5 * (fetch1(uP, q + vec2(1.0, 0.0)) - fetch1(uP, q - vec2(1.0, 0.0)));
    float gy = 0.5 * (fetch1(uP, q + vec2(0.0, 1.0)) - fetch1(uP, q - vec2(0.0, 1.0)));
    float t  = 1.0 - exp(-3.5 * clamp(length(vec2(gx, gy)) * uInvGrad, 0.0, 1.0));
    col = vec3(uLight > 0.5 ? 1.0 - t : t);

  } else if (uMode == 4) {                // Q-criterion
    float dudx = 0.5 * (fetch1(uU, q + vec2(1.0, 0.0)) - fetch1(uU, q - vec2(1.0, 0.0)));
    float dudy = 0.5 * (fetch1(uU, q + vec2(0.0, 1.0)) - fetch1(uU, q - vec2(0.0, 1.0)));
    float dvdx = 0.5 * (fetch1(uV, q + vec2(1.0, 0.0)) - fetch1(uV, q - vec2(1.0, 0.0)));
    float dvdy = 0.5 * (fetch1(uV, q + vec2(0.0, 1.0)) - fetch1(uV, q - vec2(0.0, 1.0)));
    float w   = 0.5 * (dvdx - dudy);
    float sQ  = dudx * dudx + dvdy * dvdy + 0.5 * (dudy + dvdx) * (dudy + dvdx);
    float Q   = 0.5 * (2.0 * w * w - sQ);
    float t   = 1.0 - exp(-4.0 * clamp(abs(Q) * uInvQ, 0.0, 1.0));
    col = lut(0.5 + 0.5 * (Q >= 0.0 ? t : -t));

  } else if (uMode == 5) {                // Mach
    float u = fetch1(uU, q), v = fetch1(uV, q);
    col = lut(clamp(length(vec2(u, v)) / max(uSound, 1e-4) * 0.5, 0.0, 1.0));

  } else if (uMode == 6) {                // density
    col = lut(0.5 + 0.5 * clamp((fetch1(uRho, q) - 1.0) * 3.0, -1.0, 1.0));

  } else {                                // dye
    vec3 d = fetch3(uDye, q);
    float a = clamp(max(max(d.r, d.g), d.b) * 1.6, 0.0, 1.0);
    col = mix(uBg, d / max(max(max(d.r, d.g), d.b), 1e-3), sqrt(a));
  }

  if (uMode != 7 && uDyeOverlay > 0.5) {
    vec3 d = fetch3(uDye, q);
    float a = clamp(max(max(d.r, d.g), d.b) * 1.4, 0.0, 1.0);
    col = mix(col, d / max(max(max(d.r, d.g), d.b), 1e-3), a * 0.75);
  }

  /* Free surface.
   *
   * The fill fraction is already an anti-aliased description of where the water
   * is — it is fractional precisely at the interface — so a smoothstep across
   * the half-full contour gives a clean surface for free, at output-pixel
   * resolution rather than cell resolution.
   *
   * The field underneath is kept, tinted rather than replaced, so speed or
   * pressure inside the water is still readable. A narrow band either side of
   * the contour is brightened to draw the surface line itself, which is what
   * the eye actually tracks when watching a wave.
   */
  if (uWaterOn > 0.5) {
    float wf = fetch1(uWater, q);
    float body = smoothstep(0.42, 0.58, wf);
    col = mix(col, mix(uWaterCol, col, 0.35), body);
    float band = 1.0 - smoothstep(0.0, 0.10, abs(wf - 0.5));
    col = mix(col, vec3(1.0), band * 0.55);
  }

  // Anti-aliased body edge from the interpolated solid fraction. The mask is
  // binary per cell, so interpolating it and thresholding softly removes the
  // staircase that a nearest-neighbour lookup would show.
  float cover = smoothstep(0.35, 0.62, fetch1(uSolid, q));
  col = mix(col, uBody, cover);

  fragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

export class GLRenderer {
  static create(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) return null;
    try { return new GLRenderer(gl, canvas); }
    catch (e) { console.warn('WebGL2 renderer unavailable:', e.message); return null; }
  }

  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.backend = 'webgl2';

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.vao = gl.createVertexArray();
    this.loc = {};
    for (const n of ['uU', 'uV', 'uP', 'uRho', 'uSolid', 'uDye', 'uLUT', 'uDims',
      'uGrid', 'uMode', 'uLutRow', 'uInvSpeed', 'uInvPress', 'uInvCurl',
      'uInvGrad', 'uInvQ', 'uSound', 'uBg', 'uBody', 'uDyeOverlay', 'uLight',
      'uWater', 'uWaterOn', 'uWaterCol']) {
      this.loc[n] = gl.getUniformLocation(prog, n);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.texU = this.makeTex(gl.R32F, gl.RED, gl.FLOAT);
    this.texV = this.makeTex(gl.R32F, gl.RED, gl.FLOAT);
    this.texP = this.makeTex(gl.R32F, gl.RED, gl.FLOAT);
    this.texRho = this.makeTex(gl.R32F, gl.RED, gl.FLOAT);
    this.texSolid = this.makeTex(gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texWater = this.makeTex(gl.R32F, gl.RED, gl.FLOAT);
    this.texDye = this.makeTex(gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE);

    const atlas = buildAtlas();
    this.texLUT = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texLUT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlas.width, atlas.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.dims = [0, 0];
    this.dyeStage = null;
    this.solidStage = null;
    this.solidDirty = true;
  }

  makeTex(internal, format, type) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: t, internal, format, type, w: 0, h: 0 };
  }

  /* Bind to the active unit; re-upload only when `fresh` or the size changed.
   * The binding must happen unconditionally — skipping it for a texture the
   * current mode does not read leaves that sampler pointing at whatever was
   * bound last, which some drivers treat as an incomplete-texture error for
   * the whole draw. */
  bind(slot, w, h, data, fresh) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, slot.tex);
    if (slot.w !== w || slot.h !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, slot.internal, w, h, 0, slot.format, slot.type, data);
      slot.w = w; slot.h = h;
    } else if (fresh) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, slot.format, slot.type, data);
    }
  }

  markGeometryDirty() { this.solidDirty = true; }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /* opts: { mode, stats, theme, dyeOverlay, soundSpeed } */
  draw(grid, opts) {
    const gl = this.gl;
    const W = grid.nx + 2, H = grid.ny + 2;
    const mode = MODES[opts.mode] ?? MODES.speed;
    const st = opts.stats;

    if (this.dims[0] !== W || this.dims[1] !== H) {
      this.dims = [W, H];
      this.dyeStage = new Uint8Array(W * H * 3);
      this.solidStage = new Uint8Array(W * H);
      this.solidDirty = true;
    }

    const needsUV = mode === 0 || mode === 2 || mode === 4 || mode === 5;
    const needsP = mode === 1 || mode === 3;
    const needsRho = mode === 6;
    const needsDye = mode === 7 || opts.dyeOverlay;

    gl.activeTexture(gl.TEXTURE0);
    this.bind(this.texU, W, H, grid.u, needsUV);
    gl.activeTexture(gl.TEXTURE1);
    this.bind(this.texV, W, H, grid.v, needsUV);
    gl.activeTexture(gl.TEXTURE2);
    this.bind(this.texP, W, H, grid.p, needsP);
    gl.activeTexture(gl.TEXTURE3);
    this.bind(this.texRho, W, H, grid.rho, needsRho);

    // Geometry changes rarely; re-uploading the mask every frame would be the
    // single largest constant cost here for no reason.
    gl.activeTexture(gl.TEXTURE4);
    if (this.solidDirty || this.texSolid.w !== W) {
      const s = this.solidStage, src = grid.solid;
      for (let i = 0; i < s.length; i++) s[i] = src[i] ? 255 : 0;
      this.bind(this.texSolid, W, H, s, true);
      this.solidDirty = false;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texSolid.tex);
    }

    gl.activeTexture(gl.TEXTURE5);
    if (needsDye || this.texDye.w !== W) {
      // Dye is display-only and already clamped to [0,1], so 8 bits per
      // channel is ample and costs a quarter of the float upload bandwidth.
      const d = this.dyeStage;
      const { dR, dG, dB } = grid;
      for (let i = 0, o = 0; i < dR.length; i++, o += 3) {
        const r = dR[i], g = dG[i], b = dB[i];
        d[o] = r > 1 ? 255 : r < 0 ? 0 : (r * 255) | 0;
        d[o + 1] = g > 1 ? 255 : g < 0 ? 0 : (g * 255) | 0;
        d[o + 2] = b > 1 ? 255 : b < 0 ? 0 : (b * 255) | 0;
      }
      this.bind(this.texDye, W, H, d, true);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texDye.tex);
    }

    /* Fill fraction on its own unit. Uploaded only when a free surface is
     * active — in airflow it is never sampled, so paying for the transfer every
     * frame would be pure waste. */
    gl.activeTexture(gl.TEXTURE7);
    const water = opts.water || null;
    if (water) this.bind(this.texWater, W, H, water, true);
    else this.bind(this.texWater, W, H, null, false);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const L = this.loc;
    gl.uniform1i(L.uWater, 7);
    gl.uniform1f(L.uWaterOn, water ? 1 : 0);
    const wc = opts.waterColour || [0.16, 0.42, 0.72];
    gl.uniform3f(L.uWaterCol, wc[0], wc[1], wc[2]);
    gl.uniform1i(L.uU, 0); gl.uniform1i(L.uV, 1); gl.uniform1i(L.uP, 2);
    gl.uniform1i(L.uRho, 3); gl.uniform1i(L.uSolid, 4); gl.uniform1i(L.uDye, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.texLUT);
    gl.uniform1i(L.uLUT, 6);

    gl.uniform2i(L.uDims, W, H);
    gl.uniform2f(L.uGrid, grid.nx, grid.ny);
    gl.uniform1i(L.uMode, mode);

    gl.uniform1i(L.uLutRow, MAP_ROWS.indexOf(ROW_FOR_MODE[mode]));

    gl.uniform1f(L.uInvSpeed, 1 / Math.max(st.speed, 1e-4));
    gl.uniform1f(L.uInvPress, 1 / Math.max(st.press, 1e-8));
    gl.uniform1f(L.uInvCurl, 1 / Math.max(st.curl, 1e-6));
    gl.uniform1f(L.uInvGrad, 1 / Math.max(st.grad, 1e-8));
    gl.uniform1f(L.uInvQ, 1 / Math.max(st.q, 1e-8));
    gl.uniform1f(L.uSound, opts.soundSpeed || 1);
    gl.uniform1f(L.uDyeOverlay, opts.dyeOverlay ? 1 : 0);
    gl.uniform1f(L.uLight, opts.theme.light ? 1 : 0);
    gl.uniform3fv(L.uBg, opts.theme.bg);
    gl.uniform3fv(L.uBody, opts.theme.body);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
