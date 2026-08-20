import {
  Module,
  ModuleRole,
  DataType,
  type WebGPUDescriptor,
  type CPUDescriptor,
  type VizGroup,
  type VizPrimitive,
} from '@cazala/party'

export type EffectorShape = 'rect' | 'pill'

export interface Effector {
  shape: EffectorShape
  /** World-space center. */
  x: number
  y: number
  /** Rect half extents / pill half segment length, in world units. */
  halfW: number
  halfH: number
  /** Signed peak acceleration at the body surface: positive pulls toward
   * the body, negative pushes away. The force has no outer limit -- it
   * falls off as the inverse square of distance, so there is no radius to
   * set, only how hard it pulls. */
  strength: number
}

/**
 * Signed-distance-field pushing particles out of the content text. Values
 * are world-unit distances to the (morphologically closed) text shape,
 * negative inside. The force points along the gradient toward the nearest
 * exit and scales with how deep the particle sits.
 */
export interface DistanceField {
  /** World-space origin of cell (0,0). */
  originX: number
  originY: number
  /** Cell size in world units. */
  cell: number
  cols: number
  rows: number
  strength: number
  /** Particles are kept this far outside the shape (world units): the body
   * is the glyph shape dilated by this much, so it is geometry, not
   * falloff. The push saturates anywhere inside it. */
  padding: number
  /** Row-major distances, world units, negative inside the shape. */
  distances: Float32Array
}

/**
 * One span of the cursor-trail curve: the straight piece between two
 * consecutive spline samples, with a strength at each end.
 *
 * Spans rather than points because the field is the MAX over the list, and
 * the max of a law applied to point distances is that law applied to the
 * distance to the nearest point -- a bumpy chain of beads, since the distance
 * to a set of dots is not the distance to the curve through them. Measuring
 * to the segment instead makes the same max exactly the law applied to the
 * distance to the polyline, which is the curve, so the field is a smooth
 * tube along the stroke with no seams and no beading. A stationary cursor is
 * the degenerate span whose ends coincide.
 *
 * Strength is SIGNED: positive pulls, negative pushes (drag trails). It
 * interpolates along the span, so the taper down the tail lives in the
 * strength -- all the shape the law needs.
 */
export interface TrailNode {
  x1: number
  y1: number
  x2: number
  y2: number
  s1: number
  s2: number
}

/**
 * The force law. `s` is the peak at the body surface, `r` the distance to
 * that surface, `L` the global softening length.
 *
 *   mag = s * L^2 / (r^2 + L^2)
 *
 * Far from the body this is exactly the inverse square that gravity and
 * electrostatics obey, with no cutoff and no range to set. Near it the L^2
 * keeps the force finite instead of singular, so the peak is exactly `s` at
 * the surface and half that at L. Nothing here can produce a NaN or an
 * unbounded kick, which is why the integrator needs no clamp.
 */
export const forceMag = (s: number, r: number, L: number): number =>
  (s * L * L) / (r * r + L * L)

/** Bilinear sample of a field primitive and its analytic gradient, or null
 * where the 2x2 fetch and its +/-1 gradient stencil are not both in bounds.
 * Mirrors the shaders' sampling exactly, including the cell-centre offset. */
function sampleField(
  p: Extract<VizPrimitive, { kind: 'field' }>,
  x: number,
  y: number,
): { v: number; gx: number; gy: number; tx: number; ty: number; i: number } | null {
  const fx = (x - p.originX) / p.cell
  const fy = (y - p.originY) / p.cell
  if (!(fx >= 1.5 && fy >= 1.5 && fx < p.cols - 2.5 && fy < p.rows - 2.5)) return null
  const ux = fx - 0.5
  const uy = fy - 0.5
  const tx = ux - Math.floor(ux)
  const ty = uy - Math.floor(uy)
  const i = Math.floor(uy) * p.cols + Math.floor(ux)
  const b = p.valuesStart + i
  const c = p.cols
  const v00 = p.values[b]
  const v10 = p.values[b + 1]
  const v01 = p.values[b + c]
  const v11 = p.values[b + c + 1]
  let gx = (v10 - v00) * (1 - ty) + (v11 - v01) * ty
  let gy = (v01 - v00) * (1 - tx) + (v11 - v10) * tx
  if (gx === 0 && gy === 0) {
    // The 2x2 stencil is flat. A discrete distance transform quantizes to
    // whole cells, so neighbours hold identical values across most of the
    // field near a shape. Widen by one cell to recover the slope.
    gx = p.values[b + 2] + p.values[b + c + 2] - p.values[b - 1] - p.values[b + c - 1]
    gy = p.values[b + 2 * c] + p.values[b + 2 * c + 1] - p.values[b - c] - p.values[b - c + 1]
  }
  if (gx === 0 && gy === 0) {
    // Still flat, so this is a ridge: the medial axis between two parts of
    // the shape, where the distance falls away EQUALLY on both sides and no
    // symmetric stencil can ever choose between them. Left at zero the force
    // vanishes along the entire axis -- a seam of dead cells straight down
    // the gap between two lines of text. Point at the lowest neighbour
    // instead: arbitrary between the tied sides, but stable, nonzero, and it
    // keeps the magnitude the law already decided on.
    const vl = p.values[b - 1]
    const vr = p.values[b + 2]
    const vu = p.values[b - c]
    const vd = p.values[b + 2 * c]
    const lo = Math.min(vl, vr, vu, vd)
    if (lo === vl) gx = 1
    else if (lo === vr) gx = -1
    else if (lo === vu) gy = 1
    else if (lo === vd) gy = -1
  }
  return {
    v: (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty,
    gx,
    gy,
    tx,
    ty,
    i,
  }
}

/**
 * The force primitive `p` exerts on a particle at world (x, y): the vector
 * goes into `out`, and the magnitude is returned.
 *
 * This is the single evaluation the debug renderer paints with, so the glow
 * is the physics rather than a picture of it. The shaders and `cpu()` keep
 * their own inlined copies for speed, and `force.check.ts` asserts this
 * function reproduces what `cpu()` writes — a law change that misses one of
 * them fails that check instead of silently drifting the debug view.
 */
export function forceAt(
  p: VizPrimitive,
  x: number,
  y: number,
  out: [number, number],
): number {
  out[0] = 0
  out[1] = 0
  // Dispatched into one function per shape rather than branching inline. The
  // three primitive kinds are three different object shapes, so a single body
  // reading `p.x1` here and `p.hw` there goes megamorphic and every property
  // read costs an inline-cache miss. Measured on the cursor trail: 148ns a
  // call, 60ms to raster one glow, the debug view at 7fps whenever the cursor
  // moved. Split, each callee sees one shape and the reads stay monomorphic.
  // It is the same arithmetic either way -- `force.check.ts` still asserts
  // this entry point against what `cpu()` writes.
  if (p.kind === 'segment') return segmentForce(p, x, y, out)
  if (p.kind === 'rect') return rectForce(p, x, y, out)
  return fieldForce(p, x, y, out)
}

function segmentForce(
  p: Extract<VizPrimitive, { kind: 'segment' }>,
  x: number,
  y: number,
  out: [number, number],
): number {

    // Closest point on the body segment; a point source when the ends meet.
    const vx = p.x2 - p.x1
    const vy = p.y2 - p.y1
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x1) * vx + (y - p.y1) * vy) / len2)) : 0
    const dx = p.x1 + vx * t - x
    const dy = p.y1 + vy * t - y
    const d2 = dx * dx + dy * dy
    if (d2 <= 0) return 0
    const end = p.strengthEnd ?? p.strength
    const s = p.strength + (end - p.strength) * t
    if (s === 0) return 0
    const d = Math.sqrt(d2)
    const m = forceMag(s, d, p.soften)
    out[0] = (dx / d) * m
    out[1] = (dy / d) * m
    return Math.abs(m)
  }

function rectForce(
  p: Extract<VizPrimitive, { kind: 'rect' }>,
  x: number,
  y: number,
  out: [number, number],
): number {

    const lx = x - p.x
    const ly = y - p.y
    if (Math.abs(lx) < p.hw && Math.abs(ly) < p.hh) {
      // Inside: repelling rects eject along the nearest edge at full
      // strength, attracting rects exert nothing.
      if (!p.interiorPush) return 0
      const exitX = lx < 0 ? -(p.hw + lx) : p.hw - lx
      const exitY = ly < 0 ? -(p.hh + ly) : p.hh - ly
      // Full strength inside, which is exactly forceMag(s, 0, L): the
      // interior is continuous with the exterior at the surface.
      const m = Math.abs(p.strength)
      if (Math.abs(exitY) < Math.abs(exitX)) out[1] = Math.sign(exitY) * m
      else out[0] = Math.sign(exitX) * m
      return m
    }
    const cx = Math.max(-p.hw, Math.min(p.hw, lx))
    const cy = Math.max(-p.hh, Math.min(p.hh, ly))
    const dx = cx - lx
    const dy = cy - ly
    const d2 = dx * dx + dy * dy
    if (d2 <= 0) return 0
    const d = Math.sqrt(d2)
    const m = forceMag(p.strength, d, p.soften)
    out[0] = (dx / d) * m
    out[1] = (dy / d) * m
    return Math.abs(m)
  }

function fieldForce(
  p: Extract<VizPrimitive, { kind: 'field' }>,
  x: number,
  y: number,
  out: [number, number],
): number {
  const s = sampleField(p, x, y)
  if (!s) return 0
  const gl = Math.hypot(s.gx, s.gy)
  if (gl <= 0) return 0
  const offset = p.offset ?? 0
  let m: number
  if (p.push) {
    // Saturates at the peak anywhere inside the offset surface, then falls
    // off as the inverse square outside it -- no reach, no overdrive cap.
    m = forceMag(p.strength, Math.max(s.v - offset, 0), p.soften)
  } else {
    // Pull acts only outside the surface: inside the letters there is no
    // force at all, which is what keeps pinned type from being dragged
    // through its own glyphs.
    const r = s.v - offset
    if (!(r > 0)) return 0
    m = forceMag(p.strength, r, p.soften)
    if (p.boost && p.boost.factor !== 1) {
      const bv = p.boost.values
      const zf =
        (bv[s.i] * (1 - s.tx) + bv[s.i + 1] * s.tx) * (1 - s.ty) +
        (bv[s.i + p.cols] * (1 - s.tx) + bv[s.i + p.cols + 1] * s.tx) * s.ty
      m *= 1 + (p.boost.factor - 1) * zf
    }
  }
  // Push runs down the gradient (away from the shape), pull runs up it.
  const sgn = p.push ? 1 : -1
  out[0] = (sgn * s.gx * m) / gl
  out[1] = (sgn * s.gy * m) / gl
  return Math.abs(m)
}

/**
 * Signed distance from world (x, y) to the surface of the body that emits
 * this primitive's force -- negative inside it. This is the geometry the
 * force is measured from, so a viewer can outline the real body rather than
 * an approximation of it: the segment a pill pulls toward, the rect's edge,
 * the text shape dilated by its standoff, the letter surface of the name.
 *
 * Returns NaN where a field has no sample (outside its grid).
 */
export function bodyDistance(p: VizPrimitive, x: number, y: number): number {
  if (p.kind === 'segment') {
    const vx = p.x2 - p.x1
    const vy = p.y2 - p.y1
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x1) * vx + (y - p.y1) * vy) / len2)) : 0
    return Math.hypot(x - (p.x1 + vx * t), y - (p.y1 + vy * t))
  }
  if (p.kind === 'rect') {
    // Standard box distance: positive outside, negative inside.
    const dx = Math.abs(x - p.x) - p.hw
    const dy = Math.abs(y - p.y) - p.hh
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
    return outside + Math.min(Math.max(dx, dy), 0)
  }
  const s = sampleField(p, x, y)
  if (!s) return NaN
  return s.v - (p.offset ?? 0)
}

/** Peak magnitude this primitive can reach anywhere, used to anchor the
 * debug view's opacity scale. Every law here peaks at the body surface. */
export function peakForce(p: VizPrimitive): number {
  if (p.kind === 'field') {
    const boost = p.boost && p.boost.factor > 1 ? p.boost.factor : 1
    return Math.abs(p.strength) * (p.push ? 1 : boost)
  }
  if (p.kind === 'segment') {
    return Math.max(Math.abs(p.strength), Math.abs(p.strengthEnd ?? p.strength))
  }
  return Math.abs(p.strength)
}

const SHAPE_CODE: Record<EffectorShape, number> = { rect: 0, pill: 1 }
const STRIDE = 6
const NODE_STRIDE = 6
const FIELD_HEADER = 7

type EffectorsInputs = {
  /** One global softening length in world units (see SOFTEN_PX in the host):
   * the distance at which every body's pull is half its surface peak. It is
   * the only length the force law needs, and it is shared so that one
   * strength means the same reach on every body. */
  soften: number
  data: number[]
  dynamic: number[]
  field: number[]
  nameField: number[]
  /** Name-pull tuning [strength, range, sharpness, concave], separate from
   * the multi-MB nameField array so slider drags re-upload four floats, not
   * the whole distance grid. */
  nameParams: number[]
  /** Concave-pocket mask on the nameField grid (no header, row-major 0..1):
   * 1 inside a letter's convex hull but outside the letter itself. The name
   * pull is multiplied by `concave` there (bilinearly sampled, so the
   * boost fades smoothly at pocket edges). */
  nameZone: number[]
}

function packEffectors(effectors: Effector[]): number[] {
  const data: number[] = []
  for (const e of effectors) {
    data.push(SHAPE_CODE[e.shape], e.x, e.y, e.halfW, e.halfH, e.strength)
  }
  return data
}

/**
 * Multi-instance force field. Circles, rects, and pills use the same linear
 * falloff as the built-in Interaction module; the optional distance field
 * excludes particles from the content text.
 */
export class Effectors extends Module<'effectors', EffectorsInputs> {
  readonly name = 'effectors' as const
  readonly role = ModuleRole.Force
  readonly inputs = {
    soften: DataType.NUMBER,
    data: DataType.ARRAY,
    dynamic: DataType.ARRAY,
    field: DataType.ARRAY,
    nameField: DataType.ARRAY,
    nameParams: DataType.ARRAY,
    nameZone: DataType.ARRAY,
  } as const

  constructor() {
    super()
    this.write({ soften: 1, data: [], dynamic: [], field: [], nameField: [], nameParams: [], nameZone: [] })
  }

  /** The global softening length in world units. Rewritten on zoom change. */
  setSoften(soften: number): void {
    this.write({ soften: Math.max(1e-6, soften) })
  }

  /** Static effectors: rewritten only on layout/hover changes. */
  set(effectors: Effector[]): void {
    this.write({ data: packEffectors(effectors) })
  }

  /** Cursor-trail curve samples: tiny, rewritten every frame. */
  setDynamic(nodes: TrailNode[]): void {
    const data: number[] = []
    for (const n of nodes) {
      data.push(n.x1, n.y1, n.x2, n.y2, n.s1, n.s2)
    }
    this.write({ dynamic: data })
  }

  private packField(field: DistanceField): number[] {
    const arr = new Array<number>(FIELD_HEADER + field.distances.length)
    arr[0] = field.originX
    arr[1] = field.originY
    arr[2] = field.cell
    arr[3] = field.cols
    arr[4] = field.rows
    arr[5] = field.strength
    arr[6] = field.padding
    for (let i = 0; i < field.distances.length; i++) arr[FIELD_HEADER + i] = field.distances[i]
    return arr
  }

  setField(field: DistanceField | null): void {
    this.write({ field: field ? this.packField(field) : [] })
  }

  /** The name's signed distance field: particles outside the letters are
   * pulled toward the glyph surface. The physics IS the font's vector
   * shape; strength/range/shape live in `nameParams` so the big array
   * stays byte-stable across slider drags. */
  setNameField(field: DistanceField | null): void {
    this.write({ nameField: field ? this.packField(field) : [] })
  }

  /** Name-pull tuning:
   * strength — peak pull at the letter surface, falling off as the inverse
   *   square outward with no reach to configure;
   * concave — pull multiplier inside the nameZone pockets (1 = none).
   * Inside the letters no force applies. */
  setNameParams(strength: number, concave: number): void {
    this.write({ nameParams: [strength, concave] })
  }

  /** Concave-pocket mask, same grid as the name field (see inputs doc). */
  setNameZone(zone: ArrayLike<number>): void {
    this.write({ nameZone: Array.from(zone) })
  }

  /** The per-letter convex hulls the pocket mask was filled from, in world
   * units. Debug geometry only: kept off `write()` so it is never uploaded
   * to the GPU, since the shaders read the rasterized mask, not the
   * polygons. */
  private nameHulls: number[][][] = []
  setNameHulls(hulls: number[][][]): void {
    this.nameHulls = hulls
  }

  /** Debug description decoded from the same packed arrays the shaders
   * consume, so the debug view always matches the live physics. */
  viz(): VizGroup[] {
    if (!this.isEnabled()) return []
    const state = this.read() as {
      soften?: number
      data?: number[]
      dynamic?: number[]
      field?: number[]
      nameField?: number[]
      nameParams?: number[]
      nameZone?: number[]
    }
    const groups = new Map<string, VizGroup>()
    const add = (key: string, dynamic: boolean, prim: VizPrimitive) => {
      let g = groups.get(key)
      if (!g) {
        g = { key, dynamic, primitives: [] }
        groups.set(key, g)
      }
      g.primitives.push(prim)
    }

    const data = state.data ?? []
    const soften = (state.soften as number | undefined) ?? 1
    for (let base = 0; base + STRIDE <= data.length; base += STRIDE) {
      const [kind, x, y, hw, hh, strength] = data.slice(base, base + STRIDE)
      if (strength === 0) continue
      const dir = strength < 0 ? 'repel' : 'attract'
      if (kind > 0.5) {
        add(`effectors:${dir}-pill`, false, {
          kind: 'segment',
          x1: x - hw,
          y1: y,
          x2: x + hw,
          y2: y,
          strength,
          soften,
        })
      } else {
        add(`effectors:${dir}-rect`, false, {
          kind: 'rect',
          x,
          y,
          hw,
          hh,
          strength,
          soften,
          interiorPush: strength < 0,
        })
      }
    }

    const dyn = state.dynamic ?? []
    for (let base = 0; base + NODE_STRIDE <= dyn.length; base += NODE_STRIDE) {
      const [x1, y1, x2, y2, s1, s2] = dyn.slice(base, base + NODE_STRIDE)
      if (s1 === 0 && s2 === 0) continue
      // One group, not one per sign: the physics takes a single strongest
      // span across the whole curve, so a pull span and a push span never
      // both act. Splitting them by color would make the viewer sum two
      // winners and show a force that is not there.
      add('effectors:trail', true, {
        kind: 'segment',
        x1,
        y1,
        x2,
        y2,
        strength: s1,
        strengthEnd: s2,
        soften,
      })
    }
    const trail = groups.get('effectors:trail')
    if (trail) trail.blend = 'max'

    const field = state.field
    if (field && field.length > FIELD_HEADER) {
      // Acts inside the padding surface, ramping over `falloff` to the cap.
      add('effectors:exclusion', false, {
        kind: 'field',
        originX: field[0],
        originY: field[1],
        cell: field[2],
        cols: field[3],
        rows: field[4],
        values: field,
        valuesStart: FIELD_HEADER,
        strength: field[5],
        soften,
        offset: field[6],
        push: true,
      })
    }

    const nameField = state.nameField
    const nameParams = state.nameParams
    if (nameField && nameField.length > FIELD_HEADER && nameParams && nameParams.length >= 1) {
      const cols = nameField[3]
      const rows = nameField[4]
      const zone = state.nameZone
      const concave = nameParams[1] ?? 1
      // The pocket boost is part of the name's force, not a body of its own,
      // so it rides along as a multiplier instead of a second primitive.
      // Emitted whenever the mask exists, even at factor 1 where the boost is
      // a no-op: the hulls are the geometry of the setting and are worth
      // seeing before turning it up.
      const boost =
        zone && zone.length >= cols * rows
          ? { values: zone, factor: concave, hulls: this.nameHulls }
          : undefined
      add('effectors:name', false, {
        kind: 'field',
        originX: nameField[0],
        originY: nameField[1],
        cell: nameField[2],
        cols,
        rows,
        values: nameField,
        valuesStart: FIELD_HEADER,
        strength: nameParams[0],
        soften,
        offset: 0,
        boost,
      })
    }
    return [...groups.values()]
  }

  webgpu(): WebGPUDescriptor<EffectorsInputs> {
    type WgslArgs = Parameters<
      Extract<WebGPUDescriptor<EffectorsInputs>, { apply?: unknown }>['apply'] & object
    >[0]
    // The static array carries rect/pill bodies; the dynamic array carries
    // the trail samples and has its own layout. Both obey one law, emitted
    // once as force_mag so a change here cannot miss a call site. The name
    // is deliberately unabbreviated: the field blocks below declare local
    // `fx`/`fy` grid coordinates, and a helper called `fx` is shadowed by
    // them into a WGSL compile error that no JS-side check can catch.
    const lawFn = `
fn force_mag(s: f32, r: f32, L: f32) -> f32 {
  return s * L * L / (r * r + L * L);
}

// Bilinear gradient of a distance field cell, widened by one cell wherever
// the 2x2 stencil is flat. A rasterized distance transform quantizes to whole
// cells, so neighbours hold identical values across most of the field near a
// shape; without this the gradient is exactly zero there and the body exerts
// no force at all in scattered cells -- particle traps in the simulation, and
// holes in the debug glow that read as little rectangles.
fn field_grad(v00: f32, v10: f32, v01: f32, v11: f32, tx: f32, ty: f32,
              wx0: f32, wx1: f32, wy0: f32, wy1: f32,
              nl: f32, nr: f32, nu: f32, nd: f32) -> vec2<f32> {
  var g = vec2<f32>(mix(v10 - v00, v11 - v01, ty), mix(v01 - v00, v11 - v10, tx));
  if (g.x == 0.0 && g.y == 0.0) {
    g = vec2<f32>(wx1 - wx0, wy1 - wy0);
  }
  if (g.x == 0.0 && g.y == 0.0) {
    // A ridge: distance falls away equally on both sides, so no symmetric
    // stencil can choose. Point at the lowest neighbour -- arbitrary between
    // the tied sides, but stable and nonzero, which keeps the force instead
    // of leaving a dead seam along the whole medial axis.
    let lo = min(min(nl, nr), min(nu, nd));
    if (lo == nl) { g = vec2<f32>(1.0, 0.0); }
    else if (lo == nr) { g = vec2<f32>(-1.0, 0.0); }
    else if (lo == nu) { g = vec2<f32>(0.0, 1.0); }
    else if (lo == nd) { g = vec2<f32>(0.0, -1.0); }
  }
  return g;
}`
    const shapeLoop = (
      arr: 'data',
      { particleVar, getUniform, getLength }: WgslArgs,
    ) => `
  let L = ${getUniform('soften')};
  let n_${arr} = ${getLength(arr)} / ${STRIDE}u;
  for (var i: u32 = 0u; i < n_${arr}; i = i + 1u) {
    let base = i * ${STRIDE}u;
    let kind = ${getUniform(arr, 'base + 0u')};
    let ex = ${getUniform(arr, 'base + 1u')};
    let ey = ${getUniform(arr, 'base + 2u')};
    let hw = ${getUniform(arr, 'base + 3u')};
    let hh = ${getUniform(arr, 'base + 4u')};
    let strength = ${getUniform(arr, 'base + 5u')};
    if (strength == 0.0) { continue; }
    let px = ${particleVar}.position.x;
    let py = ${particleVar}.position.y;
    if (kind > 0.5) {
      // Pill: distance to a horizontal segment.
      let sx = clamp(px - ex, -hw, hw);
      let dx = (ex + sx) - px;
      let dy = ey - py;
      let dist2 = dx * dx + dy * dy;
      if (dist2 > 0.0) {
        let dist = sqrt(dist2);
        ${particleVar}.acceleration += vec2<f32>(dx, dy) / dist * force_mag(strength, dist, L);
      }
    } else {
      let lx = px - ex;
      let ly = py - ey;
      if (abs(lx) < hw && abs(ly) < hh) {
        // Inside a repelling rect: eject along the nearest edge at the
        // surface peak, which is force_mag(strength, 0, L) -- continuous
        // with the exterior. Attracting rects exert nothing here.
        if (strength < 0.0) {
          let exitX = select(hw - lx, -(hw + lx), lx < 0.0);
          let exitY = select(hh - ly, -(hh + ly), ly < 0.0);
          var dir = vec2<f32>(sign(exitX), 0.0);
          if (abs(exitY) < abs(exitX)) { dir = vec2<f32>(0.0, sign(exitY)); }
          ${particleVar}.acceleration += dir * abs(strength);
        }
      } else {
        let cx = clamp(lx, -hw, hw);
        let cy = clamp(ly, -hh, hh);
        let dx = cx - lx;
        let dy = cy - ly;
        let dist2 = dx * dx + dy * dy;
        if (dist2 > 0.0) {
          let dist = sqrt(dist2);
          ${particleVar}.acceleration += vec2<f32>(dx, dy) / dist * force_mag(strength, dist, L);
        }
      }
    }
  }`
    // The trail field is the strongest sample, not the sum: the samples are
    // spline resampling artifacts, so summing would scale force with the
    // sample count. With one shared L, the max over samples is exactly the
    // same law applied to the distance to the trail curve.
    const trailLoop = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let tL = ${getUniform('soften')};
  let n_dyn = ${getLength('dynamic')} / ${NODE_STRIDE}u;
  var t_best = 0.0;
  var t_dx = 0.0;
  var t_dy = 0.0;
  for (var i: u32 = 0u; i < n_dyn; i = i + 1u) {
    let base = i * ${NODE_STRIDE}u;
    let ax = ${getUniform('dynamic', 'base + 0u')};
    let ay = ${getUniform('dynamic', 'base + 1u')};
    let bx = ${getUniform('dynamic', 'base + 2u')};
    let by = ${getUniform('dynamic', 'base + 3u')};
    let s1 = ${getUniform('dynamic', 'base + 4u')};
    let s2 = ${getUniform('dynamic', 'base + 5u')};
    if (s1 == 0.0 && s2 == 0.0) { continue; }
    // Closest point on the span, and the strength interpolated to it: the
    // max over spans is then the law applied to the distance to the curve.
    let ex = bx - ax;
    let ey = by - ay;
    let len2 = ex * ex + ey * ey;
    var t = 0.0;
    if (len2 > 0.0) {
      t = clamp(((${particleVar}.position.x - ax) * ex + (${particleVar}.position.y - ay) * ey) / len2, 0.0, 1.0);
    }
    let ns = mix(s1, s2, t);
    let dx = (ax + ex * t) - ${particleVar}.position.x;
    let dy = (ay + ey * t) - ${particleVar}.position.y;
    let dist2 = dx * dx + dy * dy;
    if (dist2 > 0.0 && ns != 0.0) {
      let dist = sqrt(dist2);
      let c = abs(force_mag(ns, dist, tL));
      if (c > t_best) {
        t_best = c;
        let sgn = sign(ns);
        t_dx = sgn * dx / dist;
        t_dy = sgn * dy / dist;
      }
    }
  }
  if (t_best > 0.0) {
    ${particleVar}.acceleration += vec2<f32>(t_dx, t_dy) * t_best;
  }`
    const fieldPart = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let flen = ${getLength('field')};
  if (flen > ${FIELD_HEADER}u) {
    let ox = ${getUniform('field', '0u')};
    let oy = ${getUniform('field', '1u')};
    let cw = ${getUniform('field', '2u')};
    let cols = u32(${getUniform('field', '3u')});
    let rows = u32(${getUniform('field', '4u')});
    let fstrength = ${getUniform('field', '5u')};
    let pad = ${getUniform('field', '6u')};
    let fL = ${getUniform('soften')};
    let fx = (${particleVar}.position.x - ox) / cw;
    let fy = (${particleVar}.position.y - oy) / cw;
    if (fx >= 1.5 && fy >= 1.5 && fx < f32(cols) - 2.5 && fy < f32(rows) - 2.5) {
      // Bilinear sample on cell centers: the distance and its analytic
      // gradient vary continuously, so the force has no grid-step ridges.
      let ux = fx - 0.5;
      let uy = fy - 0.5;
      let tx = fract(ux);
      let ty = fract(uy);
      let i00 = ${FIELD_HEADER}u + u32(uy) * cols + u32(ux);
      let d00 = ${getUniform('field', 'i00')};
      let d10 = ${getUniform('field', 'i00 + 1u')};
      let d01 = ${getUniform('field', 'i00 + cols')};
      let d11 = ${getUniform('field', 'i00 + cols + 1u')};
      // The body is the glyph shape dilated by pad; the push saturates
      // anywhere inside it and falls off as the inverse square outside.
      let g = field_grad(d00, d10, d01, d11, tx, ty,
        ${getUniform('field', 'i00 - 1u')} + ${getUniform('field', 'i00 + cols - 1u')},
        ${getUniform('field', 'i00 + 2u')} + ${getUniform('field', 'i00 + cols + 2u')},
        ${getUniform('field', 'i00 - cols')} + ${getUniform('field', 'i00 - cols + 1u')},
        ${getUniform('field', 'i00 + 2u * cols')} + ${getUniform('field', 'i00 + 2u * cols + 1u')},
        ${getUniform('field', 'i00 - 1u')}, ${getUniform('field', 'i00 + 2u')},
        ${getUniform('field', 'i00 - cols')}, ${getUniform('field', 'i00 + 2u * cols')});
      let gx = g.x;
      let gy = g.y;
      let gl = sqrt(gx * gx + gy * gy);
      if (gl > 0.0) {
        let d = mix(mix(d00, d10, tx), mix(d01, d11, tx), ty);
        let m = force_mag(fstrength, max(d - pad, 0.0), fL);
        ${particleVar}.acceleration += vec2<f32>(gx, gy) / gl * m;
      }
    }
  }`
    // Pull toward the name's letter surface: outside the glyphs the force
    // points down the distance gradient, fading over the range with the
    // sharpness exponent; inside the letters no force applies.
    const namePart = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let nflen = ${getLength('nameField')};
  let nplen = ${getLength('nameParams')};
  if (nflen > ${FIELD_HEADER}u && nplen >= 1u) {
    let nox = ${getUniform('nameField', '0u')};
    let noy = ${getUniform('nameField', '1u')};
    let ncw = ${getUniform('nameField', '2u')};
    let ncols = u32(${getUniform('nameField', '3u')});
    let nrows = u32(${getUniform('nameField', '4u')});
    let nstrength = ${getUniform('nameParams', '0u')};
    let nL = ${getUniform('soften')};
    let nconcave = select(1.0, ${getUniform('nameParams', '1u')}, nplen >= 2u);
    let nzlen = ${getLength('nameZone')};
    let nfx = (${particleVar}.position.x - nox) / ncw;
    let nfy = (${particleVar}.position.y - noy) / ncw;
    if (nfx >= 1.5 && nfy >= 1.5 && nfx < f32(ncols) - 2.5 && nfy < f32(nrows) - 2.5) {
      let nux = nfx - 0.5;
      let nuy = nfy - 0.5;
      let ntx = fract(nux);
      let nty = fract(nuy);
      let ni00 = ${FIELD_HEADER}u + u32(nuy) * ncols + u32(nux);
      let nd00 = ${getUniform('nameField', 'ni00')};
      let nd10 = ${getUniform('nameField', 'ni00 + 1u')};
      let nd01 = ${getUniform('nameField', 'ni00 + ncols')};
      let nd11 = ${getUniform('nameField', 'ni00 + ncols + 1u')};
      let nd = mix(mix(nd00, nd10, ntx), mix(nd01, nd11, ntx), nty);
      if (nd > 0.0) {
        let ng = field_grad(nd00, nd10, nd01, nd11, ntx, nty,
          ${getUniform('nameField', 'ni00 - 1u')} + ${getUniform('nameField', 'ni00 + ncols - 1u')},
          ${getUniform('nameField', 'ni00 + 2u')} + ${getUniform('nameField', 'ni00 + ncols + 2u')},
          ${getUniform('nameField', 'ni00 - ncols')} + ${getUniform('nameField', 'ni00 - ncols + 1u')},
          ${getUniform('nameField', 'ni00 + 2u * ncols')} + ${getUniform('nameField', 'ni00 + 2u * ncols + 1u')},
          ${getUniform('nameField', 'ni00 - 1u')}, ${getUniform('nameField', 'ni00 + 2u')},
          ${getUniform('nameField', 'ni00 - ncols')}, ${getUniform('nameField', 'ni00 + 2u * ncols')});
        let ngx = ng.x;
        let ngy = ng.y;
        let ngl = sqrt(ngx * ngx + ngy * ngy);
        if (ngl > 0.0) {
          var nm = force_mag(nstrength, nd, nL);
          if (nconcave != 1.0 && nzlen >= ncols * nrows) {
            // Concave-pocket boost, bilinearly faded at pocket edges.
            let zi00 = u32(nuy) * ncols + u32(nux);
            let z00 = ${getUniform('nameZone', 'zi00')};
            let z10 = ${getUniform('nameZone', 'zi00 + 1u')};
            let z01 = ${getUniform('nameZone', 'zi00 + ncols')};
            let z11 = ${getUniform('nameZone', 'zi00 + ncols + 1u')};
            let zf = mix(mix(z00, z10, ntx), mix(z01, z11, ntx), nty);
            nm = nm * (1.0 + (nconcave - 1.0) * zf);
          }
          ${particleVar}.acceleration -= vec2<f32>(ngx, ngy) / ngl * nm;
        }
      }
    }
  }`
    return {
      global: () => lawFn,
      apply: (args) => `{
  {${shapeLoop('data', args)}
  }
  {${trailLoop(args)}
  }
${fieldPart(args)}
${namePart(args)}
}`,
    }
  }

  cpu(): CPUDescriptor<EffectorsInputs> {
    return {
      apply: ({ particle, input }) => {
        const px = particle.position.x
        const py = particle.position.y
        const L = input.soften
        const applyList = (data: number[] | undefined) => {
          if (!data || data.length < STRIDE) return
          for (let base = 0; base + STRIDE <= data.length; base += STRIDE) {
            const kind = data[base]
            const ex = data[base + 1]
            const ey = data[base + 2]
            const hw = data[base + 3]
            const hh = data[base + 4]
            const strength = data[base + 5]
            if (strength === 0) continue
            if (kind > 0.5) {
              const sx = Math.max(-hw, Math.min(hw, px - ex))
              const dx = ex + sx - px
              const dy = ey - py
              const dist2 = dx * dx + dy * dy
              if (dist2 <= 0) continue
              const dist = Math.sqrt(dist2)
              const f = forceMag(strength, dist, L) / dist
              particle.acceleration.x += dx * f
              particle.acceleration.y += dy * f
            } else {
              const lx = px - ex
              const ly = py - ey
              if (Math.abs(lx) < hw && Math.abs(ly) < hh) {
                // Repelling rects eject at the surface peak; attracting
                // rects exert nothing inside.
                if (strength < 0) {
                  const exitX = lx < 0 ? -(hw + lx) : hw - lx
                  const exitY = ly < 0 ? -(hh + ly) : hh - ly
                  if (Math.abs(exitY) < Math.abs(exitX)) {
                    particle.acceleration.y += Math.sign(exitY) * Math.abs(strength)
                  } else {
                    particle.acceleration.x += Math.sign(exitX) * Math.abs(strength)
                  }
                }
              } else {
                const cx = Math.max(-hw, Math.min(hw, lx))
                const cy = Math.max(-hh, Math.min(hh, ly))
                const dx = cx - lx
                const dy = cy - ly
                const dist2 = dx * dx + dy * dy
                if (dist2 <= 0) continue
                const dist = Math.sqrt(dist2)
                const f = forceMag(strength, dist, L) / dist
                particle.acceleration.x += dx * f
                particle.acceleration.y += dy * f
              }
            }
          }
        }
        applyList(input.data)
        {
          // Trail samples (dynamic layout: x, y, signed strength); the
          // strongest sample wins, mirroring the WGSL max-field.
          const dyn = input.dynamic
          if (dyn && dyn.length >= NODE_STRIDE) {
            let best = 0
            let bx = 0
            let by = 0
            for (let base = 0; base + NODE_STRIDE <= dyn.length; base += NODE_STRIDE) {
              const ax = dyn[base]
              const ay = dyn[base + 1]
              const s1 = dyn[base + 4]
              const s2 = dyn[base + 5]
              if (s1 === 0 && s2 === 0) continue
              const ex = dyn[base + 2] - ax
              const ey = dyn[base + 3] - ay
              const len2 = ex * ex + ey * ey
              const t =
                len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0
              const ns = s1 + (s2 - s1) * t
              if (ns === 0) continue
              const dx = ax + ex * t - px
              const dy = ay + ey * t - py
              const dist2 = dx * dx + dy * dy
              if (dist2 <= 0) continue
              const dist = Math.sqrt(dist2)
              const c = Math.abs(forceMag(ns, dist, L))
              if (c > best) {
                best = c
                const sgn = Math.sign(ns)
                bx = (sgn * dx) / dist
                by = (sgn * dy) / dist
              }
            }
            if (best > 0) {
              particle.acceleration.x += bx * best
              particle.acceleration.y += by * best
            }
          }
        }
        const field = input.field
        if (field && field.length > FIELD_HEADER) {
          const ox = field[0]
          const oy = field[1]
          const cw = field[2]
          const cols = field[3]
          const rows = field[4]
          const fstrength = field[5]
          const pad = field[6]
          const fx = (px - ox) / cw
          const fy = (py - oy) / cw
          if (fx >= 1.5 && fy >= 1.5 && fx < cols - 2.5 && fy < rows - 2.5) {
            const ux = fx - 0.5
            const uy = fy - 0.5
            const tx = ux - Math.floor(ux)
            const ty = uy - Math.floor(uy)
            const i00 = FIELD_HEADER + Math.floor(uy) * cols + Math.floor(ux)
            const d00 = field[i00]
            const d10 = field[i00 + 1]
            const d01 = field[i00 + cols]
            const d11 = field[i00 + cols + 1]
            const d = (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty
            let gx = (d10 - d00) * (1 - ty) + (d11 - d01) * ty
            let gy = (d01 - d00) * (1 - tx) + (d11 - d10) * tx
            if (gx === 0 && gy === 0) {
              // Widened stencil; see field_grad in the shader.
              gx = field[i00 + 2] + field[i00 + cols + 2] - field[i00 - 1] - field[i00 + cols - 1]
              gy =
                field[i00 + 2 * cols] + field[i00 + 2 * cols + 1] -
                field[i00 - cols] - field[i00 - cols + 1]
            }
            if (gx === 0 && gy === 0) {
              const lo = Math.min(
                field[i00 - 1],
                field[i00 + 2],
                field[i00 - cols],
                field[i00 + 2 * cols],
              )
              if (lo === field[i00 - 1]) gx = 1
              else if (lo === field[i00 + 2]) gx = -1
              else if (lo === field[i00 - cols]) gy = 1
              else if (lo === field[i00 + 2 * cols]) gy = -1
            }
            const gl = Math.hypot(gx, gy)
            if (gl > 0) {
              const m = forceMag(fstrength, Math.max(d - pad, 0), L)
              particle.acceleration.x += (gx / gl) * m
              particle.acceleration.y += (gy / gl) * m
            }
          }
        }
        const nf = input.nameField
        const np = input.nameParams
        if (nf && nf.length > FIELD_HEADER && np && np.length >= 1) {
          const ox = nf[0]
          const oy = nf[1]
          const cw = nf[2]
          const cols = nf[3]
          const rows = nf[4]
          const strength = np[0]
          const concave = np.length >= 2 ? np[1] : 1
          const zone = input.nameZone
          const fx = (px - ox) / cw
          const fy = (py - oy) / cw
          if (fx >= 1.5 && fy >= 1.5 && fx < cols - 2.5 && fy < rows - 2.5) {
            const ux = fx - 0.5
            const uy = fy - 0.5
            const tx = ux - Math.floor(ux)
            const ty = uy - Math.floor(uy)
            const i00 = FIELD_HEADER + Math.floor(uy) * cols + Math.floor(ux)
            const d =
              (nf[i00] * (1 - tx) + nf[i00 + 1] * tx) * (1 - ty) +
              (nf[i00 + cols] * (1 - tx) + nf[i00 + cols + 1] * tx) * ty
            if (d > 0) {
              let gx = (nf[i00 + 1] - nf[i00]) * (1 - ty) + (nf[i00 + cols + 1] - nf[i00 + cols]) * ty
              let gy = (nf[i00 + cols] - nf[i00]) * (1 - tx) + (nf[i00 + cols + 1] - nf[i00 + 1]) * tx
              if (gx === 0 && gy === 0) {
                gx = nf[i00 + 2] + nf[i00 + cols + 2] - nf[i00 - 1] - nf[i00 + cols - 1]
                gy = nf[i00 + 2 * cols] + nf[i00 + 2 * cols + 1] - nf[i00 - cols] - nf[i00 - cols + 1]
              }
              if (gx === 0 && gy === 0) {
                const lo = Math.min(nf[i00 - 1], nf[i00 + 2], nf[i00 - cols], nf[i00 + 2 * cols])
                if (lo === nf[i00 - 1]) gx = 1
                else if (lo === nf[i00 + 2]) gx = -1
                else if (lo === nf[i00 - cols]) gy = 1
                else if (lo === nf[i00 + 2 * cols]) gy = -1
              }
              const gl = Math.hypot(gx, gy)
              if (gl > 0) {
                let nm = forceMag(strength, d, L)
                if (concave !== 1 && zone && zone.length >= cols * rows) {
                  // Concave-pocket boost, bilinearly faded at pocket edges.
                  const zi00 = Math.floor(uy) * cols + Math.floor(ux)
                  const zf =
                    (zone[zi00] * (1 - tx) + zone[zi00 + 1] * tx) * (1 - ty) +
                    (zone[zi00 + cols] * (1 - tx) + zone[zi00 + cols + 1] * tx) * ty
                  nm *= 1 + (concave - 1) * zf
                }
                particle.acceleration.x -= (gx / gl) * nm
                particle.acceleration.y -= (gy / gl) * nm
              }
            }
          }
        }
      },
    }
  }
}
