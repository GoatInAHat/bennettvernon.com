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
  compute pass (LocalQuery-style) that buckets in-disc particles into
  caller-defined cells, with per-cell counts, bounded candidate-index
  collection, and an outside reservoir. The readback is asynchronous and
  double-checked against disposal; callers get the latest completed
  result without ever stalling the pipeline. CPU runtime mirrors it
  synchronously.
