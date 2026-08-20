import {
  Module,
  ModuleRole,
  DataType,
  type WebGPUDescriptor,
  type CPUDescriptor,
  type VizGroup,
  type VizPrimitive,
} from '@cazala/party'

export type EffectorShape = 'circle' | 'rect' | 'pill'
export type EffectorMode = 'attract' | 'repel'

export interface Effector {
  shape: EffectorShape
  mode: EffectorMode
  /** World-space center. */
  x: number
  y: number
  /** Influence distance beyond the shape edge (circle: from center). */
  range: number
  /** Rect half extents / pill half segment length, in world units. */
  halfW: number
  halfH: number
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
  /** Particles are kept this far outside the shape (world units). */
  padding: number
  /** Distance over which the force ramps to full (world units). */
  falloff: number
  /** Row-major distances, world units, negative inside the shape. */
  distances: Float32Array
}

/**
 * One sample of the cursor-trail curve: a cone of force with its own radius
 * and peak strength. The trail field is the MAX-magnitude sample cone (not
 * the sum), so the densely sampled curve forms one smooth tapered blob
 * with no seams where samples overlap, and a stationary cursor is simply
 * the single-cone degenerate case. Strength is SIGNED: positive pulls,
 * negative pushes (drag trails).
 */
export interface TrailNode {
  x: number
  y: number
  r: number
  s: number
}

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
  const v00 = p.values[b]
  const v10 = p.values[b + 1]
  const v01 = p.values[b + p.cols]
  const v11 = p.values[b + p.cols + 1]
  return {
    v: (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty,
    gx: (v10 - v00) * (1 - ty) + (v11 - v01) * ty,
    gy: (v01 - v00) * (1 - tx) + (v11 - v10) * tx,
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
  if (p.kind === 'segment') {
    // Closest point on the body segment; a point source when the ends meet.
    const vx = p.x2 - p.x1
    const vy = p.y2 - p.y1
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x1) * vx + (y - p.y1) * vy) / len2)) : 0
    const dx = p.x1 + vx * t - x
    const dy = p.y1 + vy * t - y
    const d2 = dx * dx + dy * dy
    if (d2 <= 0 || d2 > p.range * p.range) return 0
    const d = Math.sqrt(d2)
    const m = p.strength * (1 - d / p.range)
    out[0] = (dx / d) * m
    out[1] = (dy / d) * m
    return Math.abs(m)
  }
  if (p.kind === 'rect') {
    const lx = x - p.x
    const ly = y - p.y
    if (Math.abs(lx) < p.hw && Math.abs(ly) < p.hh) {
      // Inside: repelling rects eject along the nearest edge at full
      // strength, attracting rects exert nothing.
      if (!p.interiorPush) return 0
      const exitX = lx < 0 ? -(p.hw + lx) : p.hw - lx
      const exitY = ly < 0 ? -(p.hh + ly) : p.hh - ly
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
    if (d2 <= 0 || d2 > p.range * p.range) return 0
    const d = Math.sqrt(d2)
    const m = p.strength * (1 - d / p.range)
    out[0] = (dx / d) * m
    out[1] = (dy / d) * m
    return Math.abs(m)
  }
  const s = sampleField(p, x, y)
  if (!s) return 0
  const gl = Math.hypot(s.gx, s.gy)
  if (gl <= 0) return 0
  const offset = p.offset ?? 0
  let m: number
  if (p.push) {
    // Acts only inside the offset surface, growing with penetration depth.
    if (!(s.v < offset)) return 0
    const cap = p.cap ?? 1
    m = p.strength * Math.min(Math.max((offset - s.v) / p.range, 0), cap)
  } else {
    // Acts outside the surface, fading to zero at `range`.
    const r = s.v - offset
    if (!(r > 0 && r < p.range)) return 0
    m = p.strength * Math.pow(1 - r / p.range, p.exponent ?? 1)
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

/** Peak magnitude this primitive can reach anywhere, used to anchor the
 * debug view's opacity scale. Every law here peaks at the body surface. */
export function peakForce(p: VizPrimitive): number {
  if (p.kind === 'field') {
    const boost = p.boost && p.boost.factor > 1 ? p.boost.factor : 1
    return Math.abs(p.strength) * (p.push ? (p.cap ?? 1) : boost)
  }
  return Math.abs(p.strength)
}

const SHAPE_CODE: Record<EffectorShape, number> = { circle: 0, rect: 1, pill: 2 }
const STRIDE = 8
const NODE_STRIDE = 4
const FIELD_HEADER = 8

type EffectorsInputs = {
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
    data.push(
      SHAPE_CODE[e.shape],
      e.mode === 'repel' ? 1 : 0,
      e.x,
      e.y,
      e.range,
      e.halfW,
      e.halfH,
      e.strength,
    )
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
    data: DataType.ARRAY,
    dynamic: DataType.ARRAY,
    field: DataType.ARRAY,
    nameField: DataType.ARRAY,
    nameParams: DataType.ARRAY,
    nameZone: DataType.ARRAY,
  } as const

  constructor() {
    super()
    this.write({ data: [], dynamic: [], field: [], nameField: [], nameParams: [], nameZone: [] })
  }

  /** Static effectors: rewritten only on layout/hover changes. */
  set(effectors: Effector[]): void {
    this.write({ data: packEffectors(effectors) })
  }

  /** Cursor-trail curve samples: tiny, rewritten every frame. */
  setDynamic(nodes: TrailNode[]): void {
    const data: number[] = []
    for (const n of nodes) {
      data.push(n.x, n.y, n.r, n.s)
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
    arr[7] = field.falloff
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

  /** Name-pull tuning, all world units where applicable:
   * strength — peak pull at the letter surface;
   * range — reach beyond the surface (force is zero past it);
   * sharpness — falloff exponent from the surface out (1 = linear;
   *   higher concentrates the pull near the letters);
   * concave — pull multiplier inside the nameZone pockets (1 = none).
   * Inside the letters no force applies. */
  setNameParams(strength: number, range: number, sharpness: number, concave: number): void {
    this.write({ nameParams: [strength, range, sharpness, concave] })
  }

  /** Concave-pocket mask, same grid as the name field (see inputs doc). */
  setNameZone(zone: ArrayLike<number>): void {
    this.write({ nameZone: Array.from(zone) })
  }

  /** Debug description decoded from the same packed arrays the shaders
   * consume, so the debug view always matches the live physics. */
  viz(): VizGroup[] {
    if (!this.isEnabled()) return []
    const state = this.read() as {
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
    for (let base = 0; base + STRIDE <= data.length; base += STRIDE) {
      const [kind, mode, x, y, range, hw, hh, strength] = data.slice(base, base + STRIDE)
      if (strength === 0) continue
      const dir = mode === 1 ? 'repel' : 'attract'
      // Signed for the viewer: positive pulls toward the body, negative pushes.
      const signed = mode === 1 ? -strength : strength
      if (kind < 0.5) {
        add(`effectors:${dir}-circle`, false, {
          kind: 'segment',
          x1: x,
          y1: y,
          x2: x,
          y2: y,
          strength: signed,
          range,
        })
      } else if (kind > 1.5) {
        add(`effectors:${dir}-pill`, false, {
          kind: 'segment',
          x1: x - hw,
          y1: y,
          x2: x + hw,
          y2: y,
          strength: signed,
          range,
        })
      } else {
        add(`effectors:${dir}-rect`, false, {
          kind: 'rect',
          x,
          y,
          hw,
          hh,
          strength: signed,
          range,
          interiorPush: mode === 1,
        })
      }
    }

    const dyn = state.dynamic ?? []
    for (let base = 0; base + NODE_STRIDE <= dyn.length; base += NODE_STRIDE) {
      const [x, y, r, s] = dyn.slice(base, base + NODE_STRIDE)
      if (r <= 0 || s === 0) continue
      // One group, not one per sign: the physics takes a single strongest
      // sample across the whole curve, so a pull node and a push node never
      // both act. Splitting them by color would make the viewer sum two
      // winners and show a force that is not there.
      add('effectors:trail', true, { kind: 'segment', x1: x, y1: y, x2: x, y2: y, strength: s, range: r })
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
        range: field[7],
        offset: field[6],
        push: true,
        cap: 1.5,
      })
    }

    const nameField = state.nameField
    const nameParams = state.nameParams
    if (nameField && nameField.length > FIELD_HEADER && nameParams && nameParams.length >= 3) {
      const cols = nameField[3]
      const rows = nameField[4]
      const zone = state.nameZone
      const concave = nameParams[3] ?? 1
      // The pocket boost is part of the name's force, not a body of its own,
      // so it rides along as a multiplier instead of a second primitive.
      const boost =
        concave !== 1 && zone && zone.length >= cols * rows
          ? { values: zone, factor: concave }
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
        range: nameParams[1],
        offset: 0,
        exponent: nameParams[2],
        boost,
      })
    }
    return [...groups.values()]
  }

  webgpu(): WebGPUDescriptor<EffectorsInputs> {
    type WgslArgs = Parameters<
      Extract<WebGPUDescriptor<EffectorsInputs>, { apply?: unknown }>['apply'] & object
    >[0]
    // The static array carries circle/rect/pill shapes; the dynamic array
    // carries the trail capsule chain and has its own layout.
    const shapeLoop = (
      arr: 'data',
      { particleVar, getUniform, getLength }: WgslArgs,
    ) => `
  let n_${arr} = ${getLength(arr)} / ${STRIDE}u;
  for (var i: u32 = 0u; i < n_${arr}; i = i + 1u) {
    let base = i * ${STRIDE}u;
    let kind = ${getUniform(arr, 'base + 0u')};
    let mode = ${getUniform(arr, 'base + 1u')};
    let ex = ${getUniform(arr, 'base + 2u')};
    let ey = ${getUniform(arr, 'base + 3u')};
    let range = ${getUniform(arr, 'base + 4u')};
    let hw = ${getUniform(arr, 'base + 5u')};
    let hh = ${getUniform(arr, 'base + 6u')};
    let strength = ${getUniform(arr, 'base + 7u')};
    let px = ${particleVar}.position.x;
    let py = ${particleVar}.position.y;
    if (kind < 0.5 || kind > 1.5) {
      // Circle (or pill: distance to a horizontal segment), Interaction falloff.
      let sx = clamp(px - ex, -hw, hw) * select(0.0, 1.0, kind > 1.5);
      let dx = (ex + sx) - px;
      let dy = ey - py;
      let dist2 = dx * dx + dy * dy;
      if (dist2 > 0.0 && dist2 <= range * range) {
        let dist = sqrt(dist2);
        let dir = vec2<f32>(dx, dy) / dist;
        let f = strength * (1.0 - dist / range);
        let force = select(dir * f, -dir * f, mode == 1.0);
        ${particleVar}.acceleration += force;
      }
    } else {
      let lx = px - ex;
      let ly = py - ey;
      let inside = abs(lx) < hw && abs(ly) < hh;
      if (inside) {
        if (mode == 1.0) {
          // Push out along the nearest edge at full strength.
          let exitX = select(hw - lx, -(hw + lx), lx < 0.0);
          let exitY = select(hh - ly, -(hh + ly), ly < 0.0);
          var dir = vec2<f32>(sign(exitX), 0.0);
          if (abs(exitY) < abs(exitX)) { dir = vec2<f32>(0.0, sign(exitY)); }
          ${particleVar}.acceleration += dir * strength;
        }
      } else {
        // Distance to the nearest point on the rect, Interaction falloff.
        let cx = clamp(lx, -hw, hw);
        let cy = clamp(ly, -hh, hh);
        let dx = cx - lx;
        let dy = cy - ly;
        let dist2 = dx * dx + dy * dy;
        if (dist2 > 0.0 && dist2 <= range * range) {
          let dist = sqrt(dist2);
          let dir = vec2<f32>(dx, dy) / dist;
          let f = strength * (1.0 - dist / range);
          let force = select(dir * f, -dir * f, mode == 1.0);
          ${particleVar}.acceleration += force;
        }
      }
    }
  }`
    // The trail field is the MAX-magnitude sample cone along the cursor
    // curve — the strongest sample wins at each point, so overlapping
    // samples form one smooth tapered blob instead of summing into seams.
    // Positive strength pulls toward the sample, negative pushes away.
    const trailLoop = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let n_dyn = ${getLength('dynamic')} / ${NODE_STRIDE}u;
  var t_best = 0.0;
  var t_dx = 0.0;
  var t_dy = 0.0;
  for (var i: u32 = 0u; i < n_dyn; i = i + 1u) {
    let base = i * ${NODE_STRIDE}u;
    let nx = ${getUniform('dynamic', 'base + 0u')};
    let ny = ${getUniform('dynamic', 'base + 1u')};
    let nr = ${getUniform('dynamic', 'base + 2u')};
    let ns = ${getUniform('dynamic', 'base + 3u')};
    if (nr <= 0.0 || ns == 0.0) { continue; }
    let dx = nx - ${particleVar}.position.x;
    let dy = ny - ${particleVar}.position.y;
    let dist2 = dx * dx + dy * dy;
    if (dist2 > 0.0 && dist2 < nr * nr) {
      let dist = sqrt(dist2);
      let c = abs(ns) * (1.0 - dist / nr);
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
    let falloff = ${getUniform('field', '7u')};
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
      let d = mix(mix(d00, d10, tx), mix(d01, d11, tx), ty);
      if (d < pad) {
        // Gradient points toward the nearest exit; force scales with depth.
        let gx = mix(d10 - d00, d11 - d01, ty);
        let gy = mix(d01 - d00, d11 - d10, tx);
        let gl = sqrt(gx * gx + gy * gy);
        if (gl > 0.0) {
          let m = clamp((pad - d) / falloff, 0.0, 1.5);
          ${particleVar}.acceleration += vec2<f32>(gx, gy) / gl * (fstrength * m);
        }
      }
    }
  }`
    // Pull toward the name's letter surface: outside the glyphs the force
    // points down the distance gradient, fading over the range with the
    // sharpness exponent; inside the letters no force applies.
    const namePart = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let nflen = ${getLength('nameField')};
  let nplen = ${getLength('nameParams')};
  if (nflen > ${FIELD_HEADER}u && nplen >= 3u) {
    let nox = ${getUniform('nameField', '0u')};
    let noy = ${getUniform('nameField', '1u')};
    let ncw = ${getUniform('nameField', '2u')};
    let ncols = u32(${getUniform('nameField', '3u')});
    let nrows = u32(${getUniform('nameField', '4u')});
    let nstrength = ${getUniform('nameParams', '0u')};
    let nrange = ${getUniform('nameParams', '1u')};
    let nsharp = ${getUniform('nameParams', '2u')};
    let nconcave = select(1.0, ${getUniform('nameParams', '3u')}, nplen >= 4u);
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
      if (nd > 0.0 && nd < nrange) {
        let ngx = mix(nd10 - nd00, nd11 - nd01, nty);
        let ngy = mix(nd01 - nd00, nd11 - nd10, ntx);
        let ngl = sqrt(ngx * ngx + ngy * ngy);
        if (ngl > 0.0) {
          var nm = nstrength * pow(1.0 - nd / nrange, nsharp);
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
        const applyList = (data: number[] | undefined) => {
          if (!data || data.length < STRIDE) return
          for (let base = 0; base + STRIDE <= data.length; base += STRIDE) {
            const kind = data[base]
            const mode = data[base + 1]
            const ex = data[base + 2]
            const ey = data[base + 3]
            const range = data[base + 4]
            const hw = data[base + 5]
            const hh = data[base + 6]
            const strength = data[base + 7]
            if (kind < 0.5 || kind > 1.5) {
              const sx = kind > 1.5 ? Math.max(-hw, Math.min(hw, px - ex)) : 0
              const dx = ex + sx - px
              const dy = ey - py
              const dist2 = dx * dx + dy * dy
              if (dist2 <= 0 || dist2 > range * range) continue
              const dist = Math.sqrt(dist2)
              const f = (strength * (1 - dist / range)) / dist
              const s = mode === 1 ? -1 : 1
              particle.acceleration.x += s * dx * f
              particle.acceleration.y += s * dy * f
            } else {
              const lx = px - ex
              const ly = py - ey
              if (Math.abs(lx) < hw && Math.abs(ly) < hh) {
                if (mode === 1) {
                  const exitX = lx < 0 ? -(hw + lx) : hw - lx
                  const exitY = ly < 0 ? -(hh + ly) : hh - ly
                  if (Math.abs(exitY) < Math.abs(exitX)) {
                    particle.acceleration.y += Math.sign(exitY) * strength
                  } else {
                    particle.acceleration.x += Math.sign(exitX) * strength
                  }
                }
              } else {
                const cx = Math.max(-hw, Math.min(hw, lx))
                const cy = Math.max(-hh, Math.min(hh, ly))
                const dx = cx - lx
                const dy = cy - ly
                const dist2 = dx * dx + dy * dy
                if (dist2 <= 0 || dist2 > range * range) continue
                const dist = Math.sqrt(dist2)
                const f = (strength * (1 - dist / range)) / dist
                const s = mode === 1 ? -1 : 1
                particle.acceleration.x += s * dx * f
                particle.acceleration.y += s * dy * f
              }
            }
          }
        }
        applyList(input.data)
        {
          // Trail curve samples (dynamic layout: x,y,radius,strength); the
          // strongest-magnitude cone wins, mirroring the WGSL max-field.
          // Positive strength pulls, negative pushes.
          const dyn = input.dynamic
          if (dyn && dyn.length >= NODE_STRIDE) {
            let best = 0
            let bx = 0
            let by = 0
            for (let base = 0; base + NODE_STRIDE <= dyn.length; base += NODE_STRIDE) {
              const nr = dyn[base + 2]
              const ns = dyn[base + 3]
              if (nr <= 0 || ns === 0) continue
              const dx = dyn[base] - px
              const dy = dyn[base + 1] - py
              const dist2 = dx * dx + dy * dy
              if (dist2 <= 0 || dist2 >= nr * nr) continue
              const dist = Math.sqrt(dist2)
              const c = Math.abs(ns) * (1 - dist / nr)
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
          const falloff = field[7]
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
            if (d < pad) {
              const gx = (d10 - d00) * (1 - ty) + (d11 - d01) * ty
              const gy = (d01 - d00) * (1 - tx) + (d11 - d10) * tx
              const gl = Math.hypot(gx, gy)
              if (gl > 0) {
                const m = Math.min(Math.max((pad - d) / falloff, 0), 1.5)
                particle.acceleration.x += (gx / gl) * fstrength * m
                particle.acceleration.y += (gy / gl) * fstrength * m
              }
            }
          }
        }
        const nf = input.nameField
        const np = input.nameParams
        if (nf && nf.length > FIELD_HEADER && np && np.length >= 3) {
          const ox = nf[0]
          const oy = nf[1]
          const cw = nf[2]
          const cols = nf[3]
          const rows = nf[4]
          const strength = np[0]
          const range = np[1]
          const sharp = np[2]
          const concave = np.length >= 4 ? np[3] : 1
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
            if (d > 0 && d < range) {
              const gx = (nf[i00 + 1] - nf[i00]) * (1 - ty) + (nf[i00 + cols + 1] - nf[i00 + cols]) * ty
              const gy = (nf[i00 + cols] - nf[i00]) * (1 - tx) + (nf[i00 + cols + 1] - nf[i00 + 1]) * tx
              const gl = Math.hypot(gx, gy)
              if (gl > 0) {
                let nm = strength * Math.pow(1 - d / range, sharp)
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
