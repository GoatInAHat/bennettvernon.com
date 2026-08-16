import {
  Module,
  ModuleRole,
  DataType,
  type WebGPUDescriptor,
  type CPUDescriptor,
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
 * One link of the cursor-trail chain: a capsule segment whose strength
 * interpolates between its endpoints, so the pull is continuous along the
 * whole path instead of a row of discrete circles. Attract-only.
 */
export interface TrailSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  range: number
  s1: number
  s2: number
}

const SHAPE_CODE: Record<EffectorShape, number> = { circle: 0, rect: 1, pill: 2 }
const STRIDE = 8
const FIELD_HEADER = 8

type EffectorsInputs = { data: number[]; dynamic: number[]; field: number[] }

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
  } as const

  constructor() {
    super()
    this.write({ data: [], dynamic: [], field: [] })
  }

  /** Static effectors: rewritten only on layout/hover changes. */
  set(effectors: Effector[]): void {
    this.write({ data: packEffectors(effectors) })
  }

  /** Cursor-trail capsule chain: tiny, rewritten every frame. */
  setDynamic(segments: TrailSegment[]): void {
    const data: number[] = []
    for (const s of segments) {
      data.push(s.x1, s.y1, s.x2, s.y2, s.range, s.s1, s.s2, 0)
    }
    this.write({ dynamic: data })
  }

  setField(field: DistanceField | null): void {
    if (!field) {
      this.write({ field: [] })
      return
    }
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
    this.write({ field: arr })
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
    // Continuous pull along the trail path: distance to each capsule
    // segment, strength interpolated between the segment's endpoints.
    const trailLoop = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let n_dyn = ${getLength('dynamic')} / ${STRIDE}u;
  for (var i: u32 = 0u; i < n_dyn; i = i + 1u) {
    let base = i * ${STRIDE}u;
    let ax = ${getUniform('dynamic', 'base + 0u')};
    let ay = ${getUniform('dynamic', 'base + 1u')};
    let bx = ${getUniform('dynamic', 'base + 2u')};
    let by = ${getUniform('dynamic', 'base + 3u')};
    let range = ${getUniform('dynamic', 'base + 4u')};
    let s1 = ${getUniform('dynamic', 'base + 5u')};
    let s2 = ${getUniform('dynamic', 'base + 6u')};
    let px = ${particleVar}.position.x;
    let py = ${particleVar}.position.y;
    let abx = bx - ax;
    let aby = by - ay;
    let len2 = abx * abx + aby * aby;
    var t = 0.0;
    if (len2 > 0.0) {
      t = clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0.0, 1.0);
    }
    let dx = (ax + abx * t) - px;
    let dy = (ay + aby * t) - py;
    let dist2 = dx * dx + dy * dy;
    if (dist2 > 0.0 && dist2 <= range * range) {
      let dist = sqrt(dist2);
      let f = mix(s1, s2, t) * (1.0 - dist / range);
      ${particleVar}.acceleration += vec2<f32>(dx, dy) / dist * f;
    }
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
    return {
      apply: (args) => `{
  {${shapeLoop('data', args)}
  }
  {${trailLoop(args)}
  }
${fieldPart(args)}
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
        applyList(input.dynamic)
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
      },
    }
  }
}
