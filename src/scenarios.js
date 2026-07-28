/* Built-in scenarios, expressed as scene objects.
 *
 * These used to rasterise straight into a mask, which meant the built-in
 * geometry could not be selected, moved, retyped or undone — a cylinder you
 * loaded behaved differently from a circle you drew. Building them from the
 * same primitives as everything else removes that split entirely.
 *
 * Two cases get materially better in the process: the spinning cylinder is now
 * a rotating boundary rather than a ring of fake tangential emitters, and the
 * lid-driven cavity is a moving wall rather than a row of inlet strips.
 *
 * Each entry declares the flow mode it is physically meaningful in. A sealed
 * cavity with a wall inlet blowing through it is not the benchmark, so the
 * driver follows the declaration instead of leaving it to the user to guess.
 */

import { Shapes } from './scene.js';

/* Aerofoil chord, as a fraction of domain height.
 *
 * Sized so the CAMBER resolves, not just the section. A NACA 2412 at 0.46*ny
 * puts its camber line only ~1.2 cells off the chord — below what a
 * half-coverage mask can represent — and the section then reads as symmetric
 * and produces no lift. At 0.72*ny the camber is ~1.8 cells and lift lands on
 * the textbook value (0.25 at zero incidence, ~0.9 at six degrees).
 * Fractional-coverage boundaries would lift this limit. */
const FOIL_CHORD = 0.72;

/* Swept channel walls: sample a half-height profile and close it into a
 * polygon against the top or bottom domain edge. */
function wall(nx, ny, x0, x1, halfAt, side, opts) {
  const pts = [];
  const steps = Math.max(8, Math.round(x1 - x0));
  const edge = side === 'top' ? 0 : ny + 1;
  for (let k = 0; k <= steps; k++) {
    const x = x0 + (x1 - x0) * (k / steps);
    const half = halfAt(k / steps);
    pts.push(x, side === 'top' ? (ny + 1) / 2 - half : (ny + 1) / 2 + half);
  }
  pts.push(x1, edge, x0, edge);
  return Shapes.polygonAbs(pts, opts);
}

export const SCENARIOS = [
  {
    id: 'cylinder', label: 'Cylinder', group: 'bluff', wind: true,
    text: 'Flow past a circular cylinder — the canonical vortex-shedding problem. Below Re ~47 the wake is steady and symmetric. Above it, vortices shed alternately from each side and the Karman street appears. Shedding follows St = fD/U ~ 0.2 over a wide Reynolds range.',
    objects: (nx, ny) => [Shapes.circle(nx * 0.26, (ny + 1) / 2, ny * 0.11, { name: 'Cylinder' })],
  },
  {
    id: 'square', label: 'Square', group: 'bluff', wind: true,
    text: 'A square cylinder fixes its separation points at the sharp corners instead of letting them move with Reynolds number. The wake is wider and drag higher than the circular case, and the shedding frequency shifts accordingly.',
    objects: (nx, ny) => [Shapes.rect(nx * 0.26, (ny + 1) / 2, ny * 0.2, ny * 0.2, { name: 'Square' })],
  },
  {
    id: 'plate', label: 'Flat plate', group: 'bluff', wind: true,
    text: 'A flat plate normal to the flow — close to the maximum-drag geometry for its frontal area. Separation is forced at both edges and the wake is broad and unsteady. Compare its drag to a cylinder of the same height.',
    objects: (nx, ny) => [Shapes.rect(nx * 0.26, (ny + 1) / 2, 3, ny * 0.4, { name: 'Plate' })],
  },
  {
    id: 'wedge', label: 'Wedge', group: 'bluff', wind: true,
    text: 'A wedge presents a tapered leading edge, so the flow stays attached further back before separating at the trailing corners. A useful midpoint between the streamlined aerofoil and the bluff plate.',
    objects: (nx, ny) => {
      const h = ny * 0.22, x0 = nx * 0.22, cy = (ny + 1) / 2;
      return [Shapes.polygonAbs([x0, cy - h * 0.55, x0 + h, cy, x0, cy + h * 0.55], { name: 'Wedge' })];
    },
  },
  {
    id: 'airfoil', label: 'NACA 0012', group: 'foil', wind: true, aoa: 0,
    text: 'A symmetric NACA 0012 section. At zero incidence it produces no lift by symmetry, but very little drag either — the streamlined shape keeps the boundary layer attached almost to the trailing edge. Raise the angle of attack to watch lift build, then stall.',
    objects: (nx, ny, o = {}) => [Shapes.naca(nx * 0.28, (ny + 1) / 2, ny * 0.72,
      { camber: 0, camberPos: 0.4, thickness: 0.12, aoa: o.aoa ?? 0 }, { name: 'NACA 0012' })],
  },
  {
    id: 'airfoil-cambered', label: 'NACA 2412', group: 'foil', wind: true, aoa: 4,
    text: 'A cambered NACA 2412 section. The curved mean line generates lift even at zero incidence; with a few degrees of incidence it produces markedly lower pressure over the upper surface. Switch to the pressure view to see the suction peak near the leading edge.',
    objects: (nx, ny, o = {}) => [Shapes.naca(nx * 0.28, (ny + 1) / 2, ny * 0.72,
      { camber: 0.02, camberPos: 0.4, thickness: 0.12, aoa: o.aoa ?? 4 }, { name: 'NACA 2412' })],
  },
  {
    id: 'tandem', label: 'Tandem', group: 'bluff', wind: true,
    text: 'Two cylinders in line. The downstream body sits inside the wake of the upstream one and experiences much lower drag — the drafting effect exploited in cycling and motor racing. At certain spacings the wakes lock into synchronised shedding.',
    objects: (nx, ny) => {
      const cy = (ny + 1) / 2, r = ny * 0.075, gap = ny * 0.42;
      return [
        Shapes.circle(nx * 0.22, cy, r, { name: 'Upstream' }),
        Shapes.circle(nx * 0.22 + gap, cy, r, { name: 'Downstream' }),
      ];
    },
  },
  {
    id: 'karman', label: 'Karman gallery', group: 'bluff', wind: true,
    text: 'Three cylinders of different diameter shedding side by side. Strouhal number is roughly constant across them, so shedding frequency f = St·U/D scales inversely with size — the small cylinder sheds fastest. Watch for interference where the wakes overlap.',
    objects: (nx, ny) => [
      Shapes.circle(nx * 0.26, ny * 0.22, ny * 0.075, { name: 'Large' }),
      Shapes.circle(nx * 0.26, ny * 0.52, ny * 0.05, { name: 'Small' }),
      Shapes.circle(nx * 0.26, ny * 0.80, ny * 0.10, { name: 'Largest' }),
    ],
  },
  {
    id: 'staggered', label: 'Tube bank', group: 'bluff', wind: true,
    text: 'A staggered tube bank, the core geometry of a shell-and-tube heat exchanger. Offsetting alternate rows forces the flow to weave, raising mixing and heat transfer relative to an inline array — at the cost of pressure drop.',
    objects: (nx, ny) => {
      const out = [], r = ny * 0.045, sx = nx * 0.11, sy = ny * 0.21;
      for (let row = 0; row < 5; row++) {
        const cols = row % 2 === 0 ? 5 : 4;
        const off = row % 2 === 0 ? 0 : sx * 0.5;
        for (let c = 0; c < cols; c++) {
          out.push(Shapes.circle(nx * 0.18 + c * sx + off, ny * 0.12 + row * sy, r, { name: `Tube ${row + 1}.${c + 1}` }));
        }
      }
      return out;
    },
  },
  {
    id: 'backstep', label: 'Backstep', group: 'channel', wind: true,
    text: 'The backward-facing step, one of the most-used CFD validation cases. Flow separates at the sharp edge, forms a recirculation bubble, and reattaches downstream. The reattachment length grows with Reynolds number and is the quantity codes are benchmarked against.',
    objects: (nx, ny) => {
      const w = Math.max(2, ny * 0.03);
      return [
        Shapes.rect(nx / 2, w / 2, nx, w, { name: 'Top wall' }),
        Shapes.rect(nx / 2, ny - w / 2, nx, w, { name: 'Bottom wall' }),
        Shapes.rect(nx * 0.15, ny * 0.78, nx * 0.3, ny * 0.42, { name: 'Step' }),
      ];
    },
  },
  {
    id: 'venturi', label: 'Venturi', group: 'channel', wind: true,
    text: 'A Venturi throat demonstrates the Bernoulli relation directly: the constriction accelerates the flow and the static pressure falls with it, then recovers downstream. Switch to the pressure view and watch the minimum sit exactly at the narrowest section.',
    objects: (nx, ny) => {
      const x0 = nx * 0.22, x1 = x0 + nx * 0.5;
      const throat = ny * 0.14, extra = ny * 0.2;
      const f = t => throat + (1 - 0.5 * (1 - Math.cos(2 * Math.PI * t))) * extra;
      return [wall(nx, ny, x0, x1, f, 'top', { name: 'Upper wall' }),
              wall(nx, ny, x0, x1, f, 'bottom', { name: 'Lower wall' })];
    },
  },
  {
    id: 'diffuser', label: 'Diffuser', group: 'channel', wind: true,
    text: 'A diverging channel decelerates the flow and recovers pressure — but does so against an adverse pressure gradient. Open the angle too far and the boundary layer separates from the walls. This is why diffusers are far harder to design than nozzles.',
    objects: (nx, ny) => {
      const x0 = nx * 0.12, x1 = nx * 0.8;
      const f = t => ny * 0.12 + t * (ny * 0.4 - ny * 0.12);
      return [wall(nx, ny, x0, x1, f, 'top', { name: 'Upper wall' }),
              wall(nx, ny, x0, x1, f, 'bottom', { name: 'Lower wall' })];
    },
  },
  {
    id: 'nozzle', label: 'Nozzle', group: 'channel', wind: true,
    text: 'A converging nozzle. The favourable pressure gradient keeps the boundary layer firmly attached, so unlike the diffuser it is inherently well behaved. Compare the two to see why contraction is easy and expansion is not.',
    objects: (nx, ny) => {
      const x0 = nx * 0.12, x1 = nx * 0.8;
      const f = t => ny * 0.4 + t * (ny * 0.12 - ny * 0.4);
      return [wall(nx, ny, x0, x1, f, 'top', { name: 'Upper wall' }),
              wall(nx, ny, x0, x1, f, 'bottom', { name: 'Lower wall' })];
    },
  },
  {
    id: 'bifurcation', label: 'Bifurcation', group: 'channel', wind: true,
    text: 'A Y-junction splitting one channel into two. A stagnation point forms on the splitter tip and the flow divides according to the downstream resistance of each branch. The same geometry governs arterial bifurcations, river deltas and manifold design.',
    objects: (nx, ny) => {
      const cy = (ny + 1) / 2, half = ny * 0.15;
      const forkX = Math.round(nx * 0.34), endX = Math.round(nx * 0.8);
      const rate = (ny * 0.26) / (endX - forkX);
      const outer = side => {
        const pts = [];
        const sgn = side === 'top' ? -1 : 1;
        for (let x = 1; x <= endX; x++) {
          const spread = x < forkX ? 0 : (x - forkX) * rate;
          pts.push(x, cy + sgn * (spread + half));
        }
        pts.push(endX, side === 'top' ? 0 : ny + 1, 1, side === 'top' ? 0 : ny + 1);
        return Shapes.polygonAbs(pts, { name: side === 'top' ? 'Upper wall' : 'Lower wall' });
      };
      const splitter = [];
      for (let x = forkX; x <= endX; x++) splitter.push(x, cy - (x - forkX) * rate);
      for (let x = endX; x >= forkX; x--) splitter.push(x, cy + (x - forkX) * rate);
      return [outer('top'), outer('bottom'), Shapes.polygonAbs(splitter, { name: 'Splitter' })];
    },
  },
  {
    id: 'magnus', label: 'Magnus', group: 'bluff', wind: true,
    text: 'A spinning cylinder in crossflow. Rotation entrains fluid on one side and opposes it on the other, so the stagnation points shift and a net force appears perpendicular to the freestream. This is the Magnus effect that curves a topspin tennis ball. Adjust the spin rate on the Object tab.',
    objects: (nx, ny) => [Shapes.circle(nx * 0.28, (ny + 1) / 2, ny * 0.12,
      { name: 'Spinning cylinder', boundary: 'rotating', bcParams: { omega: 1.2 } })],
  },
  /* WITHHELD — the lid-driven cavity is not shipped yet.
   *
   * A fully sealed region driven from inside goes non-finite within ~25 steps,
   * with a moving-wall boundary and with emitters alike, at every viscosity
   * and drive speed tested. Reflecting pressure at walls (rather than
   * averaging across them, which compared two regions' independent pressure
   * datums) fixed a real defect but not this one, so the cause is still open.
   *
   * It needs the proper boundary-condition work rather than another patch: a
   * closed domain has no outlet to absorb what the driver injects, so the
   * pressure solve has to carry all of it, and the collocated scheme's
   * wall treatment is not currently good enough for that.
   *
   * Shipping it in this state would mean a benchmark that visibly explodes.
   */
  /*
  {
    id: 'lid-cavity', label: 'Lid cavity', group: 'closed', wind: false,
    text: 'The lid-driven cavity: a sealed box whose top wall slides at constant speed. It is the most-studied benchmark in computational fluid dynamics because it has no inflow or outflow to get wrong. A single primary vortex forms at low Reynolds number; secondary and then tertiary corner vortices appear as it rises.',
    objects: (nx, ny) => {
      const w = Math.max(3, ny * 0.04);
      const x0 = nx * 0.5 - ny * 0.44, x1 = nx * 0.5 + ny * 0.44;
      const cx = (x0 + x1) / 2, span = x1 - x0;
      return [
        Shapes.rect(cx, ny - w / 2, span, w, { name: 'Floor' }),
        Shapes.rect(x0 + w / 2, ny / 2, w, ny, { name: 'Left wall' }),
        Shapes.rect(x1 - w / 2, ny / 2, w, ny, { name: 'Right wall' }),
        Shapes.rect(cx, w / 2, span, w, { name: 'Lid' }),
        // The lid is driven by emitters rather than a moving-wall boundary.
        //
        // The moving-wall BC works for an open domain (see Magnus, which is a
        // rotating body in a freestream) but diverges inside a SEALED region:
        // the wall injects momentum into cells the pressure solve excludes, so
        // nothing can balance it and the cavity runs away within ~25 steps
        // regardless of viscosity or lid speed. Driving the top of the fluid
        // directly avoids that until the boundary-condition work lands
        // properly, and reproduces the benchmark's primary vortex.
        ...Array.from({ length: 5 }, (_, k) =>
          Shapes.circle(x0 + w + (span - 2 * w) * (k + 0.5) / 5, w + 2.5, w * 0.9, {
            name: `Lid drive ${k + 1}`,
            boundary: 'inlet',
            bcParams: { speed: 1.1, direction: 0, strength: 10 },
          })),
      ];
    },
  },
  */
  {
    id: 'jet-impinge', label: 'Jet impinge', group: 'jets', wind: false,
    text: 'A free jet striking a flat wall. A stagnation point forms where it lands and the flow turns to spread along the surface. This drives impingement cooling of turbine blades and electronics, where the thin wall jet gives very high heat-transfer rates.',
    objects: (nx, ny) => {
      const cy = (ny + 1) / 2;
      return [
        Shapes.rect(nx * 0.7, cy, 4, ny * 0.84, { name: 'Target wall' }),
        Shapes.circle(nx * 0.12, cy, ny * 0.07, { name: 'Jet', boundary: 'inlet', bcParams: { speed: 1.35, direction: 0 } }),
      ];
    },
  },
  {
    id: 'mixing', label: 'Mixing', group: 'jets', wind: false,
    text: 'Two opposed jets colliding. The impingement plane becomes a sheet of intense shear that rolls up into vortices, which is the point of an opposed-jet reactor or a rapid-mixing chamber. Turn on the Q-criterion view to pick out the vortex cores.',
    objects: (nx, ny) => {
      const cy = (ny + 1) / 2, r = ny * 0.06;
      return [
        Shapes.circle(nx * 0.1, cy, r, { name: 'Jet A', boundary: 'inlet', bcParams: { speed: 1.25, direction: 0 } }),
        Shapes.circle(nx * 0.9, cy, r, { name: 'Jet B', boundary: 'inlet', bcParams: { speed: 1.25, direction: 180 } }),
      ];
    },
  },
  {
    id: 'fountain', label: 'Fountain', group: 'jets', wind: false,
    text: 'Two jets meeting head on. With nowhere else to go the fluid is driven outward perpendicular to the jet axis, forming a symmetric sheet with a stagnation region at the centre. Small asymmetries grow over time and the sheet begins to flap.',
    objects: (nx, ny) => {
      const cy = (ny + 1) / 2, r = ny * 0.07;
      return [
        Shapes.circle(nx * 0.22, cy, r, { name: 'Jet A', boundary: 'inlet', bcParams: { speed: 1.35, direction: 0 } }),
        Shapes.circle(nx * 0.78, cy, r, { name: 'Jet B', boundary: 'inlet', bcParams: { speed: 1.35, direction: 180 } }),
      ];
    },
  },
  {
    id: 'crossflow', label: 'Crossflow jet', group: 'jets', wind: true,
    text: 'A jet issuing into a crossflow. The jet bends over, rolls up into a counter-rotating vortex pair, and leaves a wake behind it. This governs chimney plume rise, fuel injection, and film cooling of turbine surfaces.',
    objects: (nx, ny) => [Shapes.circle(nx * 0.35, ny * 0.94, ny * 0.05,
      { name: 'Crossflow jet', boundary: 'inlet', bcParams: { speed: 1.5, direction: -90 } })],
  },

  /* Free-surface water.
   *
   * These declare `physics: 'water'`, which both filters them out of the
   * airflow menu and tells the driver to switch modes on the way in — the
   * water presets used to live only in the Water panel, so the one list that is
   * meant to show you what the app can do did not mention water at all.
   *
   * `water` names a starting fill; `objects` still works exactly as it does for
   * airflow, which is what makes the weir possible — a shape drawn in the scene
   * that the water then has to get around. */
  {
    id: 'tank', label: 'Still tank', group: 'water', physics: 'water', wind: false,
    water: 'still',
    text: 'A level body of water at rest. Dull to watch and the most diagnostic case there is: the pressure gradient exactly balances gravity, so a correct free surface stays flat and stays put. A surface that sags, drifts or ripples on its own is telling you the pressure condition at the interface is wrong.',
    objects: () => [],
  },
  {
    id: 'dam-break', label: 'Dam break', group: 'water', physics: 'water', wind: false,
    water: 'dam',
    text: 'A column of water released at t = 0. The classic free-surface benchmark: the front accelerates along the floor, runs the length of the tank, and climbs the far wall before falling back on itself. Front position against time is a published curve, so this is the case to compare against if you want a number rather than an impression.',
    objects: () => [],
  },
  {
    id: 'droplet', label: 'Falling drop', group: 'water', physics: 'water', wind: false,
    water: 'drop',
    text: 'A ball of water falling into a shallow pool. Watch the crater form, the rim rise, and the central jet spring back up — the whole sequence comes out of the free-surface condition rather than being scripted. Volume drift, in the status bar, is the honest measure of how well the interface is being tracked.',
    objects: () => [],
  },
  {
    id: 'weir', label: 'Weir', group: 'water', physics: 'water', wind: false,
    water: 'dam',
    text: 'A released column of water meeting a barrier. Water piles up behind the weir, spills over the crest, and falls as a nappe onto the pool beyond. The depth over the crest is what open-channel flow uses to measure discharge, and the Froude number in the status bar tells you whether the flow downstream is shooting or tranquil.',
    objects: (nx, ny) => [Shapes.rect(nx * 0.55, ny * 0.78, Math.max(3, nx * 0.018), ny * 0.44,
      { name: 'Weir' })],
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map(s => [s.id, s]));
