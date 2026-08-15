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
  /** Rect half extents, or pill half segment length, in world units. */
  halfW: number
  halfH: number
  strength: number
}

const SHAPE_CODE: Record<EffectorShape, number> = { circle: 0, rect: 1, pill: 2 }

const STRIDE = 8

type EffectorsInputs = { data: number[] }

/**
 * Multi-instance attract/repel field. Same force math as the built-in
 * Interaction module (linear falloff), extended to N simultaneous circles
 * and rectangles so DOM elements (buttons, content blocks) can each push
 * particles away or gather them, like the caza.la/party center circle.
 */
export class Effectors extends Module<'effectors', EffectorsInputs> {
  readonly name = 'effectors' as const
  readonly role = ModuleRole.Force
  readonly inputs = {
    data: DataType.ARRAY,
  } as const

  constructor() {
    super()
    this.write({ data: [] })
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
}`,
    }
  }

  cpu(): CPUDescriptor<EffectorsInputs> {
    return {
      apply: ({ particle, input }) => {
        const data = input.data
        if (!data || data.length < STRIDE) return
        const px = particle.position.x
        const py = particle.position.y
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
      },
    }
  }
}
