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

const SHAPE_CODE: Record<EffectorShape, number> = { circle: 0, rect: 1, pill: 2 }
const STRIDE = 8
const FIELD_HEADER = 8

type EffectorsInputs = { data: number[]; field: number[] }

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
    field: DataType.ARRAY,
  } as const

  constructor() {
    super()
    this.write({ data: [], field: [] })
  }

  set(effectors: Effector[]): void {
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
    this.write({ data })
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
    return {
      apply: ({ particleVar, getUniform, getLength }) => `{
  let n = ${getLength('data')} / ${STRIDE}u;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let base = i * ${STRIDE}u;
    let kind = ${getUniform('data', 'base + 0u')};
    let mode = ${getUniform('data', 'base + 1u')};
    let ex = ${getUniform('data', 'base + 2u')};
    let ey = ${getUniform('data', 'base + 3u')};
    let range = ${getUniform('data', 'base + 4u')};
    let hw = ${getUniform('data', 'base + 5u')};
    let hh = ${getUniform('data', 'base + 6u')};
    let strength = ${getUniform('data', 'base + 7u')};
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
  }
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
    if (fx >= 1.0 && fy >= 1.0 && fx < f32(cols) - 2.0 && fy < f32(rows) - 2.0) {
      let cx = u32(fx);
      let cy = u32(fy);
      let idx = ${FIELD_HEADER}u + cy * cols + cx;
      let d = ${getUniform('field', 'idx')};
      if (d < pad) {
        // Gradient points toward the nearest exit; force scales with depth.
        let gx = ${getUniform('field', 'idx + 1u')} - ${getUniform('field', 'idx - 1u')};
        let gy = ${getUniform('field', 'idx + cols')} - ${getUniform('field', 'idx - cols')};
        let gl = sqrt(gx * gx + gy * gy);
        if (gl > 0.0) {
          let m = clamp((pad - d) / falloff, 0.0, 1.5);
          ${particleVar}.acceleration += vec2<f32>(gx, gy) / gl * (fstrength * m);
        }
      }
    }
  }
}`,
    }
  }

  cpu(): CPUDescriptor<EffectorsInputs> {
    return {
      apply: ({ particle, input }) => {
        const data = input.data
        const px = particle.position.x
        const py = particle.position.y
        if (data && data.length >= STRIDE) {
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
          if (fx >= 1 && fy >= 1 && fx < cols - 2 && fy < rows - 2) {
            const idx = FIELD_HEADER + Math.floor(fy) * cols + Math.floor(fx)
            const d = field[idx]
            if (d < pad) {
              const gx = field[idx + 1] - field[idx - 1]
              const gy = field[idx + cols] - field[idx - cols]
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
