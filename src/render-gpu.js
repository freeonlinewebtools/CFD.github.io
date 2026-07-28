/* WebGPU field renderer.
 *
 * A port of render-gl.js, not a redesign: the same fields go up as textures,
 * the same per-output-pixel evaluation happens in the fragment stage, and the
 * same visual comes out. Keeping the two shaders line-for-line comparable is
 * deliberate — two backends that drift apart become two different products, and
 * `tests/orient.mjs` already exists because one of them once rendered upside
 * down.
 *
 * WebGL2 stays the default. WebGPU is offered, not imposed: the audience
 * includes managed school devices, where WebGPU coverage is materially worse
 * than WebGL2, and a renderer that fails to start is worse than one that is
 * merely older.
 *
 * Three differences from the WebGL2 path that are forced by the API:
 *
 *  - **Creation is asynchronous.** `requestAdapter`/`requestDevice` are
 *    promises, so this is `static async create()` and boot must await it.
 *  - **`r32float` is not filterable.** That costs nothing here, because the
 *    shader already does its own bilinear fetch from integer texel loads — the
 *    filtering it needs is the filtering it implements. Only the colour-map
 *    atlas is hardware-sampled, and rgba8unorm is filterable.
 *  - **There is no `preserveDrawingBuffer`.** A WebGPU canvas is valid to read
 *    back only until the frame is presented, so anything that captures the
 *    canvas — the PNG export and the recorder — must compose in the same task
 *    as the draw. That is already how `composeFrame` works, and `drawFor`
 *    below exists so callers cannot accidentally rely on stale contents.
 */

import { buildAtlas, MAP_ROWS } from './colormaps.js';
import { MODES, ROW_FOR_MODE, NORM_FLOOR } from './render-gl.js';

export { MODES };

const SHADER = `
struct Uniforms {
  grid       : vec2f,
  dims       : vec2f,
  mode       : f32,
  lutRow     : f32,
  invSpeed   : f32,
  invPress   : f32,
  invCurl    : f32,
  invGrad    : f32,
  invQ       : f32,
  sound      : f32,
  bg         : vec3f,
  dyeOverlay : f32,
  body       : vec3f,
  light      : f32,
  waterCol   : vec3f,
  waterOn    : f32,
};

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var texU     : texture_2d<f32>;
@group(0) @binding(2) var texV     : texture_2d<f32>;
@group(0) @binding(3) var texP     : texture_2d<f32>;
@group(0) @binding(4) var texRho   : texture_2d<f32>;
@group(0) @binding(5) var texSolid : texture_2d<f32>;
@group(0) @binding(6) var texDye   : texture_2d<f32>;
@group(0) @binding(7) var texLUT   : texture_2d<f32>;
@group(0) @binding(8) var sampLUT  : sampler;
@group(0) @binding(9) var texWater : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  // Full-screen triangle, same construction as the GL path.
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o : VSOut;
  // FLIP Y, for the same reason as the GL vertex shader: clip space runs +y up
  // while the grid arrays and the overlay canvas both run +y down. Removing
  // this renders the field upside down while overlays stay correct, which
  // symmetric scenarios hide completely. Guarded by tests/orient.mjs.
  o.uv = vec2f(p.x, 1.0 - p.y);
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn toTexel(uv : vec2f) -> vec2f { return vec2f(0.5) + uv * U.grid; }

fn fetch1(t : texture_2d<f32>, q : vec2f) -> f32 {
  let i0 = floor(q);
  let f  = q - i0;
  let hi = vec2i(U.dims) - vec2i(1);
  let b  = clamp(vec2i(i0), vec2i(0), hi - vec2i(1));
  let s00 = textureLoad(t, b,                  0).r;
  let s10 = textureLoad(t, b + vec2i(1, 0), 0).r;
  let s01 = textureLoad(t, b + vec2i(0, 1), 0).r;
  let s11 = textureLoad(t, b + vec2i(1, 1), 0).r;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

fn fetch3(t : texture_2d<f32>, q : vec2f) -> vec3f {
  let i0 = floor(q);
  let f  = q - i0;
  let hi = vec2i(U.dims) - vec2i(1);
  let b  = clamp(vec2i(i0), vec2i(0), hi - vec2i(1));
  let s00 = textureLoad(t, b,                  0).rgb;
  let s10 = textureLoad(t, b + vec2i(1, 0), 0).rgb;
  let s01 = textureLoad(t, b + vec2i(0, 1), 0).rgb;
  let s11 = textureLoad(t, b + vec2i(1, 1), 0).rgb;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

fn lut(t : f32) -> vec3f {
  let rows = f32(textureDimensions(texLUT).y);
  let row = (U.lutRow + 0.5) / rows;
  return textureSampleLevel(texLUT, sampLUT, vec2f(clamp(t, 0.0, 1.0), row), 0.0).rgb;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let q = toTexel(in.uv);
  var col : vec3f;
  let mode = i32(U.mode);

  if (mode == 0) {                        // speed
    let u = fetch1(texU, q);
    let v = fetch1(texV, q);
    col = lut(length(vec2f(u, v)) * U.invSpeed);

  } else if (mode == 1) {                 // pressure
    col = lut(0.5 + 0.5 * clamp(fetch1(texP, q) * U.invPress, -1.0, 1.0));

  } else if (mode == 2) {                 // vorticity
    let dvdx = 0.5 * (fetch1(texV, q + vec2f(1.0, 0.0)) - fetch1(texV, q - vec2f(1.0, 0.0)));
    let dudy = 0.5 * (fetch1(texU, q + vec2f(0.0, 1.0)) - fetch1(texU, q - vec2f(0.0, 1.0)));
    // NEGATED, matching render-gl.js — see the note there.
    col = lut(0.5 + 0.5 * clamp((dudy - dvdx) * U.invCurl, -1.0, 1.0));

  } else if (mode == 3) {                 // schlieren
    let gx = 0.5 * (fetch1(texP, q + vec2f(1.0, 0.0)) - fetch1(texP, q - vec2f(1.0, 0.0)));
    let gy = 0.5 * (fetch1(texP, q + vec2f(0.0, 1.0)) - fetch1(texP, q - vec2f(0.0, 1.0)));
    let t  = 1.0 - exp(-3.5 * clamp(length(vec2f(gx, gy)) * U.invGrad, 0.0, 1.0));
    let s  = select(t, 1.0 - t, U.light > 0.5);
    col = vec3f(s);

  } else if (mode == 4) {                 // Q-criterion
    let dudx = 0.5 * (fetch1(texU, q + vec2f(1.0, 0.0)) - fetch1(texU, q - vec2f(1.0, 0.0)));
    let dudy = 0.5 * (fetch1(texU, q + vec2f(0.0, 1.0)) - fetch1(texU, q - vec2f(0.0, 1.0)));
    let dvdx = 0.5 * (fetch1(texV, q + vec2f(1.0, 0.0)) - fetch1(texV, q - vec2f(1.0, 0.0)));
    let dvdy = 0.5 * (fetch1(texV, q + vec2f(0.0, 1.0)) - fetch1(texV, q - vec2f(0.0, 1.0)));
    let w  = 0.5 * (dvdx - dudy);
    let sQ = dudx * dudx + dvdy * dvdy + 0.5 * (dudy + dvdx) * (dudy + dvdx);
    let Q  = 0.5 * (2.0 * w * w - sQ);
    let t  = 1.0 - exp(-4.0 * clamp(abs(Q) * U.invQ, 0.0, 1.0));
    col = lut(0.5 + 0.5 * select(-t, t, Q >= 0.0));

  } else if (mode == 5) {                 // Mach
    let u = fetch1(texU, q);
    let v = fetch1(texV, q);
    col = lut(clamp(length(vec2f(u, v)) / max(U.sound, 1e-4) * 0.5, 0.0, 1.0));

  } else if (mode == 6) {                 // density
    col = lut(0.5 + 0.5 * clamp((fetch1(texRho, q) - 1.0) * 3.0, -1.0, 1.0));

  } else {                                // dye
    let d = fetch3(texDye, q);
    let a = clamp(max(max(d.r, d.g), d.b) * 1.6, 0.0, 1.0);
    col = mix(U.bg, d / max(max(max(d.r, d.g), d.b), 1e-3), sqrt(a));
  }

  if (mode != 7 && U.dyeOverlay > 0.5) {
    let d = fetch3(texDye, q);
    let a = clamp(max(max(d.r, d.g), d.b) * 1.4, 0.0, 1.0);
    col = mix(col, d / max(max(max(d.r, d.g), d.b), 1e-3), a * 0.75);
  }

  // Free surface — same construction as render-gl.js; see the note there.
  if (U.waterOn > 0.5) {
    let wf = fetch1(texWater, q);
    let body = smoothstep(0.42, 0.58, wf);
    col = mix(col, mix(U.waterCol, col, 0.35), body);
    let band = 1.0 - smoothstep(0.0, 0.10, abs(wf - 0.5));
    col = mix(col, vec3f(1.0), band * 0.55);
  }

  // Anti-aliased body edge from the interpolated solid fraction.
  let cover = smoothstep(0.35, 0.62, fetch1(texSolid, q));
  col = mix(col, U.body, cover);

  return vec4f(col, 1.0);
}
`;

/* Uniform block, laid out to WGSL's rules: vec3f aligns to 16 bytes, which is
 * why bg and body sit at 48 and 64 with their scalar companions tucked into the
 * padding rather than before them. */
const U_FLOATS = 24;                      // 96 bytes
const OFF = {
  grid: 0, dims: 2, mode: 4, lutRow: 5,
  invSpeed: 6, invPress: 7, invCurl: 8, invGrad: 9, invQ: 10, sound: 11,
  bg: 12, dyeOverlay: 15, body: 16, light: 19, waterCol: 20, waterOn: 23,
};

export class GPURenderer {
  static async create(canvas) {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      if (!device) return null;
      const context = canvas.getContext('webgpu');
      if (!context) return null;
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
      return new GPURenderer(device, context, format, canvas, adapter);
    } catch (e) {
      console.warn('WebGPU renderer unavailable:', e && e.message);
      return null;
    }
  }

  constructor(device, context, format, canvas, adapter) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.canvas = canvas;
    this.backend = 'webgpu';
    this.adapterInfo = (adapter && adapter.info) || null;
    // A device can be lost at any time (driver reset, tab backgrounded on some
    // platforms). Record it so the app can fall back rather than silently
    // drawing nothing forever.
    this.lost = false;
    device.lost.then(info => {
      this.lost = true;
      console.warn('WebGPU device lost:', info && info.message);
    });

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.ubuf = device.createBuffer({
      size: U_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.udata = new Float32Array(U_FLOATS);

    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const atlas = buildAtlas();
    this.texLUT = device.createTexture({
      size: [atlas.width, atlas.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.texLUT }, atlas.data,
      { bytesPerRow: atlas.width * 4 }, [atlas.width, atlas.height]);

    // Field slots, allocated lazily at first draw once the grid size is known.
    this.slots = {
      u: this.slot('r32float', 4), v: this.slot('r32float', 4),
      p: this.slot('r32float', 4), rho: this.slot('r32float', 4),
      solid: this.slot('r32float', 4), dye: this.slot('rgba8unorm', 4),
      water: this.slot('r32float', 4),
    };
    this.dims = [0, 0];
    this.bindGroup = null;
    this.solidDirty = true;
    this.solidStage = null;
    this.dyeStage = null;
  }

  slot(format, bytesPerTexel) {
    return { tex: null, view: null, format, bytesPerTexel, w: 0, h: 0 };
  }

  /* Allocate on size change, then upload when the data is fresh. Mirrors the
   * GL path's `bind`, minus the "must bind every frame" workaround — WebGPU
   * bind groups are explicit, so an unread texture cannot go stale. */
  upload(slot, w, h, data, fresh) {
    const device = this.device;
    if (slot.w !== w || slot.h !== h) {
      if (slot.tex) slot.tex.destroy();
      slot.tex = device.createTexture({
        size: [w, h],
        format: slot.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      slot.view = slot.tex.createView();
      slot.w = w; slot.h = h;
      this.bindGroup = null;               // views changed, regroup
      fresh = true;
    }
    if (fresh && data) {
      device.queue.writeTexture({ texture: slot.tex }, data,
        { bytesPerRow: w * slot.bytesPerTexel, rowsPerImage: h }, [w, h]);
    }
  }

  markGeometryDirty() { this.solidDirty = true; }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /* opts: { mode, stats, theme, dyeOverlay, soundSpeed } — identical to
   * GLRenderer.draw, so the two are interchangeable at the call site. */
  draw(grid, opts) {
    if (this.lost) return;
    const device = this.device;
    const W = grid.nx + 2, H = grid.ny + 2;
    const mode = MODES[opts.mode] ?? 0;
    const theme = opts.theme;
    const st = opts.stats;

    // The solid mask is uint8 in the grid but the shader wants a float it can
    // interpolate, so it is widened once per geometry change rather than per
    // frame — this is the only field that is not already Float32.
    if (this.solidDirty || !this.solidStage || this.solidStage.length !== W * H) {
      if (!this.solidStage || this.solidStage.length !== W * H) this.solidStage = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) this.solidStage[i] = grid.solid[i];
      this.solidDirty = false;
      this.solidFresh = true;
    }

    const needDye = mode === MODES.dye || opts.dyeOverlay;
    if (needDye) {
      if (!this.dyeStage || this.dyeStage.length !== W * H * 4) this.dyeStage = new Uint8Array(W * H * 4);
      const { dR, dG, dB } = grid;
      const s = this.dyeStage;
      for (let i = 0, o = 0; i < W * H; i++, o += 4) {
        s[o] = dR[i] * 255; s[o + 1] = dG[i] * 255; s[o + 2] = dB[i] * 255; s[o + 3] = 255;
      }
    }

    // Only the fields this mode reads are re-uploaded; the rest keep whatever
    // they had, which the shader will not sample.
    const wantsUV = mode === MODES.speed || mode === MODES.vorticity
                 || mode === MODES.qcriterion || mode === MODES.mach;
    const wantsP = mode === MODES.pressure || mode === MODES.schlieren;
    this.upload(this.slots.u, W, H, grid.u, wantsUV);
    this.upload(this.slots.v, W, H, grid.v, wantsUV);
    this.upload(this.slots.p, W, H, grid.p, wantsP);
    this.upload(this.slots.rho, W, H, grid.rho, mode === MODES.density);
    this.upload(this.slots.solid, W, H, this.solidStage, this.solidFresh);
    this.upload(this.slots.dye, W, H, needDye ? this.dyeStage : null, needDye);
    const water = opts.water || null;
    this.upload(this.slots.water, W, H, water, !!water);
    this.solidFresh = false;

    if (!this.bindGroup) {
      this.bindGroup = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.ubuf } },
          { binding: 1, resource: this.slots.u.view },
          { binding: 2, resource: this.slots.v.view },
          { binding: 3, resource: this.slots.p.view },
          { binding: 4, resource: this.slots.rho.view },
          { binding: 5, resource: this.slots.solid.view },
          { binding: 6, resource: this.slots.dye.view },
          { binding: 7, resource: this.texLUT.createView() },
          { binding: 8, resource: this.sampler },
          { binding: 9, resource: this.slots.water.view },
        ],
      });
    }

    const d = this.udata;
    d[OFF.grid] = grid.nx; d[OFF.grid + 1] = grid.ny;
    d[OFF.dims] = W; d[OFF.dims + 1] = H;
    d[OFF.mode] = mode;
    d[OFF.lutRow] = MAP_ROWS.indexOf(ROW_FOR_MODE[mode]);
    d[OFF.invSpeed] = 1 / Math.max(st.speed, NORM_FLOOR.speed);
    d[OFF.invPress] = 1 / Math.max(st.press, NORM_FLOOR.press);
    d[OFF.invCurl] = 1 / Math.max(st.curl, NORM_FLOOR.curl);
    d[OFF.invGrad] = 1 / Math.max(st.grad, NORM_FLOOR.grad);
    d[OFF.invQ] = 1 / Math.max(st.q, NORM_FLOOR.q);
    d[OFF.sound] = opts.soundSpeed || 1;
    d[OFF.bg] = theme.bg[0]; d[OFF.bg + 1] = theme.bg[1]; d[OFF.bg + 2] = theme.bg[2];
    d[OFF.dyeOverlay] = opts.dyeOverlay ? 1 : 0;
    d[OFF.body] = theme.body[0]; d[OFF.body + 1] = theme.body[1]; d[OFF.body + 2] = theme.body[2];
    d[OFF.light] = theme.light ? 1 : 0;
    const wc = opts.waterColour || [0.16, 0.42, 0.72];
    d[OFF.waterCol] = wc[0]; d[OFF.waterCol + 1] = wc[1]; d[OFF.waterCol + 2] = wc[2];
    d[OFF.waterOn] = water ? 1 : 0;
    device.queue.writeBuffer(this.ubuf, 0, d);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
