/* ============================================
   Fluid Dynamics — Standalone CFD Simulator
   Navier-Stokes (Stam) + Lattice Boltzmann (D2Q9-TRT)
   ============================================ */
'use strict';

/* ── Shared State (standalone) ── */
let globalPaused = false;

/* ── Canvas Setup ── */
function makeCanvas(canvasId, wrapId) {
  const canvas = document.getElementById(canvasId);
  const wrap = document.getElementById(wrapId);
  const resize = () => {
    canvas.width  = Math.max(1, wrap.clientWidth);
    canvas.height = Math.max(1, wrap.clientHeight);
  };
  resize();
  new ResizeObserver(resize).observe(wrap);
  return canvas;
}

/* ── Save Canvas ── */
function savePNG(canvasId, name) {
  const a = document.createElement('a');
  a.download = (name || 'fluid') + '.png';
  a.href = document.getElementById(canvasId).toDataURL();
  a.click();
}

/* ── Standalone: always active ── */
function isModuleActive() { return true; }

var FL = {
  canvas: null, ctx: null,
  offscreen: null, offCtx: null,
  _inited: false, paused: false,
  last: performance.now(), _fps0: performance.now(), fc: 0, fps: 60,

  N:  192,   // internal grid – 192² balances crisp wakes with real-time perf
  dt: 0.12,

  visc:       0.00010,
  diff:       0.00005,
  vortStrength: 8,
  densityFade:  0.992,
  brushRadius:  20,
  brushForce:   200,
  gravity:      0,
  solverIters:  14,
  timeScale:    1.0,

  // Solver mode: Navier-Stokes (Stam) or Lattice Boltzmann (D2Q9-BGK)
  solverMode: 'navier-stokes', // 'navier-stokes' | 'lbm'

  // ── Lattice Boltzmann D2Q9-BGK solver fields ──
  _lbmF: null,              // 9 Float32Arrays — distribution functions
  _lbmTau: 0.55,            // relaxation time (kinematic viscosity ν = (τ−0.5)/3)
  _lbmStepsPerFrame: 10,    // sub-steps per rendered frame (higher = faster flow)
  _lbmInited: false,

  turbulenceModel: true,   // Smagorinsky SGS sub-grid scale model (LES)
  _smagConst: 0.15,        // Cs — Smagorinsky constant (0.10–0.20 typical)
  _eddyVisc: null,         // spatially varying turbulent eddy viscosity νt(x,y)
  _meanEddyVisc: 0,        // domain-averaged νt for diagnostics
  _effectiveVisc: 0,        // ν_eff = ν + <νt> total dissipation
  _hasObstacles: false, // cached flag — avoids per-cell obstacle check in solver when empty

  // Multigrid V-cycle storage (allocated in _initMultigrid)
  _mgLevels: null,
  _mgDirty: true,

  colorMode: 'jet',     // 'jet'|'pressure'|'smoke'|'vorticity'|'schlieren'|'qcriterion'
  showVelField: false,
  showStreamlines: false,
  showVortTint: false,   // off by default — jet/pressure carry the info

  // Lagrangian particle tracer
  showParticles: false,
  _particles: null,
  _particleMax: 1200,
  _particleTrailLen: 12,
  _particleFade: true,   // fade trail opacity

  // Schlieren / Q-criterion adaptive normalisation
  _maxGrad: 0.01,
  _maxQ: 0.01,

  // Adaptive CFL-based time stepping
  adaptiveDt: false,
  _targetCFL: 0.45,  // target CFL number for adaptive stepping
  _dtMin: 0.02,
  _dtMax: 0.40,

  // Interaction mode
  interactMode: 'paint', // 'paint' | 'obstacle' | 'erase' | 'inlet' | 'eraseInlet'

  // Drawable inlets / stream sources — persistent velocity+dye emitters
  // Each: { i, j, ux, uy, cr, cg, cb, radius, strength }
  inlets: [],
  _inletColorIdx: 0,       // cycles palette for each new inlet
  _inletDirAngle: 0,       // radians — direction set by drag

  // Wind tunnel
  windTunnel: false,
  windSpeed:  120,
  wakeDecay:  0.82,   // outlet sponge: fraction of density cleared each frame at right wall

  // Compressible flow mode
  compressible: false,
  speedOfSound: 8.0,   // c_s — controls compressibility (higher = more incompressible-like)
  _machNumber: 0,      // current max Mach number
  _maxDensRatio: 1,    // max ρ/ρ₀ for rendering
  rho: null,           // fluid density field (only used in compressible mode)
  rho0: null,          // density buffer

  // DOM element cache — avoids getElementById per frame
  _elCache: {},

  // Obstacle bitmask: 1=solid, 0=fluid
  obstacles: null,
  // Pressure scalar field (computed by _project, kept for rendering)
  pressure: null,

  // Maximum speed seen this frame — used to normalise jet colormap
  _maxSpeed: 1,

  // Pre-computed jet colormap LUT (256 entries × 3 channels)
  _jetLUT: null,
  // Diverging blue-white-red LUT for pressure (standard CFD convention)
  _bwrLUT: null,

  // Pressure contour lines overlay
  showContours: false,

  // Mouse probe — shows local field values under cursor
  _probeI: -1, _probeJ: -1,
  _probeU: 0, _probeV: 0, _probeP: 0, _probeVort: 0, _probeMag: 0,

  // Active scenario name (for HUD display)
  _activeScenario: '',

  // Aero coefficients (wind tunnel only)
  _liftCoeff: 0,
  _dragCoeff: 0,
  _reynoldsNum: 0,

  // Educational stats
  _kineticEnergy: 0,
  _enstrophy: 0,
  _cflNumber: 0,
  _strouhalNum: 0,
  _flowRegime: 'N/A',

  // Strouhal number tracking (vortex shedding frequency)
  _sheddingTracker: null,

  // Scenario descriptions for educational presets
  _scenarioDesc: {
    cylinder: 'Flow past a circular cylinder — the classic demonstration of Kármán vortex shedding. At low Re, flow stays attached (steady). As Re increases (~47+), alternating vortices shed from each side, creating the famous vortex street. Watch how the Strouhal number relates shedding frequency to flow speed.',
    plate: 'Flow past a flat plate normal to the flow — maximum drag geometry. Flow separates at both edges, creating a broad turbulent wake. Compare the drag coefficient to the cylinder —  this shape has ~3× more drag due to the blunt separation.',
    wedge: 'Flow past a wedge/ramp — demonstrates gradual flow expansion and separation behind a bluff body. The tapered leading edge allows partial attachment before separation occurs at the trailing corners.',
    airfoil: 'NACA 0012 symmetric airfoil at 0° angle of attack. Produces no lift (symmetric!) but minimal drag thanks to its streamlined shape. Increase wind speed to see the boundary layer thin and the wake narrow. Compare C_D to the cylinder.',
    'airfoil-cambered': 'NACA 2412 cambered airfoil at 4° AoA — generates positive lift! The camber (curved centreline) and angle of attack create lower pressure above and higher pressure below. Watch the pressure distribution and stagnation point shift with speed.',
    square: 'Flow past a square cylinder — bluff body with fixed separation points at the sharp corners. Produces wider wake and higher drag than a circular cylinder. The vortex shedding frequency (Strouhal number) differs from the round case.',
    backstep: 'Backward-facing step — a classic CFD benchmark. Flow separates at the step edge and reattaches downstream, forming a recirculation bubble. The reattachment length depends on Reynolds number. This geometry is used to validate CFD codes worldwide.',
    tandem: 'Two cylinders in tandem — wake interaction study. The downstream cylinder sits in the wake of the upstream one, experiencing reduced drag ("drafting"). At certain spacings, the wakes lock into synchronised shedding patterns.',
    venturi: 'Venturi tube — demonstrates the Bernoulli principle. The constriction accelerates the fluid (higher velocity = lower pressure). Watch the pressure drop in the throat and recover downstream. Used in flowmeters, carburettors, and medical devices.',
    diffuser: 'Diverging channel (diffuser) — the opposite of a Venturi. Flow decelerates and pressure recovers. If the expansion angle is too large, the adverse pressure gradient causes flow separation from the walls — a key design challenge in engineering.',
    nozzle: 'Converging channel (nozzle) — accelerates flow smoothly. Unlike the diffuser, nozzles are inherently stable because the favourable pressure gradient keeps the boundary layer attached. Compare to the diffuser to see why expansion is harder than contraction.',
    'jet-impinge': 'Impinging jet — a round jet strikes a flat wall and spreads radially. This configuration appears in cooling systems, drying processes, and rocket launches. Watch the stagnation point form where the jet hits, and pressure build up on the wall.',
    mixing: 'Mixing chamber — two opposing inlets collide, creating intense turbulent mixing. This is the basis of many chemical reactors and combustion chambers. Watch how the counter-flowing streams produce complex vortex structures at their interface.',
    crossflow: 'Jet in crossflow — a vertical jet enters a horizontal stream. This fundamental interaction appears in chimney plumes, fuel injection, and film cooling. The jet bends in the crosswind, creates a kidney-shaped vortex pair, and sheds a wake.',
    'fountain': 'Fountain flow — two opposing jets collide head-on, forcing fluid outward perpendicular to the jet axes. Creates a beautiful symmetric flow pattern with a stagnation region at the centre.',
    'lid-cavity': 'Lid-driven cavity — the most-studied benchmark in computational fluid dynamics. A sealed square box with the top "lid" sliding at constant velocity. At low Re, a single large primary vortex forms. As Re increases, secondary and tertiary corner vortices appear. Every CFD textbook and code validation uses this problem.',
    'magnus': 'Magnus effect — a spinning cylinder in a crossflow. The rotation entrains flow on one side and opposes it on the other, creating asymmetric pressure → net lift force perpendicular to the freestream. This is why spinning balls curve in sports (topspin, curveballs).',
    'staggered': 'Staggered cylinder array — models a tube bank heat exchanger. Flow weaves through the offset rows, creating complex wake interactions. The staggered arrangement enhances mixing and heat transfer compared to inline arrays. Watch how wakes from upstream rows interact with downstream cylinders.',
    'bifurcation': 'Y-bifurcation — a channel that splits into two branches. Flow divides at the junction, forming a stagnation point at the splitter tip. This geometry appears in blood vessel branching, river deltas, and piping systems. Watch the pressure distribution at the bifurcation point.',
    'karman': 'Kármán vortex street gallery — three cylinders of different sizes spaced vertically. Each generates vortex shedding at a different frequency (Strouhal scaling: St ≈ 0.2 for all, but f = St·U/D varies with D). Observe how the wakes interact and sometimes synchronise.'
  },

  // Design palette accent colours (desaturated & earthy)
  _PALETTE: [
    [201, 107,  42],
    [ 74, 124, 153],
    [107,  76, 153],
    [ 61, 138,  92],
    [166,  61,  61],
  ],

  // Render resolution multiplier — offscreen bitmap is N*renderScale per side.
  // Physics stays at N²; only the visual output gets sharper. 2 is a good balance.
  renderScale: 2,

  // Backing arrays (indexed as: i + j*(N+2))
  u: null, v: null, u0: null, v0: null,
  // 3-channel density for colored dye
  dR: null, dG: null, dB: null,
  dR0: null, dG0: null, dB0: null,

  // Mouse state
  mx: 0, my: 0, pmx: 0, pmy: 0,
  mouseDown: false, mouseColorIdx: 0,

  init() {
    FL.canvas    = makeCanvas('flCanvas', 'flWrap');
    FL.ctx       = FL.canvas.getContext('2d');
    const rN     = FL.N * FL.renderScale;
    FL.offscreen = document.createElement('canvas');
    FL.offscreen.width = FL.offscreen.height = rN;
    FL.offCtx    = FL.offscreen.getContext('2d');
    FL._imgData  = FL.offCtx.createImageData(rN, rN); // cached — avoids alloc every frame

    FL._allocate();
    FL._buildJetLUT();
    FL._buildBWR_LUT();
    FL._sheddingTracker = { samples: [], lastSign: 0, crossings: [], lastUpdate: 0 };
    FL._initParticles();
    FL._bindControls();
    FL._loop();
  },

  _allocate() {
    const sz = (FL.N + 2) * (FL.N + 2);
    FL.u  = new Float32Array(sz);
    FL.v  = new Float32Array(sz);
    FL.u0 = new Float32Array(sz);
    FL.v0 = new Float32Array(sz);
    FL.dR = new Float32Array(sz);
    FL.dG = new Float32Array(sz);
    FL.dB = new Float32Array(sz);
    FL.dR0= new Float32Array(sz);
    FL.dG0= new Float32Array(sz);
    FL.dB0= new Float32Array(sz);
    FL.obstacles = new Uint8Array(sz);
    FL.pressure  = new Float32Array(sz);
    FL._tmp1     = new Float32Array(sz); // MacCormack predictor buffer
    FL._tmp2     = new Float32Array(sz); // MacCormack corrector buffer
    FL._eddyVisc = new Float32Array(sz); // Smagorinsky eddy viscosity field
    // Compressible flow density field — initialise to ρ₀ = 1
    FL.rho       = new Float32Array(sz);
    FL.rho0      = new Float32Array(sz);
    FL.rho.fill(1.0);
    FL.rho0.fill(0);
    FL._hasObstacles = false;
    FL._initMultigrid();
    FL._lbmAllocate();
  },

  _idx(i, j) { return i + j * (FL.N + 2); },

  // Update cached _hasObstacles flag
  _updateObstacleFlag() {
    FL._hasObstacles = FL.obstacles.indexOf(1) !== -1;
    FL._mgDirty = true;
  },

  // ─── Boundary conditions ───────────────────
  // b: 0=density, 1=x-vel, 2=y-vel
  // Wind tunnel: use Neumann (copy) instead of no-slip reflection on left+right
  // walls for u-velocity. This is CRITICAL — Gauss-Seidel calls _setBnd on
  // every iteration, so reflective right-wall BCs block outflow from the inside
  // regardless of what _injectWind sets afterwards.
  _setBnd(b, x) {
    const N = FL.N, s = N + 2;
    const b1 = b === 1, b2 = b === 2;
    const wt = FL.windTunnel;
    for (let i = 1; i <= N; i++) {
      const iS = i * s;
      // Left wall: Neumann for u in wind tunnel (inlet driven by _injectWind)
      x[iS]              = (b1 && !wt) ? -x[1 + iS]   : x[1 + iS];
      // Right wall: Neumann for u in wind tunnel (open outflow)
      x[(N+1) + iS]      = (b1 && !wt) ? -x[N + iS]   : x[N + iS];
      // Top/bottom: v=0 (slip), u free
      x[i]               = b2 ? -x[i + s]      : x[i + s];
      x[i + (N+1) * s]   = b2 ? -x[i + N * s] : x[i + N * s];
    }
    x[0]                     = 0.5 * (x[1]              + x[s]);
    x[(N+1) * s]             = 0.5 * (x[1 + (N+1) * s] + x[N * s]);
    x[N + 1]                 = 0.5 * (x[N]              + x[N + 1 + s]);
    x[(N+1) + (N+1) * s]     = 0.5 * (x[N + (N+1) * s] + x[(N+1) + N * s]);
  },

  // ─── Obstacle BCs: zero velocity + slow density decay inside solid ─
  _applyObstacleBCs() {
    const { N, u, v, dR, dG, dB, obstacles } = FL;
    const s = N + 2;
    for (let j = 1; j <= N; j++) {
      const jS = j * s;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (!obstacles[idx]) continue;
        u[idx] = 0; v[idx] = 0;
        dR[idx] = 0; dG[idx] = 0; dB[idx] = 0;
      }
    }
  },

  // ─── Linear solver (Red-Black SOR) ─────────────────────────────
  // Red-Black Successive Over-Relaxation: cells are split into a
  // checkerboard (red = (i+j) even, black = (i+j) odd).  Each
  // half-sweep reads only from the opposite colour, eliminating the
  // sequential data dependency of lexicographic SOR and converging
  // ~2× faster per iteration.  Optimal ω for the 2D Laplacian:
  //   ω_opt = 2 / (1 + sin(π/N))  ≈ 1.97 for N = 192
  // Capped at 1.95 for robustness with obstacles & mixed BCs.
  _linSolve(b, x, x0, a, c) {
    const N = FL.N;
    const s    = N + 2;
    const cinv = 1 / c;
    const omega = Math.min(1.95, 2.0 / (1.0 + Math.sin(Math.PI / N)));
    const iters = FL.solverIters;
    if (FL._hasObstacles) {
      const obstacles = FL.obstacles;
      for (let k = 0; k < iters; k++) {
        // Red sweep: (i+j) even
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 2 - (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            if (obstacles[idx]) continue;
            const gs = (x0[idx] + a * (
              x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]
            )) * cinv;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        // Black sweep: (i+j) odd
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 1 + (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            if (obstacles[idx]) continue;
            const gs = (x0[idx] + a * (
              x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]
            )) * cinv;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        FL._setBnd(b, x);
      }
    } else {
      // Hot path — no obstacles, inner loops have no branch
      for (let k = 0; k < iters; k++) {
        // Red sweep
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 2 - (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            const gs = (x0[idx] + a * (
              x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]
            )) * cinv;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        // Black sweep
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 1 + (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            const gs = (x0[idx] + a * (
              x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]
            )) * cinv;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        FL._setBnd(b, x);
      }
    }
  },

  // ─── Diffusion ─────────────────────────────
  _diffuse(b, x, x0, diff) {
    const a = FL.dt * diff * FL.N * FL.N;
    FL._linSolve(b, x, x0, a, 1 + 4 * a);
  },

  // ═══════════════════════════════════════════════════════════════
  // ─── Geometric Multigrid V-Cycle Poisson Solver ───────────────
  // ═══════════════════════════════════════════════════════════════
  // Solves the Pressure Poisson Equation:
  //   4·p(i,j) − p(i±1,j) − p(i,j±1) = div(i,j)
  //
  // A geometric multigrid V-cycle with Red-Black SOR smoothing
  // and cell-centred transfer operators.  At N = 192 we build
  // 6 levels: 192 → 96 → 48 → 24 → 12 → 6.
  //
  // Convergence comparison (per _project call, same wall-clock cost):
  //   RB-SOR 14 iter :  ρ¹⁴ ≈ 0.64  →  ~36% error reduction
  //   2 V-cycles     :  ρ²  ≈ 0.01  →  ~99% error reduction
  //
  // Combined with warm-starting from the previous frame's pressure,
  // this yields near-machine-precision divergence removal.
  // ═══════════════════════════════════════════════════════════════

  // Allocate multigrid hierarchy
  _initMultigrid() {
    const levels = [];
    let n = FL.N;
    while (n >= 4) {
      const sz = (n + 2) * (n + 2);
      levels.push({
        N: n,
        stride: n + 2,
        omega: Math.min(1.95, 2.0 / (1.0 + Math.sin(Math.PI / n))),
        e:   new Float32Array(sz),
        rhs: new Float32Array(sz),
        r:   new Float32Array(sz),
        obs: (n === FL.N) ? FL.obstacles : new Uint8Array(sz),
        hasObs: false
      });
      if (n % 2 !== 0 || n <= 4) break;
      n >>= 1;
    }
    FL._mgLevels = levels;
    FL._mgDirty = true;
  },

  // Pressure BCs (b = 0): Neumann on all walls.
  // Level-aware — takes N as parameter for coarse grids.
  _setBndP(x, N) {
    const s = N + 2;
    for (let i = 1; i <= N; i++) {
      const iS = i * s;
      x[iS]            = x[1 + iS];
      x[(N+1) + iS]    = x[N + iS];
      x[i]             = x[i + s];
      x[i + (N+1) * s] = x[i + N * s];
    }
    x[0]                 = 0.5 * (x[1] + x[s]);
    x[(N+1) * s]         = 0.5 * (x[1 + (N+1) * s] + x[N * s]);
    x[N + 1]             = 0.5 * (x[N] + x[N + 1 + s]);
    x[(N+1) + (N+1) * s] = 0.5 * (x[N + (N+1) * s] + x[(N+1) + N * s]);
  },

  // Red-Black SOR smoother for 5-point Laplacian (a = 1, c = 4).
  // Operates on any grid level N with its own ω and obstacle mask.
  _mgSmooth(x, b, N, omega, nIter, obs, hasObs) {
    const s = N + 2;
    if (hasObs) {
      for (let k = 0; k < nIter; k++) {
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 2 - (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            if (obs[idx]) continue;
            const gs = (b[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]) * 0.25;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 1 + (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            if (obs[idx]) continue;
            const gs = (b[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]) * 0.25;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        FL._setBndP(x, N);
      }
    } else {
      for (let k = 0; k < nIter; k++) {
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 2 - (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            const gs = (b[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]) * 0.25;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        for (let j = 1; j <= N; j++) {
          const jS = j * s;
          for (let i = 1 + (j & 1); i <= N; i += 2) {
            const idx = i + jS;
            const gs = (b[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s]) * 0.25;
            x[idx] += omega * (gs - x[idx]);
          }
        }
        FL._setBndP(x, N);
      }
    }
  },

  // Cell-centred full-weighting restriction (fine → coarse).
  // Each coarse cell = average of its 2×2 block of fine children.
  _mgRestrict(fine, coarse, Nf, Nc) {
    const sf = Nf + 2;
    const sc = Nc + 2;
    for (let j = 1; j <= Nc; j++) {
      const fj = 2 * j - 1;
      const cjS = j * sc;
      const fj0S = fj * sf;
      const fj1S = (fj + 1) * sf;
      for (let i = 1; i <= Nc; i++) {
        const fi = 2 * i - 1;
        coarse[i + cjS] = 0.25 * (
          fine[fi + fj0S] + fine[fi + 1 + fj0S] +
          fine[fi + fj1S] + fine[fi + 1 + fj1S]
        );
      }
    }
  },

  // Cell-centred prolongation (coarse → fine, additive correction).
  // Each coarse cell distributes its value equally to its 4 fine children.
  _mgProlongate(coarse, fine, Nc, Nf) {
    const sc = Nc + 2;
    const sf = Nf + 2;
    for (let j = 1; j <= Nc; j++) {
      const fj = 2 * j - 1;
      const cjS = j * sc;
      const fj0S = fj * sf;
      const fj1S = (fj + 1) * sf;
      for (let i = 1; i <= Nc; i++) {
        const fi = 2 * i - 1;
        const val = coarse[i + cjS];
        fine[fi     + fj0S] += val;
        fine[fi + 1 + fj0S] += val;
        fine[fi     + fj1S] += val;
        fine[fi + 1 + fj1S] += val;
      }
    }
  },

  // Restrict obstacle mask from fine to coarse levels.
  // A coarse cell is marked solid if ANY of its 4 fine children are solid.
  _mgRestrictObs() {
    const levels = FL._mgLevels;
    if (!levels || levels.length < 2) return;
    levels[0].hasObs = FL._hasObstacles;
    for (let l = 1; l < levels.length; l++) {
      const prev = levels[l - 1];
      const curr = levels[l];
      const Nf = prev.N, Nc = curr.N;
      const sf = Nf + 2, sc = Nc + 2;
      const fObs = prev.obs;
      const cObs = curr.obs;
      cObs.fill(0);
      let any = false;
      for (let j = 1; j <= Nc; j++) {
        const fj = 2 * j - 1;
        const cjS = j * sc;
        const fj0S = fj * sf;
        const fj1S = (fj + 1) * sf;
        for (let i = 1; i <= Nc; i++) {
          const fi = 2 * i - 1;
          const o = fObs[fi + fj0S] | fObs[fi + 1 + fj0S] |
                    fObs[fi + fj1S] | fObs[fi + 1 + fj1S];
          cObs[i + cjS] = o;
          if (o) any = true;
        }
      }
      curr.hasObs = any;
    }
  },

  // Recursive V-cycle.
  //   level 0        : operates on the actual p / div arrays
  //   level > 0      : operates on pre-allocated e / rhs arrays
  //   coarsest level : solve with extra SOR sweeps (grid is tiny)
  _mgVCycle(level) {
    const levels = FL._mgLevels;
    const lvl = levels[level];
    const { N, stride: s, omega, e: x, rhs: b, r, obs, hasObs } = lvl;

    // Coarsest level — just smooth thoroughly (cheap, grid is tiny)
    if (level === levels.length - 1) {
      FL._mgSmooth(x, b, N, omega, 12, obs, hasObs);
      return;
    }

    // ── Pre-smooth (2 RB-SOR sweeps) ──
    FL._mgSmooth(x, b, N, omega, 2, obs, hasObs);

    // ── Compute residual: r = b − A·x ──
    // A·x = 4·x[idx] − x[idx−1] − x[idx+1] − x[idx−s] − x[idx+s]
    if (hasObs) {
      for (let j = 1; j <= N; j++) {
        const jS = j * s;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          r[idx] = obs[idx] ? 0 :
            b[idx] - 4 * x[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s];
        }
      }
    } else {
      for (let j = 1; j <= N; j++) {
        const jS = j * s;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          r[idx] = b[idx] - 4 * x[idx] + x[idx - 1] + x[idx + 1] + x[idx - s] + x[idx + s];
        }
      }
    }

    // ── Restrict residual to coarser level ──
    const nxt = levels[level + 1];
    FL._mgRestrict(r, nxt.rhs, N, nxt.N);

    // ── Zero coarse correction ──
    nxt.e.fill(0);

    // ── Recurse ──
    FL._mgVCycle(level + 1);

    // ── Prolongate correction and add to current solution ──
    FL._mgProlongate(nxt.e, x, nxt.N, N);

    // ── Post-smooth (2 RB-SOR sweeps) ──
    FL._mgSmooth(x, b, N, omega, 2, obs, hasObs);
  },

  // Top-level multigrid pressure solve.
  // Falls back to plain RB-SOR if multigrid wasn't initialised.
  _mgSolve(x, b) {
    const levels = FL._mgLevels;
    if (!levels || levels.length < 2) {
      FL._linSolve(0, x, b, 1, 4);
      return;
    }
    // Ensure coarse obstacle masks are current
    if (FL._mgDirty) {
      FL._mgRestrictObs();
      FL._mgDirty = false;
    }
    // Level 0 operates on the caller's actual arrays
    levels[0].e = x;
    levels[0].rhs = b;
    levels[0].hasObs = FL._hasObstacles;
    // Two V-cycles → ~99 % error reduction with warm-start
    FL._mgVCycle(0);
    FL._mgVCycle(0);
    FL._setBndP(x, FL.N);
  },

  // ─── Semi-Lagrangian advection with RK2 midpoint back-trace ──
  // Used for scalar fields (compressible density, single-channel dye).
  // The RK2 trace finds departure points by tracing a half-step with
  // the local velocity, interpolating velocity at the midpoint, then
  // completing the full step — capturing streamline curvature that the
  // standard Euler back-trace misses entirely.
  _advectFast(b, d, d0, ux, uy) {
    const N = FL.N;
    const stride = N + 2;
    const dt0 = FL.dt * N;
    const hasObs = FL._hasObstacles;
    const obstacles = FL.obstacles;
    const lim = N + 0.5;
    const hdt = 0.5 * dt0;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { d[idx] = 0; continue; }
        // RK2 midpoint back-trace
        let xh = i - hdt * ux[idx];
        let yh = j - hdt * uy[idx];
        if (xh < 0.5) xh = 0.5; else if (xh > lim) xh = lim;
        if (yh < 0.5) yh = 0.5; else if (yh > lim) yh = lim;
        const mi0 = xh | 0, mi1 = mi0 + 1;
        const mj0 = yh | 0, mj1 = mj0 + 1;
        const ms1 = xh - mi0, ms0 = 1 - ms1;
        const mt1 = yh - mj0, mt0 = 1 - mt1;
        const mj0S = mj0 * stride, mj1S = mj1 * stride;
        const umid = ms0 * (mt0 * ux[mi0 + mj0S] + mt1 * ux[mi0 + mj1S])
                   + ms1 * (mt0 * ux[mi1 + mj0S] + mt1 * ux[mi1 + mj1S]);
        const vmid = ms0 * (mt0 * uy[mi0 + mj0S] + mt1 * uy[mi0 + mj1S])
                   + ms1 * (mt0 * uy[mi1 + mj0S] + mt1 * uy[mi1 + mj1S]);
        // Full step with midpoint velocity
        let xx = i - dt0 * umid;
        let yy = j - dt0 * vmid;
        if (xx < 0.5) xx = 0.5; else if (xx > lim) xx = lim;
        if (yy < 0.5) yy = 0.5; else if (yy > lim) yy = lim;
        const i0 = xx | 0, i1 = i0 + 1;
        const j0 = yy | 0, j1 = j0 + 1;
        const s1 = xx - i0, s0 = 1 - s1;
        const t1 = yy - j0, t0 = 1 - t1;
        const j0S = j0 * stride, j1S = j1 * stride;
        d[idx] =
          s0 * (t0 * d0[i0 + j0S] + t1 * d0[i0 + j1S]) +
          s1 * (t0 * d0[i1 + j0S] + t1 * d0[i1 + j1S]);
      }
    }
    FL._setBnd(b, d);
  },

  // ─── MacCormack advection — second-order accurate ──────────
  // Predictor–corrector with monotonicity limiter.
  // Only used for velocity (physics-critical); dye uses _advectFast.
  _advect(b, d, d0, ux, uy) {
    const N = FL.N;
    const stride = N + 2;
    const dt0 = FL.dt * N;
    const hasObs = FL._hasObstacles;
    const obstacles = FL.obstacles;
    const phiHat = FL._tmp1;
    const phiRev = FL._tmp2;
    const lim = N + 0.5;

    // Step 1: Forward semi-Lagrangian (predictor) — inlined for speed
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { phiHat[idx] = 0; continue; }
        let xx = i - dt0 * ux[idx];
        let yy = j - dt0 * uy[idx];
        if (xx < 0.5) xx = 0.5; else if (xx > lim) xx = lim;
        if (yy < 0.5) yy = 0.5; else if (yy > lim) yy = lim;
        const i0 = xx | 0, i1 = i0 + 1;
        const j0 = yy | 0, j1 = j0 + 1;
        const s1 = xx - i0, s0 = 1 - s1;
        const t1 = yy - j0, t0 = 1 - t1;
        const j0S = j0 * stride, j1S = j1 * stride;
        phiHat[idx] =
          s0 * (t0 * d0[i0 + j0S] + t1 * d0[i0 + j1S]) +
          s1 * (t0 * d0[i1 + j0S] + t1 * d0[i1 + j1S]);
      }
    }
    FL._setBnd(b, phiHat);

    // Step 2+3: Reverse advection + MacCormack correction (fused)
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { d[idx] = 0; continue; }

        // Reverse trace (forward in time)
        let rx = i + dt0 * ux[idx];
        let ry = j + dt0 * uy[idx];
        if (rx < 0.5) rx = 0.5; else if (rx > lim) rx = lim;
        if (ry < 0.5) ry = 0.5; else if (ry > lim) ry = lim;
        const ri0 = rx | 0, ri1 = ri0 + 1;
        const rj0 = ry | 0, rj1 = rj0 + 1;
        const rs1 = rx - ri0, rs0 = 1 - rs1;
        const rt1 = ry - rj0, rt0 = 1 - rt1;
        const rj0S = rj0 * stride, rj1S = rj1 * stride;
        const rev =
          rs0 * (rt0 * phiHat[ri0 + rj0S] + rt1 * phiHat[ri0 + rj1S]) +
          rs1 * (rt0 * phiHat[ri1 + rj0S] + rt1 * phiHat[ri1 + rj1S]);

        // MacCormack correction
        const corrected = phiHat[idx] + 0.5 * (d0[idx] - rev);

        // Monotonicity limiter from forward-trace neighbourhood
        let xx = i - dt0 * ux[idx];
        let yy = j - dt0 * uy[idx];
        if (xx < 0.5) xx = 0.5; else if (xx > lim) xx = lim;
        if (yy < 0.5) yy = 0.5; else if (yy > lim) yy = lim;
        const ci = xx | 0, cj = yy | 0;
        const ci1 = ci < N ? ci + 1 : ci;
        const cj1 = cj < N ? cj + 1 : cj;
        const v00 = d0[ci  + cj  * stride];
        const v10 = d0[ci1 + cj  * stride];
        const v01 = d0[ci  + cj1 * stride];
        const v11 = d0[ci1 + cj1 * stride];
        let lo, hi;
        // Branchless min/max — avoids Math.min/max overhead
        lo = v00; if (v10 < lo) lo = v10; if (v01 < lo) lo = v01; if (v11 < lo) lo = v11;
        hi = v00; if (v10 > hi) hi = v10; if (v01 > hi) hi = v01; if (v11 > hi) hi = v11;
        d[idx] = (corrected >= lo && corrected <= hi) ? corrected : phiHat[idx];
      }
    }
    FL._setBnd(b, d);
  },

  // ─── Fused u/v MacCormack advection ───────────────────────
  // Advects BOTH velocity components in a single pass, sharing:
  //   • Back-trace departure point (Step 1)
  //   • Forward-trace arrival point (Step 2)
  //   • Limiter stencil lookup (Step 3)
  // This eliminates ~45% of the computation vs. calling _advect twice.
  _advectUV(u, v, u0, v0) {
    const N = FL.N;
    const stride = N + 2;
    const dt0 = FL.dt * N;
    const hasObs = FL._hasObstacles;
    const obstacles = FL.obstacles;
    const uHat = FL._tmp1;
    const vHat = FL._tmp2;
    const lim = N + 0.5;

    // ── Step 1: Forward semi-Lagrangian predictor (RK2 midpoint back-trace) ──
    // Uses 2nd-order Runge-Kutta to find the departure point, dramatically
    // improving accuracy for curved streamlines versus Euler back-trace.
    // The half-step traces to the midpoint, interpolates velocity there,
    // then uses that midpoint velocity for the full step — this captures
    // streamline curvature that Euler completely misses. Cost: one extra
    // bilinear interpolation per cell (~25% more work in this loop), but
    // the improved departure points reduce numerical diffusion by O(h)
    // and produce significantly sharper vortex structures.
    const hdt = 0.5 * dt0;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { uHat[idx] = 0; vHat[idx] = 0; continue; }
        // Half-step Euler to midpoint
        let xh = i - hdt * u0[idx];
        let yh = j - hdt * v0[idx];
        if (xh < 0.5) xh = 0.5; else if (xh > lim) xh = lim;
        if (yh < 0.5) yh = 0.5; else if (yh > lim) yh = lim;
        const mi0 = xh | 0, mi1 = mi0 + 1;
        const mj0 = yh | 0, mj1 = mj0 + 1;
        const ms1 = xh - mi0, ms0 = 1 - ms1;
        const mt1 = yh - mj0, mt0 = 1 - mt1;
        const ma00 = mi0 + mj0 * stride, ma10 = mi1 + mj0 * stride;
        const ma01 = mi0 + mj1 * stride, ma11 = mi1 + mj1 * stride;
        const mw00 = ms0 * mt0, mw10 = ms1 * mt0, mw01 = ms0 * mt1, mw11 = ms1 * mt1;
        // Interpolate velocity at midpoint
        const umid = mw00 * u0[ma00] + mw10 * u0[ma10] + mw01 * u0[ma01] + mw11 * u0[ma11];
        const vmid = mw00 * v0[ma00] + mw10 * v0[ma10] + mw01 * v0[ma01] + mw11 * v0[ma11];
        // Full step with midpoint velocity (2nd-order accurate departure point)
        let xx = i - dt0 * umid;
        let yy = j - dt0 * vmid;
        if (xx < 0.5) xx = 0.5; else if (xx > lim) xx = lim;
        if (yy < 0.5) yy = 0.5; else if (yy > lim) yy = lim;
        const i0 = xx | 0, i1 = i0 + 1;
        const j0 = yy | 0, j1 = j0 + 1;
        const s1 = xx - i0, s0 = 1 - s1;
        const t1 = yy - j0, t0 = 1 - t1;
        const a00 = i0 + j0 * stride, a10 = i1 + j0 * stride;
        const a01 = i0 + j1 * stride, a11 = i1 + j1 * stride;
        const w00 = s0 * t0, w10 = s1 * t0, w01 = s0 * t1, w11 = s1 * t1;
        uHat[idx] = w00 * u0[a00] + w10 * u0[a10] + w01 * u0[a01] + w11 * u0[a11];
        vHat[idx] = w00 * v0[a00] + w10 * v0[a10] + w01 * v0[a01] + w11 * v0[a11];
      }
    }
    FL._setBnd(1, uHat);
    FL._setBnd(2, vHat);

    // ── Step 2+3: Reverse trace + MacCormack correction (shared) ──
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { u[idx] = 0; v[idx] = 0; continue; }

        // Reverse trace (forward in time) — shared
        let rx = i + dt0 * u0[idx];
        let ry = j + dt0 * v0[idx];
        if (rx < 0.5) rx = 0.5; else if (rx > lim) rx = lim;
        if (ry < 0.5) ry = 0.5; else if (ry > lim) ry = lim;
        const ri0 = rx | 0, ri1 = ri0 + 1;
        const rj0 = ry | 0, rj1 = rj0 + 1;
        const rs1 = rx - ri0, rs0 = 1 - rs1;
        const rt1 = ry - rj0, rt0 = 1 - rt1;
        const ra00 = ri0 + rj0 * stride, ra10 = ri1 + rj0 * stride;
        const ra01 = ri0 + rj1 * stride, ra11 = ri1 + rj1 * stride;
        const rw00 = rs0 * rt0, rw10 = rs1 * rt0, rw01 = rs0 * rt1, rw11 = rs1 * rt1;
        const uRev = rw00 * uHat[ra00] + rw10 * uHat[ra10] + rw01 * uHat[ra01] + rw11 * uHat[ra11];
        const vRev = rw00 * vHat[ra00] + rw10 * vHat[ra10] + rw01 * vHat[ra01] + rw11 * vHat[ra11];

        // MacCormack correction
        const uCorr = uHat[idx] + 0.5 * (u0[idx] - uRev);
        const vCorr = vHat[idx] + 0.5 * (v0[idx] - vRev);

        // Monotonicity limiter — shared departure point
        let xx = i - dt0 * u0[idx];
        let yy = j - dt0 * v0[idx];
        if (xx < 0.5) xx = 0.5; else if (xx > lim) xx = lim;
        if (yy < 0.5) yy = 0.5; else if (yy > lim) yy = lim;
        const ci = xx | 0, cj = yy | 0;
        const ci1 = ci < N ? ci + 1 : ci;
        const cj1 = cj < N ? cj + 1 : cj;
        const c00 = ci + cj * stride,  c10 = ci1 + cj  * stride;
        const c01 = ci + cj1 * stride, c11 = ci1 + cj1 * stride;

        // u limiter
        let uLo = u0[c00], uHi = uLo, t;
        t = u0[c10]; if (t < uLo) uLo = t; if (t > uHi) uHi = t;
        t = u0[c01]; if (t < uLo) uLo = t; if (t > uHi) uHi = t;
        t = u0[c11]; if (t < uLo) uLo = t; if (t > uHi) uHi = t;
        u[idx] = (uCorr >= uLo && uCorr <= uHi) ? uCorr : uHat[idx];

        // v limiter
        let vLo = v0[c00], vHi = vLo;
        t = v0[c10]; if (t < vLo) vLo = t; if (t > vHi) vHi = t;
        t = v0[c01]; if (t < vLo) vLo = t; if (t > vHi) vHi = t;
        t = v0[c11]; if (t < vLo) vLo = t; if (t > vHi) vHi = t;
        v[idx] = (vCorr >= vLo && vCorr <= vHi) ? vCorr : vHat[idx];
      }
    }
    FL._setBnd(1, u); FL._setBnd(2, v);
  },

  // ─── Projection (divergence-free) ──────────
  // Warm-starts from previous frame's pressure — since the pressure
  // field changes slowly between frames this dramatically accelerates
  // convergence, giving better divergence removal with the same
  // iteration budget.
  _project(ux, uy, p, div) {
    const { N, obstacles, pressure: prevP } = FL;
    const stride = N + 2;
    const negHalfH = -0.5 / N;   // pre-computed  −½h
    const halfN    =  0.5 * N;   // pre-computed  ½/h
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        div[idx] = negHalfH * (
          ux[idx + 1] - ux[idx - 1] + uy[idx + stride] - uy[idx - stride]
        );
        p[idx] = prevP[idx];  // warm-start from last frame
      }
    }
    FL._setBnd(0, div); FL._setBndP(p, N);
    FL._mgSolve(p, div);
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (obstacles[idx]) continue;
        ux[idx] -= halfN * (p[idx + 1]      - p[idx - 1]);
        uy[idx] -= halfN * (p[idx + stride] - p[idx - stride]);
      }
    }
    FL._setBnd(1, ux); FL._setBnd(2, uy);
  },

  // ─── Vorticity confinement ─────────────────
  _vorticityConfinement() {
    const { N, u, v, dt, vortStrength } = FL;
    if (vortStrength < 0.01) return;
    const curl   = FL.u0; // reuse u0 as temp
    // u0 may hold stale pressure from _project; clear with fast memset
    curl.fill(0);
    const stride = N + 2;
    // In wind tunnel skip columns 1-3 (inlet) and N-1,N (outlet) to avoid
    // amplifying ghost-cell artefacts into visible inlet/outlet noise.
    const iMin = FL.windTunnel ? 4 : 1;
    const iMax = FL.windTunnel ? N - 2 : N;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = iMin; i <= iMax; i++) {
        const idx = i + jS;
        curl[idx] = (v[idx + 1] - v[idx - 1] - u[idx + stride] + u[idx - stride]) * 0.5;
      }
    }
    const eps = vortStrength * 0.025 * (FL.turbulenceModel ? 0.7 : 1.0);
    // When the Smagorinsky SGS model is active, it already counteracts
    // numerical diffusion at the correct rate (Kolmogorov scaling), so
    // the ad-hoc vorticity confinement strength is reduced by 30% to
    // prevent over-amplification of small-scale features.
    const iMin2 = iMin > 2 ? iMin : 2;
    const iMax2 = iMax < N - 1 ? iMax : N - 1;
    for (let j = 2; j <= N - 1; j++) {
      const jS = j * stride;
      for (let i = iMin2; i <= iMax2; i++) {
        const idx  = i + jS;
        // Inline abs avoids function-call overhead in hot path
        const cr = curl[idx + 1], cl = curl[idx - 1];
        const cu = curl[idx + stride], cd = curl[idx - stride];
        const dOx  = (cr < 0 ? -cr : cr) - (cl < 0 ? -cl : cl);
        const dOy  = (cu < 0 ? -cu : cu) - (cd < 0 ? -cd : cd);
        // Single reciprocal sqrt → 2 muls (cheaper than 2 divisions)
        const invLen = 1 / (Math.sqrt(dOx * dOx + dOy * dOy) + 1e-5);
        const f = dt * eps * curl[idx];
        u[idx] += f * dOy * invLen;
        v[idx] -= f * dOx * invLen;
      }
    }
    FL._setBnd(1, u); FL._setBnd(2, v);
  },

  // ─── Smagorinsky SGS Turbulence Model (Large Eddy Simulation) ────────
  // Computes sub-grid scale turbulent eddy viscosity from the resolved
  // strain rate tensor S_ij using the Boussinesq turbulence hypothesis:
  //
  //   ν_t(x,y) = (C_s · Δ)² · |S|
  //
  // where |S| = √(2 S_ij S_ij) is the strain rate magnitude,
  // Δ = h = 1/N is the grid spacing, and Cs ≈ 0.15 (Smagorinsky constant).
  //
  // Physics: In turbulent flow, the Kolmogorov energy cascade transfers
  // kinetic energy from large resolved eddies to smaller sub-grid scales
  // where it is dissipated by molecular viscosity. The SGS model captures
  // this forward cascade by adding a spatially-varying turbulent viscosity
  // proportional to the local resolved strain rate. This correctly produces:
  //   • Enhanced mixing in shear layers and separated flows
  //   • Proper energy dissipation rate ε ~ ν_t |S|²
  //   • Scale-dependent damping (small scales damped more than large ones)
  //
  // The sub-grid stress tensor τ_ij^SGS = −2 ν_t S_ij is applied as
  // explicit turbulent diffusion in conservative (divergence) form:
  //   ∇·(ν_t ∇u) ≈ Σ_faces ν_{face} · (u_neighbor − u_center) · N²
  // with face-averaged viscosity ν_{face} = ½(ν_center + ν_neighbor)
  // for proper momentum conservation across cell interfaces.
  //
  // Stability: ν_t is clamped to satisfy the explicit diffusion CFL
  // condition dt · ν_max · N² < 0.25 (the 2D stability limit).
  _smagorinskyLES() {
    if (!FL.turbulenceModel) return;
    const { N, u, v, dt, obstacles } = FL;
    const s = N + 2;
    const hasObs = FL._hasObstacles;
    const nut = FL._eddyVisc;
    const h = 1.0 / N;
    const CsDelta2 = (FL._smagConst * h) * (FL._smagConst * h);
    const halfN = 0.5 * N;             // central difference scale: 1/(2h) = N/2
    const N2 = N * N;
    const maxNuT = 0.22 / (dt * N2);   // explicit diffusion stability limit

    // ── Phase 1: Eddy viscosity from strain rate tensor ──
    // S11 = ∂u/∂x,  S22 = ∂v/∂y,  S12 = ½(∂u/∂y + ∂v/∂x)
    // |S|² = 2(S11² + S22² + 2·S12²)
    let nutSum = 0;
    for (let j = 1; j <= N; j++) {
      const jS = j * s;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { nut[idx] = 0; continue; }
        const S11 = (u[idx + 1] - u[idx - 1]) * halfN;
        const S22 = (v[idx + s] - v[idx - s]) * halfN;
        const S12 = 0.5 * ((u[idx + s] - u[idx - s])
                          + (v[idx + 1] - v[idx - 1])) * halfN;
        const sMag2 = 2 * (S11 * S11 + S22 * S22 + 2 * S12 * S12);
        const nuVal = CsDelta2 * Math.sqrt(sMag2);
        nut[idx] = nuVal < maxNuT ? nuVal : maxNuT;
        nutSum += nut[idx];
      }
    }
    FL._meanEddyVisc = nutSum / (N * N);

    // ── Phase 2: Explicit turbulent diffusion (conservative form) ──
    // Uses face-averaged ν_t for proper conservation of momentum.
    // Skips outermost row to avoid boundary issues; _setBnd applied after.
    const dtN2 = dt * N2;
    for (let j = 2; j < N; j++) {
      const jS = j * s;
      for (let i = 2; i < N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) continue;
        const nuC = nut[idx];
        if (nuC < 1e-12) continue;
        // Face-averaged viscosities (arithmetic mean)
        const nuR = 0.5 * (nuC + nut[idx + 1]);
        const nuL = 0.5 * (nuC + nut[idx - 1]);
        const nuU = 0.5 * (nuC + nut[idx + s]);
        const nuD = 0.5 * (nuC + nut[idx - s]);
        // ∇·(ν_t ∇φ) with face fluxes for u and v
        u[idx] += dtN2 * (nuR * (u[idx + 1] - u[idx]) - nuL * (u[idx] - u[idx - 1])
                        + nuU * (u[idx + s] - u[idx]) - nuD * (u[idx] - u[idx - s]));
        v[idx] += dtN2 * (nuR * (v[idx + 1] - v[idx]) - nuL * (v[idx] - v[idx - 1])
                        + nuU * (v[idx + s] - v[idx]) - nuD * (v[idx] - v[idx - s]));
      }
    }
    FL._setBnd(1, u); FL._setBnd(2, v);
  },

  // ═══════════════════════════════════════════════════════════════
  // ─── Lattice Boltzmann Method (D2Q9-TRT + Smagorinsky LES) ───
  // ═══════════════════════════════════════════════════════════════
  //
  // Models fluid as fictitious particles on a 2D lattice performing
  // consecutive collision and streaming steps. The D2Q9 model uses
  // 9 velocity directions per node:
  //
  //     6  2  5       D2Q9 velocity layout:
  //      \ | /        0: ( 0, 0) rest        w = 4/9
  //   3 ──0── 1       1: (+1, 0) east        w = 1/9
  //      / | \        2: ( 0,+1) south       w = 1/9
  //     7  4  8       3: (−1, 0) west        w = 1/9
  //                   4: ( 0,−1) north       w = 1/9
  //   Diagonals:      5: (+1,+1) SE          w = 1/36
  //                   6: (−1,+1) SW          w = 1/36
  //                   7: (−1,−1) NW          w = 1/36
  //                   8: (+1,−1) NE          w = 1/36
  //
  // TRT collision: uses two relaxation rates instead of one (BGK).
  //   s+ (symmetric)     controls viscosity: ν = (1/s+ − ½)/3
  //   s− (antisymmetric)  controls accuracy/stability of advection.
  //   "Magic" parameter Λ = (1/s+ − ½)(1/s− − ½) = ¼ ensures:
  //     • Exact bounce-back wall location at lattice mid-link
  //     • Viscosity-independent truncation error
  //     • ~2× stability range vs. BGK at the same viscosity
  //
  // Smagorinsky SGS (when LES enabled): adapts τ per-cell from the
  // non-equilibrium stress tensor (a natural LBM observable — no
  // finite-difference stencil needed).
  //
  // Force coupling: Exact Difference Method (EDM, Kupershtokh 2009)
  //   Δf_i = f_i^eq(ρ, u+F/ρ) − f_i^eq(ρ, u)
  //   Exact to all orders (vs. Guo forcing which is 2nd-order).
  //
  // Equilibrium:   f_i^eq = w_i ρ (1 + 3 e_i·u + 4.5(e_i·u)² − 1.5 u²)
  // Kinematic viscosity: ν = (τ − 0.5) / 3
  // Speed of sound: c_s = 1/√3 ≈ 0.577
  //
  // Bounce-back: obstacle nodes reverse incoming distributions,
  // providing a natural no-slip boundary condition.
  //
  // References:
  //   Ginzburg, d'Humières (2003), "Multireflection BCs for LBM"
  //   Kupershtokh et al. (2009), "On equations of state in LBM"
  //   Schroeder, Weber State University — physics.weber.edu/schroeder/fluids
  //   Chen & Doolen (1998), "Lattice Boltzmann Method for Fluid Flows"
  // ═══════════════════════════════════════════════════════════════

  _lbmAllocate() {
    const sz = (FL.N + 2) * (FL.N + 2);
    FL._lbmF = [];
    for (let d = 0; d < 9; d++) {
      FL._lbmF[d] = new Float32Array(sz);
    }
    FL._lbmInited = false;
  },

  // Initialize all distributions to equilibrium at current macroscopic state.
  _lbmInitEquilibrium() {
    const N = FL.N, s = N + 2;
    const f = FL._lbmF;
    if (!f || f.length < 9) return;
    const w  = [4/9, 1/9, 1/9, 1/9, 1/9, 1/36, 1/36, 1/36, 1/36];
    const ex = [0, 1, 0, -1, 0, 1, -1, -1, 1];
    const ey = [0, 0, 1, 0, -1, 1, 1, -1, -1];

    // Wind tunnel: initialize with uniform rightward flow
    const wtSpd = FL.windTunnel ? Math.min(0.18, FL.windSpeed * 0.001) : 0;

    for (let j = 0; j <= N + 1; j++) {
      const jS = j * s;
      for (let i = 0; i <= N + 1; i++) {
        const idx = i + jS;
        const isObs = FL.obstacles[idx];
        // In wind tunnel, start with uniform inlet velocity everywhere
        let ux = FL.windTunnel ? wtSpd : (FL.u[idx] || 0);
        let uy = FL.windTunnel ? 0 : (FL.v[idx] || 0);
        if (isObs) { ux = 0; uy = 0; }
        const rho = 1.0;
        const usq = ux * ux + uy * uy;
        const u15 = 1.5 * usq;
        for (let d = 0; d < 9; d++) {
          const eu = ex[d] * ux + ey[d] * uy;
          f[d][idx] = w[d] * rho * (1 + 3 * eu + 4.5 * eu * eu - u15);
        }
        FL.u[idx] = ux;
        FL.v[idx] = uy;
        FL.rho[idx] = rho;
      }
    }
    FL._lbmInited = true;
  },

  // ── One LBM timestep ──
  // Correct ordering: Collide → Stream → Bounce-back → BCs → Extract macroscopic
  //
  // Collision operator: TRT (Two-Relaxation-Time) with optional Smagorinsky SGS.
  // TRT uses separate relaxation rates for symmetric (s+) and antisymmetric (s−)
  // parts of the distribution function. This eliminates the viscosity-dependent
  // wall-slip artefact of BGK and greatly extends the stability envelope,
  // especially at low τ (high Reynolds number flows).
  //
  // "Magic" parameter: Λ = (τ − ½)(τ_a − ½) = ¼
  //   → τ_a = ½ + 1/(4(τ − ½))
  // This choice ensures:
  //   • Bounce-back walls are located exactly at the lattice mid-link
  //   • Truncation error independence from viscosity
  //   • Optimal stability for the antisymmetric modes
  //
  // When LES (Smagorinsky SGS) is enabled, the local relaxation time is
  // adapted per-cell by computing the non-equilibrium stress tensor directly
  // from the distributions (no finite-difference stencil needed!):
  //   Π^neq_αβ = Σ_i (f_i − f_i^eq) · e_iα · e_iβ
  //   τ_eff = ½(τ₀ + √(τ₀² + 18√2·Cs²·|Π^neq|/ρ))
  _lbmStep() {
    const N = FL.N, s = N + 2;
    const f = FL._lbmF;
    const obs = FL.obstacles;
    const hasObs = FL._hasObstacles;
    const tau0 = FL._lbmTau;
    const one9 = 1.0 / 9, one36 = 1.0 / 36, four9 = 4.0 / 9;
    const maxU = 0.20; // velocity clamp (Ma ≈ 0.35) — prevents blowup

    // Pre-compute base TRT relaxation rates
    const sPlus0 = 1.0 / tau0;
    const tauA0 = 0.5 + 1.0 / (4.0 * Math.max(tau0 - 0.5, 1e-6));
    const sMinus0 = 1.0 / tauA0;

    const useSmagorinsky = FL.turbulenceModel;
    const Cs2 = FL._smagConst * FL._smagConst;
    const SQRT2 = 1.41421356237;
    let nutSum = 0; // accumulate mean eddy viscosity for diagnostics

    // ── Phase 1: TRT Collision + optional Smagorinsky SGS ──
    // Conservation: Σ f_i^eq = Σ f_i = ρ  and  Σ f_i^eq e_i = Σ f_i e_i = ρu
    // TRT opposite pairs: (1,3), (2,4), (5,7), (6,8). Direction 0 is self-opposite.
    for (let j = 1; j <= N; j++) {
      const jS = j * s;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obs[idx]) continue;

        const f0 = f[0][idx], f1 = f[1][idx], f2 = f[2][idx];
        const f3 = f[3][idx], f4 = f[4][idx], f5 = f[5][idx];
        const f6 = f[6][idx], f7 = f[7][idx], f8 = f[8][idx];

        let rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
        // Stability guard: clamp density
        if (rho < 0.01) rho = 0.01;
        if (rho > 5.0) rho = 5.0;
        const invRho = 1.0 / rho;
        let ux = (f1 - f3 + f5 - f6 - f7 + f8) * invRho;
        let uy = (f2 - f4 + f5 + f6 - f7 - f8) * invRho;

        // Velocity clamp: prevent Mach number > ~0.35
        const uMag2 = ux * ux + uy * uy;
        if (uMag2 > maxU * maxU) {
          const sc = maxU / Math.sqrt(uMag2);
          ux *= sc; uy *= sc;
        }

        // Equilibrium distributions (fully unrolled)
        const usq = ux * ux + uy * uy;
        const u15 = 1.5 * usq;
        let eu;
        const feq0 = four9 * rho * (1 - u15);
        const feq1 = one9  * rho * (1 + 3 * ux + 4.5 * ux * ux - u15);
        const feq2 = one9  * rho * (1 + 3 * uy + 4.5 * uy * uy - u15);
        const feq3 = one9  * rho * (1 - 3 * ux + 4.5 * ux * ux - u15);
        const feq4 = one9  * rho * (1 - 3 * uy + 4.5 * uy * uy - u15);
        eu = ux + uy;  const feq5 = one36 * rho * (1 + 3 * eu + 4.5 * eu * eu - u15);
        eu = -ux + uy; const feq6 = one36 * rho * (1 + 3 * eu + 4.5 * eu * eu - u15);
        eu = -ux - uy; const feq7 = one36 * rho * (1 + 3 * eu + 4.5 * eu * eu - u15);
        eu = ux - uy;  const feq8 = one36 * rho * (1 + 3 * eu + 4.5 * eu * eu - u15);

        // Determine effective relaxation rates
        let sPlus = sPlus0, sMinus = sMinus0;

        if (useSmagorinsky) {
          // Non-equilibrium stress tensor computed directly from distributions.
          // This is the key advantage of LBM for LES: the stress tensor is a
          // natural output of the kinetic model — no finite-difference stencil
          // needed, no additional boundary treatment, exact on the lattice.
          //   Π^neq_αβ = Σ_i (f_i − f_i^eq) · e_iα · e_iβ
          const fneq1 = f1 - feq1, fneq2 = f2 - feq2, fneq3 = f3 - feq3;
          const fneq4 = f4 - feq4, fneq5 = f5 - feq5, fneq6 = f6 - feq6;
          const fneq7 = f7 - feq7, fneq8 = f8 - feq8;
          // Π_xx = Σ fneq_i · e_ix² (nonzero for d=1,3,5,6,7,8 where |e_x|=1)
          const Pxx = fneq1 + fneq3 + fneq5 + fneq6 + fneq7 + fneq8;
          // Π_yy = Σ fneq_i · e_iy² (nonzero for d=2,4,5,6,7,8 where |e_y|=1)
          const Pyy = fneq2 + fneq4 + fneq5 + fneq6 + fneq7 + fneq8;
          // Π_xy = Σ fneq_i · e_ix · e_iy
          const Pxy = fneq5 - fneq6 + fneq7 - fneq8;
          // |Π^neq| = √(Π_xx² + 2·Π_xy² + Π_yy²)
          const Qval = Math.sqrt(Pxx * Pxx + 2 * Pxy * Pxy + Pyy * Pyy);
          // Smagorinsky-adapted τ via quadratic formula:
          // τ_eff = ½(τ₀ + √(τ₀² + 18√2·Cs²·Q/ρ))
          const tauEff = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + 18 * SQRT2 * Cs2 * Qval * invRho));
          sPlus = 1.0 / tauEff;
          // TRT antisymmetric rate with magic parameter Λ = ¼
          const tauA = 0.5 + 1.0 / (4.0 * Math.max(tauEff - 0.5, 1e-6));
          sMinus = 1.0 / tauA;
          // Accumulate eddy viscosity: ν_t = (τ_eff − τ₀) / 3
          nutSum += (tauEff - tau0) / 3;
        }

        // ── TRT collision operator ──
        //   f_i^+ = (f_i + f_ī)/2    feq_i^+ = (feq_i + feq_ī)/2   (symmetric)
        //   f_i^- = (f_i − f_ī)/2    feq_i^- = (feq_i − feq_ī)/2   (antisymmetric)
        //   f_i* = f_i − s+·(f_i^+ − feq_i^+) − s-·(f_i^- − feq_i^-)
        //   f_ī* = f_ī − s+·(f_i^+ − feq_i^+) + s-·(f_i^- − feq_i^-)

        // Direction 0 (self-opposite: antisymmetric part = 0)
        f[0][idx] = f0 - sPlus * (f0 - feq0);

        // Pair (1, 3) — east / west
        const dpS13 = sPlus  * (0.5 * (f1 + f3) - 0.5 * (feq1 + feq3));
        const dmS13 = sMinus * (0.5 * (f1 - f3) - 0.5 * (feq1 - feq3));
        f[1][idx] = f1 - dpS13 - dmS13;
        f[3][idx] = f3 - dpS13 + dmS13;

        // Pair (2, 4) — south / north
        const dpS24 = sPlus  * (0.5 * (f2 + f4) - 0.5 * (feq2 + feq4));
        const dmS24 = sMinus * (0.5 * (f2 - f4) - 0.5 * (feq2 - feq4));
        f[2][idx] = f2 - dpS24 - dmS24;
        f[4][idx] = f4 - dpS24 + dmS24;

        // Pair (5, 7) — SE / NW
        const dpS57 = sPlus  * (0.5 * (f5 + f7) - 0.5 * (feq5 + feq7));
        const dmS57 = sMinus * (0.5 * (f5 - f7) - 0.5 * (feq5 - feq7));
        f[5][idx] = f5 - dpS57 - dmS57;
        f[7][idx] = f7 - dpS57 + dmS57;

        // Pair (6, 8) — SW / NE
        const dpS68 = sPlus  * (0.5 * (f6 + f8) - 0.5 * (feq6 + feq8));
        const dmS68 = sMinus * (0.5 * (f6 - f8) - 0.5 * (feq6 - feq8));
        f[6][idx] = f6 - dpS68 - dmS68;
        f[8][idx] = f8 - dpS68 + dmS68;

        // Clamp post-collision distributions to prevent negative populations
        for (let d = 0; d < 9; d++) {
          if (f[d][idx] < 0) f[d][idx] = 0;
        }
      }
    }
    // Update mean eddy viscosity for diagnostics (LBM Smagorinsky)
    if (useSmagorinsky) FL._meanEddyVisc = nutSum / (N * N);

    // ── Phase 2: Streaming (in-place, correct sweep order) ──
    // Each direction d propagates by its lattice velocity (ex[d], ey[d]).
    // Sweep order ensures we read from upstream before it's overwritten.

    // d=1: east (+1,0) — sweep right→left
    for (let j = 0; j < s; j++) {
      const jS = j * s;
      for (let i = s - 1; i > 0; i--) f[1][i + jS] = f[1][(i - 1) + jS];
    }
    // d=2: south (0,+1) — sweep bottom→top
    for (let j = s - 1; j > 0; j--) {
      const jS = j * s, jmS = (j - 1) * s;
      for (let i = 0; i < s; i++) f[2][i + jS] = f[2][i + jmS];
    }
    // d=3: west (−1,0) — sweep left→right
    for (let j = 0; j < s; j++) {
      const jS = j * s;
      for (let i = 0; i < s - 1; i++) f[3][i + jS] = f[3][(i + 1) + jS];
    }
    // d=4: north (0,−1) — sweep top→bottom
    for (let j = 0; j < s - 1; j++) {
      const jS = j * s, jpS = (j + 1) * s;
      for (let i = 0; i < s; i++) f[4][i + jS] = f[4][i + jpS];
    }
    // d=5: SE (+1,+1) — sweep right→left, bottom→top
    for (let j = s - 1; j > 0; j--) {
      const jS = j * s, jmS = (j - 1) * s;
      for (let i = s - 1; i > 0; i--) f[5][i + jS] = f[5][(i - 1) + jmS];
    }
    // d=6: SW (−1,+1) — sweep left→right, bottom→top
    for (let j = s - 1; j > 0; j--) {
      const jS = j * s, jmS = (j - 1) * s;
      for (let i = 0; i < s - 1; i++) f[6][i + jS] = f[6][(i + 1) + jmS];
    }
    // d=7: NW (−1,−1) — sweep left→right, top→bottom
    for (let j = 0; j < s - 1; j++) {
      const jS = j * s, jpS = (j + 1) * s;
      for (let i = 0; i < s - 1; i++) f[7][i + jS] = f[7][(i + 1) + jpS];
    }
    // d=8: NE (+1,−1) — sweep right→left, top→bottom
    for (let j = 0; j < s - 1; j++) {
      const jS = j * s, jpS = (j + 1) * s;
      for (let i = s - 1; i > 0; i--) f[8][i + jS] = f[8][(i - 1) + jpS];
    }

    // ── Phase 3: Bounce-back for obstacle cells (POST-streaming) ──
    // After streaming, obstacles have received populations from neighbors.
    // Swapping opposite directions reflects them back towards the fluid,
    // implementing no-slip boundary conditions.
    if (hasObs) {
      for (let j = 1; j <= N; j++) {
        const jS = j * s;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          if (!obs[idx]) continue;
          let tmp;
          tmp = f[1][idx]; f[1][idx] = f[3][idx]; f[3][idx] = tmp;
          tmp = f[2][idx]; f[2][idx] = f[4][idx]; f[4][idx] = tmp;
          tmp = f[5][idx]; f[5][idx] = f[7][idx]; f[7][idx] = tmp;
          tmp = f[6][idx]; f[6][idx] = f[8][idx]; f[8][idx] = tmp;
        }
      }
    }

    // ── Phase 4: Boundary conditions ──
    FL._lbmBoundaryConditions();

    // ── Phase 5: Extract macroscopic fields (post-streaming, post-BC) ──
    // This gives the most accurate representation of the current state.
    for (let j = 1; j <= N; j++) {
      const jS = j * s;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obs[idx]) {
          FL.u[idx] = 0; FL.v[idx] = 0; FL.rho[idx] = 1;
          FL.pressure[idx] = 0;
          continue;
        }
        const f0 = f[0][idx], f1 = f[1][idx], f2 = f[2][idx];
        const f3 = f[3][idx], f4 = f[4][idx], f5 = f[5][idx];
        const f6 = f[6][idx], f7 = f[7][idx], f8 = f[8][idx];
        let rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
        if (rho < 0.001) rho = 0.001;
        const invRho = 1.0 / rho;
        FL.u[idx] = (f1 - f3 + f5 - f6 - f7 + f8) * invRho;
        FL.v[idx] = (f2 - f4 + f5 + f6 - f7 - f8) * invRho;
        FL.rho[idx] = rho;
        // Pressure from equation of state: p = c_s² ρ, deviation from ρ₀=1
        FL.pressure[idx] = (rho - 1.0) * 0.333333;
      }
    }
  },

  // LBM boundary conditions for walls and wind tunnel.
  _lbmBoundaryConditions() {
    const N = FL.N, s = N + 2;
    const f = FL._lbmF;

    if (FL.windTunnel) {
      // ── Zou-He velocity inlet (left wall, i=1) ──
      // Prescribes ux = u_in, uy = 0, computes ρ from known distributions
      // More accurate and stable than forcing equilibrium at the inlet.
      const spd = Math.min(0.18, FL.windSpeed * 0.001);
      const one6 = 1.0 / 6, one2 = 0.5;

      for (let j = 1; j <= N; j++) {
        const idx = 1 + j * s;
        // After streaming, f[3], f[6], f[7] are known (came from interior)
        // f[0], f[2], f[4] are known (not affected by inlet)
        // f[1], f[5], f[8] are unknown (would come from outside)
        const rho = (f[0][idx] + f[2][idx] + f[4][idx]
                  + 2 * (f[3][idx] + f[6][idx] + f[7][idx])) / (1 - spd);
        const ru = rho * spd;
        f[1][idx] = f[3][idx] + (2.0 / 3) * ru;
        f[5][idx] = f[7][idx] + one6 * ru + one2 * (f[4][idx] - f[2][idx]);
        f[8][idx] = f[6][idx] + one6 * ru - one2 * (f[4][idx] - f[2][idx]);

        // Ghost column mirrors inlet
        const ig = 0 + j * s;
        for (let d = 0; d < 9; d++) f[d][ig] = f[d][idx];
      }

      // ── Outflow (right wall, i=N) — zero-gradient on unknown distributions ──
      // Only extrapolate the left-pointing distributions (f[3], f[6], f[7])
      // that are unknown at the outlet (would have streamed from outside).
      // Other distributions are correctly determined by interior streaming.
      for (let j = 0; j <= N + 1; j++) {
        const jS = j * s;
        // Unknown distributions at column N (left-pointing: would come from i=N+1)
        f[3][N + jS] = f[3][(N - 1) + jS];
        f[6][N + jS] = f[6][(N - 1) + jS];
        f[7][N + jS] = f[7][(N - 1) + jS];
        // Ghost column (N+1): copy all from column N for consistency
        for (let d = 0; d < 9; d++) {
          f[d][(N + 1) + jS] = f[d][N + jS];
        }
      }

      // ── Top wall (j=0): bounce-back ──
      // After streaming, f[4] (ey=-1), f[7] (NW), f[8] (NE) have arrived
      // at the wall from interior. Reflect them back.
      for (let i = 0; i < s; i++) {
        f[2][i]        = f[4][i];
        f[5][i]        = f[7][i];
        f[6][i]        = f[8][i];
      }
      // ── Bottom wall (j=N+1): bounce-back ──
      for (let i = 0; i < s; i++) {
        const bIdx = i + (N + 1) * s;
        f[4][bIdx] = f[2][bIdx];
        f[7][bIdx] = f[5][bIdx];
        f[8][bIdx] = f[6][bIdx];
      }
    } else {
      // Free-flow mode: bounce-back on all four walls
      // Top (j = 0)
      for (let i = 0; i < s; i++) {
        f[2][i] = f[4][i]; f[5][i] = f[7][i]; f[6][i] = f[8][i];
      }
      // Bottom (j = N+1)
      for (let i = 0; i < s; i++) {
        const bIdx = i + (N + 1) * s;
        f[4][bIdx] = f[2][bIdx]; f[7][bIdx] = f[5][bIdx]; f[8][bIdx] = f[6][bIdx];
      }
      // Left (i = 0)
      for (let j = 0; j < s; j++) {
        const jS = j * s;
        f[1][jS] = f[3][jS]; f[5][jS] = f[7][jS]; f[8][jS] = f[6][jS];
      }
      // Right (i = N+1)
      for (let j = 0; j < s; j++) {
        const jS = j * s;
        f[3][(N + 1) + jS] = f[1][(N + 1) + jS];
        f[7][(N + 1) + jS] = f[5][(N + 1) + jS];
        f[6][(N + 1) + jS] = f[8][(N + 1) + jS];
      }
    }
  },

  // Apply accumulated forces to LBM distributions using the Exact Difference
  // Method (EDM):  Δf_i = f_i^eq(ρ, u + F/ρ) − f_i^eq(ρ, u)
  //
  // EDM is exact to all orders in velocity — the Guo forcing scheme it replaces
  // is only 2nd-order accurate. EDM properly handles large forces (strong user
  // interaction, gravity) without the O(F²) errors that cause Guo forcing to
  // generate spurious density fluctuations. The implementation is also simpler:
  // just evaluate the equilibrium at two velocities and take the difference.
  //
  // Reference: Kupershtokh et al. (2009), "On equations of state in a lattice
  //            Boltzmann method", Computers & Mathematics with Applications.
  _lbmApplyForces() {
    const N = FL.N, s = N + 2;
    const f = FL._lbmF;
    const obs = FL.obstacles;
    const hasObs = FL._hasObstacles;
    const one9 = 1.0 / 9, one36 = 1.0 / 36, four9 = 4.0 / 9;
    // Scale: spread frame-accumulated force over sub-steps
    const scale = FL.dt / Math.max(1, FL._lbmStepsPerFrame);
    const hasGravity = Math.abs(FL.gravity) > 0.01;
    const grav = FL.gravity * 0.0008;

    for (let j = 1; j <= N; j++) {
      const jS = j * s;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obs[idx]) continue;
        let fx = FL.u0[idx] * scale;
        let fy = FL.v0[idx] * scale;
        if (hasGravity) {
          const dens = (FL.dR[idx] + FL.dG[idx] + FL.dB[idx]) * 0.333;
          fy += FL.dt * grav * dens;
        }
        if (fx * fx + fy * fy < 1e-14) continue;
        // Clamp force magnitude to prevent instability
        const fMag2 = fx * fx + fy * fy;
        if (fMag2 > 0.01) {
          const sc = 0.1 / Math.sqrt(fMag2);
          fx *= sc; fy *= sc;
        }

        // ── Exact Difference Method ──
        // Compute equilibrium at original velocity and forced velocity,
        // then add the difference to every distribution.
        const rhoVal = FL.rho[idx] > 0.001 ? FL.rho[idx] : 1.0;
        const invRho = 1.0 / rhoVal;
        const ux = FL.u[idx], uy = FL.v[idx];
        const ux1 = ux + fx * invRho, uy1 = uy + fy * invRho;

        const usq0 = ux * ux + uy * uy, u150 = 1.5 * usq0;
        const usq1 = ux1 * ux1 + uy1 * uy1, u151 = 1.5 * usq1;
        let eu0, eu1;

        // d=0: e=(0,0)
        f[0][idx] += four9 * rhoVal * (u150 - u151);
        // d=1: e=(1,0)
        eu0 = ux; eu1 = ux1;
        f[1][idx] += one9 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=2: e=(0,1)
        eu0 = uy; eu1 = uy1;
        f[2][idx] += one9 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=3: e=(-1,0)
        eu0 = -ux; eu1 = -ux1;
        f[3][idx] += one9 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=4: e=(0,-1)
        eu0 = -uy; eu1 = -uy1;
        f[4][idx] += one9 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=5: e=(1,1)
        eu0 = ux + uy; eu1 = ux1 + uy1;
        f[5][idx] += one36 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=6: e=(-1,1)
        eu0 = -ux + uy; eu1 = -ux1 + uy1;
        f[6][idx] += one36 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=7: e=(-1,-1)
        eu0 = -ux - uy; eu1 = -ux1 - uy1;
        f[7][idx] += one36 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));
        // d=8: e=(1,-1)
        eu0 = ux - uy; eu1 = ux1 - uy1;
        f[8][idx] += one36 * rhoVal * ((3*eu1 + 4.5*eu1*eu1 - u151) - (3*eu0 + 4.5*eu0*eu0 - u150));

        // Keep distributions non-negative
        for (let d = 0; d < 9; d++) {
          if (f[d][idx] < 0) f[d][idx] = 0;
        }
      }
    }
  },

  // Clear the accumulated force buffers after applying.
  _lbmClearForces() {
    FL.u0.fill(0); FL.v0.fill(0);
  },

  // Wind tunnel dye injection for LBM mode.
  _lbmInjectWindDye() {
    const { N, obstacles } = FL;
    const stride = N + 2;
    // ── Outlet sponge: fade dye near right wall ──
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let k = 0; k < 10; k++) {
        const i = N - k;
        if (i < 1) break;
        const idx = i + jS;
        if (obstacles[idx]) continue;
        const xi = (10 - k) / 10;
        const decay = 1.0 - 0.35 * xi * xi;
        FL.dR[idx] *= decay; FL.dG[idx] *= decay; FL.dB[idx] *= decay;
      }
    }
    // ── Inject coloured streamlines at inlet ──
    // Use wider stripes (3 cells each) for more visible dye
    const nStripes = 8;
    const gap = ((N - 2) / nStripes) | 0;
    for (let si = 0; si < nStripes; si++) {
      const col = FL._PALETTE[si % FL._PALETTE.length];
      const cr = col[0] / 255 * 0.9;
      const cg = col[1] / 255 * 0.9;
      const cb = col[2] / 255 * 0.9;
      const jc = 2 + si * gap + (gap >> 1);
      // Inject 3 rows per stripe for visibility
      for (let dj = -1; dj <= 1; dj++) {
        const j = jc + dj;
        if (j < 1 || j > N) continue;
        const idx = 1 + j * stride;
        if (obstacles[idx]) continue;
        FL.dR0[idx] = cr; FL.dG0[idx] = cg; FL.dB0[idx] = cb;
      }
    }
  },

  // ─── Wind tunnel inlet + open BCs ────────
  _injectWind() {
    const { N, windSpeed, obstacles } = FL;
    const stride = N + 2;
    const spd    = windSpeed * 0.008;  // normalised to grid units

    // LEFT WALL: uniform inlet velocity (all rows)
    for (let j = 1; j <= N; j++) {
      const jS  = j * stride;
      const idx = 1 + jS;
      FL.u[0 + jS] = spd;  // left ghost
      FL.u[idx]    = spd;
      FL.v[0 + jS] = 0;    // no transverse inflow
      FL.v[idx]    = 0;
      FL.u0[idx]   = 0;
      FL.v0[idx]   = 0;
    }

    // RIGHT WALL: open outflow + Rayleigh damping sponge layer
    // A multi-cell sponge zone relaxes velocity toward freestream and fades
    // dye, preventing non-physical wave reflections at the outlet boundary.
    // This is standard practice in computational aeroacoustics (CAA) and
    // high-fidelity wind tunnel CFD. The damping profile is quadratic:
    //   σ(ξ) = σ_max · ξ²   where ξ ∈ [0,1] increases toward outlet
    // giving smooth onset (no abrupt damping at the sponge inner edge).
    const spongeW = 8;
    const sigmaMax = 2.0;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      // Ghost cell: Neumann outflow
      const idxOut = (N + 1) + jS;
      FL.u[idxOut] = FL.u[(N - 1) + jS];
      FL.v[idxOut] = FL.v[(N - 1) + jS];
      FL.dR[idxOut] = 0; FL.dG[idxOut] = 0; FL.dB[idxOut] = 0;
      // Rayleigh sponge: relax over spongeW cells toward freestream
      for (let k = 0; k < spongeW; k++) {
        const i = N - k;
        if (i < 1) break;
        const idx = i + jS;
        if (obstacles[idx]) continue;
        const xi = (spongeW - k) / spongeW;        // 1 at outlet, 0 at inner edge
        const sigma = sigmaMax * xi * xi;            // quadratic damping profile
        const decay = 1.0 / (1.0 + sigma * FL.dt);  // implicit Rayleigh damping
        FL.u[idx] = spd + (FL.u[idx] - spd) * decay; // relax u → freestream
        FL.v[idx] *= decay;                           // damp transverse velocity
        FL.dR[idx] *= decay; FL.dG[idx] *= decay; FL.dB[idx] *= decay;
      }
    }

    // TOP & BOTTOM: slip walls (free-slip: ∂u/∂y = 0, v = 0)
    for (let i = 1; i <= N; i++) {
      FL.u[i + 0 * stride]       = FL.u[i + 1 * stride];       // top ghost
      FL.u[i + (N+1) * stride]   = FL.u[i + N * stride];       // bottom ghost
      FL.v[i + 0 * stride]       = 0;
      FL.v[i + (N+1) * stride]   = 0;
    }

    // Inject coloured streamlines at inlet (single-cell-wide horizontal lines)
    const nStripes = 8;
    const gap      = ((N - 2) / nStripes) | 0;
    for (let s = 0; s < nStripes; s++) {
      const col    = FL._PALETTE[s % FL._PALETTE.length];
      const cr     = col[0] / 255 * 0.85;
      const cg     = col[1] / 255 * 0.85;
      const cb     = col[2] / 255 * 0.85;
      const jc     = 2 + s * gap + (gap >> 1);
      // Inject 3 rows per stripe for visibility (matches LBM behavior)
      for (let dj = -1; dj <= 1; dj++) {
        const j = jc + dj;
        if (j < 1 || j > N) continue;
        const idx = 1 + j * stride;
        if (obstacles[idx]) continue;
        FL.dR0[idx] = cr;
        FL.dG0[idx] = cg;
        FL.dB0[idx] = cb;
      }
    }
  },

  // ─── Compressible velocity step — hybrid weakly-compressible formulation ──
  // Uses the incompressible projection for numerical stability and adds a
  // density field driven by pre-projection divergence (compression signal).
  // A weak density-based pressure correction feeds compressible effects back
  // into the velocity field. This avoids the extreme CFL restriction of a
  // fully-explicit compressible solver (which would need ~200 sub-steps).
  //  • Density variations from local convergence/divergence
  //  • Equation of state p = c²(ρ − ρ₀) for density-pressure coupling
  //  • Visible Mach/density effects without sacrificing interactivity
  //  • Converges to standard incompressible solver as c_s → ∞
  _velStepCompressible() {
    const { u, v, u0, v0, rho, rho0, visc, dt, speedOfSound } = FL;
    const N = FL.N;
    const stride = N + 2;
    const len = u.length;
    const cs2 = speedOfSound * speedOfSound; // c²
    const obstacles = FL.obstacles;
    const hasObs = FL._hasObstacles;

    // ──── Phase 1: Standard velocity step (projection-based, stable) ────
    // Add body forces (u0/v0 hold forces from user input)
    for (let i = 0; i < len; i++) { u[i] += dt * u0[i]; v[i] += dt * v0[i]; }
    u0.fill(0); v0.fill(0);

    // Buoyancy / gravity
    if (Math.abs(FL.gravity) > 0.01) {
      const grav = FL.gravity * 0.0008;
      for (let j = 1; j <= N; j++) {
        const jS = j * stride;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          if (hasObs && obstacles[idx]) continue;
          const dens = (FL.dR[idx] + FL.dG[idx] + FL.dB[idx]) * 0.333;
          v[idx] += dt * grav * dens;
        }
      }
    }

    // Diffuse velocity (implicit solver — unconditionally stable)
    u0.set(u); v0.set(v);
    if (visc > 1e-7) {
      FL._diffuse(1, u, u0, visc);
      FL._diffuse(2, v, v0, visc);
    }

    // ── Density-based pressure correction (before first projection) ──
    // Apply force from density deviation via EOS p = c²(ρ−ρ₀); this is the
    // compressible feedback that creates visible density waves and Mach effects.
    // α = 1 gives full physical coupling; reduced slightly for stability with
    // the hybrid projection approach (projection removes some of the signal).
    const alpha = 0.35; // feedback strength: 0 = incompressible, 1 = full
    if (alpha > 0) {
      for (let j = 1; j <= N; j++) {
        const jS = j * stride;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          if (hasObs && obstacles[idx]) continue;
          const invRho = 1.0 / rho[idx];
          // −(α/ρ)∇p  where p = c²(ρ−1);  ∇ρ via central differences / (2h)
          const dpx = cs2 * (rho[idx + 1]      - rho[idx - 1])      * 0.5 * N;
          const dpy = cs2 * (rho[idx + stride] - rho[idx - stride]) * 0.5 * N;
          u[idx] -= alpha * dt * invRho * dpx;
          v[idx] -= alpha * dt * invRho * dpy;
        }
      }
      FL._setBnd(1, u); FL._setBnd(2, v);
    }

    // ──── Phase 2: Density evolution from pre-projection divergence ────
    // CRITICAL: Measure divergence BEFORE projection. The EOS-driven
    // pressure gradient creates convergence/divergence in the velocity
    // field — this IS the physical compression signal. If we measured
    // after projection, the projection would have already removed it,
    // leaving only tiny numerical residuals and no meaningful density
    // evolution. Measuring here captures the full compressible signal.
    //
    // ∂ρ/∂t = −ρ·∇·u  (continuity equation)
    // Enhanced with Von Neumann-Richtmyer-style artificial bulk viscosity
    // in compression zones (∇·u < 0) to prevent Gibbs oscillations.
    rho0.set(rho);
    const maxDrho = 0.30; // cap per-step density change for stability
    const halfN = 0.5 * N;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) { rho[idx] = 1.0; continue; }
        // Physical divergence ∇·u (central differences, factor N/2 = 1/(2h))
        const divLocal = (u[idx + 1] - u[idx - 1]
                        + v[idx + stride] - v[idx - stride]) * halfN;
        let drho = -dt * rho0[idx] * divLocal;
        // Artificial bulk viscosity for shock capturing
        if (divLocal < -0.01) {
          const lapRho = rho0[idx + 1] + rho0[idx - 1]
                       + rho0[idx + stride] + rho0[idx - stride]
                       - 4 * rho0[idx];
          drho += 0.08 * lapRho;
        }
        if (drho >  maxDrho) drho =  maxDrho;
        if (drho < -maxDrho) drho = -maxDrho;
        rho[idx] = rho0[idx] + drho;
      }
    }
    FL._setBnd(0, rho);

    // First projection (enforces near-incompressibility)
    FL._project(u, v, u0, v0);

    // Advect velocity (MacCormack for accuracy — fused u/v)
    u0.set(u); v0.set(v);
    FL._advectUV(u, v, u0, v0);

    // Second projection
    FL._project(u, v, u0, v0);
    // Snapshot projection pressure for rendering
    FL.pressure.set(u0);

    // Advect density with divergence-free velocity
    rho0.set(rho);
    FL._advectFast(0, rho, rho0, u, v);

    // Gentle relaxation toward ρ₀=1 (prevents unbounded drift) + clamp
    const relax = 0.9992;
    for (let i = 0; i < len; i++) {
      rho[i] = 1.0 + (rho[i] - 1.0) * relax;
      if (rho[i] < 0.1)  rho[i] = 0.1;
      if (rho[i] > 5.0)  rho[i] = 5.0;
    }

    // ──── Phase 4: Update pressure to include density contribution ────
    // Scale EOS pressure by dt to match solver-pressure units
    // (Stam's projection pressure = dt × physical pressure)
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        FL.pressure[idx] += dt * cs2 * (rho[idx] - 1.0);
      }
    }

    // ──── Phase 5: Compute Mach number & density stats ────
    let maxSpd = 0;
    let maxRhoRatio = 1;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) continue;
        const sp = u[idx] * u[idx] + v[idx] * v[idx];
        if (sp > maxSpd) maxSpd = sp;
        const rr = rho[idx];
        if (rr > maxRhoRatio) maxRhoRatio = rr;
        if (1 / rr > maxRhoRatio) maxRhoRatio = 1 / rr;
      }
    }
    FL._machNumber = Math.sqrt(maxSpd) / speedOfSound;
    FL._maxDensRatio = maxRhoRatio;

    // Enforce obstacles
    FL._applyObstacleBCs();

    // Wind tunnel BCs
    if (FL.windTunnel) {
      FL._injectWind();
      // Reset density at inlet to ρ₀=1
      for (let j = 1; j <= N; j++) {
        const jS = j * stride;
        rho[0 + jS] = 1.0;
        rho[1 + jS] = 1.0;
        // Neumann outlet
        rho[(N+1) + jS] = rho[N + jS];
      }
      if (FL.fc % 3 === 0) FL._computeAeroCoeffs();
    }
    if (FL.fc % 3 === 0) FL._computeEducationalStats();
    FL._vorticityConfinement();
    // Smagorinsky SGS turbulence model — adds resolved-scale turbulent diffusion
    FL._smagorinskyLES();
  },

  // ─── Velocity step (incompressible) ─────────────────────────
  _velStep() {
    const { u, v, u0, v0, visc, dt } = FL;
    const len = u.length;

    // Add body forces (u0, v0 hold forces added by user)
    for (let i = 0; i < len; i++) { u[i] += dt * u0[i]; v[i] += dt * v0[i]; }
    u0.fill(0); v0.fill(0);

    // Buoyancy / gravity — density-driven vertical force
    if (Math.abs(FL.gravity) > 0.01) {
      const N = FL.N, stride = N + 2;
      const grav = FL.gravity * 0.0008;
      for (let j = 1; j <= N; j++) {
        const jS = j * stride;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          if (FL.obstacles[idx]) continue;
          const dens = (FL.dR[idx] + FL.dG[idx] + FL.dB[idx]) * 0.333;
          v[idx] += dt * grav * dens;
        }
      }
    }

    // Diffuse — skip when viscosity is negligible for perf
    u0.set(u); v0.set(v);
    if (visc > 1e-7) {
      FL._diffuse(1, u, u0, visc);
      FL._diffuse(2, v, v0, visc);
    }

    // Keep density at ρ₀=1 in incompressible mode (prevents stale values
    // from compressible mode bleeding into rendering)
    if (FL.rho) FL.rho.fill(1.0);

    // Project (enforce incompressibility)
    FL._project(u, v, u0, v0);

    // Advect (fused u/v MacCormack)
    u0.set(u); v0.set(v);
    FL._advectUV(u, v, u0, v0);

    // Project again (second projection keeps divergence-free after advection)
    FL._project(u, v, u0, v0);
    // Snapshot pressure for rendering (u0 holds pressure after _project)
    FL.pressure.set(u0);

    // Enforce obstacles
    FL._applyObstacleBCs();

    // Wind tunnel: override BCs AFTER all linSolve/_setBnd calls so they stick
    if (FL.windTunnel) {
      FL._injectWind();
      if (FL.fc % 3 === 0) FL._computeAeroCoeffs();
    }
    // Educational stats computation (throttled to every 3rd frame)
    if (FL.fc % 3 === 0) FL._computeEducationalStats();
    // Vorticity confinement runs for both modes; protected columns in wind tunnel
    FL._vorticityConfinement();
    // Smagorinsky SGS turbulence model — adds resolved-scale turbulent diffusion
    FL._smagorinskyLES();
  },

  // ─── Aerodynamic coefficient estimation ────
  // Integrates pressure around obstacle boundary to estimate CL, CD, Re.
  // Not exact (staircase boundary) but educational and directionally accurate.
  _computeAeroCoeffs() {
    const { N, u, v, pressure, obstacles, windSpeed } = FL;
    const stride = N + 2;
    const isLBM = FL.solverMode === 'lbm';
    const spd = isLBM ? Math.min(0.15, windSpeed * 0.0006) : windSpeed * 0.008;
    const nu  = isLBM ? Math.max((FL._lbmTau - 0.5) / 3, 1e-6) : (FL.visc > 0 ? FL.visc : 1e-6);
    let Fx = 0, Fy = 0;
    let obstCount = 0;
    let minOx = N, maxOx = 0, minOy = N, maxOy = 0;

    // Find obstacle bounding box and integrate pressure on boundary cells
    for (let j = 2; j < N; j++) {
      const jS = j * stride;
      for (let i = 2; i < N; i++) {
        const idx = i + jS;
        if (!obstacles[idx]) continue;
        obstCount++;
        if (i < minOx) minOx = i;
        if (i > maxOx) maxOx = i;
        if (j < minOy) minOy = j;
        if (j > maxOy) maxOy = j;

        // Check all 4 neighbours — if any is fluid, this is a boundary cell
        const nL = obstacles[idx - 1] ? 0 : 1;
        const nR = obstacles[idx + 1] ? 0 : 1;
        const nD = obstacles[idx - stride] ? 0 : 1;
        const nU = obstacles[idx + stride] ? 0 : 1;
        if (nL + nR + nD + nU === 0) continue; // fully interior

        // Pressure force: F = -p·n̂ on each exposed face
        if (nL) Fx -= pressure[idx - 1];
        if (nR) Fx += pressure[idx + 1];
        if (nD) Fy -= pressure[idx - stride];
        if (nU) Fy += pressure[idx + stride];

        // Viscous (friction) drag — wall shear stress τ_w ≈ μ·∂u_t/∂n
        // LBM: pressure in lattice units (no dt factor);  N-S: solver units (dt × physical)
        const viscScale = isLBM ? 2 * nu * N : 2 * FL.visc * N * FL.dt;
        if (nL) { Fx -= viscScale * u[idx - 1]; Fy -= viscScale * v[idx - 1]; }
        if (nR) { Fx += viscScale * u[idx + 1]; Fy += viscScale * v[idx + 1]; }
        if (nD) { Fx -= viscScale * u[idx - stride]; Fy -= viscScale * v[idx - stride]; }
        if (nU) { Fx += viscScale * u[idx + stride]; Fy += viscScale * v[idx + stride]; }
      }
    }

    const charLen = Math.max(maxOy - minOy, maxOx - minOx, 1) / N; // fraction of domain
    const refArea = charLen; // 2D: ref "area" is chord length
    const q = 0.5 * spd * spd; // dynamic pressure
    if (q > 1e-10 && refArea > 0) {
      // LBM: units are self-consistent (lattice units); N-S: divide by dt
      const qDenom = isLBM ? q * N * refArea : q * N * refArea * FL.dt;
      FL._dragCoeff = Fx / qDenom;
      FL._liftCoeff = -Fy / qDenom;
    }
    // Reynolds number: Re = U·L/ν
    FL._reynoldsNum = spd * charLen * N / nu;
  },

  // ─── Educational statistics ─────────────────────────────────
  // Computes kinetic energy, enstrophy, CFL number, Strouhal number,
  // and flow regime — key quantities for CFD education.
  _computeEducationalStats() {
    const { N, u, v, dt, obstacles } = FL;
    const stride = N + 2;
    let ke = 0, enst = 0, maxU = 0, maxV = 0;

    for (let j = 2; j < N; j++) {
      const jS = j * stride;
      for (let i = 2; i < N; i++) {
        const idx = i + jS;
        if (obstacles[idx]) continue;
        const uu = u[idx], vv = v[idx];
        ke += uu * uu + vv * vv;
        // Vorticity ω = ∂v/∂x − ∂u/∂y
        const curl = (v[idx + 1] - v[idx - 1] - u[idx + stride] + u[idx - stride]) * 0.5;
        enst += curl * curl;
        const au = Math.abs(uu), av = Math.abs(vv);
        if (au > maxU) maxU = au;
        if (av > maxV) maxV = av;
      }
    }

    FL._kineticEnergy = ke * 0.5 / (N * N);
    FL._enstrophy = enst / (N * N);
    FL._cflNumber = Math.max(maxU, maxV) * dt * N;

    // For LBM: compute Mach number (c_s = 1/√3 ≈ 0.577 in lattice units)
    if (FL.solverMode === 'lbm') {
      const maxSpd = Math.sqrt(maxU * maxU + maxV * maxV);
      FL._machNumber = maxSpd * 1.7320508; // maxSpd / (1/√3) = maxSpd × √3
    }

    // Effective viscosity: molecular + turbulent (Smagorinsky SGS)
    // ν_eff = ν + <ν_t> represents the total dissipation rate
    const baseVisc = FL.solverMode === 'lbm' ? (FL._lbmTau - 0.5) / 3 : FL.visc;
    FL._effectiveVisc = baseVisc + FL._meanEddyVisc;

    // Flow regime classification based on Reynolds number
    const Re = FL._reynoldsNum;
    if (!FL.windTunnel || Re < 1) {
      FL._flowRegime = FL.windTunnel ? 'N/A' : 'Free';
    } else if (Re < 10) {
      FL._flowRegime = 'Creeping';
    } else if (Re < 47) {
      FL._flowRegime = 'Laminar (steady)';
    } else if (Re < 190) {
      FL._flowRegime = 'Laminar (vortex street)';
    } else if (Re < 1000) {
      FL._flowRegime = 'Transitional';
    } else {
      FL._flowRegime = 'Turbulent';
    }

    // Strouhal number estimation via zero-crossing detection of lift
    if (FL.windTunnel && FL._hasObstacles) {
      const tracker = FL._sheddingTracker;
      const now = performance.now();
      const liftSign = FL._liftCoeff > 0 ? 1 : -1;

      if (tracker.lastSign !== 0 && liftSign !== tracker.lastSign) {
        // Zero crossing detected
        tracker.crossings.push(now);
        // Keep last 20 crossings
        if (tracker.crossings.length > 20) tracker.crossings.shift();
      }
      tracker.lastSign = liftSign;

      // Estimate frequency from crossing intervals (need at least 4 crossings = 2 full periods)
      if (tracker.crossings.length >= 4 && now - tracker.lastUpdate > 500) {
        const c = tracker.crossings;
        let totalPeriod = 0;
        let count = 0;
        // Each pair of crossings is half a period, so stride by 2
        for (let i = 2; i < c.length; i += 2) {
          totalPeriod += c[i] - c[i - 2];
          count++;
        }
        if (count > 0) {
          const avgPeriodMs = totalPeriod / count; // ms per full period
          const freq = 1000 / avgPeriodMs; // Hz
          // St = f * D / U  (D = characteristic length, U = freestream velocity)
          // We need dimensional characteristic length. Use _computeAeroCoeffs bounding box logic.
          const spd = FL.solverMode === 'lbm'
            ? Math.min(0.15, FL.windSpeed * 0.0006)
            : FL.windSpeed * 0.008;
          // Approximate characteristic length from obstacle size
          let minOx = N, maxOx = 0, minOy = N, maxOy = 0;
          for (let j2 = 2; j2 < N; j2++) {
            const jS2 = j2 * stride;
            for (let i2 = 2; i2 < N; i2++) {
              if (!obstacles[i2 + jS2]) continue;
              if (i2 < minOx) minOx = i2;
              if (i2 > maxOx) maxOx = i2;
              if (j2 < minOy) minOy = j2;
              if (j2 > maxOy) maxOy = j2;
            }
          }
          const charLen = Math.max(maxOy - minOy, maxOx - minOx, 1) / N;
          if (spd > 0.001) {
            // Strouhal: St = f·D/U — dimensionless shedding frequency
            // freq is in real Hz (from wall-clock timing), normalise properly
            const simTimePerSec = FL.fps * FL.dt; // simulation time units per real second
            const rawSt = freq * charLen / (spd * simTimePerSec);
            // Exponential smoothing for stability
            const prevSt = FL._strouhalNum || rawSt;
            FL._strouhalNum = prevSt * 0.7 + rawSt * 0.3;
          }
        }
        tracker.lastUpdate = now;
      }
    }
  },

  // ─── Density step (single channel — kept for compatibility) ─────
  _densStep(d, d0) {
    const len = d.length;
    const dt = FL.dt;
    const fade = FL.densityFade;
    const diff = FL.diff;
    for (let i = 0; i < len; i++) d[i] += dt * d0[i];
    d0.fill(0);
    if (diff > 1e-7) {
      const tmp = d0; d0.set(d);
      FL._diffuse(0, d, tmp, diff);
      tmp.set(d);
    } else {
      d0.set(d);
    }
    FL._advectFast(0, d, d0, FL.u, FL.v);
    for (let i = 0; i < len; i++) d[i] *= fade;
  },

  // ─── Fused RGB advection — computes departure points once for all 3 channels ──
  // Eliminates 2/3 of the back-trace and interpolation weight calculations
  // compared to calling _advectFast three times.
  // ─── Fused RGB advection with RK2 back-trace and integrated fade ──────
  // Computes departure points once for all 3 channels using RK2 midpoint
  // tracing (same as velocity advection), and applies density fade inline —
  // eliminating a separate N² fade loop (saves ~110K memory accesses/frame).
  // The RK2 trace captures streamline curvature that Euler misses, producing
  // visibly sharper dye filaments around vortex cores.
  _advectFastRGB(dR, dG, dB, dR0, dG0, dB0, ux, uy) {
    const N = FL.N;
    const stride = N + 2;
    const dt0 = FL.dt * N;
    const hasObs = FL._hasObstacles;
    const obstacles = FL.obstacles;
    const lim = N + 0.5;
    const fade = FL.densityFade;
    const hdt = 0.5 * dt0;
    for (let j = 1; j <= N; j++) {
      const jS = j * stride;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;
        if (hasObs && obstacles[idx]) {
          dR[idx] = 0; dG[idx] = 0; dB[idx] = 0;
          continue;
        }
        // RK2 midpoint back-trace (shared across all 3 channels)
        let xh = i - hdt * ux[idx];
        let yh = j - hdt * uy[idx];
        if (xh < 0.5) xh = 0.5; else if (xh > lim) xh = lim;
        if (yh < 0.5) yh = 0.5; else if (yh > lim) yh = lim;
        const mi0 = xh | 0, mi1 = mi0 + 1;
        const mj0 = yh | 0, mj1 = mj0 + 1;
        const ms1 = xh - mi0, ms0 = 1 - ms1;
        const mt1 = yh - mj0, mt0 = 1 - mt1;
        const ma00 = mi0 + mj0 * stride, ma10 = mi1 + mj0 * stride;
        const ma01 = mi0 + mj1 * stride, ma11 = mi1 + mj1 * stride;
        const mw00 = ms0 * mt0, mw10 = ms1 * mt0, mw01 = ms0 * mt1, mw11 = ms1 * mt1;
        const umid = mw00 * ux[ma00] + mw10 * ux[ma10] + mw01 * ux[ma01] + mw11 * ux[ma11];
        const vmid = mw00 * uy[ma00] + mw10 * uy[ma10] + mw01 * uy[ma01] + mw11 * uy[ma11];
        // Full step with midpoint velocity
        let xx = i - dt0 * umid;
        let yy = j - dt0 * vmid;
        if (xx < 0.5) xx = 0.5; else if (xx > lim) xx = lim;
        if (yy < 0.5) yy = 0.5; else if (yy > lim) yy = lim;
        const i0 = xx | 0, i1 = i0 + 1;
        const j0 = yy | 0, j1 = j0 + 1;
        const s1 = xx - i0, s0 = 1 - s1;
        const t1 = yy - j0, t0 = 1 - t1;
        const a00 = i0 + j0 * stride, a10 = i1 + j0 * stride;
        const a01 = i0 + j1 * stride, a11 = i1 + j1 * stride;
        const w00 = s0 * t0, w10 = s1 * t0, w01 = s0 * t1, w11 = s1 * t1;
        // Bilinear interpolation + fused fade (eliminates separate fade loop)
        dR[idx] = (w00 * dR0[a00] + w10 * dR0[a10] + w01 * dR0[a01] + w11 * dR0[a11]) * fade;
        dG[idx] = (w00 * dG0[a00] + w10 * dG0[a10] + w01 * dG0[a01] + w11 * dG0[a11]) * fade;
        dB[idx] = (w00 * dB0[a00] + w10 * dB0[a10] + w01 * dB0[a01] + w11 * dB0[a11]) * fade;
      }
    }
    FL._setBnd(0, dR); FL._setBnd(0, dG); FL._setBnd(0, dB);
  },

  // ─── Fused RGB density step — processes all 3 dye channels together ──
  // Reduces loop overhead and improves cache locality vs. 3× _densStep.
  _densStepRGB() {
    const { dR, dG, dB, dR0, dG0, dB0, dt, diff } = FL;
    const len = dR.length;

    // 1. Add sources + clear source buffers (fused)
    for (let i = 0; i < len; i++) {
      dR[i] += dt * dR0[i]; dR0[i] = 0;
      dG[i] += dt * dG0[i]; dG0[i] = 0;
      dB[i] += dt * dB0[i]; dB0[i] = 0;
    }

    // 2. Diffuse each channel independently (implicit solver)
    if (diff > 1e-7) {
      dR0.set(dR); FL._diffuse(0, dR, dR0, diff);
      dG0.set(dG); FL._diffuse(0, dG, dG0, diff);
      dB0.set(dB); FL._diffuse(0, dB, dB0, diff);
    }

    // 3. Copy for advection + advect all 3 channels in one pass
    //    Fade is fused into _advectFastRGB (no separate fade loop needed)
    dR0.set(dR); dG0.set(dG); dB0.set(dB);
    FL._advectFastRGB(dR, dG, dB, dR0, dG0, dB0, FL.u, FL.v);
  },

  // ═══════════════════════════════════════════════════════════════
  // ─── Lagrangian Particle Tracer ───────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  // Advects massless tracer particles through the velocity field
  // using 4th-order Runge-Kutta integration (RK4). This produces
  // smooth, accurate pathlines even in strongly curved flows.
  //
  // Each particle stores a trail of recent positions for visual
  // streakline rendering. Particles that leave the domain or hit
  // obstacles are automatically re-seeded at appropriate locations
  // (inlet in wind tunnel, random otherwise).
  //
  // Physics: dx_p/dt = u(x_p, t)  — Lagrangian particle equation
  // ═══════════════════════════════════════════════════════════════

  _initParticles() {
    FL._particles = [];
    FL._seedParticles();
  },

  _seedParticles() {
    const { N, _particleMax: maxP } = FL;
    const particles = FL._particles;
    particles.length = 0;
    if (FL.windTunnel) {
      // Seed along inlet evenly
      for (let k = 0; k < maxP; k++) {
        particles.push({
          x: 2 + Math.random() * 4,
          y: 1 + Math.random() * N,
          trail: [], age: 0,
          ci: k % FL._PALETTE.length
        });
      }
    } else {
      // Seed on a jittered grid
      const side = Math.ceil(Math.sqrt(maxP));
      const step = N / (side + 1);
      let count = 0;
      for (let j = 0; j < side && count < maxP; j++) {
        for (let i = 0; i < side && count < maxP; i++) {
          particles.push({
            x: 1 + (i + 0.3 + Math.random() * 0.4) * step,
            y: 1 + (j + 0.3 + Math.random() * 0.4) * step,
            trail: [], age: 0,
            ci: count % FL._PALETTE.length
          });
          count++;
        }
      }
    }
  },

  // Bilinear interpolation of a field at continuous position (px, py).
  // Used by particle tracer and other Lagrangian routines.
  _interpField(field, px, py) {
    const N = FL.N, stride = N + 2;
    const i0 = px | 0, j0 = py | 0;
    if (i0 < 1 || i0 >= N || j0 < 1 || j0 >= N) return 0;
    const i1 = i0 + 1, j1 = j0 + 1;
    const s = px - i0, t = py - j0;
    const s1 = 1 - s, t1 = 1 - t;
    return s1 * t1 * field[i0 + j0 * stride] + s * t1 * field[i1 + j0 * stride]
         + s1 * t  * field[i0 + j1 * stride] + s * t  * field[i1 + j1 * stride];
  },

  _advectParticles() {
    if (!FL.showParticles || !FL._particles) return;
    const { N, u, v, obstacles, dt } = FL;
    const stride = N + 2;
    const particles = FL._particles;
    const trailLen = FL._particleTrailLen;
    const dtN = dt * N;

    for (let k = 0; k < particles.length; k++) {
      const p = particles[k];
      const x = p.x, y = p.y;

      // Out-of-bounds → re-seed
      if (x < 1 || x > N || y < 1 || y > N) {
        FL._reseedParticle(p);
        continue;
      }

      // Hit obstacle → re-seed
      const idx = (x | 0) + (y | 0) * stride;
      if (obstacles[idx]) {
        FL._reseedParticle(p);
        continue;
      }

      // Helper: clamp sample point to domain and reject obstacle cells
      // Returns velocity from the field, or zero if inside an obstacle.
      const safeVx = (sx, sy) => {
        const cx = Math.max(1, Math.min(N, sx)) | 0;
        const cy = Math.max(1, Math.min(N, sy)) | 0;
        if (obstacles[cx + cy * stride]) return 0;
        return FL._interpField(u, sx, sy);
      };
      const safeVy = (sx, sy) => {
        const cx = Math.max(1, Math.min(N, sx)) | 0;
        const cy = Math.max(1, Math.min(N, sy)) | 0;
        if (obstacles[cx + cy * stride]) return 0;
        return FL._interpField(v, sx, sy);
      };

      // RK4 integration (4th-order Runge-Kutta)
      const k1x = safeVx(x, y) * dtN;
      const k1y = safeVy(x, y) * dtN;
      const k2x = safeVx(x + 0.5 * k1x, y + 0.5 * k1y) * dtN;
      const k2y = safeVy(x + 0.5 * k1x, y + 0.5 * k1y) * dtN;
      const k3x = safeVx(x + 0.5 * k2x, y + 0.5 * k2y) * dtN;
      const k3y = safeVy(x + 0.5 * k2x, y + 0.5 * k2y) * dtN;
      const k4x = safeVx(x + k3x, y + k3y) * dtN;
      const k4y = safeVy(x + k3x, y + k3y) * dtN;

      let nx = x + (k1x + 2 * k2x + 2 * k3x + k4x) / 6;
      let ny = y + (k1y + 2 * k2y + 2 * k3y + k4y) / 6;

      // Check if new position is inside an obstacle → reseed
      if (nx >= 1 && nx <= N && ny >= 1 && ny <= N) {
        const ni = (nx | 0) + (ny | 0) * stride;
        if (obstacles[ni]) {
          FL._reseedParticle(p);
          continue;
        }
      }

      // Bresenham-style march between old and new cell to catch thin obstacles
      const ci0 = x | 0, cj0 = y | 0;
      const ci1 = nx | 0, cj1 = ny | 0;
      if (ci0 !== ci1 || cj0 !== cj1) {
        // Simple line march through intermediate cells
        const di = ci1 - ci0, dj = cj1 - cj0;
        const steps = Math.max(Math.abs(di), Math.abs(dj));
        let hitObs = false;
        for (let t = 1; t <= steps; t++) {
          const mi = ci0 + Math.round(di * t / steps);
          const mj = cj0 + Math.round(dj * t / steps);
          if (mi >= 1 && mi <= N && mj >= 1 && mj <= N && obstacles[mi + mj * stride]) {
            hitObs = true;
            break;
          }
        }
        if (hitObs) {
          FL._reseedParticle(p);
          continue;
        }
      }

      // Store trail point before moving
      p.trail.push(x, y); // flat array: x0,y0,x1,y1,...
      if (p.trail.length > trailLen * 2) {
        p.trail.splice(0, 2); // remove oldest point (x,y pair)
      }

      p.x = nx;
      p.y = ny;
      p.age++;
    }
  },

  _reseedParticle(p) {
    const N = FL.N;
    if (FL.windTunnel) {
      p.x = 2 + Math.random() * 3;
      p.y = 1 + Math.random() * N;
    } else {
      p.x = 1 + Math.random() * N;
      p.y = 1 + Math.random() * N;
    }
    p.trail.length = 0;
    p.age = 0;
  },

  _renderParticles() {
    if (!FL.showParticles || !FL._particles || FL._particles.length === 0) return;
    const { canvas, ctx, N, _particles: particles } = FL;
    const scaleX = canvas.width / N;
    const scaleY = canvas.height / N;
    const isLight = document.body.classList.contains('light');
    const palette = FL._PALETTE;
    const fade = FL._particleFade;

    for (let k = 0; k < particles.length; k++) {
      const p = particles[k];
      if (p.trail.length < 2) continue;
      const col = palette[p.ci];
      const nPts = p.trail.length >> 1; // number of trail points

      // Draw trail as tapered, fading segments
      if (nPts >= 1) {
        for (let t = 0; t < nPts; t++) {
          const t0x = (p.trail[t * 2] - 0.5) * scaleX;
          const t0y = (p.trail[t * 2 + 1] - 0.5) * scaleY;
          let t1x, t1y;
          if (t < nPts - 1) {
            t1x = (p.trail[(t + 1) * 2] - 0.5) * scaleX;
            t1y = (p.trail[(t + 1) * 2 + 1] - 0.5) * scaleY;
          } else {
            t1x = (p.x - 0.5) * scaleX;
            t1y = (p.y - 0.5) * scaleY;
          }
          const segFrac = (t + 1) / (nPts + 1); // 0=oldest, 1=newest
          const segAlpha = fade ? (0.04 + segFrac * 0.66) : (0.15 + segFrac * 0.45);
          const segWidth = 0.3 + segFrac * 1.7;
          ctx.beginPath();
          ctx.moveTo(t0x, t0y);
          ctx.lineTo(t1x, t1y);
          ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${segAlpha.toFixed(2)})`;
          ctx.lineWidth = segWidth;
          ctx.stroke();
        }
      }

      // Draw particle head as a small dot
      const px = (p.x - 0.5) * scaleX;
      const py = (p.y - 0.5) * scaleY;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, 6.2832);
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
      ctx.fill();
    }
  },

  // ─── Pre-compute jet colourmap LUT (256 entries) ────────────
  // Eliminates per-pixel array allocation in the render loop.
  _buildJetLUT() {
    // 5-stop ramp matching standard CFD jet palette:
    // deep blue → cyan → green → yellow-orange → red
    const stops = [
      [ 10,  20, 180],  // 0.00 — visible dark blue (not black)
      [  0, 150, 255],  // 0.25
      [ 80, 255, 100],  // 0.50 — reduced green saturation
      [255, 210,   0],  // 0.75
      [210,  30,  10],  // 1.00 — slightly warmer red
    ];
    const lut = new Uint8Array(256 * 3);
    for (let n = 0; n < 256; n++) {
      const tc = n / 255;
      const fi = tc * 4;
      const lo = fi | 0;
      const hi = lo >= 4 ? 4 : lo + 1;
      const f  = fi - lo;
      const a  = stops[lo], b = stops[hi];
      lut[n * 3]     = (a[0] + f * (b[0] - a[0])) | 0;
      lut[n * 3 + 1] = (a[1] + f * (b[1] - a[1])) | 0;
      lut[n * 3 + 2] = (a[2] + f * (b[2] - a[2])) | 0;
    }
    FL._jetLUT = lut;
  },

  // ─── Blue-White-Red diverging colourmap LUT (256 entries) ──
  // Standard CFD convention for pressure: blue=negative, white=zero, red=positive
  _buildBWR_LUT() {
    const lut = new Uint8Array(256 * 3);
    for (let n = 0; n < 256; n++) {
      const t = n / 255; // 0..1 where 0.5 = zero pressure
      let R, G, B;
      if (t < 0.5) {
        // Blue → White (low → zero pressure)
        const s = t * 2; // 0..1
        R = (30  + s * 225) | 0;
        G = (60  + s * 195) | 0;
        B = (200 + s * 55)  | 0;
      } else {
        // White → Red (zero → high pressure)
        const s = (t - 0.5) * 2; // 0..1
        R = (255 - s * 55) | 0;
        G = (255 - s * 210) | 0;
        B = (255 - s * 225) | 0;
      }
      lut[n * 3]     = R;
      lut[n * 3 + 1] = G;
      lut[n * 3 + 2] = B;
    }
    FL._bwrLUT = lut;
  },

  // ─── Jet colourmap: t∈[0,1] → [R,G,B] via LUT ──
  _jet(t) {
    const idx = ((t < 0 ? 0 : t > 1 ? 1 : t) * 255 + 0.5) | 0;
    const lut = FL._jetLUT;
    return [lut[idx * 3], lut[idx * 3 + 1], lut[idx * 3 + 2]];
  },

  // Inline jet lookup — avoids array allocation in hot path
  _jetIdx(t) {
    return ((t < 0 ? 0 : t > 1 ? 1 : t) * 255 + 0.5) | 0;
  },

  // ─── Apply user-placed inlets each frame ──────────────
  _applyInlets() {
    const { N, inlets } = FL;
    if (inlets.length === 0) return;
    const stride = N + 2;
    const obstacles = FL.obstacles;
    for (let k = 0; k < inlets.length; k++) {
      const src = inlets[k];
      const ri = src.radius | 0;
      for (let dj = -ri; dj <= ri; dj++) {
        for (let di = -ri; di <= ri; di++) {
          const d2 = di * di + dj * dj;
          if (d2 > ri * ri) continue;
          const i = src.i + di, j = src.j + dj;
          if (i < 1 || i > N || j < 1 || j > N) continue;
          const idx = i + j * stride;
          if (obstacles[idx]) continue;
          const falloff = 1 - Math.sqrt(d2) / (ri + 1);
          const str = src.strength * falloff;
          FL.u0[idx] += src.ux * str;
          FL.v0[idx] += src.uy * str;
          FL.dR0[idx] += src.cr * falloff * 1.8;
          FL.dG0[idx] += src.cg * falloff * 1.8;
          FL.dB0[idx] += src.cb * falloff * 1.8;
        }
      }
    }
  },

  // Remove inlets near grid position (i,j) within radius r
  _eraseInletsNear(ci, cj, r) {
    FL.inlets = FL.inlets.filter(src => {
      const dx = src.i - ci, dy = src.j - cj;
      return Math.sqrt(dx * dx + dy * dy) > r + src.radius;
    });
  },

  // ─── Render ────────────────────────────────
  _render() {
    const { N, offCtx, offscreen, canvas, ctx, u, v,
            showVelField, showStreamlines, showVortTint,
            obstacles, dR, dG, dB, _jetLUT: lut } = FL;
    const rS      = FL.renderScale;
    const imgData = FL._imgData;
    const data    = imgData.data;
    // Use Uint32Array view for 4-byte pixel writes (endian-safe ABGR on little-endian)
    const buf32   = FL._buf32 || (FL._buf32 = new Uint32Array(data.buffer));
    const stride  = N + 2;
    const rN      = N * rS;
    const isLight = document.body.classList.contains('light');
    const colMode = FL.colorMode;
    const isJet   = colMode === 'jet';
    const isPres  = colMode === 'pressure';
    const isSmoke = colMode === 'smoke';
    const isVort  = colMode === 'vorticity';
    const isMach  = colMode === 'mach';
    const isDensity = colMode === 'density';
    const isSchlieren = colMode === 'schlieren';
    const isQcrit = colMode === 'qcriterion';
    const hasObs  = FL._hasObstacles;

    const pressure = FL.pressure;

    // Background colour (warm off-white / warm dark)
    const bgR = isLight ? 240 : 12;
    const bgG = isLight ? 237 : 12;
    const bgB = isLight ? 230 : 14;

    // Obstacle colour
    const obR = isLight ? 80 : 200;
    const obG = isLight ? 76 : 195;
    const obB = isLight ? 70 : 185;
    // Pre-pack obstacle + bg as 32-bit pixel (ABGR little-endian)
    const obPx = (255 << 24) | (obB << 16) | (obG << 8) | obR;
    const bgPx = (255 << 24) | (bgB << 16) | (bgG << 8) | bgR;

    // ── Single-pass: compute stats + pixels simultaneously ──
    // When renderScale > 1, each grid cell maps to rS×rS output pixels.
    // We fill a rS×rS block per cell — bilinear blending done by canvas upscale.
    let maxVelSq = 0, maxP = 1e-6, minP = -1e-6, maxCurl = 1e-6;
    let totalDens = 0;
    let maxGrad = 1e-6, maxQval = 1e-6;
    const prevMaxGrad = FL._maxGrad;
    const prevMaxQ = FL._maxQ;
    const needStats = isJet || isVort || isMach || isSchlieren || isQcrit;

    for (let j = 1; j <= N; j++) {
      const jS  = j * stride;
      const jPxBase = (j - 1) * rS * rN;
      for (let i = 1; i <= N; i++) {
        const idx = i + jS;

        if (hasObs && obstacles[idx]) {
          // Fill rS×rS block with obstacle colour
          const iPxBase = (i - 1) * rS;
          for (let sy = 0; sy < rS; sy++) {
            const row = jPxBase + sy * rN + iPxBase;
            for (let sx = 0; sx < rS; sx++) buf32[row + sx] = obPx;
          }
          continue;
        }

        let R, G, B;

        if (isJet) {
          const uu = u[idx], vv = v[idx];
          const sq = uu * uu + vv * vv;
          if (sq > maxVelSq) maxVelSq = sq;
          const spd = Math.sqrt(sq) * (1 / (FL._maxSpeed || 1));
          const t   = spd > 1 ? 1 : spd;
          const li  = ((t * 255 + 0.5) | 0) * 3;
          R = lut[li]; G = lut[li + 1]; B = lut[li + 2];
          if (showVortTint) {
            const curl = (v[idx + 1] - v[idx - 1] - u[idx + stride] + u[idx - stride]) * 0.5;
            const ct = Math.abs(curl) * 0.18;
            if (ct > 0) {
              const br = ct > 1 ? 0.4 : ct * 0.4;
              const ibr = 1 - br;
              R = (R * ibr + 255 * br) | 0;
              G = (G * ibr + 255 * br) | 0;
              B = (B * ibr + 255 * br) | 0;
            }
          }
        } else if (isPres) {
          const p = pressure[idx];
          if (p > maxP) maxP = p;
          if (p < minP) minP = p;
          // Defer coloring — will be done in second pass only for pressure mode
          R = G = B = 0; // placeholder
        } else if (isVort) {
          const curl = (v[idx + 1] - v[idx - 1] - u[idx + stride] + u[idx - stride]) * 0.5;
          const absCurl = Math.abs(curl);
          const uu = u[idx], vv = v[idx];
          const sq = uu * uu + vv * vv;
          if (sq > maxVelSq) maxVelSq = sq;
          if (absCurl > maxCurl) maxCurl = absCurl;
          const mag = absCurl * (1 / (FL._maxCurl || 1));
          const t = mag > 1 ? 1 : mag;
          if (curl >= 0) {
            R = (bgR + (210 - bgR) * t) | 0;
            G = (bgG + ( 60 - bgG) * t) | 0;
            B = (bgB + ( 30 - bgB) * t) | 0;
          } else {
            R = (bgR + ( 30 - bgR) * t) | 0;
            G = (bgG + ( 80 - bgG) * t) | 0;
            B = (bgB + (200 - bgB) * t) | 0;
          }
        } else if (isMach) {
          const uu = u[idx], vv = v[idx];
          const sq = uu * uu + vv * vv;
          if (sq > maxVelSq) maxVelSq = sq;
          const spd = Math.sqrt(sq);
          const mach = spd / FL.speedOfSound;
          // Map Mach 0..2 across the jet LUT
          const t = mach > 2 ? 1 : mach * 0.5;
          const li = ((t * 255 + 0.5) | 0) * 3;
          R = lut[li]; G = lut[li + 1]; B = lut[li + 2];
        } else if (isDensity) {
          const rhoVal = FL.rho ? FL.rho[idx] : 1;
          // Map density deviation around 1.0 using BWR (blue-white-red)
          // rho < 1 → blue, rho = 1 → white/bg, rho > 1 → red
          const dev = (rhoVal - 1.0) * 3.0; // amplify
          const t = dev < -1 ? -1 : dev > 1 ? 1 : dev;
          if (t >= 0) {
            // white → red
            R = 255;
            G = ((1 - t) * 255) | 0;
            B = ((1 - t) * 255) | 0;
          } else {
            // white → blue
            const at = -t;
            R = ((1 - at) * 255) | 0;
            G = ((1 - at) * 255) | 0;
            B = 255;
          }
        } else if (isSchlieren) {
          // ── Schlieren — pressure gradient magnitude ──
          // Mimics the optical schlieren technique used in wind tunnel experiments.
          // Shows |∇p| — regions of strong pressure change appear bright.
          // Also works beautifully for shocks in compressible mode.
          const gpx = (pressure[idx + 1] - pressure[idx - 1]) * 0.5;
          const gpy = (pressure[idx + stride] - pressure[idx - stride]) * 0.5;
          const grad = Math.sqrt(gpx * gpx + gpy * gpy);
          if (grad > maxGrad) maxGrad = grad;
          const t = Math.min(1, grad / (prevMaxGrad || 0.01));
          // Exponential mapping for better dynamic range (like real schlieren optics)
          const te = 1 - Math.exp(-3.5 * t);
          if (isLight) {
            // Dark on light (traditional schlieren)
            const val = (255 * (1 - te)) | 0;
            R = val; G = val; B = val;
          } else {
            // Bright on dark (digital schlieren display)
            const val = (255 * te) | 0;
            // Slight warm-cool tint based on gradient direction
            const angle = Math.atan2(gpy, gpx);
            const tint = 0.15 * te;
            R = (val + tint * 50 * Math.cos(angle)) | 0;
            G = val;
            B = (val + tint * 50 * Math.sin(angle)) | 0;
            if (R < 0) R = 0; if (R > 255) R = 255;
            if (B < 0) B = 0; if (B > 255) B = 255;
          }
        } else if (isQcrit) {
          // ── Q-criterion — vortex identification ──
          // Q = ½(|Ω|² − |S|²) where Ω = rotation rate, S = strain rate
          // Q > 0 → rotation-dominated (vortex cores)
          // Q < 0 → strain-dominated (shear layers, stagnation)
          // Q ≈ 0 → background
          const halfN = 0.5 * N;
          const dudx = (u[idx + 1] - u[idx - 1]) * halfN;
          const dudy = (u[idx + stride] - u[idx - stride]) * halfN;
          const dvdx = (v[idx + 1] - v[idx - 1]) * halfN;
          const dvdy = (v[idx + stride] - v[idx - stride]) * halfN;
          // Rotation rate tensor: Ω₁₂ = ½(∂v/∂x − ∂u/∂y)
          const omega12 = 0.5 * (dvdx - dudy);
          const omegaSq = 2 * omega12 * omega12;
          // Strain rate tensor: S₁₁ = ∂u/∂x, S₂₂ = ∂v/∂y, S₁₂ = ½(∂u/∂y + ∂v/∂x)
          const strainSq = dudx * dudx + dvdy * dvdy + 0.5 * (dudy + dvdx) * (dudy + dvdx);
          const Q = 0.5 * (omegaSq - strainSq);
          const absQ = Q < 0 ? -Q : Q;
          if (absQ > maxQval) maxQval = absQ;
          const qn = Math.min(1, absQ / (prevMaxQ || 0.01));
          const qe = 1 - Math.exp(-4 * qn); // exponential mapping
          if (Q > 0) {
            // Vortex-dominated: cyan-blue
            R = (bgR * (1 - qe) + 20 * qe) | 0;
            G = (bgG * (1 - qe) + 160 * qe) | 0;
            B = (bgB * (1 - qe) + 230 * qe) | 0;
          } else {
            // Strain-dominated: warm amber
            R = (bgR * (1 - qe) + 220 * qe) | 0;
            G = (bgG * (1 - qe) + 140 * qe) | 0;
            B = (bgB * (1 - qe) + 30 * qe) | 0;
          }
        } else if (isSmoke) {
          const drv = dR[idx] + dG[idx] + dB[idx];
          const d   = drv < 0 ? 0 : drv > 3 ? 1 : drv * 0.333;
          totalDens += d;
          const t   = d * 1.8 > 1 ? 1 : d * 1.8;
          const base = isLight ? bgR : 14;
          const peak = isLight ? 30  : 220;
          const v2   = (base + (peak - base) * t) | 0;
          // Subtle warm-cool tint based on local vorticity
          const curl = (v[idx + 1] - v[idx - 1] - u[idx + stride] + u[idx - stride]) * 0.5;
          const tint = Math.min(1, Math.abs(curl) * 0.25) * t;
          const warm = curl > 0 ? tint * 18 : 0;
          const cool = curl < 0 ? tint * 18 : 0;
          R = Math.min(255, (v2 + warm) | 0);
          G = v2;
          B = Math.min(255, (v2 + cool) | 0);
        } else {
          const drv = dR[idx], dgv = dG[idx], dbv = dB[idx];
          const dr  = drv < 0 ? 0 : drv > 1 ? 1 : drv;
          const dg  = dgv < 0 ? 0 : dgv > 1 ? 1 : dgv;
          const db  = dbv < 0 ? 0 : dbv > 1 ? 1 : dbv;
          const d   = (dr + dg + db) * 0.3333;
          totalDens += d;
          const raw = d * 2.5;
          const t   = raw > 1 ? 1 : Math.sqrt(raw); // gamma correction for richer colors
          if (d < 0.001) {
            const iPxBase0 = (i - 1) * rS;
            for (let sy = 0; sy < rS; sy++) {
              const row = jPxBase + sy * rN + iPxBase0;
              for (let sx = 0; sx < rS; sx++) buf32[row + sx] = bgPx;
            }
            continue;
          }
          const it = 1 - t;
          R = (bgR * it + dr * 255 * t) | 0;
          G = (bgG * it + dg * 255 * t) | 0;
          B = (bgB * it + db * 255 * t) | 0;
        }

        // Fill rS×rS block for this cell
        const packed = (255 << 24) | (B << 16) | (G << 8) | R;
        const iPxBase = (i - 1) * rS;
        for (let sy = 0; sy < rS; sy++) {
          const row = jPxBase + sy * rN + iPxBase;
          for (let sx = 0; sx < rS; sx++) buf32[row + sx] = packed;
        }
      }
    }

    // Pressure mode needs a second mini-pass to color with known range
    // Uses blue-white-red diverging colormap (standard CFD convention)
    if (isPres) {
      const bwr = FL._bwrLUT;
      const presRange = Math.max(maxP, -minP);
      const invPres = presRange > 0 ? 1 / presRange : 1;
      for (let j = 1; j <= N; j++) {
        const jS = j * stride;
        const jPxBase2 = (j - 1) * rS * rN;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          if (hasObs && obstacles[idx]) continue;
          const p  = pressure[idx] * invPres;
          const pt = 0.5 + p * 0.5;
          const li = ((pt * 255 + 0.5) | 0) * 3;
          const packed = (255 << 24) | (bwr[li + 2] << 16) | (bwr[li + 1] << 8) | bwr[li];
          const iPxBase = (i - 1) * rS;
          for (let sy = 0; sy < rS; sy++) {
            const row = jPxBase2 + sy * rN + iPxBase;
            for (let sx = 0; sx < rS; sx++) buf32[row + sx] = packed;
          }
        }
      }
    }

    // Update adaptive maxes
    if (needStats) {
      const measured = Math.sqrt(maxVelSq);
      FL._maxSpeed = measured > FL._maxSpeed
        ? FL._maxSpeed * 0.6 + measured * 0.4
        : FL._maxSpeed * 0.93 + measured * 0.07;
      if (FL._maxSpeed < 0.01) FL._maxSpeed = 0.01;
    }
    if (isVort) {
      FL._maxCurl = maxCurl > (FL._maxCurl || 0)
        ? (FL._maxCurl || maxCurl) * 0.6 + maxCurl * 0.4
        : (FL._maxCurl || maxCurl) * 0.93 + maxCurl * 0.07;
      if (FL._maxCurl < 0.001) FL._maxCurl = 0.001;
    }
    if (isSchlieren) {
      FL._maxGrad = maxGrad > FL._maxGrad
        ? FL._maxGrad * 0.6 + maxGrad * 0.4
        : FL._maxGrad * 0.93 + maxGrad * 0.07;
      if (FL._maxGrad < 1e-6) FL._maxGrad = 1e-6;
    }
    if (isQcrit) {
      FL._maxQ = maxQval > FL._maxQ
        ? FL._maxQ * 0.6 + maxQval * 0.4
        : FL._maxQ * 0.93 + maxQval * 0.07;
      if (FL._maxQ < 1e-6) FL._maxQ = 1e-6;
    }
    const invMaxSpd = 1 / (FL._maxSpeed || 1);
    const invCurl   = 1 / (FL._maxCurl || 1);

    offCtx.putImageData(imgData, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    const scaleX = canvas.width  / N;
    const scaleY = canvas.height / N;

    // ── On-canvas HUD panel (top-left) — key sim stats at a glance ──────
    {
      const hPad = 8, hLineH = 12, hCorner = 5;
      const hudLines = [];
      // Show scenario name if one is active
      if (FL._activeScenario) {
        const scenarioNames = {
          cylinder: 'Cylinder', plate: 'Flat Plate', wedge: 'Wedge',
          airfoil: 'NACA 0012', 'airfoil-cambered': 'NACA 2412', square: 'Square',
          backstep: 'Backstep', tandem: 'Tandem', venturi: 'Venturi',
          diffuser: 'Diffuser', nozzle: 'Nozzle', 'jet-impinge': 'Jet Impinge',
          mixing: 'Mixing', crossflow: 'Crossflow', fountain: 'Fountain',
          'lid-cavity': 'Lid Cavity', magnus: 'Magnus', staggered: 'Tube Bank',
          bifurcation: 'Bifurcation', karman: 'K\u00E1rm\u00E1n Gallery'
        };
        hudLines.push(`\u25C6 ${scenarioNames[FL._activeScenario] || FL._activeScenario}`);
      }
      // Always show grid, CFL, regime
      hudLines.push(`${N}\u00D7${N}  \u0394t=${FL.dt.toFixed(3)}`);
      const cflStr = FL._cflNumber.toFixed(2);
      hudLines.push(`CFL ${cflStr}  ${FL._flowRegime}`);
      if (FL.windTunnel) {
        const reStr = FL._reynoldsNum > 1000
          ? (FL._reynoldsNum / 1000).toFixed(1) + 'k'
          : FL._reynoldsNum.toFixed(0);
        hudLines.push(`Re \u2248 ${reStr}  U\u221E=${FL.windSpeed}`);
      }
      if (FL.compressible) {
        hudLines.push(`Mach ${FL._machNumber.toFixed(2)}  c\u209B=${FL.speedOfSound}`);
      }
      if (FL.turbulenceModel) {
        hudLines.push(`LES  C\u209B=${FL._smagConst}`);
      }
      const hW = 142, hH = hudLines.length * hLineH + hPad * 2 + 2;
      const hx = 8, hy = 8;
      ctx.fillStyle = isLight ? 'rgba(255,255,255,0.7)' : 'rgba(8,8,14,0.65)';
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx + hCorner, hy);
      ctx.lineTo(hx + hW - hCorner, hy); ctx.arcTo(hx + hW, hy, hx + hW, hy + hCorner, hCorner);
      ctx.lineTo(hx + hW, hy + hH - hCorner); ctx.arcTo(hx + hW, hy + hH, hx + hW - hCorner, hy + hH, hCorner);
      ctx.lineTo(hx + hCorner, hy + hH); ctx.arcTo(hx, hy + hH, hx, hy + hH - hCorner, hCorner);
      ctx.lineTo(hx, hy + hCorner); ctx.arcTo(hx, hy, hx + hCorner, hy, hCorner);
      ctx.closePath(); ctx.fill(); ctx.stroke();

      ctx.font = '500 7.5px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      for (let li = 0; li < hudLines.length; li++) {
        const isFirstLine = li === 0;
        // Highlight CFL in colour
        if (li === 1) {
          const cflVal = FL._cflNumber;
          ctx.fillStyle = cflVal >= 1 ? '#d44' : cflVal >= 0.5 ? '#d9a020' :
            (isLight ? 'rgba(40,40,40,0.8)' : 'rgba(200,200,200,0.75)');
        } else {
          ctx.fillStyle = isLight ? 'rgba(40,40,40,0.8)' : 'rgba(200,200,200,0.75)';
        }
        ctx.fillText(hudLines[li], hx + hPad, hy + hPad + 9 + li * hLineH);
      }
    }

    // ── Grid scale bar (bottom-left) ──────────────────────
    {
      const sbCells = 20; // number of grid cells the bar represents
      const sbW = sbCells * scaleX;
      const sbH = 3;
      const sbX = 10, sbY = canvas.height - 14;
      // Bar
      ctx.fillStyle = isLight ? 'rgba(40,40,40,0.45)' : 'rgba(200,200,200,0.35)';
      ctx.fillRect(sbX, sbY, sbW, sbH);
      // End ticks
      ctx.fillRect(sbX, sbY - 2, 1, sbH + 4);
      ctx.fillRect(sbX + sbW, sbY - 2, 1, sbH + 4);
      // Label
      ctx.font = '400 7px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = isLight ? 'rgba(40,40,40,0.55)' : 'rgba(200,200,200,0.45)';
      ctx.fillText(`${sbCells} cells`, sbX + sbW / 2, sbY - 4);
    }

    // ── Velocity arrows with arrowheads ──────────────────────
    if (showVelField) {
      const step = FL.windTunnel ? 10 : 14;
      const arrowLen = FL.windTunnel ? 1.8 : 2.5;
      const headSize = 3.5; // arrowhead size in pixels
      ctx.strokeStyle = isLight ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.35)';
      ctx.fillStyle   = isLight ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth   = 0.9;
      ctx.beginPath();
      const headPts = []; // collect arrowhead positions for batch fill
      for (let j = step; j <= N; j += step) {
        const jS = j * stride;
        for (let i = step; i <= N; i += step) {
          const idx = i + jS;
          if (obstacles[idx]) continue;
          const uu  = u[idx] * arrowLen;
          const vv  = v[idx] * arrowLen;
          const mag = Math.sqrt(uu * uu + vv * vv);
          if (mag < 0.01) continue;
          const px  = (i - 0.5) * scaleX;
          const py  = (j - 0.5) * scaleY;
          const ex  = px + uu * scaleX;
          const ey  = py + vv * scaleY;
          ctx.moveTo(px, py);
          ctx.lineTo(ex, ey);
          // Arrowhead direction
          const dx = (uu * scaleX) / mag / scaleX;
          const dy = (vv * scaleY) / mag / scaleY;
          headPts.push(ex, ey, dx * scaleX, dy * scaleY);
        }
      }
      ctx.stroke();
      // Draw arrowheads as small filled triangles
      ctx.beginPath();
      for (let h = 0; h < headPts.length; h += 4) {
        const ex = headPts[h], ey = headPts[h+1];
        const dx = headPts[h+2], dy = headPts[h+3];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.1) continue;
        const nx = dx / len, ny = dy / len;
        const px1 = -ny, py1 = nx; // perpendicular
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - nx * headSize + px1 * headSize * 0.4,
                   ey - ny * headSize + py1 * headSize * 0.4);
        ctx.lineTo(ex - nx * headSize - px1 * headSize * 0.4,
                   ey - ny * headSize - py1 * headSize * 0.4);
        ctx.closePath();
      }
      ctx.fill();
    }

    // ── Streamlines (RK2 midpoint integration, velocity-tapered width) ───
    if (showStreamlines) {
      const nSeeds  = FL.windTunnel ? 32 : 20;
      const nSteps  = FL.windTunnel ? 180 : 100;
      const stepLen = 1.2;
      const invMS   = invMaxSpd;
      for (let s = 0; s < nSeeds; s++) {
        let sx = FL.windTunnel ? 2 : (N * 0.1);
        let sy = (N / (nSeeds + 1)) * (s + 1);
        ctx.beginPath();
        ctx.moveTo((sx - 0.5) * scaleX, (sy - 0.5) * scaleY);
        let maxSegSpd = 0;
        for (let step = 0; step < nSteps; step++) {
          const ii = (sx | 0), jj = (sy | 0);
          if (ii < 1 || ii >= N || jj < 1 || jj >= N) break;
          const sIdx = ii + jj * stride;
          if (obstacles[sIdx]) break;
          // RK2 midpoint method for smoother curves
          const ux1 = u[sIdx], uy1 = v[sIdx];
          const mag1 = Math.sqrt(ux1 * ux1 + uy1 * uy1);
          if (mag1 < 1e-6) break;
          if (mag1 > maxSegSpd) maxSegSpd = mag1;
          const hsx = sx + 0.5 * (ux1 / mag1) * stepLen;
          const hsy = sy + 0.5 * (uy1 / mag1) * stepLen;
          const hi = (hsx | 0), hj = (hsy | 0);
          if (hi >= 1 && hi < N && hj >= 1 && hj < N) {
            const hIdx = hi + hj * stride;
            if (!obstacles[hIdx]) {
              const ux2 = u[hIdx], uy2 = v[hIdx];
              const mag2 = Math.sqrt(ux2 * ux2 + uy2 * uy2);
              if (mag2 > 1e-6) {
                sx += (ux2 / mag2) * stepLen;
                sy += (uy2 / mag2) * stepLen;
              } else {
                sx += (ux1 / mag1) * stepLen;
                sy += (uy1 / mag1) * stepLen;
              }
            } else {
              sx += (ux1 / mag1) * stepLen;
              sy += (uy1 / mag1) * stepLen;
            }
          } else {
            sx += (ux1 / mag1) * stepLen;
            sy += (uy1 / mag1) * stepLen;
          }
          ctx.lineTo((sx - 0.5) * scaleX, (sy - 0.5) * scaleY);
        }
        // Width scales with local speed — faster flow = thicker line
        const velT = Math.min(1, maxSegSpd * invMS);
        ctx.lineWidth   = 0.6 + velT * 1.6;
        ctx.strokeStyle = isLight
          ? `rgba(0,0,0,${(0.12 + velT * 0.22).toFixed(2)})`
          : `rgba(255,255,255,${(0.10 + velT * 0.18).toFixed(2)})`;
        ctx.stroke();
      }

      // Additional seed column at mid-domain for wake coverage
      if (FL.windTunnel) {
        const midSeeds = 16;
        for (let s = 0; s < midSeeds; s++) {
          let sx = N * 0.5;
          let sy = (N / (midSeeds + 1)) * (s + 1);
          ctx.beginPath();
          ctx.moveTo((sx - 0.5) * scaleX, (sy - 0.5) * scaleY);
          let maxSegSpd2 = 0;
          for (let step = 0; step < nSteps; step++) {
            const ii = (sx | 0), jj = (sy | 0);
            if (ii < 1 || ii >= N || jj < 1 || jj >= N) break;
            const sIdx = ii + jj * stride;
            if (obstacles[sIdx]) break;
            const ux1 = u[sIdx], uy1 = v[sIdx];
            const mag1 = Math.sqrt(ux1 * ux1 + uy1 * uy1);
            if (mag1 < 1e-6) break;
            if (mag1 > maxSegSpd2) maxSegSpd2 = mag1;
            const hsx = sx + 0.5 * (ux1 / mag1) * stepLen;
            const hsy = sy + 0.5 * (uy1 / mag1) * stepLen;
            const hi = (hsx | 0), hj = (hsy | 0);
            if (hi >= 1 && hi < N && hj >= 1 && hj < N) {
              const hIdx = hi + hj * stride;
              if (!obstacles[hIdx]) {
                const ux2 = u[hIdx], uy2 = v[hIdx];
                const mag2 = Math.sqrt(ux2 * ux2 + uy2 * uy2);
                if (mag2 > 1e-6) { sx += (ux2 / mag2) * stepLen; sy += (uy2 / mag2) * stepLen; }
                else { sx += (ux1 / mag1) * stepLen; sy += (uy1 / mag1) * stepLen; }
              } else { sx += (ux1 / mag1) * stepLen; sy += (uy1 / mag1) * stepLen; }
            } else { sx += (ux1 / mag1) * stepLen; sy += (uy1 / mag1) * stepLen; }
            ctx.lineTo((sx - 0.5) * scaleX, (sy - 0.5) * scaleY);
          }
          const velT2 = Math.min(1, maxSegSpd2 * invMS);
          ctx.lineWidth = 0.5 + velT2 * 1.2;
          ctx.strokeStyle = isLight
            ? `rgba(0,0,0,${(0.08 + velT2 * 0.18).toFixed(2)})`
            : `rgba(255,255,255,${(0.07 + velT2 * 0.14).toFixed(2)})`;
          ctx.stroke();
        }
      }
    }

    // ── Pressure contour lines overlay ──────────────────────
    if (FL.showContours && pressure) {
      const nContours = 12;
      // Find pressure range
      let pMin = 1e10, pMax = -1e10;
      for (let j = 1; j <= N; j++) {
        const jS = j * stride;
        for (let i = 1; i <= N; i++) {
          const idx = i + jS;
          if (hasObs && obstacles[idx]) continue;
          const p = pressure[idx];
          if (p < pMin) pMin = p;
          if (p > pMax) pMax = p;
        }
      }
      const pRange = pMax - pMin;
      if (pRange > 1e-8) {
        ctx.lineWidth = 0.7;
        for (let c = 1; c < nContours; c++) {
          const level = pMin + (pRange * c / nContours);
          const isZero = Math.abs(level) < pRange * 0.05;
          ctx.strokeStyle = isZero
            ? (isLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)')
            : (isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.18)');
          if (isZero) ctx.lineWidth = 1.2;
          ctx.beginPath();
          // Marching squares contour extraction
          for (let j = 1; j < N; j++) {
            const jS = j * stride;
            const jPx1 = (j - 1) * scaleY;
            const jPx2 = j * scaleY;
            for (let i = 1; i < N; i++) {
              const idx = i + jS;
              if (hasObs && (obstacles[idx] || obstacles[idx+1] || obstacles[idx+stride] || obstacles[idx+1+stride])) continue;
              const p00 = pressure[idx] - level;
              const p10 = pressure[idx + 1] - level;
              const p01 = pressure[idx + stride] - level;
              const p11 = pressure[idx + 1 + stride] - level;
              // Cell case (4-bit)
              const cs = (p00 > 0 ? 1 : 0) | (p10 > 0 ? 2 : 0) | (p01 > 0 ? 4 : 0) | (p11 > 0 ? 8 : 0);
              if (cs === 0 || cs === 15) continue;
              const x0 = (i - 0.5) * scaleX, x1 = (i + 0.5) * scaleX;
              const y0 = (j - 0.5) * scaleY, y1 = (j + 0.5) * scaleY;
              // Interpolation helpers
              const tTop    = p00 / (p00 - p10);
              const tBottom = p01 / (p01 - p11);
              const tLeft   = p00 / (p00 - p01);
              const tRight  = p10 / (p10 - p11);
              // Draw line segments for common cases
              const lerp = (a, b, t2) => a + (b - a) * t2;
              if (cs === 1 || cs === 14) { ctx.moveTo(lerp(x0,x1,tTop), y0); ctx.lineTo(x0, lerp(y0,y1,tLeft)); }
              else if (cs === 2 || cs === 13) { ctx.moveTo(lerp(x0,x1,tTop), y0); ctx.lineTo(x1, lerp(y0,y1,tRight)); }
              else if (cs === 4 || cs === 11) { ctx.moveTo(x0, lerp(y0,y1,tLeft)); ctx.lineTo(lerp(x0,x1,tBottom), y1); }
              else if (cs === 8 || cs === 7) { ctx.moveTo(x1, lerp(y0,y1,tRight)); ctx.lineTo(lerp(x0,x1,tBottom), y1); }
              else if (cs === 3 || cs === 12) { ctx.moveTo(x0, lerp(y0,y1,tLeft)); ctx.lineTo(x1, lerp(y0,y1,tRight)); }
              else if (cs === 5 || cs === 10) { ctx.moveTo(lerp(x0,x1,tTop), y0); ctx.lineTo(lerp(x0,x1,tBottom), y1); }
              else if (cs === 6 || cs === 9) {
                ctx.moveTo(lerp(x0,x1,tTop), y0); ctx.lineTo(x0, lerp(y0,y1,tLeft));
                ctx.moveTo(x1, lerp(y0,y1,tRight)); ctx.lineTo(lerp(x0,x1,tBottom), y1);
              }
            }
          }
          ctx.stroke();
          if (isZero) ctx.lineWidth = 0.7;
        }
      }
    }

    // ── Colourbar legend (with rounded backdrop + title + tick values) ──────
    if (isJet || isPres || isVort || isMach || isDensity || isSchlieren || isQcrit) {
      const cw = canvas.width, ch = canvas.height;
      const bw = 12, bh = Math.min(140, ch * 0.38) | 0;
      const bx = cw - 30, by = (ch - bh) >> 1;

      // Determine title & tick values for each mode
      let cbTitle = '', cbTop = '', cbMid = '', cbBot = '', cbUnit = '';
      if (isVort) {
        cbTitle = 'Vorticity'; cbTop = 'CCW'; cbMid = '0'; cbBot = 'CW'; cbUnit = 'ω [1/s]';
      } else if (isJet && FL.windTunnel) {
        cbTitle = 'Speed'; cbTop = FL._maxSpeed.toFixed(1); cbMid = (FL._maxSpeed * 0.5).toFixed(1); cbBot = '0'; cbUnit = '|v|';
      } else if (isJet) {
        cbTitle = 'Speed'; cbTop = FL._maxSpeed.toFixed(1); cbMid = (FL._maxSpeed * 0.5).toFixed(1); cbBot = '0'; cbUnit = '|v|';
      } else if (isMach) {
        cbTitle = 'Mach'; cbTop = 'M=2.0'; cbMid = 'M=1.0'; cbBot = 'M=0'; cbUnit = '|v|/cₛ';
      } else if (isDensity) {
        cbTitle = 'Density'; cbTop = 'ρ > ρ₀'; cbMid = 'ρ₀'; cbBot = 'ρ < ρ₀'; cbUnit = 'ρ/ρ₀';
      } else if (isSchlieren) {
        cbTitle = 'Schlieren'; cbTop = 'high'; cbMid = '|∇p|'; cbBot = 'low'; cbUnit = 'grad';
      } else if (isQcrit) {
        cbTitle = 'Q-criterion'; cbTop = 'vortex'; cbMid = 'Q=0'; cbBot = 'strain'; cbUnit = 'Q';
      } else {
        cbTitle = 'Pressure'; cbTop = '+p'; cbMid = '0'; cbBot = '\u2212p'; cbUnit = 'Δp';
      }

      // Backdrop panel (wider to fit title)
      const pad = 7, lw = 56;
      const titleH = 16;
      const px = bx - lw - pad, py = by - pad - titleH - 4;
      const pw = lw + bw + pad * 2 + 4, ph = bh + pad * 2 + titleH + 14;
      const bR = 6;
      ctx.fillStyle   = isLight ? 'rgba(255,255,255,0.8)' : 'rgba(8,8,14,0.8)';
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.07)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(px+bR,py); ctx.lineTo(px+pw-bR,py); ctx.arcTo(px+pw,py,px+pw,py+bR,bR);
      ctx.lineTo(px+pw,py+ph-bR); ctx.arcTo(px+pw,py+ph,px+pw-bR,py+ph,bR);
      ctx.lineTo(px+bR,py+ph); ctx.arcTo(px,py+ph,px,py+ph-bR,bR);
      ctx.lineTo(px,py+bR); ctx.arcTo(px,py,px+bR,py,bR);
      ctx.closePath(); ctx.fill(); ctx.stroke();

      // Title
      ctx.fillStyle = isLight ? 'rgba(30,30,30,0.9)' : 'rgba(230,230,230,0.9)';
      ctx.font = '600 9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(cbTitle, px + pw / 2, py + pad + 9);

      // Unit subtitle
      ctx.fillStyle = isLight ? 'rgba(80,80,80,0.6)' : 'rgba(180,180,180,0.5)';
      ctx.font = '400 7px JetBrains Mono, monospace';
      ctx.fillText(cbUnit, px + pw / 2, py + ph - 4);

      // Colour gradient strip
      for (let ppy = 0; ppy < bh; ppy++) {
        const t = 1 - ppy / bh;
        if (isVort) {
          const half = t - 0.5;
          if (half >= 0) {
            const m = half * 2;
            ctx.fillStyle = `rgb(${(bgR + (210 - bgR) * m) | 0},${(bgG + (60 - bgG) * m) | 0},${(bgB + (30 - bgB) * m) | 0})`;
          } else {
            const m = -half * 2;
            ctx.fillStyle = `rgb(${(bgR + (30 - bgR) * m) | 0},${(bgG + (80 - bgG) * m) | 0},${(bgB + (200 - bgB) * m) | 0})`;
          }
        } else if (isPres) {
          const bwr = FL._bwrLUT;
          const li = ((t * 255 + 0.5) | 0) * 3;
          ctx.fillStyle = `rgb(${bwr[li]},${bwr[li + 1]},${bwr[li + 2]})`;
        } else if (isMach) {
          const li = ((t * 255 + 0.5) | 0) * 3;
          ctx.fillStyle = `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]})`;
        } else if (isDensity) {
          const half = t - 0.5;
          if (half >= 0) {
            const m = half * 2;
            ctx.fillStyle = `rgb(${255},${((1 - m) * 255) | 0},${((1 - m) * 255) | 0})`;
          } else {
            const m = -half * 2;
            ctx.fillStyle = `rgb(${((1 - m) * 255) | 0},${((1 - m) * 255) | 0},${255})`;
          }
        } else if (isSchlieren) {
          if (isLight) {
            const v2 = (255 * (1 - t)) | 0;
            ctx.fillStyle = `rgb(${v2},${v2},${v2})`;
          } else {
            const v2 = (255 * t) | 0;
            ctx.fillStyle = `rgb(${v2},${v2},${v2})`;
          }
        } else if (isQcrit) {
          const half = t - 0.5;
          if (half >= 0) {
            const m = half * 2;
            ctx.fillStyle = `rgb(${(bgR + (20 - bgR) * m) | 0},${(bgG + (160 - bgG) * m) | 0},${(bgB + (230 - bgB) * m) | 0})`;
          } else {
            const m = -half * 2;
            ctx.fillStyle = `rgb(${(bgR + (220 - bgR) * m) | 0},${(bgG + (140 - bgG) * m) | 0},${(bgB + (30 - bgB) * m) | 0})`;
          }
        } else {
          const li = ((t * 255 + 0.5) | 0) * 3;
          ctx.fillStyle = `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]})`;
        }
        ctx.fillRect(bx, by + ppy, bw, 1);
      }
      // Bar border
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx, by, bw, bh);

      // Tick marks and labels
      ctx.fillStyle = isLight ? 'rgba(40,40,40,0.85)' : 'rgba(220,220,220,0.85)';
      ctx.font = '500 8px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      // Top, middle, bottom ticks with small horizontal lines
      ctx.strokeStyle = isLight ? 'rgba(40,40,40,0.3)' : 'rgba(220,220,220,0.25)';
      ctx.lineWidth = 0.5;
      const tickX = bx - 2;
      const tickLen = 4;
      // Top tick
      ctx.beginPath(); ctx.moveTo(tickX, by + 1); ctx.lineTo(tickX - tickLen, by + 1); ctx.stroke();
      ctx.fillText(cbTop,  tickX - tickLen - 2, by + 5);
      // Middle tick
      const midY = by + (bh >> 1);
      ctx.beginPath(); ctx.moveTo(tickX, midY); ctx.lineTo(tickX - tickLen, midY); ctx.stroke();
      ctx.fillText(cbMid,  tickX - tickLen - 2, midY + 3);
      // Bottom tick
      ctx.beginPath(); ctx.moveTo(tickX, by + bh - 1); ctx.lineTo(tickX - tickLen, by + bh - 1); ctx.stroke();
      ctx.fillText(cbBot,  tickX - tickLen - 2, by + bh + 1);
      // Quarter ticks (small, no label)
      const q1Y = by + (bh >> 2);
      const q3Y = by + 3 * (bh >> 2);
      ctx.beginPath(); ctx.moveTo(tickX, q1Y); ctx.lineTo(tickX - 2, q1Y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tickX, q3Y); ctx.lineTo(tickX - 2, q3Y); ctx.stroke();
    }

    // ── Wind tunnel force arrows (drag + lift) with numeric values ──
    if (FL.windTunnel && Math.abs(FL._dragCoeff) + Math.abs(FL._liftCoeff) > 0.001) {
      // Find obstacle centroid
      let ocx = 0, ocy = 0, oCnt = 0;
      for (let j = 2; j < N; j++) {
        const jS = j * stride;
        for (let i = 2; i < N; i++) {
          if (obstacles[i + jS]) { ocx += i; ocy += j; oCnt++; }
        }
      }
      if (oCnt > 0) {
        ocx = (ocx / oCnt - 0.5) * scaleX;
        ocy = (ocy / oCnt - 0.5) * scaleY;
        const arrowScale = 50;
        // Drag arrow (red, horizontal)
        const dx = FL._dragCoeff * arrowScale;
        if (Math.abs(dx) > 2) {
          ctx.strokeStyle = isLight ? 'rgba(169,61,61,0.75)' : 'rgba(201,85,85,0.85)';
          ctx.lineWidth   = 2.5;
          ctx.beginPath();
          ctx.moveTo(ocx, ocy);
          ctx.lineTo(ocx + dx, ocy);
          const dir = dx > 0 ? 1 : -1;
          ctx.lineTo(ocx + dx - dir * 7, ocy - 4);
          ctx.moveTo(ocx + dx, ocy);
          ctx.lineTo(ocx + dx - dir * 7, ocy + 4);
          ctx.stroke();
          ctx.font = '600 8px JetBrains Mono, monospace';
          ctx.fillStyle = isLight ? 'rgba(169,61,61,0.9)' : 'rgba(201,85,85,0.95)';
          ctx.textAlign = 'center';
          ctx.fillText('D', ocx + dx + dir * 10, ocy + 3);
          // Numeric value below arrow
          ctx.font = '500 7px JetBrains Mono, monospace';
          ctx.fillStyle = isLight ? 'rgba(169,61,61,0.7)' : 'rgba(201,85,85,0.7)';
          ctx.fillText('C\u2091=' + FL._dragCoeff.toFixed(3), ocx + dx * 0.5, ocy + 14);
        }
        // Lift arrow (blue, vertical)
        const ly = -FL._liftCoeff * arrowScale;
        if (Math.abs(ly) > 2) {
          ctx.strokeStyle = isLight ? 'rgba(74,124,153,0.75)' : 'rgba(90,155,181,0.85)';
          ctx.lineWidth   = 2.5;
          ctx.beginPath();
          ctx.moveTo(ocx, ocy);
          ctx.lineTo(ocx, ocy + ly);
          const dir = ly > 0 ? 1 : -1;
          ctx.lineTo(ocx - 4, ocy + ly - dir * 7);
          ctx.moveTo(ocx, ocy + ly);
          ctx.lineTo(ocx + 4, ocy + ly - dir * 7);
          ctx.stroke();
          ctx.font = '600 8px JetBrains Mono, monospace';
          ctx.fillStyle = isLight ? 'rgba(74,124,153,0.9)' : 'rgba(90,155,181,0.95)';
          ctx.textAlign = 'center';
          ctx.fillText('L', ocx + 10, ocy + ly - dir * 2);
          // Numeric value beside arrow
          ctx.font = '500 7px JetBrains Mono, monospace';
          ctx.fillStyle = isLight ? 'rgba(74,124,153,0.7)' : 'rgba(90,155,181,0.7)';
          ctx.fillText('C\u2097=' + FL._liftCoeff.toFixed(3), ocx + 18, ocy + ly * 0.5 + 3);
        }
      }
    }

    // Stats — update every other frame for perf
    if (FL.fc & 1) {
      const maxVel = (isJet || isVort || isMach) ? FL._maxSpeed : Math.sqrt(maxVelSq);
      const fpsEl  = FL._elCache.fps  || (FL._elCache.fps  = document.getElementById('fl-stat-fps'));
      const velEl  = FL._elCache.vel  || (FL._elCache.vel  = document.getElementById('fl-stat-vel'));
      const iVelEl = FL._elCache.ivel || (FL._elCache.ivel = document.getElementById('fl-info-vel'));
      if (fpsEl)  fpsEl.textContent  = FL.fps;
      if (velEl)  velEl.textContent   = maxVel.toFixed(2);
      if (iVelEl) iVelEl.textContent  = maxVel.toFixed(2);

      // Educational stats
      const keEl  = FL._elCache.ke   || (FL._elCache.ke   = document.getElementById('fl-stat-ke'));
      const cflEl = FL._elCache.cfl  || (FL._elCache.cfl  = document.getElementById('fl-stat-cfl'));
      const stEl  = FL._elCache.st   || (FL._elCache.st   = document.getElementById('fl-stat-st'));
      const regEl = FL._elCache.reg  || (FL._elCache.reg  = document.getElementById('fl-stat-regime'));
      if (keEl)  keEl.textContent  = FL._kineticEnergy > 100 ? FL._kineticEnergy.toFixed(0) : FL._kineticEnergy.toFixed(3);
      if (cflEl) {
        cflEl.textContent = FL._cflNumber.toFixed(2);
        cflEl.style.color = FL._cflNumber < 0.5 ? '' : FL._cflNumber < 1.0 ? '#e6a817' : '#d44';
      }
      if (stEl) stEl.textContent = FL._strouhalNum > 0.01 ? FL._strouhalNum.toFixed(3) : '\u2014';
      if (regEl) regEl.textContent = FL._flowRegime;

      // Enstrophy and effective viscosity
      const enstEl = FL._elCache.enst || (FL._elCache.enst = document.getElementById('fl-stat-enst'));
      const neffEl = FL._elCache.neff || (FL._elCache.neff = document.getElementById('fl-stat-neff'));
      if (enstEl) enstEl.textContent = FL._enstrophy > 100 ? FL._enstrophy.toFixed(0) : FL._enstrophy.toFixed(4);
      if (neffEl) {
        const neff = FL._effectiveVisc;
        neffEl.textContent = neff > 0.001 ? neff.toFixed(4) : neff.toExponential(1);
      }

      // Compressible flow stats
      const machEl = FL._elCache.mach || (FL._elCache.mach = document.getElementById('fl-stat-mach'));
      if (FL.compressible) {
        if (machEl) machEl.textContent = FL._machNumber.toFixed(3);
      } else {
        if (machEl) machEl.textContent = '\u2014';
      }

      // Wind tunnel aero stats
      if (FL.windTunnel) {
        const reEl = FL._elCache.re || (FL._elCache.re = document.getElementById('fl-stat-re'));
        const clEl = FL._elCache.cl || (FL._elCache.cl = document.getElementById('fl-stat-cl'));
        const cdEl = FL._elCache.cd || (FL._elCache.cd = document.getElementById('fl-stat-cd'));
        const iReEl = FL._elCache.ire || (FL._elCache.ire = document.getElementById('fl-info-re'));
        const iClEl = FL._elCache.icl || (FL._elCache.icl = document.getElementById('fl-info-cl'));
        const iCdEl = FL._elCache.icd || (FL._elCache.icd = document.getElementById('fl-info-cd'));
        if (reEl)  reEl.textContent  = FL._reynoldsNum > 1e6 ? (FL._reynoldsNum / 1e6).toFixed(1) + 'M' : FL._reynoldsNum > 1000 ? (FL._reynoldsNum / 1000).toFixed(1) + 'k' : FL._reynoldsNum.toFixed(0);
        if (clEl)  clEl.textContent  = FL._liftCoeff.toFixed(3);
        if (cdEl)  cdEl.textContent  = FL._dragCoeff.toFixed(3);
        if (iReEl) iReEl.textContent = 'Re \u2248 ' + (FL._reynoldsNum > 1000 ? (FL._reynoldsNum / 1000).toFixed(1) + 'k' : FL._reynoldsNum.toFixed(0));
        if (iClEl) iClEl.textContent = 'C_L=' + FL._liftCoeff.toFixed(3);
        if (iCdEl) iCdEl.textContent = 'C_D=' + FL._dragCoeff.toFixed(3);
      }

      // Extra info strip items: kinetic energy, visualisation mode
      const iKeEl  = FL._elCache.ike  || (FL._elCache.ike  = document.getElementById('fl-info-ke'));
      const iVisEl = FL._elCache.ivis || (FL._elCache.ivis = document.getElementById('fl-info-vis'));
      if (iKeEl) {
        const ke = FL._kineticEnergy;
        iKeEl.textContent = 'KE=' + (ke > 100 ? ke.toFixed(0) : ke.toFixed(2));
      }
      if (iVisEl) {
        const modeNames = {
          jet: 'speed', pressure: 'pressure', vorticity: 'vorticity', smoke: 'smoke',
          schlieren: 'schlieren', qcriterion: 'Q-crit', mach: 'Mach', density: 'density'
        };
        const overlays = [];
        if (FL.showVelField) overlays.push('vec');
        if (FL.showStreamlines) overlays.push('stream');
        if (FL.showContours) overlays.push('iso');
        if (FL.showParticles) overlays.push('part');
        const overlayStr = overlays.length ? ' +' + overlays.join('+') : '';
        iVisEl.textContent = (modeNames[FL.colorMode] || FL.colorMode) + overlayStr;
      }
    }

    // ── Mouse probe overlay (enhanced) ──────────────────────
    if (FL._probeI >= 1 && FL._probeI <= N && FL._probeJ >= 1 && FL._probeJ <= N) {
      const pi = FL._probeI, pj = FL._probeJ;
      const pidx = pi + pj * stride;
      if (!obstacles[pidx]) {
        const pu = u[pidx], pv = v[pidx];
        const pmag = Math.sqrt(pu * pu + pv * pv);
        const pp = pressure[pidx];
        const pcurl = (v[pidx + 1] - v[pidx - 1] - u[pidx + stride] + u[pidx - stride]) * 0.5;
        const pAngle = Math.atan2(pv, pu) * 180 / Math.PI;

        const probX = (pi - 0.5) * scaleX;
        const probY = (pj - 0.5) * scaleY;

        // Enhanced crosshair with a velocity direction indicator
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(probX - 10, probY); ctx.lineTo(probX + 10, probY);
        ctx.moveTo(probX, probY - 10); ctx.lineTo(probX, probY + 10);
        ctx.stroke();

        // Mini velocity direction arrow from probe centre
        if (pmag > 0.01) {
          const vLen = Math.min(18, pmag * 6);
          const vnx = pu / pmag, vny = pv / pmag;
          ctx.strokeStyle = isLight ? 'rgba(201,107,42,0.8)' : 'rgba(230,160,60,0.8)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(probX, probY);
          ctx.lineTo(probX + vnx * vLen, probY + vny * vLen);
          ctx.stroke();
          // Small arrowhead
          const ahx = probX + vnx * vLen, ahy = probY + vny * vLen;
          const perpx = -vny, perpy = vnx;
          ctx.beginPath();
          ctx.moveTo(ahx, ahy);
          ctx.lineTo(ahx - vnx * 4 + perpx * 2, ahy - vny * 4 + perpy * 2);
          ctx.lineTo(ahx - vnx * 4 - perpx * 2, ahy - vny * 4 - perpy * 2);
          ctx.closePath();
          ctx.fillStyle = isLight ? 'rgba(201,107,42,0.8)' : 'rgba(230,160,60,0.8)';
          ctx.fill();
        }

        // Info tooltip (wider, richer)
        const tipX = probX + 16;
        const tipY = probY - 14;
        ctx.fillStyle = isLight ? 'rgba(255,255,255,0.9)' : 'rgba(8,8,14,0.9)';
        const tipLines = 5 + (FL.compressible ? 2 : 0);
        const lineH = 11.5;
        const tipW = 132, tipH = tipLines * lineH + 16;
        const cornerR = 5;
        // Clamp to canvas bounds — flip to left side if near right edge
        let tx = tipX, ty = Math.max(tipY, 4);
        if (tx + tipW + 4 > canvas.width) tx = probX - tipW - 16;
        if (ty + tipH + 4 > canvas.height) ty = canvas.height - tipH - 4;
        ctx.beginPath();
        ctx.moveTo(tx + cornerR, ty);
        ctx.lineTo(tx + tipW - cornerR, ty); ctx.arcTo(tx + tipW, ty, tx + tipW, ty + cornerR, cornerR);
        ctx.lineTo(tx + tipW, ty + tipH - cornerR); ctx.arcTo(tx + tipW, ty + tipH, tx + tipW - cornerR, ty + tipH, cornerR);
        ctx.lineTo(tx + cornerR, ty + tipH); ctx.arcTo(tx, ty + tipH, tx, ty + tipH - cornerR, cornerR);
        ctx.lineTo(tx, ty + cornerR); ctx.arcTo(tx, ty, tx + cornerR, ty, cornerR);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Header
        ctx.fillStyle = isLight ? 'rgba(80,80,80,0.5)' : 'rgba(160,160,160,0.45)';
        ctx.font = '400 6.5px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`cell (${pi}, ${pj})`, tx + 5, ty + 9);

        // Divider line
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.moveTo(tx + 5, ty + 12); ctx.lineTo(tx + tipW - 5, ty + 12); ctx.stroke();

        // Field values — label : value layout
        ctx.font = '500 7.5px JetBrains Mono, monospace';
        let ly = ty + 23;
        const drawRow = (lbl, val, color) => {
          ctx.fillStyle = isLight ? 'rgba(100,100,100,0.7)' : 'rgba(160,160,160,0.6)';
          ctx.textAlign = 'left';
          ctx.fillText(lbl, tx + 5, ly);
          ctx.fillStyle = color || (isLight ? 'rgba(30,30,30,0.9)' : 'rgba(230,230,230,0.9)');
          ctx.textAlign = 'right';
          ctx.fillText(val, tx + tipW - 5, ly);
          ly += lineH;
        };
        drawRow('|v|', pmag.toFixed(3));
        drawRow('u, v', `${pu.toFixed(2)}, ${pv.toFixed(2)}`);
        drawRow('\u03B8', `${pAngle.toFixed(1)}\u00B0`);
        drawRow('p', pp.toFixed(4));
        drawRow('\u03C9', pcurl.toFixed(4),
          pcurl > 0.01 ? (isLight ? '#b05020' : '#d2845a') :
          pcurl < -0.01 ? (isLight ? '#2060a0' : '#5a9cd2') : undefined);
        if (FL.compressible) {
          const prho = FL.rho ? FL.rho[pidx] : 1;
          const pMach = pmag / FL.speedOfSound;
          drawRow('\u03C1', prho.toFixed(4));
          drawRow('Mach', pMach.toFixed(3),
            pMach > 1 ? '#d44' : undefined);
        }
      }
    }

    // ── Lagrangian particles overlay ──────────────────────
    FL._renderParticles();

    // ── Draw inlet markers ──────────────────────
    if (FL.inlets.length > 0) {
      const scX2 = canvas.width  / N;
      const scY2 = canvas.height / N;
      for (let k = 0; k < FL.inlets.length; k++) {
        const src = FL.inlets[k];
        const sx = (src.i - 0.5) * scX2;
        const sy = (src.j - 0.5) * scY2;
        const aLen = Math.max(12, src.radius * scX2 * 1.8);
        const mag = Math.sqrt(src.ux * src.ux + src.uy * src.uy);
        const nx = mag > 0.001 ? src.ux / mag : 1;
        const ny = mag > 0.001 ? src.uy / mag : 0;
        const ex = sx + nx * aLen;
        const ey = sy + ny * aLen;

        // Circle showing inlet area
        ctx.beginPath();
        ctx.arc(sx, sy, src.radius * scX2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${(src.cr*255)|0},${(src.cg*255)|0},${(src.cb*255)|0},0.5)`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Direction arrow
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = `rgba(${(src.cr*255)|0},${(src.cg*255)|0},${(src.cb*255)|0},0.75)`;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Arrowhead
        const px1 = -ny, py1 = nx;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - nx * 6 + px1 * 3, ey - ny * 6 + py1 * 3);
        ctx.lineTo(ex - nx * 6 - px1 * 3, ey - ny * 6 - py1 * 3);
        ctx.closePath();
        ctx.fillStyle = `rgba(${(src.cr*255)|0},${(src.cg*255)|0},${(src.cb*255)|0},0.75)`;
        ctx.fill();
      }
    }
  },

  // ─── User interaction ──────────────────────
  _addForce(gx, gy, fx, fy) {
    const { N } = FL;
    const r  = (FL.brushRadius / FL.canvas.width) * N;
    const cx = (gx / FL.canvas.width)  * N + 0.5 | 0;
    const cy = (gy / FL.canvas.height) * N + 0.5 | 0;
    const ri = r | 0;
    const col = FL._PALETTE[FL.mouseColorIdx % FL._PALETTE.length];
    const [cr, cg, cb] = col;

    for (let dj = -ri; dj <= ri; dj++) {
      for (let di = -ri; di <= ri; di++) {
        if (di * di + dj * dj > ri * ri) continue;
        const i = cx + di, j = cy + dj;
        if (i < 1 || i > N || j < 1 || j > N) continue;
        if (FL.obstacles[FL._idx(i, j)]) continue;
        const falloff = 1 - Math.sqrt(di * di + dj * dj) / (ri + 1);
        const idx = FL._idx(i, j);
        FL.u0[idx] += fx * falloff;
        FL.v0[idx] += fy * falloff;
        FL.dR0[idx] += (cr / 255) * falloff * 3.0;
        FL.dG0[idx] += (cg / 255) * falloff * 3.0;
        FL.dB0[idx] += (cb / 255) * falloff * 3.0;
      }
    }
  },

  _applyObstacleBrush(gx, gy, erase) {
    const { N } = FL;
    const r  = Math.max(4, (FL.brushRadius / FL.canvas.width) * N * 0.9);
    const cx = (gx / FL.canvas.width)  * N + 0.5 | 0;
    const cy = (gy / FL.canvas.height) * N + 0.5 | 0;
    const ri = r | 0;
    for (let dj = -ri; dj <= ri; dj++) {
      for (let di = -ri; di <= ri; di++) {
        if (di * di + dj * dj > ri * ri) continue;
        const i = cx + di, j = cy + dj;
        if (i < 1 || i > N || j < 1 || j > N) continue;
        FL.obstacles[FL._idx(i, j)] = erase ? 0 : 1;
      }
    }
    FL._updateObstacleFlag();
  },

  // ─── Interpolated obstacle brush — stamps along the line from (x0,y0) to (x1,y1) ──
  // Prevents gaps when dragging fast; gives smoother obstacle edges.
  _interpolatedBrush(x0, y0, x1, y1, erase) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Stamp spacing in pixels — smaller = smoother but more work
    const spacing = Math.max(2, FL.brushRadius * 0.3);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let s = 0; s <= steps; s++) {
      const t = steps > 0 ? s / steps : 0;
      FL._applyObstacleBrush(x0 + dx * t, y0 + dy * t, erase);
    }
  },

  // ─── Place an inlet from mousedown→mouseup drag ─────────
  // Start point = inlet position, drag direction/length = flow direction & strength.
  _placeInletFromDrag(sx, sy, ex, ey) {
    const { N } = FL;
    const ci = (sx / FL.canvas.width  * N + 0.5) | 0;
    const cj = (sy / FL.canvas.height * N + 0.5) | 0;
    if (ci < 1 || ci > N || cj < 1 || cj > N) return;
    // Direction from drag
    let dx = ex - sx, dy = ey - sy;
    const dragLen = Math.sqrt(dx * dx + dy * dy);
    // Default direction: rightward if no drag
    if (dragLen < 5) { dx = 1; dy = 0; } else { dx /= dragLen; dy /= dragLen; }
    // Strength proportional to drag length (capped)
    const strength = Math.min(40, Math.max(5, dragLen * 0.15));
    const speed = strength * 0.5;
    const rad = Math.max(2, ((FL.brushRadius / FL.canvas.width) * N * 0.5) | 0);
    const col = FL._PALETTE[FL._inletColorIdx % FL._PALETTE.length];
    FL.inlets.push({
      i: ci, j: cj,
      ux: dx * speed, uy: dy * speed,
      cr: col[0] / 255, cg: col[1] / 255, cb: col[2] / 255,
      radius: rad,
      strength: strength
    });
  },

  // ─── Place an inlet programmatically (for presets) ────────
  _addInlet(ci, cj, ux, uy, radius, strength, colorIdx) {
    const col = FL._PALETTE[(colorIdx || 0) % FL._PALETTE.length];
    FL.inlets.push({
      i: ci, j: cj,
      ux: ux, uy: uy,
      cr: col[0] / 255, cg: col[1] / 255, cb: col[2] / 255,
      radius: radius,
      strength: strength
    });
  },

  _setObstacleCircle(cx, cy, r) {
    const { N } = FL;
    const ri = r | 0;
    for (let dj = -ri; dj <= ri; dj++) {
      for (let di = -ri; di <= ri; di++) {
        if (di * di + dj * dj > ri * ri) continue;
        const i = cx + di, j = cy + dj;
        if (i < 1 || i > N || j < 1 || j > N) continue;
        FL.obstacles[FL._idx(i, j)] = 1;
      }
    }
  },

  _setObstacleRect(x0, y0, x1, y1) {
    const { N } = FL;
    for (let j = Math.max(1, y0); j <= Math.min(N, y1); j++) {
      for (let i = Math.max(1, x0); i <= Math.min(N, x1); i++) {
        FL.obstacles[FL._idx(i, j)] = 1;
      }
    }
  },

  // ─── NACA 4-digit aerofoil generator ────────────────────────
  // m = max camber, p = camber position (tenths), t = max thickness ratio
  // Returns upper & lower surface y-offsets at chordwise position x/c ∈ [0,1]
  _nacaProfile(xc, m, p, t) {
    // Thickness distribution (NACA formula)
    const yt = 5 * t * (
      0.2969 * Math.sqrt(xc)
      - 0.1260 * xc
      - 0.3516 * xc * xc
      + 0.2843 * xc * xc * xc
      - 0.1015 * xc * xc * xc * xc
    );
    if (m === 0) return { upper: yt, lower: -yt };
    // Camber line
    let yc, dyc;
    if (xc <= p) {
      yc  = (m / (p * p)) * (2 * p * xc - xc * xc);
      dyc = (2 * m / (p * p)) * (p - xc);
    } else {
      const op = 1 - p;
      yc  = (m / (op * op)) * ((1 - 2 * p) + 2 * p * xc - xc * xc);
      dyc = (2 * m / (op * op)) * (p - xc);
    }
    const theta = Math.atan(dyc);
    const cosT  = Math.cos(theta), sinT = Math.sin(theta);
    return {
      upper:  yc + yt * cosT,
      lower:  yc - yt * cosT
    };
  },

  _placeNACA(cx, cy, chord, m, p, t, aoa) {
    const { N } = FL;
    const rad = aoa * Math.PI / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);
    const steps = chord * 2; // oversample for smooth boundary
    for (let s = 0; s <= steps; s++) {
      const xc = s / steps;
      const prof = FL._nacaProfile(xc, m, p, t);
      // Rasterise both surfaces
      const xRel = (xc - 0.5) * chord;
      for (let side = -1; side <= 1; side += 2) {
        const yRel = (side === 1 ? prof.upper : prof.lower) * chord;
        // Rotate by AoA
        const rx = xRel * cosA - yRel * sinA;
        const ry = xRel * sinA + yRel * cosA;
        const gi = (cx + rx) | 0;
        const gj = (cy + ry) | 0;
        if (gi >= 1 && gi <= N && gj >= 1 && gj <= N) {
          FL.obstacles[FL._idx(gi, gj)] = 1;
        }
      }
      // Fill interior between upper and lower surfaces
      const yU = prof.upper * chord;
      const yL = prof.lower * chord;
      const rxU = (xc - 0.5) * chord * cosA - yU * sinA;
      const ryU = (xc - 0.5) * chord * sinA + yU * cosA;
      const rxL = (xc - 0.5) * chord * cosA - yL * sinA;
      const ryL = (xc - 0.5) * chord * sinA + yL * cosA;
      const jMin = Math.min(ryU, ryL);
      const jMax = Math.max(ryU, ryL);
      for (let dy = Math.floor(jMin); dy <= Math.ceil(jMax); dy++) {
        const xi = (cx + (xc - 0.5) * chord * cosA - dy * sinA) | 0;
        const yj = (cy + dy) | 0;
        if (xi >= 1 && xi <= N && yj >= 1 && yj <= N) {
          FL.obstacles[FL._idx(xi, yj)] = 1;
        }
      }
    }
  },

  _placePreset(name) {
    const { N } = FL;
    FL.obstacles.fill(0);
    FL.inlets.length = 0;
    const cx = (N * 0.32) | 0;
    const cy = (N * 0.50) | 0;
    if (name === 'cylinder') {
      FL._setObstacleCircle(cx, cy, N * 0.07);
    } else if (name === 'plate') {
      const hw = 2, hh = (N * 0.14) | 0;
      FL._setObstacleRect(cx - hw, cy - hh, cx + hw, cy + hh);
    } else if (name === 'wedge') {
      const h = (N * 0.10) | 0;
      for (let j = 0; j <= h; j++) {
        const half = ((h - j) * 0.6) | 0;
        FL._setObstacleRect(cx + j, cy - half, cx + j, cy + half);
      }
    } else if (name === 'airfoil') {
      // NACA 0012 — symmetric, zero camber, 12% thickness
      FL._placeNACA(cx, cy, N * 0.22, 0, 0.4, 0.12, 0);
    } else if (name === 'airfoil-cambered') {
      // NACA 2412 — 2% camber at 40% chord, 12% thickness
      FL._placeNACA(cx, cy, N * 0.22, 0.02, 0.4, 0.12, 4);
    } else if (name === 'square') {
      const s = (N * 0.07) | 0;
      FL._setObstacleRect(cx - s, cy - s, cx + s, cy + s);
    } else if (name === 'backstep') {
      // Backward-facing step — classic CFD benchmark
      const stepH = (N * 0.20) | 0;
      const stepX = (N * 0.30) | 0;
      FL._setObstacleRect(1, 1, stepX, stepH);           // step body
      FL._setObstacleRect(1, 1, N, 3);                   // bottom wall
      FL._setObstacleRect(1, N - 2, stepX, N);           // top wall before step
    } else if (name === 'tandem') {
      // Two cylinders in tandem — wake interaction study
      const r = (N * 0.045) | 0;
      const gap = (N * 0.20) | 0;
      FL._setObstacleCircle(cx - (gap >> 1), cy, r);
      FL._setObstacleCircle(cx + (gap >> 1), cy, r);
    } else if (name === 'venturi') {
      // Venturi tube — demonstrates Bernoulli effect (velocity↑ pressure↓ in throat)
      const wallH = (N * 0.12) | 0;       // wall thickness
      const throatHalf = (N * 0.10) | 0;   // half-height at throat
      const len = (N * 0.50) | 0;          // total length
      const startX = (N * 0.25) | 0;
      for (let dx = 0; dx < len; dx++) {
        // Smooth cosine taper: wide → narrow → wide
        const t = dx / (len - 1);
        const taper = 0.5 * (1 - Math.cos(2 * Math.PI * t)); // 0 at ends, 1 at centre
        const halfGap = throatHalf + (1 - taper) * wallH;
        const xi = startX + dx;
        // Top wall
        FL._setObstacleRect(xi, 1, xi, (cy - halfGap) | 0);
        // Bottom wall
        FL._setObstacleRect(xi, (cy + halfGap) | 0, xi, N);
      }
    } else if (name === 'diffuser') {
      // Diverging channel — adverse pressure gradient → potential separation
      const startX = (N * 0.15) | 0;
      const endX   = (N * 0.75) | 0;
      const entryHalf = (N * 0.08) | 0;
      const exitHalf  = (N * 0.28) | 0;
      for (let dx = 0; dx <= (endX - startX); dx++) {
        const t = dx / (endX - startX);
        const halfGap = entryHalf + t * (exitHalf - entryHalf);
        const xi = startX + dx;
        FL._setObstacleRect(xi, 1, xi, (cy - halfGap) | 0);
        FL._setObstacleRect(xi, (cy + halfGap) | 0, xi, N);
      }
    } else if (name === 'nozzle') {
      // Converging channel — favourable pressure gradient → stable flow
      const startX = (N * 0.15) | 0;
      const endX   = (N * 0.75) | 0;
      const entryHalf = (N * 0.28) | 0;
      const exitHalf  = (N * 0.08) | 0;
      for (let dx = 0; dx <= (endX - startX); dx++) {
        const t = dx / (endX - startX);
        const halfGap = entryHalf + t * (exitHalf - entryHalf);
        const xi = startX + dx;
        FL._setObstacleRect(xi, 1, xi, (cy - halfGap) | 0);
        FL._setObstacleRect(xi, (cy + halfGap) | 0, xi, N);
      }
    }
    // ── Presets with inlets (stream sources) ──
    else if (name === 'jet-impinge') {
      // Impinging jet on a flat wall
      FL.inlets.length = 0;
      const wallX = (N * 0.65) | 0;
      FL._setObstacleRect(wallX, (cy - N * 0.25) | 0, wallX + 3, (cy + N * 0.25) | 0);
      const jetR = (N * 0.04) | 0;
      FL._addInlet((N * 0.15) | 0, cy, 12, 0, jetR, 20, 0);
    } else if (name === 'mixing') {
      // Two opposing jets → turbulent mixing
      FL.inlets.length = 0;
      const jetR = (N * 0.035) | 0;
      FL._addInlet((N * 0.10) | 0, cy, 10, 0, jetR, 18, 0);
      FL._addInlet((N * 0.90) | 0, cy, -10, 0, jetR, 18, 1);
    } else if (name === 'crossflow') {
      // Jet in crossflow — vertical jet meets horizontal stream
      FL.inlets.length = 0;
      const jetR = (N * 0.03) | 0;
      // Main horizontal stream
      FL._addInlet((N * 0.08) | 0, cy, 8, 0, (N * 0.15) | 0, 12, 0);
      // Vertical jet from bottom
      FL._addInlet((N * 0.40) | 0, (N * 0.92) | 0, 0, -14, jetR, 25, 2);
    } else if (name === 'fountain') {
      // Two jets colliding head-on — fountain effect
      FL.inlets.length = 0;
      const jetR = (N * 0.04) | 0;
      FL._addInlet((N * 0.20) | 0, cy, 12, 0, jetR, 20, 3);
      FL._addInlet((N * 0.80) | 0, cy, -12, 0, jetR, 20, 4);
    } else if (name === 'lid-cavity') {
      // Lid-driven cavity — closed box with moving top wall
      // Classic CFD benchmark problem (Re-dependent vortex structure)
      const wall = 3;
      FL._setObstacleRect(1, 1, wall, N);            // left wall
      FL._setObstacleRect(N - wall, 1, N, N);        // right wall
      FL._setObstacleRect(1, N - wall, N, N);        // bottom wall
      // Top "lid" implemented as a wide inlet strip sliding rightward
      const lidY = wall + 2;
      const lidSpeed = 8;
      const lidR = 1;
      const segW = (N * 0.12) | 0;
      for (let xi = wall + segW; xi < N - wall - segW; xi += segW * 2) {
        FL._addInlet(xi, lidY, lidSpeed, 0, segW, 12, 0);
      }
    } else if (name === 'magnus') {
      // Magnus effect — spinning cylinder generates lift in crossflow
      // The surface velocity is simulated by placing tangential inlets
      // around the cylinder perimeter (rotation-driven boundary layer)
      const r = (N * 0.08) | 0;
      FL._setObstacleCircle(cx, cy, r);
      // Add tangential velocity sources around the cylinder to simulate spin
      const spinSpeed = 6;
      const nPts = 12;
      const outerR = r + 2;
      for (let k = 0; k < nPts; k++) {
        const angle = (2 * Math.PI * k) / nPts;
        const px = cx + Math.cos(angle) * outerR;
        const py = cy + Math.sin(angle) * outerR;
        const pi = Math.round(px), pj = Math.round(py);
        if (pi < 1 || pi > N || pj < 1 || pj > N) continue;
        // Tangential direction (perpendicular to radius, counter-clockwise)
        const tx = -Math.sin(angle) * spinSpeed;
        const ty =  Math.cos(angle) * spinSpeed;
        FL._addInlet(pi, pj, tx, ty, 2, 8, 2);
      }
    } else if (name === 'staggered') {
      // Staggered cylinder array — tube bank heat exchanger model
      const r = (N * 0.028) | 0;
      const spacingX = (N * 0.14) | 0;
      const spacingY = (N * 0.13) | 0;
      const startX = (N * 0.22) | 0;
      const startY = (N * 0.15) | 0;
      for (let row = 0; row < 5; row++) {
        const nCols = row % 2 === 0 ? 4 : 3;
        const offsetX = row % 2 === 0 ? 0 : (spacingX >> 1);
        for (let col = 0; col < nCols; col++) {
          const x = startX + col * spacingX + offsetX;
          const y = startY + row * spacingY;
          if (x > 1 && x < N && y > 1 && y < N) {
            FL._setObstacleCircle(x, y, r);
          }
        }
      }
    } else if (name === 'bifurcation') {
      // Y-bifurcation — channel splits into two branches
      const wallT = 3; // wall thickness
      const trunkL = (N * 0.35) | 0;  // trunk length
      const trunkH = (N * 0.12) | 0;  // trunk half-height
      const branchLen = (N * 0.30) | 0;
      const spreadAngle = 0.35; // radians (~20°)
      // Trunk (horizontal channel)
      const startX = (N * 0.10) | 0;
      for (let dx = 0; dx < trunkL; dx++) {
        const xi = startX + dx;
        FL._setObstacleRect(xi, cy - trunkH - wallT, xi, cy - trunkH);
        FL._setObstacleRect(xi, cy + trunkH, xi, cy + trunkH + wallT);
      }
      // Splitter tip and branch walls
      const forkX = startX + trunkL;
      // Splitter wedge
      for (let dx = 0; dx < branchLen; dx++) {
        const xi = forkX + dx;
        const spread = dx * Math.tan(spreadAngle);
        // Upper branch walls
        const upperCy = cy - spread;
        FL._setObstacleRect(xi, (upperCy - trunkH - wallT) | 0, xi, (upperCy - trunkH) | 0);
        if (dx > 3) FL._setObstacleRect(xi, (upperCy + trunkH) | 0, xi, (upperCy + trunkH + wallT) | 0);
        // Lower branch walls
        const lowerCy = cy + spread;
        if (dx > 3) FL._setObstacleRect(xi, (lowerCy - trunkH - wallT) | 0, xi, (lowerCy - trunkH) | 0);
        FL._setObstacleRect(xi, (lowerCy + trunkH) | 0, xi, (lowerCy + trunkH + wallT) | 0);
      }
      // Splitter body (triangular divider at junction)
      for (let dx = 0; dx <= 10; dx++) {
        const xi = forkX + dx;
        const halfH = ((10 - dx) * trunkH / 12) | 0;
        if (halfH > 0) FL._setObstacleRect(xi, cy - halfH, xi, cy + halfH);
      }
    } else if (name === 'karman') {
      // Kármán gallery — three cylinders of different sizes
      const r1 = (N * 0.05) | 0;
      const r2 = (N * 0.035) | 0;
      const r3 = (N * 0.065) | 0;
      FL._setObstacleCircle(cx, (N * 0.25) | 0, r1);
      FL._setObstacleCircle(cx, (N * 0.50) | 0, r2);
      FL._setObstacleCircle(cx, (N * 0.75) | 0, r3);
    }
    // 'clear' → already filled(0) above
    FL._updateObstacleFlag();
    // Re-seed particles for new obstacle configuration
    if (FL.showParticles) FL._initParticles();

    // Show scenario description if available
    const descEl = document.getElementById('fl-scenario-desc');
    const subEl  = document.getElementById('fl-ctbsub');
    if (descEl) {
      const desc = FL._scenarioDesc[name];
      if (desc) {
        descEl.textContent = desc;
        descEl.style.display = '';
        // Also show a short version in the canvas toolbar subtitle
        if (subEl) {
          // Extract first sentence as a concise summary
          const firstSentence = desc.split(/\.\s/)[0] + '.';
          subEl.textContent = firstSentence;
        }
      } else {
        descEl.textContent = '';
        descEl.style.display = 'none';
        if (subEl && name === 'clear') subEl.textContent = 'obstacles cleared \u00B7 draw your own or select a preset';
      }
    }

    // Track active scenario name for HUD display
    FL._activeScenario = (name !== 'clear') ? name : '';
  },

  _bindControls() {
    // ── Slider helper ──
    const bs = (id, key, fmt, vid) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        FL[key] = parseFloat(el.value);
        const vEl = document.getElementById(vid);
        if (vEl) vEl.textContent = fmt(FL[key]);
      });
    };
    const _syncSlider = (id, val, vid, fmt) => {
      const el = document.getElementById(id);
      const vEl = document.getElementById(vid);
      if (el) el.value = val;
      if (vEl) vEl.textContent = fmt(val);
    };

    bs('fl-visc',  'visc',         v => v.toFixed(5), 'fl-viscv');
    bs('fl-diff',  'diff',         v => v.toFixed(5), 'fl-diffv');
    bs('fl-vort',  'vortStrength', v => v.toFixed(1),  'fl-vortv');
    bs('fl-fade',  'densityFade',  v => v.toFixed(3),  'fl-fadev');
    bs('fl-rad',   'brushRadius',  v => v.toFixed(0),  'fl-radv');
    bs('fl-force', 'brushForce',   v => v.toFixed(0),  'fl-forcev');
    bs('fl-gravity',   'gravity',     v => v.toFixed(0),  'fl-gravityv');
    bs('fl-timescale', 'timeScale',   v => v.toFixed(1),  'fl-timescalev');
    bs('fl-solver',    'solverIters', v => v.toFixed(0),  'fl-solverv');
    bs('fl-sos',       'speedOfSound', v => v.toFixed(1), 'fl-sosv');
    bs('fl-smag',      '_smagConst', v => v.toFixed(2), 'fl-smagv');

    // ── Wind speed slider ──
    const windEl = document.getElementById('fl-wind');
    if (windEl) {
      windEl.addEventListener('input', () => {
        FL.windSpeed = parseFloat(windEl.value);
        const vEl = document.getElementById('fl-windv');
        if (vEl) vEl.textContent = FL.windSpeed.toFixed(0);
      });
    }

    // ── LBM sliders ──
    const lbmTauEl = document.getElementById('fl-lbm-tau');
    if (lbmTauEl) {
      lbmTauEl.addEventListener('input', () => {
        FL._lbmTau = parseFloat(lbmTauEl.value);
        const vEl = document.getElementById('fl-lbm-tauv');
        if (vEl) vEl.textContent = FL._lbmTau.toFixed(3);
      });
    }
    const lbmStepsEl = document.getElementById('fl-lbm-steps');
    if (lbmStepsEl) {
      lbmStepsEl.addEventListener('input', () => {
        FL._lbmStepsPerFrame = parseInt(lbmStepsEl.value, 10);
        const vEl = document.getElementById('fl-lbm-stepsv');
        if (vEl) vEl.textContent = FL._lbmStepsPerFrame.toString();
      });
    }

    // ── Solver select ──
    const solverSel = document.getElementById('sel-solver');
    if (solverSel) {
      solverSel.addEventListener('change', () => {
        const mode = solverSel.value;
        FL.solverMode = mode;
        FL.u.fill(0); FL.v.fill(0); FL.u0.fill(0); FL.v0.fill(0);
        FL.pressure.fill(0);
        if (FL.rho) FL.rho.fill(1.0);
        FL._maxSpeed = 1;
        if (mode === 'lbm') FL._lbmInited = false;
      });
    }

    // ── Fluid preset select ──
    const _fluidPresets = {
      air:        { visc: 0.00003, diff: 0.00001, vortStrength: 12, densityFade: 0.988 },
      default:    { visc: 0.00010, diff: 0.00005, vortStrength: 8,  densityFade: 0.992 },
      water:      { visc: 0.00030, diff: 0.00010, vortStrength: 5,  densityFade: 0.996 },
      honey:      { visc: 0.00300, diff: 0.00020, vortStrength: 1,  densityFade: 0.998 },
      smoke:      { visc: 0.00002, diff: 0.00080, vortStrength: 15, densityFade: 0.970 },
      superfluid: { visc: 0.00000, diff: 0.00000, vortStrength: 20, densityFade: 0.999 },
    };
    const presetSel = document.getElementById('sel-preset');
    if (presetSel) {
      presetSel.addEventListener('change', () => {
        const pre = _fluidPresets[presetSel.value];
        if (!pre) return;
        FL.visc = pre.visc; FL.diff = pre.diff;
        FL.vortStrength = pre.vortStrength; FL.densityFade = pre.densityFade;
        _syncSlider('fl-visc', pre.visc, 'fl-viscv', v => v.toFixed(5));
        _syncSlider('fl-diff', pre.diff, 'fl-diffv', v => v.toFixed(5));
        _syncSlider('fl-vort', pre.vortStrength, 'fl-vortv', v => v.toFixed(1));
        _syncSlider('fl-fade', pre.densityFade, 'fl-fadev', v => v.toFixed(3));
      });
    }

    // ── Visualisation select ──
    const visSel = document.getElementById('sel-vis');
    if (visSel) {
      visSel.addEventListener('change', () => { FL.colorMode = visSel.value; });
    }

    // ── Interaction mode select ──
    const modeSel = document.getElementById('sel-mode');
    if (modeSel) {
      modeSel.addEventListener('change', () => { FL.interactMode = modeSel.value; });
    }

    // ── Checkbox toggles ──
    const chk = (id, cb) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => cb(el.checked));
    };

    chk('chk-wind', v => {
      FL.windTunnel = v;
      const shapesRow = document.getElementById('fl-shapes-row');
      if (shapesRow) shapesRow.style.display = v ? '' : 'none';
      if (v) {
        FL.colorMode = 'jet';
        const visSel2 = document.getElementById('sel-vis');
        if (visSel2) visSel2.value = 'jet';
        FL.u.fill(0); FL.v.fill(0); FL.u0.fill(0); FL.v0.fill(0);
        FL.dR.fill(0); FL.dG.fill(0); FL.dB.fill(0);
        FL.dR0.fill(0); FL.dG0.fill(0); FL.dB0.fill(0);
        FL.pressure.fill(0);
        if (FL.rho) FL.rho.fill(1.0);
        FL._maxSpeed = 1;
      }
    });

    chk('chk-vectors', v => { FL.showVelField = v; });
    chk('chk-stream', v => { FL.showStreamlines = v; });
    chk('chk-contour', v => { FL.showContours = v; });
    chk('chk-particles', v => {
      FL.showParticles = v;
      if (v && (!FL._particles || FL._particles.length === 0)) FL._initParticles();
    });

    chk('chk-compress', v => {
      FL.compressible = v;
      if (FL.rho) FL.rho.fill(1.0);
      FL.pressure.fill(0);
    });

    chk('chk-turb', v => {
      FL.turbulenceModel = v;
      if (!v && FL._eddyVisc) FL._eddyVisc.fill(0);
    });

    chk('chk-adaptdt', v => { FL.adaptiveDt = v; });

    // ── Obstacle preset buttons ──
    document.querySelectorAll('[data-flobst]').forEach(btn => {
      btn.addEventListener('click', () => FL._placePreset(btn.dataset.flobst));
    });

    // ── Reset / Pause / Clear / Save ──
    document.getElementById('fl-reset-flow')?.addEventListener('click', () => {
      FL.u.fill(0); FL.v.fill(0); FL.u0.fill(0); FL.v0.fill(0);
      FL.dR.fill(0); FL.dG.fill(0); FL.dB.fill(0);
      FL.dR0.fill(0); FL.dG0.fill(0); FL.dB0.fill(0);
      FL.pressure.fill(0);
      if (FL.rho) FL.rho.fill(1.0);
      FL._maxSpeed = 1;
      FL._lbmInited = false;
    });

    document.getElementById('flPauseBtn')?.addEventListener('click', () => {
      FL.paused = !FL.paused;
      document.getElementById('flPauseBtn').textContent = FL.paused ? 'Resume' : 'Pause';
    });

    document.getElementById('flClearBtn')?.addEventListener('click', () => {
      FL.u.fill(0); FL.v.fill(0); FL.u0.fill(0); FL.v0.fill(0);
      FL.dR.fill(0); FL.dG.fill(0); FL.dB.fill(0);
      FL.dR0.fill(0); FL.dG0.fill(0); FL.dB0.fill(0);
      FL.obstacles.fill(0);
      FL.pressure.fill(0);
      FL.inlets.length = 0;
      if (FL.rho) FL.rho.fill(1.0);
      FL._updateObstacleFlag();
      FL._maxSpeed = 1;
      FL._lbmInited = false;
      FL._strouhalNum = 0;
      FL._activeScenario = '';
      FL._sheddingTracker = { samples: [], lastSign: 0, crossings: [], lastUpdate: 0 };
      FL._initParticles();
    });

    document.getElementById('flSaveBtn')?.addEventListener('click', () => savePNG('flCanvas', 'fluid'));

    // ── Mouse / Touch ─────────────────────────
    const canvas = FL.canvas;
    const getPos = e => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const handleDrag = (x, y) => {
      if (FL.interactMode === 'paint') {
        const fx = (FL.mx - FL.pmx) * FL.brushForce * 0.1;
        const fy = (FL.my - FL.pmy) * FL.brushForce * 0.1;
        FL._addForce(x, y, fx, fy);
      } else if (FL.interactMode === 'obstacle') {
        FL._interpolatedBrush(FL.pmx, FL.pmy, x, y, false);
      } else if (FL.interactMode === 'erase') {
        FL._interpolatedBrush(FL.pmx, FL.pmy, x, y, true);
      } else if (FL.interactMode === 'eraseInlet') {
        const ci = (x / canvas.width  * FL.N + 0.5) | 0;
        const cj = (y / canvas.height * FL.N + 0.5) | 0;
        const er = Math.max(4, (FL.brushRadius / canvas.width) * FL.N);
        FL._eraseInletsNear(ci, cj, er);
      }
    };

    canvas.addEventListener('mousedown', e => {
      FL.mouseDown = true;
      const { x, y } = getPos(e);
      FL.mx = FL.pmx = x; FL.my = FL.pmy = y;
      if (FL.interactMode === 'paint') {
        FL.mouseColorIdx = (FL.mouseColorIdx + 1) % FL._PALETTE.length;
      } else if (FL.interactMode === 'inlet') {
        // Record start position for direction calc
        FL._inletStartX = x; FL._inletStartY = y;
        FL._inletColorIdx = (FL._inletColorIdx + 1) % FL._PALETTE.length;
      }
    });
    canvas.addEventListener('mousemove', e => {
      const { x, y } = getPos(e);
      FL.pmx = FL.mx; FL.pmy = FL.my;
      FL.mx = x; FL.my = y;
      // Update probe position for local value readout
      FL._probeI = (x / canvas.width  * FL.N + 0.5) | 0;
      FL._probeJ = (y / canvas.height * FL.N + 0.5) | 0;
      if (FL.mouseDown) handleDrag(x, y);
    });
    canvas.addEventListener('mouseup', e => {
      if (FL.mouseDown && FL.interactMode === 'inlet') {
        const { x, y } = getPos(e);
        FL._placeInletFromDrag(FL._inletStartX, FL._inletStartY, x, y);
      }
      FL.mouseDown = false;
    });
    canvas.addEventListener('mouseleave', () => { FL.mouseDown = false; FL._probeI = -1; FL._probeJ = -1; });

    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.touches[0];
      const { x, y } = getPos(t);
      FL.mouseDown = true; FL.mx = FL.pmx = x; FL.my = FL.pmy = y;
      if (FL.interactMode === 'paint') {
        FL.mouseColorIdx = (FL.mouseColorIdx + 1) % FL._PALETTE.length;
      } else if (FL.interactMode === 'inlet') {
        FL._inletStartX = x; FL._inletStartY = y;
        FL._inletColorIdx = (FL._inletColorIdx + 1) % FL._PALETTE.length;
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const t = e.touches[0];
      const { x, y } = getPos(t);
      FL.pmx = FL.mx; FL.pmy = FL.my; FL.mx = x; FL.my = y;
      if (FL.mouseDown) handleDrag(x, y);
    }, { passive: false });
    canvas.addEventListener('touchend', e => {
      if (FL.mouseDown && FL.interactMode === 'inlet') {
        FL._placeInletFromDrag(FL._inletStartX, FL._inletStartY, FL.mx, FL.my);
      }
      FL.mouseDown = false;
    });
  },

  _loop() {
    const now = performance.now();
    FL.fc++;
    if (FL.fc % 30 === 0) {
      FL.fps = Math.min(999, (30000 / (now - FL._fps0)) | 0);
      FL._fps0 = now;
    }

    if (!FL.paused && !globalPaused) {
      // Compute effective dt with time scale
      FL.dt = 0.12 * FL.timeScale;

      // ── Adaptive CFL-based time stepping ──
      // Adjusts dt each frame to maintain a target CFL number,
      // which ensures the advection scheme remains stable even as
      // flow speeds change dynamically. The CFL condition requires
      // |u|·dt·N < 1; we target 0.45 for a comfortable safety margin.
      if (FL.adaptiveDt && FL._cflNumber > 0.01) {
        const ratio = FL._targetCFL / FL._cflNumber;
        // Smooth adjustment (avoid sudden jumps) with exponential filter
        let newDt = FL.dt * Math.min(1.3, Math.max(0.6, ratio));
        // Clamp to safe range
        if (newDt < FL._dtMin) newDt = FL._dtMin;
        if (newDt > FL._dtMax) newDt = FL._dtMax;
        FL.dt = FL.dt * 0.8 + newDt * 0.2; // smooth blend
        // React faster when nearing instability
        if (FL._cflNumber > 0.8) {
          FL.dt = FL.dt * 0.5 + newDt * 0.5;
        }
      }

      // Apply persistent user-placed inlets (velocity + dye sources)
      FL._applyInlets();

      if (FL.solverMode === 'lbm') {
        // ── Lattice Boltzmann solver ──
        if (!FL._lbmInited) FL._lbmInitEquilibrium();
        // Apply user/inlet forces before the sub-step loop
        FL._lbmApplyForces();
        FL._lbmClearForces();
        const steps = FL._lbmStepsPerFrame;
        for (let step = 0; step < steps; step++) {
          FL._lbmStep();
        }
        if (FL.windTunnel) {
          FL._lbmInjectWindDye();
          if (FL.fc % 3 === 0) FL._computeAeroCoeffs();
        }
        if (FL.fc % 3 === 0) FL._computeEducationalStats();
      } else {
        // ── Navier–Stokes solver ──
        if (FL.compressible) {
          FL._velStepCompressible();
        } else {
          FL._velStep();
        }
      } 
      // Boost density fade in wind tunnel so dye remains visible through the full wake
      const savedFade = FL.densityFade;
      if (FL.windTunnel) FL.densityFade = Math.max(FL.densityFade, 0.997);
      FL._densStepRGB();
      FL.densityFade = savedFade;

      // Advect Lagrangian particles (after velocity step, uses new velocity field)
      FL._advectParticles();
    }

    FL._render();
    requestAnimationFrame(() => FL._loop());
  }
};

/* ═══════════════════════════════════════════
   STANDALONE INIT
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (key === ' ') { e.preventDefault(); document.getElementById('flPauseBtn')?.click(); return; }
    if (key === 's' && !e.ctrlKey && !e.metaKey) {
      document.getElementById('flSaveBtn')?.click();
    }
  });

  FL.init();
  FL._inited = true;
});
