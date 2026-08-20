import type { VizGroup, VizPrimitive } from '@cazala/party'
import { bodyDistance, forceAt, peakForce } from './effectors'

/**
 * Generic debug renderer for the engine's viz contract. Every body is drawn
 * as a glow whose opacity at each point is the actual force a particle there
 * would feel from it, evaluated with `forceAt` — the same function the check
 * asserts the physics against — so the picture cannot be tuned independently
 * of the simulation. Colors are derived deterministically from group keys.
 *
 * The scale is anchored globally: the strongest force present anywhere in the
 * system renders at `maxOpacity`, and everything else is shown relative to
 * it. A source an order of magnitude weaker looks an order of magnitude
 * fainter, because it is.
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

/** The strongest force any live primitive can exert. Anchors the opacity
 * scale, so it is a scan of peaks rather than a search over space. */
export function vizFmax(groups: VizGroup[]): number {
  let max = 0
  for (const g of groups) {
    for (const p of g.primitives) {
      const peak = peakForce(p)
      if (peak > max) max = peak
    }
  }
  return max
}

/** Below half an 8-bit quantum the glow is indistinguishable from nothing.
 * This is a property of the pixel format, not of the physics — it is the
 * only constant in this file that shapes what gets drawn. */
const ALPHA_QUANTUM = 0.5 / 255
/** Cells evaluated per group per frame. Cells coarsen rather than the field
 * being clipped, so a glow never loses its outer reach to a budget. */
const CELL_BUDGET = 600_000
const MIN_CELL_PX = 3

/**
 * World-space box outside which this primitive cannot raise a single alpha
 * quantum, so painting past it is provably invisible rather than merely
 * unlikely. The bounded field law stops at its range; the inverse-square law
 * never reaches zero, so its edge is solved from the law itself:
 *
 *   k * peak * L^2 / (r^2 + L^2) = ALPHA_QUANTUM
 *   r = L * sqrt(k * peak / ALPHA_QUANTUM - 1)
 *
 * `k` is maxOpacity / fmax. The only constant involved is the 8-bit quantum,
 * which is a property of the pixel format, not of the physics.
 */
function extent(p: VizPrimitive, k: number): [number, number, number, number] {
  if (p.kind === 'field') {
    return [p.originX, p.originY, p.originX + p.cols * p.cell, p.originY + p.rows * p.cell]
  }
  const reach = p.soften * Math.sqrt(Math.max(0, (k * peakForce(p)) / ALPHA_QUANTUM - 1))
  if (p.kind === 'segment') {
    return [
      Math.min(p.x1, p.x2) - reach,
      Math.min(p.y1, p.y2) - reach,
      Math.max(p.x1, p.x2) + reach,
      Math.max(p.y1, p.y2) + reach,
    ]
  }
  return [p.x - p.hw - reach, p.y - p.hh - reach, p.x + p.hw + reach, p.y + p.hh + reach]
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  g: VizGroup,
  zoom: number,
  fmax: number,
  maxOpacity: number,
  viewW: number,
  viewH: number,
) {
  // A primitive whose own peak cannot reach one alpha quantum is invisible
  // at this anchor; skipping it is exact, not an approximation.
  const k = maxOpacity / fmax
  const live = g.primitives.filter((p) => k * peakForce(p) >= ALPHA_QUANTUM)
  if (live.length === 0) return

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of live) {
    const e = extent(p, k)
    if (e[0] < x0) x0 = e[0]
    if (e[1] < y0) y0 = e[1]
    if (e[2] > x1) x1 = e[2]
    if (e[3] > y1) y1 = e[3]
  }
  // Clip to the viewport in page px.
  x0 = Math.max(0, x0 * zoom)
  y0 = Math.max(0, y0 * zoom)
  x1 = Math.min(viewW, x1 * zoom)
  y1 = Math.min(viewH, y1 * zoom)
  const w = x1 - x0
  const h = y1 - y0
  if (!(w > 0 && h > 0)) return

  const cell = Math.max(MIN_CELL_PX, Math.sqrt((w * h) / CELL_BUDGET))
  const cols = Math.max(1, Math.ceil(w / cell))
  const rows = Math.max(1, Math.ceil(h / cell))
  const img = new ImageData(cols, rows)
  const px = img.data
  const [cr, cg, cb] = vizRgb(g.key)
  const isMax = g.blend === 'max'
  // Outline the body the force is measured from, one cell thick. Skipped for
  // max-blend groups: their primitives are dense curve samples, so per-sample
  // outlines would be noise rather than geometry.
  const halfLine = isMax ? -1 : (cell / zoom) * 0.5
  const out: [number, number] = [0, 0]

  for (let r = 0; r < rows; r++) {
    const wy = (y0 + (r + 0.5) * cell) / zoom
    for (let c = 0; c < cols; c++) {
      const wx = (x0 + (c + 0.5) * cell) / zoom
      let sx = 0
      let sy = 0
      let best = 0
      for (const p of live) {
        const m = forceAt(p, wx, wy, out)
        if (m === 0) continue
        if (isMax) {
          // The physics takes the single strongest sample, so the picture does.
          if (m > best) best = m
        } else {
          sx += out[0]
          sy += out[1]
        }
      }
      let a = 0
      if (halfLine > 0) {
        for (const p of live) {
          const bd = bodyDistance(p, wx, wy)
          if (bd === bd && Math.abs(bd) <= halfLine) { a = maxOpacity; break }
        }
      }
      if (a === 0) {
        const mag = isMax ? best : Math.hypot(sx, sy)
        if (mag <= 0) continue
        a = Math.min(maxOpacity, k * mag)
      }
      if (a < ALPHA_QUANTUM) continue
      const o = (r * cols + c) * 4
      px[o] = cr
      px[o + 1] = cg
      px[o + 2] = cb
      px[o + 3] = Math.round(a * 255)
    }
  }

  // Blit at cell resolution and let the canvas smooth it up to page px.
  const tile = document.createElement('canvas')
  tile.width = cols
  tile.height = rows
  const tctx = tile.getContext('2d')
  if (!tctx) return
  tctx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(tile, x0, y0, w, h)
}

/**
 * Paint every group's glow. `fmax` anchors opacity globally (see `vizFmax`)
 * and `maxOpacity` is the ceiling the strongest force renders at.
 *
 * Groups composite source-over, so overlapping bodies show as overlapping
 * glows rather than as their net field: this answers "which bodies act here,
 * and how hard", not "what is the resultant force". Within a group the
 * combination does match the physics — summed, or strongest-wins for
 * `blend: 'max'`.
 */
export function drawViz(
  ctx: CanvasRenderingContext2D,
  groups: VizGroup[],
  zoom: number,
  fmax: number,
  maxOpacity: number,
): void {
  if (!(fmax > 0) || !(maxOpacity > 0)) return
  const t = ctx.getTransform()
  const dpr = t.a || 1
  const viewW = ctx.canvas.width / dpr
  const viewH = ctx.canvas.height / dpr
  for (const g of groups) drawGlow(ctx, g, zoom, fmax, maxOpacity, viewW, viewH)
}
