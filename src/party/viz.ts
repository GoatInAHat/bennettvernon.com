import type { VizGroup, VizPrimitive } from '@cazala/party'

/**
 * Generic debug renderer for the engine's viz contract: draws every module's
 * self-described force geometry — the body outline, the range-limit outline,
 * and the falloff gradient between them — with colors derived
 * deterministically from group keys. New physics renders here without any
 * changes to this file, as long as it describes itself via Module.viz().
 */

/** Deterministic hue from a group key (FNV-1a). */
export function vizHue(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}

export const vizCss = (key: string, alpha: number): string =>
  `hsla(${vizHue(key)}, 72%, 36%, ${alpha})`

/** The vizCss color of a key as RGB bytes, for ImageData painting. */
export function vizRgb(key: string): [number, number, number] {
  // s=0.72, l=0.36 to match vizCss.
  const hue = vizHue(key)
  const s = 0.72
  const l = 0.36
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** Max intensity per group, for relative alpha scaling. */
function groupScale(g: VizGroup): number {
  let max = 0
  for (const p of g.primitives) {
    if (p.kind === 'capsule') max = Math.max(max, Math.abs(p.i1), Math.abs(p.i2))
    else max = Math.max(max, Math.abs(p.intensity))
  }
  return max > 0 ? max : 1
}

function drawRing(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: Extract<VizPrimitive, { kind: 'ring' }>,
  norm: number,
  zoom: number,
  gradientOnly = false,
) {
  const x = p.x * zoom
  const y = p.y * zoom
  const r0 = p.r0 * zoom
  const r1 = p.r1 * zoom
  if (r1 <= 0) return
  const grad = ctx.createRadialGradient(x, y, Math.max(r0, 0), x, y, r1)
  grad.addColorStop(0, vizCss(key, 0.3 * norm))
  grad.addColorStop(1, vizCss(key, 0))
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y, r1, 0, Math.PI * 2)
  ctx.fill()
  // In max-composited groups the primitives are dense curve samples; their
  // union gradient IS the geometry, so per-sample outlines are just noise.
  if (gradientOnly) return
  // Body geometry (a dot for point sources) and the range limit.
  ctx.fillStyle = vizCss(key, Math.min(1, 0.5 + 0.5 * norm))
  ctx.strokeStyle = ctx.fillStyle
  ctx.lineWidth = 1
  if (r0 >= 1) {
    ctx.beginPath()
    ctx.arc(x, y, r0, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(x, y, 1.4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.strokeStyle = vizCss(key, 0.22)
  ctx.beginPath()
  ctx.arc(x, y, r1, 0, Math.PI * 2)
  ctx.stroke()
}

function drawCapsule(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: Extract<VizPrimitive, { kind: 'capsule' }>,
  norm: number,
  zoom: number,
) {
  const x1 = p.x1 * zoom
  const y1 = p.y1 * zoom
  const x2 = p.x2 * zoom
  const y2 = p.y2 * zoom
  const r = p.range * zoom
  const i1 = Math.abs(p.i1) * norm
  const i2 = Math.abs(p.i2) * norm
  const len = Math.hypot(x2 - x1, y2 - y1)
  if (len < 0.5) {
    drawRing(ctx, key, { kind: 'ring', x: p.x1, y: p.y1, r0: 0, r1: p.range, intensity: Math.max(i1, i2) / (norm || 1) }, Math.max(i1, i2), zoom)
    return
  }
  const mid = (i1 + i2) / 2
  const ang0 = Math.atan2(y2 - y1, x2 - x1)
  // Exact capsule falloff: the distance field of a segment is a
  // perpendicular linear ramp along the middle slab plus radial ramps
  // around the end caps — rendered with real gradients, matching the
  // shader's strength * (1 - dist / range).
  ctx.save()
  ctx.translate(x1, y1)
  ctx.rotate(ang0)
  const slab = ctx.createLinearGradient(0, -r, 0, r)
  slab.addColorStop(0, vizCss(key, 0))
  slab.addColorStop(0.5, vizCss(key, 0.3 * mid))
  slab.addColorStop(1, vizCss(key, 0))
  ctx.fillStyle = slab
  ctx.fillRect(0, -r, len, r * 2)
  const cap = (cxo: number, intensity: number, side: -1 | 1) => {
    ctx.save()
    ctx.beginPath()
    ctx.rect(side < 0 ? cxo - r : cxo, -r, r, r * 2)
    ctx.clip()
    const g = ctx.createRadialGradient(cxo, 0, 0, cxo, 0, r)
    g.addColorStop(0, vizCss(key, 0.3 * intensity))
    g.addColorStop(1, vizCss(key, 0))
    ctx.fillStyle = g
    ctx.fillRect(cxo - r, -r, r * 2, r * 2)
    ctx.restore()
  }
  cap(0, i1, -1)
  cap(len, i2, 1)
  ctx.restore()
  // Range limit: the capsule outline. (The body segment itself is not
  // stroked — across the round caps it reads as a diameter line.) The cap
  // arcs run from the +normal side around the tip to the −normal side, so
  // the path never jumps across the circle.
  const nx = -(y2 - y1) / len
  const ny = (x2 - x1) / len
  const ang = Math.atan2(y2 - y1, x2 - x1)
  ctx.strokeStyle = vizCss(key, 0.22 * Math.min(1, mid + 0.3))
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x1 + nx * r, y1 + ny * r)
  ctx.lineTo(x2 + nx * r, y2 + ny * r)
  ctx.arc(x2, y2, r, ang + Math.PI / 2, ang - Math.PI / 2, true)
  ctx.lineTo(x1 - nx * r, y1 - ny * r)
  ctx.arc(x1, y1, r, ang - Math.PI / 2, ang + Math.PI / 2, true)
  ctx.closePath()
  ctx.stroke()
}

function drawRectRing(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: Extract<VizPrimitive, { kind: 'rectRing' }>,
  norm: number,
  zoom: number,
) {
  const x = p.x * zoom
  const y = p.y * zoom
  const hw = p.hw * zoom
  const hh = p.hh * zoom
  const r = p.range * zoom
  // Falloff gradient: expanding outlines with falling alpha. The offset
  // surface of a rectangle is a rounded rectangle whose corner radius is
  // the offset distance.
  const steps = 6
  for (let k = 1; k < steps; k++) {
    const o = (k / steps) * r
    ctx.strokeStyle = vizCss(key, 0.3 * norm * (1 - k / steps))
    ctx.lineWidth = Math.max(1, r / steps)
    ctx.beginPath()
    ctx.roundRect(x - hw - o, y - hh - o, (hw + o) * 2, (hh + o) * 2, o)
    ctx.stroke()
  }
  // Body geometry and range limit.
  ctx.lineWidth = 1
  ctx.strokeStyle = vizCss(key, Math.min(1, 0.5 + 0.5 * norm))
  ctx.strokeRect(x - hw, y - hh, hw * 2, hh * 2)
  ctx.strokeStyle = vizCss(key, 0.22)
  ctx.beginPath()
  ctx.roundRect(x - hw - r, y - hh - r, (hw + r) * 2, (hh + r) * 2, r)
  ctx.stroke()
}

/** Strokes one isoline of a sampled scalar field as smooth vector contours
 * (marching squares with linear interpolation between cell centers), so the
 * curve renders at native resolution instead of the field's raster grid. */
function strokeIso(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: Extract<VizPrimitive, { kind: 'field' }>,
  iso: number,
  alpha: number,
  width: number,
  zoom: number,
) {
  const { cols, rows } = p
  const v = (gx: number, gy: number) => Number(p.values[p.valuesStart + gy * cols + gx])
  const cx = (g: number) => (p.originX + (g + 0.5) * p.cell) * zoom
  const cy = (g: number) => (p.originY + (g + 0.5) * p.cell) * zoom
  ctx.strokeStyle = vizCss(key, alpha)
  ctx.lineWidth = width
  ctx.beginPath()
  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const a = v(gx, gy)
      const b = v(gx + 1, gy)
      const c = v(gx + 1, gy + 1)
      const d = v(gx, gy + 1)
      let idx = 0
      if (a >= iso) idx |= 1
      if (b >= iso) idx |= 2
      if (c >= iso) idx |= 4
      if (d >= iso) idx |= 8
      if (idx === 0 || idx === 15) continue
      const t = (v1: number, v2: number) => (iso - v1) / (v2 - v1)
      const top = () => [cx(gx) + (cx(gx + 1) - cx(gx)) * t(a, b), cy(gy)]
      const right = () => [cx(gx + 1), cy(gy) + (cy(gy + 1) - cy(gy)) * t(b, c)]
      const bottom = () => [cx(gx) + (cx(gx + 1) - cx(gx)) * t(d, c), cy(gy + 1)]
      const left = () => [cx(gx), cy(gy) + (cy(gy + 1) - cy(gy)) * t(a, d)]
      const seg = (e1: number[], e2: number[]) => {
        ctx.moveTo(e1[0], e1[1])
        ctx.lineTo(e2[0], e2[1])
      }
      switch (idx) {
        case 1:
        case 14:
          seg(left(), top())
          break
        case 2:
        case 13:
          seg(top(), right())
          break
        case 3:
        case 12:
          seg(left(), right())
          break
        case 4:
        case 11:
          seg(right(), bottom())
          break
        case 6:
        case 9:
          seg(top(), bottom())
          break
        case 7:
        case 8:
          seg(left(), bottom())
          break
        case 5:
          seg(left(), top())
          seg(right(), bottom())
          break
        case 10:
          seg(top(), right())
          seg(left(), bottom())
          break
      }
    }
  }
  ctx.stroke()
}

function drawField(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: Extract<VizPrimitive, { kind: 'field' }>,
  zoom: number,
) {
  const { cols, rows } = p
  if (cols < 2 || rows < 2) return
  const [cr, cg, cb] = vizRgb(key)
  const img = new ImageData(cols, rows)
  const band = Math.max(p.outer - p.inner, 1e-6)
  for (let i = 0; i < cols * rows; i++) {
    const d = Number(p.values[p.valuesStart + i])
    let a = 0
    if (d < p.inner) a = 0.3
    else if (d < p.outer) a = 0.3 * (1 - (d - p.inner) / band)
    if (a > 0) {
      img.data[i * 4] = cr
      img.data[i * 4 + 1] = cg
      img.data[i * 4 + 2] = cb
      img.data[i * 4 + 3] = Math.round(a * 255)
    }
  }
  const small = document.createElement('canvas')
  small.width = cols
  small.height = rows
  small.getContext('2d')?.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(
    small,
    p.originX * zoom,
    p.originY * zoom,
    cols * p.cell * zoom,
    rows * p.cell * zoom,
  )
  // Body and range-limit isolines as smooth vector contours.
  strokeIso(ctx, key, p, p.inner, 0.8, 1.2, zoom)
  strokeIso(ctx, key, p, p.outer, 0.4, 1, zoom)
}

let maxScratch: HTMLCanvasElement | null = null

function drawGroup(ctx: CanvasRenderingContext2D, g: VizGroup, zoom: number, gradientOnly: boolean) {
  const scale = groupScale(g)
  for (const p of g.primitives) {
    if (p.kind === 'ring') drawRing(ctx, g.key, p, Math.abs(p.intensity) / scale, zoom, gradientOnly)
    else if (p.kind === 'capsule') drawCapsule(ctx, g.key, p, 1 / scale, zoom)
    else if (p.kind === 'rectRing') drawRectRing(ctx, g.key, p, Math.abs(p.intensity) / scale, zoom)
    else drawField(ctx, g.key, p, zoom)
  }
}

/** Renders viz groups onto a page-space canvas (world units × zoom). */
export function drawViz(ctx: CanvasRenderingContext2D, groups: VizGroup[], zoom: number): void {
  for (const g of groups) {
    if (g.blend === 'max') {
      // Physics says the strongest primitive wins at each point, so the
      // view composites with lighten (per-channel max) on a scratch layer
      // — dense overlapping samples read as one smooth blob, exactly like
      // the force field.
      const w = ctx.canvas.width
      const h = ctx.canvas.height
      if (!maxScratch) maxScratch = document.createElement('canvas')
      if (maxScratch.width !== w || maxScratch.height !== h) {
        maxScratch.width = w
        maxScratch.height = h
      }
      const sctx = maxScratch.getContext('2d')
      if (!sctx) continue
      sctx.setTransform(1, 0, 0, 1, 0, 0)
      sctx.clearRect(0, 0, w, h)
      sctx.setTransform(ctx.getTransform())
      sctx.globalCompositeOperation = 'lighten'
      drawGroup(sctx, g, zoom, true)
      sctx.globalCompositeOperation = 'source-over'
      const t = ctx.getTransform()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(maxScratch, 0, 0)
      ctx.setTransform(t)
    } else {
      drawGroup(ctx, g, zoom, false)
    }
  }
}
