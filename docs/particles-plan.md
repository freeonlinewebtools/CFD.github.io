# Particle visualisation — what ParaView does, and what to take from it

Research notes and a staged plan. Stage 1 is **built**; the rest is scoped, not
written.

## What ParaView actually does with OpenFOAM

ParaView reads an OpenFOAM case through a `.foam` stub and exposes volume
fields, boundary patches, and — the relevant part — **Lagrangian clouds**.
OpenFOAM's kinematic clouds carry per-particle arrays: position, `U`, `d`
(diameter), `T`, `rho`, and `age`. The visualisation idiom is then:

1. **Colour by an array, never by identity.** A particle's colour is a scalar
   you pick from a menu — `mag(U)`, temperature, diameter, age. Kitware's own
   spray write-up colours particles by temperature across a solidification
   range, and uses a Calculator filter (`mag(U)`) when it wants speed. Nothing
   is coloured by particle index, because that encodes nothing.
2. **Scale glyphs by an array.** Glyph filter with "Scale by" set to diameter or
   speed, so size carries a second variable.
3. **A scalar bar for every mapping.** The legend states which array and what
   range, so a colour is readable as a number.
4. **Perceptually ordered colour maps.** ParaView's default is Cool-to-Warm
   diverging, deliberately *not* rainbow — the rainbow map invents banding that
   reads as structure that is not in the data. Moreland (who wrote ParaView's
   default) is the standard reference; viridis is the usual perceptually
   uniform sequential choice.
5. **Diverging maps centred on zero** for signed quantities, so the neutral
   midpoint means exactly zero.
6. **Stream Tracer + Tube** for steady-state lines, **Particle Tracer** for
   time-dependent paths, and **Temporal Particles To Pathlines** for trails.

## Stage 1 — colour carries data  *(done)*

Tracers were tinted `k % palette.length`: five decorative hues meaning nothing,
and collectively a rainbow. Replaced with a chosen scalar:

| mode | map | notes |
|---|---|---|
| Speed | `SPEED` | sequential, monotone lightness |
| Vorticity | `VORTICITY` | signed, centred on 0.5 |
| Pressure | `DIVERGING` | signed — this is Cool-to-Warm |
| Residence time | `SPEED` | age since spawn, OpenFOAM's `age` |
| Uniform | — | one colour; clearest over a mapped field |

Two things worth knowing before extending this:

- **A tracer coloured by the field's own scalar is invisible.** Same value, same
  map, so each particle is painted the exact colour it sits on. Every trail is
  therefore drawn over a dark casing, in one pass across all particles (per-bin
  casing would darken already-coloured trails wherever they cross). The default
  mode is vorticity precisely because the field defaults to speed — the second
  channel should show what the first does not.
- **Colours are quantised into 24 bins** so trails still batch into one path per
  colour. Per-particle strokes would be ~1400 draw calls a frame.

## Stage 2 — a legend for the tracers

Colour without a scale is decoration again. The colour bar already exists
(`overlays.colourBar`); it needs to show a *second*, smaller bar when the
tracers are mapped to a different scalar than the field, labelled with the array
name and its range. Cheap: the LUT and the normalisation are both already known
at that point in `render()`.

## Stage 3 — size and opacity as a second channel

ParaView's "Scale by array". Here the natural pairs are:

- head radius ∝ speed, so fast fluid reads as heavier marks;
- trail length ∝ speed (already implicit — a fast particle lays a longer trail
  per frame — but not *controlled*);
- opacity ∝ age, so newly seeded tracers fade in rather than popping.

`trailLen` is currently a fixed ring size for every particle. Per-particle
lengths mean either a variable-stride buffer or drawing fewer samples from a
fixed one; the second is far simpler and enough.

## Stage 4 — seeding you can place

ParaView's Stream Tracer takes a seed *source*: a line, a point cloud, a disc.
Ours seeds uniformly, or in a strip at the inlet. A placeable seed line — drag
in the viewport, tracers emit from it — is how you actually interrogate a
specific shear layer or wake. This is the biggest usability gap versus a real
post-processor, and it composes with the existing draft/operator machinery.

## Stage 5 — pathlines and streaklines

Distinct objects that ParaView keeps separate and we currently conflate:

- **streamlines** — tangent to the instantaneous field (the existing
  `overlays.streamlines`);
- **pathlines** — where one particle actually went over time (our trails);
- **streaklines** — the locus of all particles released from one point, which is
  what a physical dye or smoke wire produces.

In steady flow all three coincide; in a shedding wake they differ visibly, and
showing that is genuinely instructive. Streaklines need a per-seed release
history rather than a per-particle trail.

## Deliberately not doing

- **Surface LIC.** Beautiful, and a large shader project for a 2D app where the
  vector overlay already covers the same question.
- **Rainbow as an option.** It would be used, and it misleads. The existing maps
  cover every case with better discriminability.

## Sources

- [Spray Simulation Post-Processing with ParaView — Kitware](https://www.kitware.com/spray-simulation-post-processing-with-paraview/)
- [Color Map Advice for Scientific Visualization — Kenneth Moreland](https://www.kennethmoreland.com/color-advice/)
- [A New Default Colormap for ParaView — IEEE CG&A](https://www.computer.org/csdl/magazine/cg/2024/04/10640196/1ZySI5cfpNm)
- [OpenFOAM User Guide — paraFoam](https://doc.cfd.direct/openfoam/user-guide-v10/paraview)
- [ParaView tips — BARAM](https://baramcfd.org/en/resource-en/tips-en/paraview-tips-en/)
