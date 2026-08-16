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

type EffectorsInputs = {
  data: number[]
  dynamic: number[]
  field: number[]
  nameField: number[]
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
  } as const

  constructor() {
    super()
    this.write({ data: [], dynamic: [], field: [], nameField: [] })
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
   * pulled toward the glyph surface (force fades over `falloff`); inside
   * the letters no force applies. The physics IS the font's vector shape. */
  setNameField(field: DistanceField | null): void {
    this.write({ nameField: field ? this.packField(field) : [] })
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
      if (kind < 0.5) {
        add(`effectors:${dir}-circle`, false, { kind: 'ring', x, y, r0: 0, r1: range, intensity: strength })
      } else if (kind > 1.5) {
        add(`effectors:${dir}-pill`, false, {
          kind: 'capsule',
          x1: x - hw,
          y1: y,
          x2: x + hw,
          y2: y,
          range,
          i1: strength,
          i2: strength,
        })
      } else {
        add(`effectors:${dir}-rect`, false, { kind: 'rectRing', x, y, hw, hh, range, intensity: strength })
      }
    }

    const dyn = state.dynamic ?? []
    for (let base = 0; base + STRIDE <= dyn.length; base += STRIDE) {
      const [x1, y1, x2, y2, range, s1, s2] = dyn.slice(base, base + STRIDE)
      if (range === 0 || (s1 === 0 && s2 === 0)) continue
      add('effectors:trail', true, { kind: 'capsule', x1, y1, x2, y2, range, i1: s1, i2: s2 })
    }

    const field = state.field
    if (field && field.length > FIELD_HEADER) {
      add('effectors:exclusion', false, {
        kind: 'field',
        originX: field[0],
        originY: field[1],
        cell: field[2],
        cols: field[3],
        rows: field[4],
        values: field,
        valuesStart: FIELD_HEADER,
        inner: field[6],
        outer: field[6] + field[7],
        intensity: field[5],
      })
    }

    const nameField = state.nameField
    if (nameField && nameField.length > FIELD_HEADER) {
      add('effectors:name', false, {
        kind: 'field',
        originX: nameField[0],
        originY: nameField[1],
        cell: nameField[2],
        cols: nameField[3],
        rows: nameField[4],
        values: nameField,
        valuesStart: FIELD_HEADER,
        inner: 0, // the letter surface itself
        outer: nameField[7],
        intensity: nameField[5],
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
    // Pull toward the name's letter surface: outside the glyphs the force
    // points down the distance gradient, fading linearly over the falloff;
    // inside the letters no force applies.
    const namePart = ({ particleVar, getUniform, getLength }: WgslArgs) => `
  let nflen = ${getLength('nameField')};
  if (nflen > ${FIELD_HEADER}u) {
    let nox = ${getUniform('nameField', '0u')};
    let noy = ${getUniform('nameField', '1u')};
    let ncw = ${getUniform('nameField', '2u')};
    let ncols = u32(${getUniform('nameField', '3u')});
    let nrows = u32(${getUniform('nameField', '4u')});
    let nstrength = ${getUniform('nameField', '5u')};
    let nrange = ${getUniform('nameField', '7u')};
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
          let nm = nstrength * (1.0 - nd / nrange);
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
          // Trail capsule chain (dynamic layout: x1,y1,x2,y2,range,s1,s2,pad).
          const dyn = input.dynamic
          if (dyn && dyn.length >= STRIDE) {
            for (let base = 0; base + STRIDE <= dyn.length; base += STRIDE) {
              const ax = dyn[base]
              const ay = dyn[base + 1]
              const bx = dyn[base + 2]
              const by = dyn[base + 3]
              const range = dyn[base + 4]
              const s1 = dyn[base + 5]
              const s2 = dyn[base + 6]
              if (range <= 0 || (s1 === 0 && s2 === 0)) continue
              const abx = bx - ax
              const aby = by - ay
              const len2 = abx * abx + aby * aby
              const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / len2)) : 0
              const dx = ax + abx * t - px
              const dy = ay + aby * t - py
              const dist2 = dx * dx + dy * dy
              if (dist2 <= 0 || dist2 > range * range) continue
              const dist = Math.sqrt(dist2)
              const f = ((s1 + (s2 - s1) * t) * (1 - dist / range)) / dist
              particle.acceleration.x += dx * f
              particle.acceleration.y += dy * f
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
        if (nf && nf.length > FIELD_HEADER) {
          const ox = nf[0]
          const oy = nf[1]
          const cw = nf[2]
          const cols = nf[3]
          const rows = nf[4]
          const strength = nf[5]
          const range = nf[7]
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
                const m = (strength * (1 - d / range)) / gl
                particle.acceleration.x -= gx * m
                particle.acceleration.y -= gy * m
              }
            }
          }
        }
      },
    }
  }
}
