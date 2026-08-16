# @cazala/party (vendored fork)

Source of the [`@cazala/party`](https://github.com/cazala/party) engine
(`packages/core/src` at commit `5966de5`, identical to the published `1.0.1`),
vendored so this site can extend the engine where the public module API ends.
MIT licensed — see [LICENSE](LICENSE). Imports keep the upstream package name
via a `@cazala/party` alias in `vite.config.ts` / `tsconfig.app.json`.

## Local modifications

Every divergence from upstream is listed here.

- `modules/render/trails.ts` — the decay pass fades with a guaranteed
  minimum decrement of one 8-bit LSB per frame. The upstream exponential
  fade has a rounding fixed point in the rgba8unorm scene texture
  (`round(V * (1 - d)) == V` whenever `V < 0.5 / d`), leaving a permanent
  film up to ~10 LSB from the background at the default decay. The CPU
  path snaps one rotating strip of the canvas per frame for the same
  reason (Canvas2D alpha compositing has the identical fixed point).
- `runtimes/webgpu/module-registry.ts` + `gpu-resources.ts` — array
  writes only re-upload arrays whose content changed or whose offset in
  the module's combined buffer moved (plus everything on buffer growth).
  Upstream re-uploaded every array input of the module on any array
  write, which made small per-frame array updates re-send multi-MB
  sibling arrays. Added `getCombinedArrayStorageCapacity()`.
- `runtimes/webgpu/cell-census.ts` (new) + `interfaces.ts`,
  `engine.ts`, both runtime engines — `updateCellCensus()`: a persistent
  compute pass that buckets in-disc particles into caller-defined cells,
  with per-cell counts, bounded candidate-index collection, and an
  outside reservoir. The readback is asynchronous and double-checked
  against disposal; callers get the latest completed result without ever
  stalling the pipeline. CPU runtime mirrors it synchronously.
- `EngineOptions.onFrame` — host per-frame hook called by both runtimes
  before the simulation step, so host writes (uniform lerps, particle
  edits) land in the same frame instead of racing a second rAF loop.
- `module.ts` — debug-visualization contract (`VizPrimitive`,
  `VizGroup`, optional `Module.viz()`): modules describe their own live
  spatial influence so a generic viewer can render body geometry, range
  limits, and falloff gradients for any physics without viewer changes.
  Groups can declare `blend: 'max'` when their primitives combine by
  strongest-wins rather than summing (viewers render the exact max-field).
- `gpu-resources.ts` — the initialize() failure path destroys a
  partially-created GPUDevice instead of leaking it.
- `modules/forces/fluids.ts`, `collisions.ts`, `sensors.ts` — each gains a
  `strength` master-gate uniform (default 1) with an exact no-op at 0, so
  hosts can fade whole modules in and out continuously. Fluids needs it
  because the PIC/FLIP transfer rewrites velocity even at zero pressure
  (the final write blends `mix(velIn, solved, strength)`; SPH scales its
  force). Collisions is a positional solver with no other magnitude knob
  (corrections and impulses scale, `correct` is gated). Sensors SETS
  velocity on activation, so `sensorStrength: 0` would freeze particles
  rather than disable steering (the write blends by `strength`).
- `interfaces.ts`, both runtime engines, `particle-store.ts` —
  `setParticleRange(start, list)`: overwrite a contiguous run of particles
  with a single GPU buffer upload (per-index `setParticle` costs one
  `writeBuffer` each; the host respawns hundreds of revealed particles per
  frame while a rising particle budget animates).
- Deleted upstream code this site never uses: `Joints`, `Grab`, `Lines`,
  `Interaction` modules, `Spawner`, `LocalQuery`/`getParticlesInRadius`
  (the cell census replaced the site's only bounded-query use; the query
  API's three serial full-queue-drain readbacks made it a per-call
  pipeline stall anyway; the site's unified pointer-field system replaced
  Interaction with signed trail nodes), and the engine-owned oscillator
  system (`oscillators.ts` and the IEngine/AbstractEngine/facade API).
  The host now evaluates preset oscillators itself inside its per-frame
  hook, where they can blend with mode transitions without value snaps.
