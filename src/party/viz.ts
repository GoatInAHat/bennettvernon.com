import type { VizGroup, VizPrimitive } from '@cazala/party'
import { forceAt, peakForce } from './effectors'

/**
 * Generic debug renderer for the engine's viz contract. Every body is drawn
 * as a glow whose opacity at each point is the actual force a particle there
 * would feel from it, evaluated with `forceAt` — the same function the check
 * asserts the physics against — so the picture cannot be tuned independently
 * of the simulation. Colors are derived deterministically from group keys.
 *
 * Force maps to opacity through a saturating curve against a fixed reference:
 *
 *   alpha = maxOpacity * m / (m + reference)
 *
 * so `reference` renders at half of `maxOpacity`, ten times it at ten
 * elevenths, and nothing ever reaches the ceiling. Three properties fall out,
 * and all three were broken by the global anchor this replaces:
 *
 * - `maxOpacity` is a MULTIPLIER. It scales the whole picture and changes
 *   nothing about the relative brightness of two bodies.
 * - No body's brightness depends on any other body. The anchor divided every
 *   glow by the strongest force in the system, so dragging the cursor — the
 *   strongest thing on the page while it moves — dimmed the name, the text
 *   and the dividers for as long as it moved.
 * - Nothing saturates. Clipping at `maxOpacity` turned the whole region where
 *   the force was merely strong into one flat slab at the ceiling, so a glow
 *   read as a solid shape with an edge where it finally dropped below the cap
 *   rather than as light falling off. The falloff is now visible everywhere,
 *   which is also what makes a boost like the name's concavity multiplier
 *   show up at all: under the anchor a stronger force in the pocket raised
 *   both the numerator and the anchor, so the pocket rendered at exactly the
 *   same opacity no matter how far the multiplier was turned up.
 *
 * Near zero the curve is linear in the force (m / reference), so weak fields
 * stay proportional to each other; it only compresses once a force is large
 * against the reference, which is the range where the difference between
 * "strong" and "stronger" does not need pixels spent on it.
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


/** Below half an 8-bit quantum the glow is indistinguishable from nothing.
 * This is a property of the pixel format, not of the physics — it is the
 * only constant in this file that shapes what gets drawn. */
const ALPHA_QUANTUM = 0.5 / 255
/**
 * Force evaluations per group per frame. The budget is on EVALUATIONS, not
 * cells: every cell is tested against every live primitive, so a hundred-span
 * cursor trail costs a hundred times a single body at the same resolution.
 * Budgeting cells alone let the trail reach ~7.7M evaluations a frame, which
 * stalls the main thread hard enough that the simulation loses frames and
 * looks like the forces switched off. Cells coarsen instead, so a glow never
 * loses its outer reach to the budget — only its sharpness, and only while
 * something is moving.
 */
const EVAL_BUDGET = 400_000
const MIN_CELL_PX = 3
/**
 * Opacity at which a glow is treated as finished. Four steps out of 255 --
 * about 1.6% -- so the edge is a step of one and a half percent of the
 * darkest the glow ever gets, against a white page. Set at the single
 * representable step instead, the tail reaches nearly three times further for
 * nothing anyone can see, and the cost of that reach is what pushed the
 * sample grid coarse enough to show its own interpolation.
 */
const EDGE_ALPHA = 4 / 255

/** Opacity of a force magnitude. See the header: saturating, so `maxOpacity`
 * multiplies rather than anchors, and nothing ever clips. */
const alphaOf = (m: number, maxOpacity: number, reference: number): number =>
  (maxOpacity * m) / (m + reference)

/**
 * Where a body stops being painted, as a force magnitude -- `alphaOf`
 * inverted at `EDGE_ALPHA`.
 *
 * An inverse-square tail never reaches zero, so this is what decides how much
 * of it gets drawn, and it costs quadratically: the reach goes as
 * sqrt(peak / floor), so painting down to the last representable step means a
 * box twice as wide as painting down to four steps, and four times the pixels
 * to fill and to blit every frame. The cursor trail's box spanned the entire
 * viewport at one step, which is what made the debug view crawl while the
 * cursor moved -- and every one of those pixels was carrying an alpha of one
 * or two out of 255.
 */
const faintest = (maxOpacity: number, reference: number): number =>
  maxOpacity > EDGE_ALPHA ? (EDGE_ALPHA * reference) / (maxOpacity - EDGE_ALPHA) : Infinity

/**
 * World-space box outside which this primitive cannot raise a single alpha
 * quantum, so painting past it is provably invisible rather than merely
 * unlikely. The bounded field law stops at its range; the inverse-square law
 * never reaches zero, so its edge is solved from the law itself:
 *
 *   peak * L^2 / (r^2 + L^2) = faintest
 *   r = L * sqrt(peak / faintest - 1)
 *
 * The only constant involved is the 8-bit quantum, which is a property of the
 * pixel format, not of the physics.
 */
function extent(p: VizPrimitive, floor: number): [number, number, number, number] {
  if (p.kind === 'field') {
    return [p.originX, p.originY, p.originX + p.cols * p.cell, p.originY + p.rows * p.cell]
  }
  const reach = p.soften * Math.sqrt(Math.max(0, peakForce(p) / floor - 1))
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
  reference: number,
  maxOpacity: number,
  viewW: number,
  viewH: number,
) {
  // A primitive whose own peak cannot reach one alpha quantum is invisible;
  // skipping it is exact, not an approximation.
  const floor = faintest(maxOpacity, reference)
  const live = g.primitives.filter((p) => peakForce(p) >= floor)
  if (live.length === 0) return

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of live) {
    const e = extent(p, floor)
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

  const isMax = g.blend === 'max'
  const [cr, cg, cb] = vizRgb(g.key)
  const out: [number, number] = [0, 0]

  // Cells coarsen rather than the glow losing its reach: every cell is tested
  // against every primitive, so a forty-span cursor trail costs forty times a
  // single body at the same resolution.
  //
  // Pruning the primitives per cell was tried and measured: order them
  // strongest-first and reject one whose peak over its distance to its own
  // geometry box cannot beat the best found so far. It is exact and it does
  // reject almost everything -- and it made no difference, because in JS the
  // loop iteration and the property reads cost about what the evaluation
  // costs, so rejecting a primitive is barely cheaper than evaluating it.
  // Forcing 3px cells on the strength of the rejection count took the frame
  // from 8ms to 124ms. What the trail needs is a rasterizer that is not a
  // scalar loop over cells; that is the GPU, and it is a bigger change than
  // this file.
  const cell = Math.max(MIN_CELL_PX, Math.sqrt((w * h * live.length) / EVAL_BUDGET))
  // The sample grid is snapped to a multiple of the cell size in page space.
  // The box tracks the cursor, so an unsnapped origin dragged the sample
  // points along with it, and the interpolation pattern between samples slid
  // across the glow every frame -- which is what read as a line moving
  // through the cursor. Snapped, the samples hold still and only their values
  // change.
  const gx0 = Math.floor(x0 / cell) * cell
  const gy0 = Math.floor(y0 / cell) * cell
  const cols = Math.max(1, Math.ceil((x1 - gx0) / cell))
  const rows = Math.max(1, Math.ceil((y1 - gy0) / cell))
  const img = new ImageData(cols, rows)
  const px = img.data

  for (let r = 0; r < rows; r++) {
    const wy = (gy0 + (r + 0.5) * cell) / zoom
    for (let c = 0; c < cols; c++) {
      const wx = (gx0 + (c + 0.5) * cell) / zoom
      let sx = 0
      let sy = 0
      let best = 0
      // Indexed, not `for...of`: this is the innermost loop of the whole
      // renderer and the iterator protocol is not free at four hundred
      // thousand calls a frame.
      for (let i = 0; i < live.length; i++) {
        const m = forceAt(live[i], wx, wy, out)
        if (m === 0) continue
        if (isMax) {
          // The physics takes the single strongest sample, so the picture does.
          if (m > best) best = m
        } else {
          sx += out[0]
          sy += out[1]
        }
      }
      const mag = isMax ? best : Math.hypot(sx, sy)
      if (mag <= 0) continue
      const a = alphaOf(mag, maxOpacity, reference)
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
  ctx.drawImage(tile, gx0, gy0, cols * cell, rows * cell)
}

/**
 * Append the `iso` contour of a field to the current path by marching
 * squares, interpolating each crossing along its cell edge. Traced as vector
 * segments rather than tested per raster cell: a distance grid quantizes to
 * whole cells, so a "within half a cell of the isoline" test misses most of
 * the contour and draws a dotted ghost of it.
 */
function isoPath(
  ctx: CanvasRenderingContext2D,
  p: Extract<VizPrimitive, { kind: 'field' }>,
  iso: number,
  zoom: number,
) {
  const { cols, rows } = p
  if (cols < 2 || rows < 2) return
  const v = (gx: number, gy: number) => Number(p.values[p.valuesStart + gy * cols + gx])
  const cx = (g: number) => (p.originX + (g + 0.5) * p.cell) * zoom
  const cy = (g: number) => (p.originY + (g + 0.5) * p.cell) * zoom
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
      const top = (): [number, number] => [cx(gx) + (cx(gx + 1) - cx(gx)) * t(a, b), cy(gy)]
      const right = (): [number, number] => [cx(gx + 1), cy(gy) + (cy(gy + 1) - cy(gy)) * t(b, c)]
      const bottom = (): [number, number] => [cx(gx) + (cx(gx + 1) - cx(gx)) * t(d, c), cy(gy + 1)]
      const left = (): [number, number] => [cx(gx), cy(gy) + (cy(gy + 1) - cy(gy)) * t(a, d)]
      const seg = (e1: [number, number], e2: [number, number]) => {
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
}

/**
 * Outline the body each primitive's force is measured from: the segment a
 * pill pulls toward, the rect's edge, and for a field the isoline that is its
 * surface — the text shape dilated by its standoff, the letter surface of the
 * name. Drawn from the same geometry the physics uses, on top of the glow.
 *
 * Max-blend groups are skipped: their primitives are dense samples of one
 * curve, so per-sample outlines would be noise rather than geometry.
 */
function strokeBodies(
  ctx: CanvasRenderingContext2D,
  g: VizGroup,
  zoom: number,
  maxOpacity: number,
) {
  if (g.blend === 'max') return
  ctx.strokeStyle = vizCss(g.key, Math.min(1, maxOpacity + 0.1))
  ctx.lineWidth = 1.25
  ctx.beginPath()
  // Regions that scale a body's force rather than emit it -- the convex
  // hulls the name's concavity boost is filled from -- are drawn dashed, so
  // the solid contour always means "this is the body".
  ctx.save()
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1
  ctx.strokeStyle = vizCss(g.key, Math.min(1, maxOpacity * 0.7))
  ctx.beginPath()
  for (const p of g.primitives) {
    if (p.kind !== 'field' || !p.boost?.hulls) continue
    for (const poly of p.boost.hulls) {
      if (poly.length < 3) continue
      ctx.moveTo(poly[0][0] * zoom, poly[0][1] * zoom)
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] * zoom, poly[i][1] * zoom)
      ctx.closePath()
    }
  }
  ctx.stroke()
  ctx.restore()

  ctx.beginPath()
  for (const p of g.primitives) {
    if (p.kind === 'rect') {
      ctx.rect((p.x - p.hw) * zoom, (p.y - p.hh) * zoom, p.hw * 2 * zoom, p.hh * 2 * zoom)
    } else if (p.kind === 'segment') {
      ctx.moveTo(p.x1 * zoom, p.y1 * zoom)
      ctx.lineTo(p.x2 * zoom, p.y2 * zoom)
    } else {
      isoPath(ctx, p, p.offset ?? 0, zoom)
    }
  }
  ctx.stroke()
}

/**
 * Paint every group's glow. `reference` is the force that renders at half of
 * `maxOpacity` -- the scale the saturating curve is measured against, which
 * the caller supplies because only the caller knows what one unit of force
 * means for its own physics. `maxOpacity` then multiplies the result.
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
  reference: number,
  maxOpacity: number,
): void {
  if (!(reference > 0) || !(maxOpacity > 0)) return
  const t = ctx.getTransform()
  const dpr = t.a || 1
  const viewW = ctx.canvas.width / dpr
  const viewH = ctx.canvas.height / dpr
  for (const g of groups) {
    drawGlow(ctx, g, zoom, reference, maxOpacity, viewW, viewH)
    strokeBodies(ctx, g, zoom, maxOpacity)
  }
}
