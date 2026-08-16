import { useEffect, useRef } from 'react'
import { Engine, Interaction, type IParticle, type CellCensusResult } from '@cazala/party'
import {
  bridge,
  NAME_FONTS,
  MODE_SETTING_KEYS,
  type GlobalSettings,
  type GlobalSettingKey,
  type ModeSettingKey,
  type ModeSettings,
} from './bridge'
import { Effectors, type Effector, type TrailSegment } from './effectors'
import {
  createPartyModules,
  applyDiscretePreset,
  applyPresetOscillators,
  DEMO_PRESETS,
  PARAM_DEFS,
} from './presets'
import { getTargets, onTargetsChanged } from './targets'

const NAME_LINES = ['BENNETT', 'VERNON']
const GUTTER_PX = 22
/** The name sits this far from both the left and the top edge. */
const NAME_MARGIN_PX = GUTTER_PX * 2
// A zero innerWidth means the viewport is not measurable yet (hidden or
// pre-layout) — treat it as desktop rather than mobile.
const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (window.innerWidth >= 1 && window.innerWidth < 768)
const DESIRED_ZOOM = () => (isMobile() ? 0.2 : 0.3)
const SWARM_BUDGET = (webgpu: boolean) => (webgpu ? (isMobile() ? 24_000 : 80_000) : 2_500)
/** Particles spawned up front; the particle-count setting caps the effective
 * count via maxParticles so changing it never respawns the swarm. */
const PARTICLE_POOL = (webgpu: boolean) => (webgpu ? 80_000 : 8_000)
/** Backing-store cap; taller pages render uniformly downscaled so the
 * simulation always reaches the bottom of the page. */
const MAX_CANVAS_HEIGHT = 8_000

/** Effector tuning (world units are CSS px / zoom). */
const PANEL_RANGE_PX = 6
const BOX_CORNER_PX = 6
const SEPARATOR_RANGE_PX = 90
const SPAWN_SPREAD_PX = 60
const SPAWN_SPEED = 100
const TRAIL_BASE_TTL_MS = 900
const TRAIL_POINT_RANGE_PX = 80
const TRAIL_MIN_SPACING_PX = 10
const TRAIL_MAX_POINTS = 32

const GLOBAL_DEFAULTS: GlobalSettings = {
  particleCount: 0, // resolved to the device budget once the runtime is known
  dragStrength: 100_000,
  dragRadius: 800,
  nameAttraction: 10_000,
  boxAttraction: 100_000,
  textPadding: 8,
  textSmoothing: 1.8,
  exclusionFalloff: 36,
  separatorAttraction: 15_000,
  cursorStrength: 6_000,
  trailIntensity: 0.5,
  cursorFalloff: 0.5,
  modeDuration: 15,
  transitionLength: 2.5,
  nameFont: 0,
  nameWeight: 700,
  nameDensity: 1000,
  nameDensityRes: 36,
}
// Name-density enforcement runs off the engine's cell census: a per-frame
// GPU compute pass with an asynchronous readback, so it never stalls the
// pipeline. Corrections apply whenever a fresh census lands (~every frame).
const CENSUS_SAMPLES_PER_CELL = 64
const CENSUS_OUTSIDE_SAMPLES = 512
/** Distance-field raster resolution in page px per cell. */
const FIELD_CELL_PX = 3
const FIELD_MARGIN_PX = 60

function nameWidth(pageW: number): number {
  // ~1/3 of the page on desktop (min sized for a regular ~1440px desktop);
  // below the width where that would exceed 3/4 of the page, span the page.
  const desktop = Math.max(pageW / 3, 480)
  return desktop >= pageW * 0.75 ? pageW - NAME_MARGIN_PX * 2 : desktop
}

interface NameLayout {
  /** Page-space glyph sample points the particles are attracted to. */
  points: { x: number; y: number }[]
  bottom: number
  width: number
  /** Sampling step in page px; also drives attractor range and spawn jitter. */
  step: number
  /** Type geometry for the debug outline. */
  size: number
  topY: number
  lineGap: number
}

/** Samples the name glyphs into page-space points, top-left justified. */
function sampleName(pageW: number, viewportH: number, font: string, weight: number): NameLayout {
  const off = document.createElement('canvas')
  const ctx = off.getContext('2d', { willReadFrequently: true })
  const width = Math.max(nameWidth(pageW), 200)
  const fallback = {
    points: [],
    bottom: viewportH * 0.4,
    width,
    step: 10,
    size: 0,
    topY: 0,
    lineGap: 0,
  }
  if (!ctx) return fallback
  ctx.font = `${weight} 100px ${font}`
  const widest = Math.max(...NAME_LINES.map((l) => ctx.measureText(l).width))
  const size = (100 * width) / widest
  const lineGap = size * 1.08
  const topY = NAME_MARGIN_PX
  const step = Math.max(9, Math.round(size / 14))

  const points: { x: number; y: number }[] = []
  NAME_LINES.forEach((text, i) => {
    off.width = Math.ceil(width) + step * 2
    off.height = Math.ceil(size * 1.3)
    const c = off.getContext('2d', { willReadFrequently: true })
    if (!c) return
    c.clearRect(0, 0, off.width, off.height)
    c.font = `${weight} ${size}px ${font}`
    c.textBaseline = 'top'
    c.fillStyle = '#fff'
    c.fillText(text, 0, 0)
    const data = c.getImageData(0, 0, off.width, off.height).data
    for (let y = 0; y < off.height; y += step) {
      for (let x = 0; x < off.width; x += step) {
        if (data[(y * off.width + x) * 4 + 3] > 64) {
          points.push({ x: NAME_MARGIN_PX + x, y: topY + i * lineGap + y })
        }
      }
    }
  })
  return { points, bottom: topY + lineGap + size * 1.1, width, step, size, topY, lineGap }
}

interface CharBall {
  x: number
  y: number
  /** Glyph radius in page px (before smoothing/padding). */
  r: number
}

/** Page-space balls, one per rendered glitchable character span. */
function collectCharBalls(): CharBall[] {
  const balls: CharBall[] = []
  for (const el of document.querySelectorAll<HTMLElement>('main .g')) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    balls.push({
      x: r.left + window.scrollX + r.width / 2,
      y: r.top + window.scrollY + r.height / 2,
      r: Math.max(r.width, r.height * 0.72) / 2,
    })
  }
  return balls
}

/** Felzenszwalb 1D squared distance transform, applied in place. */
function edt1d(f: Float32Array, n: number, out: Float32Array) {
  const v = new Int32Array(n)
  const z = new Float32Array(n + 1)
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    out[q] = dq * dq + f[v[k]]
  }
}

/** 2D Euclidean distance (in cells) to the nearest true cell of `mask`. */
function edt2d(mask: Uint8Array, cols: number, rows: number): Float32Array {
  const INF = 1e12
  const g = new Float32Array(cols * rows)
  const col = new Float32Array(rows)
  const out = new Float32Array(rows)
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) col[y] = mask[y * cols + x] ? 0 : INF
    edt1d(col, rows, out)
    for (let y = 0; y < rows; y++) g[y * cols + x] = out[y]
  }
  const row = new Float32Array(cols)
  const rowOut = new Float32Array(cols)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) row[x] = g[y * cols + x]
    edt1d(row, cols, rowOut)
    for (let x = 0; x < cols; x++) g[y * cols + x] = Math.sqrt(rowOut[x])
  }
  return g
}

const easeInOutCubic = (p: number) =>
  p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2

export function PartyBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const debugRef = useRef<HTMLCanvasElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const debugCanvas = debugRef.current
    const holder = holderRef.current
    if (!canvas || !debugCanvas || !holder) return

    let disposed = false
    let engine: Engine | null = null
    let zoom = DESIRED_ZOOM()
    let webgpu = false
    let demoIndex = 0
    let demoTimer = 0
    let maxParticlesRaf = 0
    let tickRaf = 0
    let syncScheduled = false
    const globals: GlobalSettings = { ...GLOBAL_DEFAULTS, dragRadius: isMobile() ? 700 : 800 }
    const overrides: Partial<Record<number, Partial<ModeSettings>>> = {}
    const currentParams: Record<string, number> = {}
    let transition: { from: Record<string, number>; to: Record<string, number>; t0: number; ms: number; preset: (typeof DEMO_PRESETS)[number] } | null = null
    let name: NameLayout | null = null
    let charBalls: CharBall[] = []
    let voroSeeds: { x: number; y: number }[] = []
    let voroCellPoints: number[][] = []
    let glyphGrid: {
      minX: number
      minY: number
      cols: number
      rows: number
      step: number
      cellOf: Int16Array
    } | null = null
    let particleCountTouched = false
    let densityStatus = 'idle'
    const densityStats = {
      calls: 0,
      noRes: 0,
      stale: 0,
      mismatch: 0,
      rounds: 0,
      fromCells: 0,
      fromOutside: 0,
      lastCounts: [] as number[],
    }
    let censusCells: Int32Array | null = null
    let censusVersion = 0
    let lastCensus: CellCensusResult | null = null
    /** Net corrections issued since the in-flight census was dispatched. */
    let pendingDelta1: number[] = []
    let lastCpuRound = 0
    let teleportCount = 0
    let teleportWindowStart = 0
    let teleportRate = 0
    let staticEffectors: Effector[] = []
    let dynamicDirty = false
    const frameDts = new Float32Array(120)
    let frameDtIndex = 0
    let lastTickAt = 0
    let trail: { x: number; y: number; t: number }[] = []
    /** Page-space trail nodes with their current strength fraction, kept in
     * sync with the physics for the debug overlay. */
    let trailViz: { x: number; y: number; s: number }[] = []
    let cursor: { x: number; y: number } | null = null
    let dragging = false
    // Debug overlay layers, cached separately because they invalidate on
    // different events (field/settings, name geometry, effector layout).
    let blobCache: HTMLCanvasElement | null = null
    let blobCacheDirty = true
    let voroCache: HTMLCanvasElement | null = null
    let voroCacheDirty = true
    let effCache: HTMLCanvasElement | null = null
    let effCacheDirty = true
    const cleanups: (() => void)[] = []

    // Rebuilt on every engine boot: a destroyed runtime leaves stale uniform
    // writers attached to old module instances, so reuse is unsafe.
    let mods = createPartyModules()
    let interaction = new Interaction({
      mode: 'repel',
      strength: globals.dragStrength,
      radius: globals.dragRadius,
      active: false,
    })
    let effectors = new Effectors()

    const nameFontStack = () => NAME_FONTS[globals.nameFont]?.stack ?? NAME_FONTS[0].stack
    const pageToWorld = (px: number, py: number) => ({ x: px / zoom, y: py / zoom })

    const toPageRect = (r: DOMRect) => ({
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
    })

    interface TextField {
      /** Page-space origin and cell size of the distance grid. */
      minX: number
      minY: number
      cell: number
      cols: number
      rows: number
      /** Distances in page px, negative inside the closed text shape. */
      d: Float32Array
    }
    let textField: TextField | null = null

    // Rasterizes the real vector glyphs of every content character, closes
    // the shape morphologically (dilate+erode) so pockets between lines fill
    // in, and derives a signed distance field. The blob-smoothing setting is
    // the closing radius.
    const buildTextField = () => {
      textField = null
      const spans = [...document.querySelectorAll<HTMLElement>('main .g')]
      if (spans.length === 0) {
        effectors.setField(null)
        return
      }
      const rects = spans.map((el) => toPageRect(el.getBoundingClientRect()))
      const minX = Math.min(...rects.map((r) => r.x)) - FIELD_MARGIN_PX
      const minY = Math.min(...rects.map((r) => r.y)) - FIELD_MARGIN_PX
      const maxX = Math.max(...rects.map((r) => r.x + r.w)) + FIELD_MARGIN_PX
      const maxY = Math.max(...rects.map((r) => r.y + r.h)) + FIELD_MARGIN_PX
      const cell = FIELD_CELL_PX
      const cols = Math.ceil((maxX - minX) / cell)
      const rows = Math.ceil((maxY - minY) / cell)
      if (cols < 4 || rows < 4 || cols * rows > 2_000_000) return

      const raster = document.createElement('canvas')
      raster.width = cols
      raster.height = rows
      const ctx = raster.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.setTransform(1 / cell, 0, 0, 1 / cell, -minX / cell, -minY / cell)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'top'
      const fontCache = new Map<Element, string>()
      spans.forEach((el, i) => {
        const parent = el.parentElement
        if (!parent) return
        let font = fontCache.get(parent)
        if (!font) {
          font = getComputedStyle(parent).font
          fontCache.set(parent, font)
        }
        ctx.font = font
        ctx.fillText(el.textContent ?? '', rects[i].x, rects[i].y)
      })
      const alpha = ctx.getImageData(0, 0, cols, rows).data
      const mask = new Uint8Array(cols * rows)
      for (let i = 0; i < mask.length; i++) mask[i] = alpha[i * 4 + 3] > 64 ? 1 : 0

      // Morphological closing in cell units fills pockets between lines.
      const rc = Math.max(1, ((3 + globals.textSmoothing * 5) / cell) * 1.5)
      const distToText = edt2d(mask, cols, rows)
      const dilated = new Uint8Array(cols * rows)
      for (let i = 0; i < dilated.length; i++) dilated[i] = distToText[i] <= rc ? 1 : 0
      const inverseDilated = new Uint8Array(cols * rows)
      for (let i = 0; i < dilated.length; i++) inverseDilated[i] = dilated[i] ? 0 : 1
      const distToOutside = edt2d(inverseDilated, cols, rows)
      const closed = new Uint8Array(cols * rows)
      for (let i = 0; i < closed.length; i++) closed[i] = distToOutside[i] > rc ? 1 : 0

      const inverseClosed = new Uint8Array(cols * rows)
      for (let i = 0; i < closed.length; i++) inverseClosed[i] = closed[i] ? 0 : 1
      const outerDist = edt2d(closed, cols, rows)
      const innerDist = edt2d(inverseClosed, cols, rows)
      const d = new Float32Array(cols * rows)
      for (let i = 0; i < d.length; i++) {
        d[i] = (closed[i] ? -innerDist[i] : outerDist[i]) * cell
      }
      textField = { minX, minY, cell, cols, rows, d }
      pushField()
    }

    /** Uploads the field with the current strength/padding header. */
    const pushField = () => {
      if (!textField) {
        effectors.setField(null)
        return
      }
      const world = new Float32Array(textField.d.length)
      for (let i = 0; i < world.length; i++) world[i] = textField.d[i] / zoom
      effectors.setField({
        originX: textField.minX / zoom,
        originY: textField.minY / zoom,
        cell: textField.cell / zoom,
        cols: textField.cols,
        rows: textField.rows,
        strength: globals.boxAttraction,
        padding: globals.textPadding / zoom,
        falloff: globals.exclusionFalloff / zoom,
        distances: world,
      })
    }

    /** Red layer: the closed text exclusion shape, with the repel force
     * fading out as a gradient band between padding and padding+falloff. */
    const renderBlobCache = () => {
      blobCacheDirty = false
      if (!blobCache) blobCache = document.createElement('canvas')
      blobCache.width = debugCanvas.width
      blobCache.height = debugCanvas.height
      const ctx = blobCache.getContext('2d')
      if (!ctx || !textField) return
      const { minX, minY, cell, cols, rows, d } = textField
      const pad = globals.textPadding
      const falloff = Math.max(1, globals.exclusionFalloff)
      // Painted at grid resolution, then scaled up with smoothing so the
      // shape reads as a continuous field rather than voxels.
      const img = new ImageData(cols, rows)
      for (let i = 0; i < d.length; i++) {
        const dist = d[i]
        let a = 0
        if (dist < pad) a = 0.3
        else if (dist < pad + falloff) a = 0.3 * (1 - (dist - pad) / falloff)
        if (a > 0) {
          img.data[i * 4] = 220
          img.data[i * 4 + 1] = 40
          img.data[i * 4 + 2] = 40
          img.data[i * 4 + 3] = Math.round(a * 255)
        }
      }
      const small = document.createElement('canvas')
      small.width = cols
      small.height = rows
      small.getContext('2d')?.putImageData(img, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(small, minX, minY, cols * cell, rows * cell)
    }

    /** Blue layer: Voronoi cell borders and round seed dots over the name. */
    const renderVoroCache = () => {
      voroCacheDirty = false
      if (!voroCache) voroCache = document.createElement('canvas')
      voroCache.width = debugCanvas.width
      voroCache.height = debugCanvas.height
      const ctx = voroCache.getContext('2d')
      if (!ctx || !glyphGrid || voroSeeds.length === 0) return
      // Owner scan across the whole name box (not just glyph cells) so the
      // borders form complete, visible cell outlines.
      const res = 2
      const x0 = glyphGrid.minX
      const y0 = glyphGrid.minY
      const cols = Math.ceil((glyphGrid.cols * glyphGrid.step) / res)
      const rows = Math.ceil((glyphGrid.rows * glyphGrid.step) / res)
      const owner = new Int16Array(cols * rows)
      for (let gy = 0; gy < rows; gy++) {
        const py = y0 + (gy + 0.5) * res
        for (let gx = 0; gx < cols; gx++) {
          const px = x0 + (gx + 0.5) * res
          let si = 0
          let sd = Infinity
          for (let i = 0; i < voroSeeds.length; i++) {
            const dd = (px - voroSeeds[i].x) ** 2 + (py - voroSeeds[i].y) ** 2
            if (dd < sd) {
              sd = dd
              si = i
            }
          }
          owner[gy * cols + gx] = si
        }
      }
      ctx.fillStyle = 'rgba(40, 90, 220, 0.65)'
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          const c = owner[gy * cols + gx]
          if (gx + 1 < cols && owner[gy * cols + gx + 1] !== c) {
            ctx.fillRect(x0 + (gx + 1) * res - 0.5, y0 + gy * res, 1, res)
          }
          if (gy + 1 < rows && owner[(gy + 1) * cols + gx] !== c) {
            ctx.fillRect(x0 + gx * res, y0 + (gy + 1) * res - 0.5, res, 1)
          }
        }
      }
      ctx.strokeStyle = 'rgba(40, 90, 220, 0.5)'
      ctx.lineWidth = 1
      ctx.strokeRect(x0, y0, cols * res, rows * res)
      // Seeds as genuine round dots (fillRect at fractional coordinates used
      // to smear them into stubby lines).
      ctx.fillStyle = 'rgba(40, 90, 220, 0.9)'
      for (const s of voroSeeds) {
        ctx.beginPath()
        ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    /** Static effector layer: every force drawn as a gradient between its
     * body and its range limit, plus the limit outlines. */
    const renderEffCache = () => {
      effCacheDirty = false
      if (!effCache) effCache = document.createElement('canvas')
      effCache.width = debugCanvas.width
      effCache.height = debugCanvas.height
      const ctx = effCache.getContext('2d')
      if (!ctx || !name) return
      // Red outline: the type the name attractor points were sampled from.
      ctx.strokeStyle = 'rgba(220, 40, 40, 0.8)'
      ctx.lineWidth = 1
      ctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      ctx.textBaseline = 'top'
      NAME_LINES.forEach((text, i) => {
        ctx.strokeText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      // Teal: the name attract points, each a radial gradient to its range.
      const range = Math.max(16, name.step * 2.2)
      for (const p of name.points) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, range)
        g.addColorStop(0, 'rgba(20, 150, 170, 0.28)')
        g.addColorStop(1, 'rgba(20, 150, 170, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, range, 0, Math.PI * 2)
        ctx.fill()
      }
      // Purple: separator pull, a gradient band fading over its range with
      // the segment and range limits outlined; orange: the settings panel.
      for (const t of getTargets()) {
        const r = toPageRect(t.el.getBoundingClientRect())
        if (r.w === 0) continue
        if (t.kind === 'separator') {
          const cy = r.y + r.h / 2
          const range = SEPARATOR_RANGE_PX
          const g = ctx.createLinearGradient(0, cy - range, 0, cy + range)
          g.addColorStop(0, 'rgba(140, 60, 200, 0)')
          g.addColorStop(0.5, 'rgba(140, 60, 200, 0.25)')
          g.addColorStop(1, 'rgba(140, 60, 200, 0)')
          ctx.fillStyle = g
          ctx.fillRect(r.x, cy - range, r.w, range * 2)
          ctx.strokeStyle = 'rgba(140, 60, 200, 0.8)'
          ctx.beginPath()
          ctx.moveTo(r.x, cy)
          ctx.lineTo(r.x + r.w, cy)
          ctx.stroke()
          ctx.strokeStyle = 'rgba(140, 60, 200, 0.3)'
          ctx.strokeRect(r.x, cy - range, r.w, range * 2)
        } else {
          const pad = PANEL_RANGE_PX
          const reach = pad + BOX_CORNER_PX
          // The rect force fades from the panel edge to its range: a stack
          // of expanding outlines with falling alpha reads as the gradient.
          for (let k = 0; k < 8; k++) {
            const o = (k / 7) * reach
            ctx.strokeStyle = `rgba(230, 130, 30, ${0.55 * (1 - k / 7) + 0.1})`
            ctx.beginPath()
            ctx.roundRect(r.x - o, r.y - o, r.w + o * 2, r.h + o * 2, BOX_CORNER_PX + o)
            ctx.stroke()
          }
        }
      }
    }

    /** Green: the trail force as a soft gradient band along the path, a
     * fading curve through the nodes, and shrinking per-node circles. */
    const drawTrailDebug = (dctx: CanvasRenderingContext2D) => {
      const pts = trailViz
      if (pts.length === 0) return
      const range = TRAIL_POINT_RANGE_PX
      dctx.lineCap = 'round'
      dctx.lineJoin = 'round'
      // Capsule-chain gradient: nested soft strokes approximate the linear
      // falloff from the path out to its range limit.
      for (const [w, a] of [
        [2, 0.045],
        [1.35, 0.06],
        [0.7, 0.08],
      ] as const) {
        dctx.lineWidth = range * w
        for (let i = 1; i < pts.length; i++) {
          const s = (pts[i - 1].s + pts[i].s) / 2
          if (s <= 0.01) continue
          dctx.strokeStyle = `rgba(30, 160, 60, ${a * s})`
          dctx.beginPath()
          dctx.moveTo(pts[i - 1].x, pts[i - 1].y)
          dctx.lineTo(pts[i].x, pts[i].y)
          dctx.stroke()
        }
      }
      // Smooth curve through the nodes, fading with the local strength.
      dctx.lineWidth = 1.5
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1]
        const p = pts[i]
        const next = pts[i + 1]
        dctx.strokeStyle = `rgba(30, 160, 60, ${0.15 + 0.65 * ((prev.s + p.s) / 2)})`
        dctx.beginPath()
        dctx.moveTo((prev.x + p.x) / 2, (prev.y + p.y) / 2)
        if (next) {
          dctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2)
        } else {
          dctx.lineTo(p.x, p.y)
        }
        dctx.stroke()
      }
      // Node circles fade and shrink as their pull decays.
      dctx.lineWidth = 1
      for (const p of pts) {
        if (p.s <= 0.02) continue
        dctx.strokeStyle = `rgba(30, 160, 60, ${0.2 + 0.6 * p.s})`
        dctx.beginPath()
        dctx.arc(p.x, p.y, 3 + (range / 3 - 3) * p.s, 0, Math.PI * 2)
        dctx.stroke()
      }
    }

    const drawDebug = () => {
      const dctx = debugCanvas.getContext('2d')
      if (!dctx) return
      dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
      if (!bridge.debugOn || !name) return
      if (blobCacheDirty) renderBlobCache()
      if (voroCacheDirty) renderVoroCache()
      if (effCacheDirty) renderEffCache()
      if (blobCache) dctx.drawImage(blobCache, 0, 0)
      if (voroCache) dctx.drawImage(voroCache, 0, 0)
      if (effCache) dctx.drawImage(effCache, 0, 0)
      drawTrailDebug(dctx)
    }

    const syncEffectors = () => {
      syncScheduled = false
      if (!engine || !name) return
      // The CPU runtime pays for every attract point per particle; half the
      // grid gives the same pull shape at half the cost.
      const namePts = webgpu ? name.points : name.points.filter((_, i) => i % 2 === 0)
      const range = Math.max(16, name.step * 2.2) / zoom
      const list: Effector[] = namePts.map((p) => ({
        shape: 'circle' as const,
        mode: 'attract' as const,
        x: p.x / zoom,
        y: p.y / zoom,
        range,
        halfW: 0,
        halfH: 0,
        strength: globals.nameAttraction,
      }))
      for (const t of getTargets()) {
        const r = toPageRect(t.el.getBoundingClientRect())
        if (r.w === 0 && r.h === 0) continue
        if (t.kind === 'separator') {
          // A genuine line: the pill kernel attracts to a segment.
          list.push({
            shape: 'pill',
            mode: 'attract',
            x: (r.x + r.w / 2) / zoom,
            y: (r.y + r.h / 2) / zoom,
            range: SEPARATOR_RANGE_PX / zoom,
            halfW: r.w / 2 / zoom,
            halfH: 0,
            strength: globals.separatorAttraction,
          })
        } else {
          list.push({
            shape: 'rect',
            mode: 'repel',
            x: (r.x + r.w / 2) / zoom,
            y: (r.y + r.h / 2) / zoom,
            range: (PANEL_RANGE_PX + BOX_CORNER_PX) / zoom,
            halfW: Math.max(2, r.w / 2 - BOX_CORNER_PX) / zoom,
            halfH: Math.max(2, r.h / 2 - BOX_CORNER_PX) / zoom,
            strength: globals.boxAttraction,
          })
        }
      }
      staticEffectors = list
      effectors.set(staticEffectors)
      effCacheDirty = true
      drawDebug()
    }

    const scheduleSync = () => {
      if (syncScheduled) return
      syncScheduled = true
      requestAnimationFrame(syncEffectors)
    }

    /** The cursor pull as a continuous capsule chain along the trail path:
     * strength interpolates between nodes, so the force field is smooth
     * along the whole path rather than a row of discrete circles. Ages the
     * trail every frame, so it keeps fading after the cursor leaves the
     * window. Padded to a fixed length so the module's array offsets stay
     * stable and the per-frame upload covers only this small array. */
    const trailSegments = (now: number): TrailSegment[] => {
      let pathLen = 0
      for (let i = 1; i < trail.length; i++) {
        pathLen += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y)
      }
      // Longer trails expire faster, scaled by the falloff setting.
      const ttl = TRAIL_BASE_TTL_MS / (1 + globals.cursorFalloff * 4 * (pathLen / 600))
      trail = trail.filter((p) => now - p.t < ttl)

      const pts: { x: number; y: number; s: number }[] = []
      if (!dragging && globals.cursorStrength > 0) {
        const gamma = 0.4 + (1 - globals.trailIntensity) * 2.6
        const n = trail.length
        trail.forEach((p, i) => {
          const fromHead = (n - i) / (n + 1)
          const fade = Math.max(0, 1 - (now - p.t) / ttl)
          pts.push({ x: p.x, y: p.y, s: Math.pow(1 - fromHead, gamma) * fade })
        })
        if (cursor) pts.push({ x: cursor.x, y: cursor.y, s: 1 })
      }
      trailViz = pts

      const range = TRAIL_POINT_RANGE_PX / zoom
      const segs: TrailSegment[] = []
      for (let i = 1; i < pts.length; i++) {
        segs.push({
          x1: pts[i - 1].x / zoom,
          y1: pts[i - 1].y / zoom,
          x2: pts[i].x / zoom,
          y2: pts[i].y / zoom,
          range,
          s1: globals.cursorStrength * pts[i - 1].s,
          s2: globals.cursorStrength * pts[i].s,
        })
      }
      if (pts.length === 1) {
        const p = pts[0]
        const s = globals.cursorStrength * p.s
        segs.push({ x1: p.x / zoom, y1: p.y / zoom, x2: p.x / zoom, y2: p.y / zoom, range, s1: s, s2: s })
      }
      while (segs.length < TRAIL_MAX_POINTS + 1) {
        segs.push({ x1: 0, y1: 0, x2: 0, y2: 0, range: 0, s1: 0, s2: 0 })
      }
      return segs
    }

    // Per-frame driver: transitions, cursor trail, teleport drain, telemetry.
    const tick = () => {
      tickRaf = requestAnimationFrame(tick)
      if (!engine) return
      const now = performance.now()
      if (lastTickAt > 0) {
        frameDts[frameDtIndex] = now - lastTickAt
        frameDtIndex = (frameDtIndex + 1) % frameDts.length
      }
      lastTickAt = now
      if (transition) {
        const p = Math.min((now - transition.t0) / transition.ms, 1)
        const e = easeInOutCubic(p)
        for (const def of PARAM_DEFS) {
          const v = transition.from[def.key] + (transition.to[def.key] - transition.from[def.key]) * e
          def.set(mods, v)
          currentParams[def.key] = v
        }
        if (p >= 1) {
          applyPresetOscillators(engine, transition.preset)
          transition = null
        }
      }
      // Only the small dynamic array is written per frame; the static list
      // stays untouched. Skip entirely when the trail is idle.
      if (trail.length > 0 || dynamicDirty) {
        effectors.setDynamic(trailSegments(now))
        dynamicDirty = trail.length > 0
        if (bridge.debugOn) drawDebug()
      }
      if (now - teleportWindowStart > 1000) {
        teleportRate = teleportCount
        teleportCount = 0
        teleportWindowStart = now
      }
      enforceDensity()
    }

    const layout = () => {
      if (!engine) return
      // The overflow-hidden holder tracks the content height, so the canvas
      // itself never feeds back into the document height measurement. Pages
      // taller than the backing cap render uniformly downscaled so the
      // simulation always spans the full page.
      const w = holder.clientWidth
      const h = holder.clientHeight
      if (w < 1 || h < 1) return
      const scale = Math.min(1, MAX_CANVAS_HEIGHT / h)
      for (const c of [canvas, debugCanvas]) {
        c.style.width = `${w}px`
        c.style.height = `${h}px`
      }
      debugCanvas.width = w
      debugCanvas.height = Math.min(h, 16_000)
      blobCacheDirty = true
      engine.setSize(Math.round(w * scale), Math.round(h * scale))
      engine.setZoom(DESIRED_ZOOM() * scale)
      zoom = engine.getZoom() / scale // effective page-px zoom
      engine.setCamera(w / (2 * zoom), h / (2 * zoom))
    }

    // Voronoi cells over the name glyphs (seeded with best-candidate points
    // so the pattern is even rather than pixel-grid aligned). Each grid cell
    // of the glyph mask stores its nearest seed for O(1) classification.
    const rebuildVoronoi = () => {
      voroSeeds = []
      voroCellPoints = []
      glyphGrid = null
      if (!name || name.points.length === 0) return
      const pts = name.points
      const target = Math.max(4, Math.min(Math.round(globals.nameDensityRes), pts.length))
      voroSeeds.push({ ...pts[Math.floor(Math.random() * pts.length)] })
      while (voroSeeds.length < target) {
        let best = pts[0]
        let bestD = -1
        for (let c = 0; c < 10; c++) {
          const cand = pts[Math.floor(Math.random() * pts.length)]
          let d = Infinity
          for (const s of voroSeeds) {
            d = Math.min(d, (cand.x - s.x) ** 2 + (cand.y - s.y) ** 2)
          }
          if (d > bestD) {
            bestD = d
            best = cand
          }
        }
        voroSeeds.push({ ...best })
      }
      const step = name.step
      const minX = Math.min(...pts.map((p) => p.x)) - step
      const minY = Math.min(...pts.map((p) => p.y)) - step
      const cols = Math.ceil((Math.max(...pts.map((p) => p.x)) - minX) / step) + 2
      const rows = Math.ceil((Math.max(...pts.map((p) => p.y)) - minY) / step) + 2
      const cellOf = new Int16Array(cols * rows).fill(-1)
      voroCellPoints = voroSeeds.map(() => [])
      pts.forEach((p, pi) => {
        let si = 0
        let sd = Infinity
        for (let i = 0; i < voroSeeds.length; i++) {
          const d = (p.x - voroSeeds[i].x) ** 2 + (p.y - voroSeeds[i].y) ** 2
          if (d < sd) {
            sd = d
            si = i
          }
        }
        const gx = Math.floor((p.x - minX) / step)
        const gy = Math.floor((p.y - minY) / step)
        cellOf[gy * cols + gx] = si
        voroCellPoints[si].push(pi)
      })
      glyphGrid = { minX, minY, cols, rows, step, cellOf }
      censusCells = Int32Array.from(cellOf)
      censusVersion++
      lastCensus = null
      voroCacheDirty = true
    }

    // Keeps every Voronoi cell of the name at its minimum particle count by
    // teleporting donors — first from name cells that sit above the minimum
    // (densest first, so the distribution self-levels), then from particles
    // outside the name. The counting and candidate collection run on the
    // GPU as the engine's cell-census compute pass with an async readback,
    // so enforcement is per-frame with no pipeline stalls and no teleport
    // caps. Physics is untouched — only positions move.
    const enforceDensity = () => {
      if (!engine || !name || !glyphGrid || !censusCells || voroSeeds.length === 0) {
        densityStatus = `guards e=${!!engine} n=${!!name} g=${!!glyphGrid} c=${!!censusCells} s=${voroSeeds.length}`
        return
      }
      // Never demand more than half the population, or a small swarm (CPU
      // fallback) gets teleported into the name wholesale every round.
      const totalMin = Math.round(Math.min(globals.nameDensity, engine.getCount() * 0.5))
      if (totalMin <= 0) {
        densityStatus = 'min<=0'
        return
      }
      // No work while the name is scrolled out of view.
      if (window.scrollY > name.bottom + 200) {
        densityStatus = 'offscreen'
        return
      }
      // The CPU census is synchronous, so uncapped per-frame enforcement
      // just fights the (slow) CPU sim; a 2Hz cadence keeps the name legible
      // without the churn.
      if (!webgpu && lastTickAt - lastCpuRound < 500) {
        densityStatus = 'cpu-throttle'
        return
      }
      densityStatus = 'active'
      // The overall density stays put as the cell count changes: each cell
      // owes an equal share of the total. No floor — flooring to one per
      // cell would let total demand exceed the population cap above when
      // there are more cells than the configured total.
      const perCell = Math.round(totalMin / voroSeeds.length)
      if (perCell <= 0) return
      const w = name.width
      const h = name.bottom - name.topY
      const center = pageToWorld(NAME_MARGIN_PX + w / 2, name.topY + h / 2)
      const res = engine.updateCellCensus({
        centerX: center.x,
        centerY: center.y,
        radius: (Math.hypot(w, h) / 2 + 300) / zoom,
        gridMinX: glyphGrid.minX / zoom,
        gridMinY: glyphGrid.minY / zoom,
        gridCell: glyphGrid.step / zoom,
        gridCols: glyphGrid.cols,
        gridRows: glyphGrid.rows,
        cells: censusCells,
        version: censusVersion,
        cellCount: voroSeeds.length,
        samplesPerCell: CENSUS_SAMPLES_PER_CELL,
        outsideSamples: CENSUS_OUTSIDE_SAMPLES,
      })
      // Act only on fresh census data: the GPU result is a frame or two
      // old, and re-applying the same deficits against stale counts would
      // overshoot into oscillation.
      densityStats.calls++
      if (!res) {
        densityStats.noRes++
        return
      }
      if (res === lastCensus) {
        densityStats.stale++
        return
      }
      if (res.counts.length !== voroSeeds.length) {
        densityStats.mismatch++
        return
      }
      lastCensus = res
      lastCpuRound = lastTickAt
      densityStats.rounds++
      // On WebGPU the next census is dispatched before this round's
      // teleports are written, so it is exactly one round of corrections
      // stale: credit them here or every refill double-fills and
      // oscillates. The CPU census is synchronous and needs no credit.
      if (pendingDelta1.length !== voroSeeds.length) {
        pendingDelta1 = new Array<number>(voroSeeds.length).fill(0)
      }
      const counts = webgpu
        ? Array.from(res.counts, (v, i) => v + pendingDelta1[i])
        : Array.from(res.counts)
      pendingDelta1 = new Array<number>(voroSeeds.length).fill(0)
      densityStats.lastCounts = counts.slice()
      const used = new Uint32Array(counts.length) // sample cursor per cell
      let outsideUsed = 0
      const outsideAvail = Math.min(res.outsideCount, res.outside.length)
      const k = res.samplesPerCell
      // Donors keep a margin above the minimum so continuous drift between
      // neighboring cells doesn't ping-pong the same particles every round.
      const donorFloor = perCell + Math.max(2, Math.round(perCell * 0.25))
      for (let ci = 0; ci < counts.length; ci++) {
        const cellPts = voroCellPoints[ci]
        if (cellPts.length === 0) continue
        let need = perCell - counts[ci]
        while (need > 0) {
          // Densest donor cell that stays comfortably above the minimum
          // after giving one up (and still has uncollected candidates).
          // The candidate cursor is bounded by the RAW census count — only
          // min(res.counts[i], k) sample slots were written this dispatch;
          // the credited count must never index into stale slots.
          let densest = -1
          let densestCount = donorFloor
          for (let i = 0; i < counts.length; i++) {
            if (counts[i] > densestCount && used[i] < Math.min(res.counts[i], k)) {
              densestCount = counts[i]
              densest = i
            }
          }
          let donor = -1
          if (densest >= 0) {
            donor = res.samples[densest * k + used[densest]]
            used[densest]++
            counts[densest]--
            pendingDelta1[densest]--
            densityStats.fromCells++
          } else if (outsideUsed < outsideAvail) {
            donor = res.outside[outsideUsed++]
            densityStats.fromOutside++
          } else {
            break
          }
          const pt = name.points[cellPts[Math.floor(Math.random() * cellPts.length)]]
          // Small enough that the landing spot stays in the marked grid
          // cell, so the next census doesn't count it as outside.
          const jitter = name.step * 0.5
          engine.setParticle(donor, {
            position: pageToWorld(
              pt.x + (Math.random() - 0.5) * jitter,
              pt.y + (Math.random() - 0.5) * jitter,
            ),
            velocity: { x: 0, y: 0 },
            size: 3,
            mass: 1,
            color: { r: 1, g: 1, b: 1, a: 1 },
          })
          teleportCount++
          counts[ci]++
          pendingDelta1[ci]++
          need--
        }
      }
    }

    const measureName = () => {
      name = sampleName(holder.clientWidth, window.innerHeight, nameFontStack(), globals.nameWeight)
      document.documentElement.style.setProperty('--name-bottom', `${Math.round(name.bottom)}px`)
      rebuildVoronoi()
    }

    const measureContent = () => {
      charBalls = collectCharBalls()
      buildTextField()
      blobCacheDirty = true
    }

    // Like the reference page's spawn-around-the-circle: particles are born
    // scattered around the name and around the content text, with the same
    // random launch speed.
    const spawnAll = () => {
      if (!engine || !name || name.points.length === 0) return
      const anchors = charBalls.filter((_, i) => i % 3 === 0)
      const count = PARTICLE_POOL(webgpu)
      const particles: IParticle[] = []
      for (let i = 0; i < count; i++) {
        const anchor =
          anchors.length > 0 && i % 2 === 0
            ? anchors[Math.floor(Math.random() * anchors.length)]
            : name.points[Math.floor(Math.random() * name.points.length)]
        const spread = SPAWN_SPREAD_PX * Math.sqrt(Math.random())
        const angle = Math.random() * Math.PI * 2
        const { x, y } = pageToWorld(
          anchor.x + Math.cos(angle) * spread,
          anchor.y + Math.sin(angle) * spread,
        )
        const heading = Math.random() * Math.PI * 2
        particles.push({
          position: { x, y },
          velocity: { x: Math.cos(heading) * SPAWN_SPEED, y: Math.sin(heading) * SPAWN_SPEED },
          size: 3,
          mass: 1,
          color: { r: 1, g: 1, b: 1, a: 1 },
        })
      }
      engine.setParticles(particles)
    }

    const setMaxParticlesAnimated = (target: number, durationMs: number) => {
      if (!engine) return
      cancelAnimationFrame(maxParticlesRaf)
      if (durationMs <= 0) {
        engine.setMaxParticles(target)
        return
      }
      const start = engine.getMaxParticles() ?? target
      const t0 = performance.now()
      const step = (t: number) => {
        if (!engine) return
        const p = Math.min((t - t0) / durationMs, 1)
        engine.setMaxParticles(Math.round(start + (target - start) * easeInOutCubic(p)))
        if (p < 1) maxParticlesRaf = requestAnimationFrame(step)
      }
      maxParticlesRaf = requestAnimationFrame(step)
    }

    const paramByKey = new Map(PARAM_DEFS.map((d) => [d.key, d]))

    const baseSettings = (index: number): ModeSettings => {
      const preset = DEMO_PRESETS[index]
      return Object.fromEntries(
        MODE_SETTING_KEYS.map((k) => [k, paramByKey.get(k)!.from(preset, isMobile())]),
      ) as ModeSettings
    }

    const getSettings = (index: number): ModeSettings => ({
      ...baseSettings(index),
      ...overrides[index],
    })

    const nextEnabled = (from: number): number => {
      for (let k = 1; k <= DEMO_PRESETS.length; k++) {
        const i = (from + k) % DEMO_PRESETS.length
        if (bridge.enabledModes[i]) return i
      }
      return from
    }

    const scheduleNextDemo = () => {
      window.clearTimeout(demoTimer)
      if (!bridge.autoRotateOn) return
      if (!bridge.enabledModes.some(Boolean)) return
      demoTimer = window.setTimeout(
        () => applyDemo(nextEnabled(demoIndex)),
        globals.modeDuration * 1000,
      )
    }

    const applyDemo = (index: number, instant = false) => {
      if (!engine) return
      demoIndex = index
      const preset = DEMO_PRESETS[index]
      applyDiscretePreset(engine, mods, preset, { isWebGPU: webgpu })
      engine.clearOscillators()
      const modeOverrides = overrides[index] ?? {}
      const to: Record<string, number> = {}
      for (const def of PARAM_DEFS) {
        to[def.key] =
          (modeOverrides as Record<string, number | undefined>)[def.key] ??
          def.from(preset, isMobile())
      }
      const ms = instant ? 0 : globals.transitionLength * 1000
      if (ms <= 0) {
        for (const def of PARAM_DEFS) {
          def.set(mods, to[def.key])
          currentParams[def.key] = to[def.key]
        }
        applyPresetOscillators(engine, preset)
        transition = null
      } else {
        transition = { from: { ...currentParams }, to, t0: performance.now(), ms, preset }
      }
      setMaxParticlesAnimated(Math.floor(globals.particleCount * preset.budgetFactor), ms)
      window.dispatchEvent(new CustomEvent('party:demo', { detail: index }))
      scheduleNextDemo()
    }

    bridge.setAutoRotate = (on: boolean) => {
      bridge.autoRotateOn = on
      scheduleNextDemo()
    }
    bridge.applySetting = (key: ModeSettingKey, value: number) => {
      overrides[demoIndex] = { ...overrides[demoIndex], [key]: value }
      paramByKey.get(key)?.set(mods, value)
      currentParams[key] = value
      if (transition) transition.to[key] = value
    }
    bridge.getCurrentSettings = () => getSettings(demoIndex)
    bridge.getLiveSettings = () => ({ ...currentParams }) as Partial<ModeSettings>
    bridge.applyGlobal = (key: GlobalSettingKey, value: number) => {
      globals[key] = value
      if (key === 'dragStrength') interaction.setStrength(value)
      else if (key === 'dragRadius') interaction.setRadius(value)
      else if (key === 'nameFont' || key === 'nameWeight') {
        measureName()
        blobCacheDirty = true
        scheduleSync()
      } else if (key === 'modeDuration') scheduleNextDemo()
      else if (key === 'textPadding' || key === 'boxAttraction') {
        pushField()
        blobCacheDirty = true
        scheduleSync()
      } else if (key === 'textSmoothing') {
        buildTextField()
        blobCacheDirty = true
        scheduleSync()
      } else if (key === 'exclusionFalloff') {
        pushField()
        blobCacheDirty = true
        scheduleSync()
      } else if (key === 'particleCount') {
        particleCountTouched = true
        setMaxParticlesAnimated(
          Math.floor(value * DEMO_PRESETS[demoIndex].budgetFactor),
          400,
        )
      } else if (key === 'nameDensityRes') {
        rebuildVoronoi()
        scheduleSync()
      } else scheduleSync()
    }
    bridge.getGlobals = () => ({ ...globals })
    bridge.setModeEnabled = (index: number, on: boolean) => {
      bridge.enabledModes[index] = on
      window.dispatchEvent(new CustomEvent('party:modes', { detail: [...bridge.enabledModes] }))
      if (!on && index === demoIndex) {
        const next = nextEnabled(index)
        if (bridge.enabledModes[next]) applyDemo(next)
      } else {
        scheduleNextDemo()
      }
    }
    // Everything in `globals` flows into the export automatically via the
    // spread; new settings never need export wiring.
    bridge.getAllSettings = () => ({
      global: {
        ...globals,
        nameFont: NAME_FONTS[globals.nameFont]?.label ?? 'Georgia',
        enabledModes: [...bridge.enabledModes],
        autoSwitch: bridge.autoRotateOn,
        debugView: bridge.debugOn,
        runtime: bridge.runtimePref,
      },
      modes: Object.fromEntries(DEMO_PRESETS.map((p, i) => [p.session.name, getSettings(i)])),
    })
    bridge.setDebug = (on) => {
      bridge.debugOn = on
      window.dispatchEvent(new CustomEvent('party:debug', { detail: on }))
      scheduleSync()
    }
    bridge.getTelemetry = () => {
      let sum = 0
      let max = 0
      let count = 0
      for (let i = 0; i < frameDts.length; i++) {
        const dt = frameDts[i]
        if (dt <= 0) continue
        sum += dt
        if (dt > max) max = dt
        count++
      }
      const dts: number[] = []
      for (let i = 0; i < frameDts.length; i++) {
        dts.push(frameDts[(frameDtIndex + i) % frameDts.length])
      }
      return {
        fps: engine?.getFPS() ?? 0,
        avgMs: count > 0 ? sum / count : 0,
        maxMs: max,
        particles: engine?.getCount() ?? 0,
        effectors: staticEffectors.length + trail.length,
        teleportsPerSec: teleportRate,
        dts,
      }
    }
    cleanups.push(() => {
      bridge.setAutoRotate = () => {}
      bridge.applySetting = () => {}
      bridge.getCurrentSettings = () => null
      bridge.getLiveSettings = () => null
      bridge.applyGlobal = () => {}
      bridge.getGlobals = () => null
      bridge.setModeEnabled = () => {}
      bridge.getAllSettings = () => ({})
      bridge.setDebug = () => {}
      bridge.getTelemetry = () => null
    })

    let booting = false
    let fallbackNotified = false

    const boot = async (pref: 'auto' | 'webgpu' | 'cpu') => {
      mods = createPartyModules()
      interaction = new Interaction({
        mode: 'repel',
        strength: globals.dragStrength,
        radius: globals.dragRadius,
        active: false,
      })
      effectors = new Effectors()
      trail = []
      trailViz = []
      dynamicDirty = false
      lastCensus = null
      const eng = new Engine({
        canvas,
        forces: [
          mods.environment,
          mods.boundary,
          mods.collisions,
          mods.fluids,
          mods.behavior,
          mods.sensors,
          interaction,
          effectors,
        ],
        render: [mods.trails, mods.particles],
        runtime: pref,
        maxParticles: 80_000,
        cellSize: 16,
        maxNeighbors: 100,
        constrainIterations: 1,
      })
      await eng.initialize()
      // A hidden or pre-layout page reports zero dimensions (e.g. opened in
      // a background tab); measuring now would build a degenerate world, so
      // hold until real dimensions exist. Timers still run while hidden.
      while (!disposed && (holder.clientWidth < 1 || holder.clientHeight < 1)) {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
      }
      if (disposed) {
        void eng.destroy()
        return
      }
      engine = eng
      webgpu = engine.getActualRuntime() === 'webgpu'
      bridge.actualRuntime = engine.getActualRuntime()
      if (pref === 'auto') bridge.autoResolved = bridge.actualRuntime
      globals.particleCount = SWARM_BUDGET(webgpu)
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__party = {
          engine: eng,
          probe: () => ({
            zoom,
            seeds: voroSeeds.length,
            name: !!name,
            points: name?.points.length,
            webgpu,
            mobile: isMobile(),
            globals: { ...globals },
            teleportRate,
            densityStatus,
            densityStats: { ...densityStats, lastCounts: [...densityStats.lastCounts] },
            lastTickAt,
            census: lastCensus
              ? {
                  counts: Array.from(lastCensus.counts),
                  outside: lastCensus.outsideCount,
                }
              : null,
          }),
        }
      }
      layout()
      measureName()
      measureContent()
      lastPageW = holder.clientWidth
      spawnAll()
      syncEffectors()
      applyDemo(demoIndex, true)
      engine.play()
      cancelAnimationFrame(tickRaf)
      tickRaf = requestAnimationFrame(tick)
      window.dispatchEvent(new CustomEvent('party:runtime', { detail: bridge.actualRuntime }))
      if (pref === 'auto' && bridge.actualRuntime === 'cpu' && !fallbackNotified) {
        fallbackNotified = true
        window.dispatchEvent(new CustomEvent('party:fallback'))
      }
    }

    /** Tears the current engine down and boots a fresh one on `pref`. A
     * request arriving mid-reboot queues (latest wins) instead of being
     * dropped, so rapid runtime clicks can't desync the UI from the engine. */
    let pendingRuntime: 'auto' | 'webgpu' | 'cpu' | null = null
    const reboot = async (pref: 'auto' | 'webgpu' | 'cpu') => {
      if (booting) {
        pendingRuntime = pref
        return
      }
      booting = true
      try {
        cancelAnimationFrame(tickRaf)
        cancelAnimationFrame(maxParticlesRaf)
        window.clearTimeout(demoTimer)
        if (engine) {
          const old = engine
          engine = null
          await old.destroy()
        }
        if (!disposed) await boot(pref)
      } finally {
        booting = false
      }
      const next = pendingRuntime
      pendingRuntime = null
      if (next && next !== pref && !disposed) await reboot(next)
    }

    bridge.setRuntime = (pref) => {
      if (bridge.runtimePref === pref) return
      bridge.runtimePref = pref
      void reboot(pref).catch((err: unknown) => {
        console.error('Runtime switch failed', err)
        // An explicit webgpu request can fail where auto would fall back.
        if (pref !== 'auto') {
          bridge.runtimePref = 'auto'
          void reboot('auto').catch(() => {})
        }
      })
    }
    cleanups.push(() => {
      bridge.setRuntime = () => {}
    })

    // While pressed the pointer is the classic repel field; released, it is
    // an attractor with a fading trail.
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element && target.closest('a, button, input, select, .settings-panel')
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || isInteractive(e.target)) return
      dragging = true
      trail = []
      dynamicDirty = true
      const { x, y } = pageToWorld(e.pageX, e.pageY)
      interaction.setPosition(x, y)
      interaction.setActive(true)
    }
    const onPointerMove = (e: PointerEvent) => {
      cursor = { x: e.pageX, y: e.pageY }
      dynamicDirty = true
      if (dragging) {
        const { x, y } = pageToWorld(e.pageX, e.pageY)
        interaction.setPosition(x, y)
        interaction.setActive(true)
        return
      }
      const last = trail[trail.length - 1]
      if (!last || Math.hypot(e.pageX - last.x, e.pageY - last.y) >= TRAIL_MIN_SPACING_PX) {
        trail.push({ x: e.pageX, y: e.pageY, t: performance.now() })
        if (trail.length > TRAIL_MAX_POINTS) trail.shift()
      }
    }
    const stopDrag = () => {
      dragging = false
      interaction.setActive(false)
    }
    const onLeaveWindow = () => {
      // The trail keeps aging and fading in tick(); only the head detaches.
      cursor = null
      dynamicDirty = true
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    document.documentElement.addEventListener('pointerleave', onLeaveWindow)
    cleanups.push(() => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
      document.documentElement.removeEventListener('pointerleave', onLeaveWindow)
    })

    // The fixed-position settings panel moves in page space while scrolling.
    window.addEventListener('scroll', scheduleSync, { passive: true })
    cleanups.push(() => window.removeEventListener('scroll', scheduleSync))
    cleanups.push(onTargetsChanged(scheduleSync))

    // Viewport/document size changes: always relayout and resync; only
    // respawn (and re-measure) when the width actually changed.
    let resizeTimer = 0
    let lastPageW = 0
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        if (!engine) return
        const pageW = holder.clientWidth
        layout()
        measureName()
        measureContent()
        if (pageW !== lastPageW) {
          lastPageW = pageW
          spawnAll()
          // The device budget tracks the viewport class until the user
          // pins an explicit particle count.
          if (!particleCountTouched) globals.particleCount = SWARM_BUDGET(webgpu)
          engine.setMaxParticles(
            Math.floor(globals.particleCount * DEMO_PRESETS[demoIndex].budgetFactor),
          )
        }
        syncEffectors()
      }, 200)
    }
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    observer.observe(document.body)
    cleanups.push(() => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
      window.clearTimeout(resizeTimer)
    })

    // Dot clicks select a demo with the same smooth transition.
    const onSelect = (e: Event) => {
      const index = (e as CustomEvent<number>).detail
      if (typeof index === 'number' && index !== demoIndex) applyDemo(index)
    }
    window.addEventListener('party:select', onSelect)
    cleanups.push(() => window.removeEventListener('party:select', onSelect))

    void reboot(bridge.runtimePref).catch((err: unknown) => {
      console.error('Party engine failed to start', err)
    })

    return () => {
      disposed = true
      for (const fn of cleanups) fn()
      window.clearTimeout(demoTimer)
      cancelAnimationFrame(maxParticlesRaf)
      cancelAnimationFrame(tickRaf)
      if (engine) {
        void engine.destroy()
        engine = null
      }
    }
  }, [])

  return (
    <div ref={holderRef} className="party-holder" aria-hidden="true">
      <canvas ref={canvasRef} className="party-canvas" />
      <canvas ref={debugRef} className="party-debug" />
    </div>
  )
}
