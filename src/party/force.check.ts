/**
 * Anti-drift check for the debug view.
 *
 * The glow paints `forceAt` over the primitives `Effectors.viz()` emits; the
 * simulation runs the inlined copies in `cpu()` and the WGSL. Nothing in the
 * type system ties those together, so this asserts the first reproduces the
 * second: change one law and forget the other, and this fails instead of the
 * debug view quietly lying.
 *
 * Run: npx tsx src/party/force.check.ts
 */
import { Effectors, forceAt, peakForce, type DistanceField } from './effectors'

let checks = 0
const eq = (a: number, b: number, what: string, tol = 1e-9) => {
  checks++
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  if (Math.abs(a - b) / scale > tol) {
    throw new Error(`${what}: ${a} !== ${b}`)
  }
}

/** Minimal stand-in for the engine's particle, enough for cpu().apply. */
function makeParticle(x: number, y: number) {
  return {
    position: { x, y },
    velocity: { x: 0, y: 0 },
    acceleration: {
      x: 0,
      y: 0,
      add(v: { x: number; y: number }) {
        this.x += v.x
        this.y += v.y
        return this
      },
    },
    size: 1,
    mass: 1,
  }
}

/** Build a signed-distance grid for a disc, so gradients are well defined. */
function discField(strength: number, padding: number): DistanceField {
  const cols = 48
  const rows = 48
  const cell = 10
  const cx = 240
  const cy = 240
  const radius = 90
  const distances = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = c * cell + cell / 2
      const wy = r * cell + cell / 2
      distances[r * cols + c] = Math.hypot(wx - cx, wy - cy) - radius
    }
  }
  return { originX: 0, originY: 0, cell, cols, rows, strength, padding, distances }
}

function run() {
  const fx = new Effectors()
  fx.setSoften(30)
  fx.set([
    { shape: 'pill', x: 300, y: 120, halfW: 90, halfH: 0, strength: 15_000 },
    { shape: 'rect', x: 160, y: 320, halfW: 70, halfH: 40, strength: -40_000 },
    { shape: 'rect', x: 420, y: 400, halfW: 30, halfH: 30, strength: 8_000 },
  ])
  // A stroke of spans plus one degenerate (stationary-cursor) span.
  fx.setDynamic([
    { x1: 250, y1: 250, x2: 290, y2: 265, s1: 6_000, s2: 5_200 },
    { x1: 290, y1: 265, x2: 330, y2: 280, s1: 5_200, s2: -9_000 },
    { x1: 400, y1: 180, x2: 400, y2: 180, s1: -4_000, s2: -4_000 },
  ])
  fx.setField(discField(50_000, 44))

  const nameField = discField(10_000, 0)
  fx.setNameField(nameField)
  fx.setNameParams(10_000, 3)
  const zone = new Float32Array(nameField.cols * nameField.rows)
  for (let i = 0; i < zone.length; i++) zone[i] = (i % 7) / 6
  fx.setNameZone(zone)

  const groups = fx.viz()
  if (groups.length === 0) throw new Error('viz() emitted nothing')
  const apply = (fx.cpu() as { apply: (a: unknown) => void }).apply
  const input = fx.read() as Record<string, number[]>
  const out: [number, number] = [0, 0]

  // Deterministic sweep over the region the bodies occupy.
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 400; i++) {
    const x = rnd() * 470
    const y = rnd() * 470
    const p = makeParticle(x, y)
    apply({ particle: p, input, dt: 1 / 60 })

    // Sum forceAt the way the renderer does: per group, max-blend groups take
    // the strongest primitive's vector, the rest sum.
    let sx = 0
    let sy = 0
    for (const g of groups) {
      if (g.blend === 'max') {
        let best = 0
        let bx = 0
        let by = 0
        for (const prim of g.primitives) {
          const m = forceAt(prim, x, y, out)
          if (m > best) {
            best = m
            bx = out[0]
            by = out[1]
          }
        }
        sx += bx
        sy += by
      } else {
        for (const prim of g.primitives) {
          forceAt(prim, x, y, out)
          sx += out[0]
          sy += out[1]
        }
      }
    }
    eq(sx, p.acceleration.x, `forceAt vs cpu() ax at (${x.toFixed(1)}, ${y.toFixed(1)})`)
    eq(sy, p.acceleration.y, `forceAt vs cpu() ay at (${x.toFixed(1)}, ${y.toFixed(1)})`)
  }

  // peakForce must bound what forceAt can actually produce, or the glow
  // anchor is wrong and the strongest source would clip instead of hitting
  // exactly maxOpacity.
  for (const g of groups) {
    for (const prim of g.primitives) {
      const peak = peakForce(prim)
      let observed = 0
      for (let i = 0; i < 4000; i++) {
        const m = forceAt(prim, rnd() * 470, rnd() * 470, out)
        if (m > observed) observed = m
      }
      checks++
      if (observed > peak * (1 + 1e-9)) {
        throw new Error(`${g.key} ${prim.kind}: observed ${observed} exceeds peak ${peak}`)
      }
    }
  }

  // The trail is a curve, not a string of beads. Along a polyline of spans
  // with uniform strength every point is ON the body, so the force there is
  // the surface peak everywhere -- flat. Measuring to the sample points
  // instead would dip between them, which is the beading this replaced.
  {
    const trail = new Effectors()
    trail.setSoften(30)
    const step = 30
    const nodes = []
    for (let x = 0; x + step <= 300; x += step) {
      nodes.push({ x1: x, y1: 100, x2: x + step, y2: 100, s1: 7_000, s2: 7_000 })
    }
    trail.setDynamic(nodes)
    const prim = trail.viz()[0].primitives
    // Sampled a fixed 2 units off the curve, so the distance to the body is
    // the same at every x. (Exactly ON the curve is skipped: there the push
    // direction is a genuine tie between the two sides, so the law returns
    // nothing -- a measure-zero set no particle lands on.)
    let lo = Infinity
    let hi = 0
    for (let x = 0; x <= 300; x += 3) {
      let best = 0
      for (const p of prim) best = Math.max(best, forceAt(p, x, 102, out))
      lo = Math.min(lo, best)
      hi = Math.max(hi, best)
    }
    checks++
    if (hi / lo > 1.0001) {
      throw new Error(`trail ripples along its own curve: ${lo}..${hi}`)
    }
    // And the falloff away from the curve is the same law as any other body.
    for (const d of [2, 15, 30, 90]) {
      let got = 0
      for (const p of prim) got = Math.max(got, forceAt(p, 150, 100 + d, out))
      const want = (7_000 * 30 * 30) / (d * d + 30 * 30)
      checks++
      if (Math.abs(got - want) > 1e-9) {
        throw new Error(`trail falloff at ${d}: ${got} !== ${want}`)
      }
    }
  }

  // A signed-distance field with a flat interior plateau -- which is what a
  // discrete distance transform produces along the medial axis of any filled
  // shape -- must still push. The 2x2 bilinear stencil has an exactly zero
  // gradient there, and bailing on that leaves force-free pockets inside the
  // body that trap particles and punch holes in the glow.
  {
    const cols = 32
    const rows = 32
    const cell = 10
    const distances = new Float32Array(cols * rows)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // A real distance transform, quantized to whole cells the way a
        // rasterized one is. Neighbours land on identical values wherever the
        // true distance changes by less than a cell, which is most of the
        // field near the shape -- and there the 2x2 bilinear gradient is
        // exactly zero.
        const edge = Math.min(c, r, cols - 1 - c, rows - 1 - r)
        distances[r * cols + c] = Math.round(edge - 8) * cell
      }
    }
    const flat = new Effectors()
    flat.setSoften(30)
    flat.setField({ originX: 0, originY: 0, cell, cols, rows, strength: 1_000, padding: 0, distances })
    const prim = flat.viz()[0].primitives[0]
    // Sweep the interior: every sampled point must feel the push. A single
    // dead cell here is a particle trap in the simulation and a hole in the
    // debug glow.
    let dead = 0
    let sampled = 0
    const deadAt: string[] = []
    for (let gy = 4; gy < rows - 4; gy++) {
      for (let gx = 4; gx < cols - 4; gx++) {
        sampled++
        if (forceAt(prim, (gx + 0.5) * cell, (gy + 0.5) * cell, out) <= 0) {
          dead++
          if (deadAt.length < 6) deadAt.push(`${gx},${gy}`)
        }
      }
    }
    checks++
    if (dead > 0) {
      throw new Error(`${dead}/${sampled} cells exert no force at ${JSON.stringify(deadAt)}`)
    }
  }

  // Two bars with a gap: the medial axis down the middle is a ridge where the
  // distance falls away equally on both sides. Every symmetric stencil ties
  // there, so without a tie-break the force dies along the whole seam -- which
  // is exactly the gap between two lines of a name.
  {
    const cols = 40
    const rows = 40
    const cell = 10
    const distances = new Float32Array(cols * rows)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Bars at rows 6..12 and 27..33; distance to the nearer one.
        const dTop = r < 6 ? 6 - r : r > 12 ? r - 12 : 0
        const dBot = r < 27 ? 27 - r : r > 33 ? r - 33 : 0
        distances[r * cols + c] = Math.round(Math.min(dTop, dBot)) * cell
      }
    }
    const bars = new Effectors()
    bars.setSoften(30)
    bars.setNameField({ originX: 0, originY: 0, cell, cols, rows, strength: 0, padding: 0, distances })
    bars.setNameParams(9_000, 1)
    const prim = bars.viz()[0].primitives[0]
    let dead = 0
    const deadAt: string[] = []
    for (let gy = 3; gy < rows - 4; gy++) {
      for (let gx = 3; gx < cols - 4; gx++) {
        // Only outside the bars, where the pull is defined at all.
        if (distances[gy * cols + gx] <= 0) continue
        if (forceAt(prim, (gx + 0.5) * cell, (gy + 0.5) * cell, out) <= 0) {
          dead++
          if (deadAt.length < 6) deadAt.push(`${gx},${gy}`)
        }
      }
    }
    checks++
    if (dead > 0) {
      throw new Error(`${dead} dead cells on the ridge between two bars at ${JSON.stringify(deadAt)}`)
    }
  }

  // An empty system must not produce a NaN anchor.
  const empty = new Effectors()
  checks++
  if (empty.viz().some((g) => g.primitives.length > 0)) {
    throw new Error('empty effectors emitted primitives')
  }

  console.log(`force.check: ${checks} assertions passed`)
}

run()
