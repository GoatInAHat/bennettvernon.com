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
function discField(strength: number, padding: number, falloff: number): DistanceField {
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
  return { originX: 0, originY: 0, cell, cols, rows, strength, padding, falloff, distances }
}

function run() {
  const fx = new Effectors()
  fx.set([
    { shape: 'pill', mode: 'attract', x: 300, y: 120, range: 140, halfW: 90, halfH: 0, strength: 15_000 },
    { shape: 'rect', mode: 'repel', x: 160, y: 320, range: 60, halfW: 70, halfH: 40, strength: 40_000 },
    { shape: 'circle', mode: 'repel', x: 420, y: 400, range: 100, halfW: 0, halfH: 0, strength: 8_000 },
  ])
  fx.setDynamic([
    { x: 250, y: 250, r: 120, s: 6_000 },
    { x: 290, y: 265, r: 120, s: 6_000 },
    { x: 330, y: 280, r: 110, s: -9_000 },
  ])
  fx.setField(discField(50_000, 44, 30))

  const nameField = discField(10_000, 0, 0)
  fx.setNameField(nameField)
  fx.setNameParams(10_000, 90, 1.6, 3)
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

  // An empty system must not produce a NaN anchor.
  const empty = new Effectors()
  checks++
  if (empty.viz().some((g) => g.primitives.length > 0)) {
    throw new Error('empty effectors emitted primitives')
  }

  console.log(`force.check: ${checks} assertions passed`)
}

run()
