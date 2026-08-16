import { useEffect, useRef } from 'react'
import { Engine, Interaction, type IParticle, type ParticleQuery } from '@cazala/party'
import {
  bridge,
  NAME_FONTS,
  MODE_SETTING_KEYS,
  type GlobalSettings,
  type GlobalSettingKey,
  type ModeSettingKey,
  type ModeSettings,
} from './bridge'
import { Effectors, type Effector } from './effectors'
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
const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768
const DESIRED_ZOOM = () => (isMobile() ? 0.2 : 0.3)
const SWARM_BUDGET = (webgpu: boolean) => (webgpu ? (isMobile() ? 24_000 : 80_000) : 2_500)
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
  dragStrength: 100_000,
  dragRadius: 800,
  nameAttraction: 10_000,
  boxAttraction: 100_000,
  textPadding: 8,
  textSmoothing: 1.8,
  separatorAttraction: 15_000,
  cursorStrength: 6_000,
  trailIntensity: 0.5,
  cursorFalloff: 0.5,
  modeDuration: 15,
  transitionLength: 2.5,
  nameFont: 0,
  nameWeight: 700,
  nameDensity: 30,
  nameDensityRes: 36,
}
// Density queries sync the GPU pipeline (three awaited readbacks each), so
// they run at a low rate and the resulting teleports are spread smoothly
// across the frames in between.
const DENSITY_INTERVAL_MS = 250
const DENSITY_TELEPORT_BUDGET = 200
const DENSITY_DRAIN_PER_FRAME = 25
/** Distance-field raster resolution in page px per cell. */
const FIELD_CELL_PX = 3
const FIELD_MARGIN_PX = 60
const FIELD_FALLOFF_PX = 36

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
  const width = nameWidth(pageW)
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
    let densityBusy = false
    let lastDensity = 0
    let teleportQueue: { index: number; x: number; y: number }[] = []
    let teleportCount = 0
    let teleportWindowStart = 0
    let teleportRate = 0
    let staticEffectors: Effector[] = []
    let dynamicDirty = false
    const frameDts = new Float32Array(120)
    let frameDtIndex = 0
    let lastTickAt = 0
    let trail: { x: number; y: number; t: number }[] = []
    let cursor: { x: number; y: number } | null = null
    let dragging = false
    let blobCache: HTMLCanvasElement | null = null
    let blobCacheDirty = true
    const cleanups: (() => void)[] = []

    const mods = createPartyModules()
    const interaction = new Interaction({
      mode: 'repel',
      strength: globals.dragStrength,
      radius: globals.dragRadius,
      active: false,
    })
    const effectors = new Effectors()

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
        falloff: FIELD_FALLOFF_PX / zoom,
        distances: world,
      })
    }

    /** Renders the closed text shape (field < padding) into a cached layer. */
    const renderBlobCache = () => {
      blobCacheDirty = false
      if (!blobCache) blobCache = document.createElement('canvas')
      blobCache.width = debugCanvas.width
      blobCache.height = debugCanvas.height
      const ctx = blobCache.getContext('2d')
      if (!ctx || !textField) return
      ctx.fillStyle = 'rgba(220, 40, 40, 0.22)'
      const { minX, minY, cell, cols, rows, d } = textField
      const pad = globals.textPadding
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          if (d[gy * cols + gx] < pad) {
            ctx.fillRect(minX + gx * cell, minY + gy * cell, cell, cell)
          }
        }
      }
    }

    const drawDebug = () => {
      const dctx = debugCanvas.getContext('2d')
      if (!dctx) return
      dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
      if (!bridge.debugOn || !name) return
      // Red: the closed text exclusion shape.
      if (blobCacheDirty) renderBlobCache()
      if (blobCache) dctx.drawImage(blobCache, 0, 0)
      dctx.strokeStyle = 'rgba(220, 40, 40, 0.8)'
      dctx.lineWidth = 1
      // Red outline: the type the name attractor points were sampled from.
      dctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      dctx.textBaseline = 'top'
      NAME_LINES.forEach((text, i) => {
        dctx.strokeText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      // Blue: Voronoi divisions and seeds of the name-density cells.
      dctx.strokeStyle = 'rgba(40, 90, 220, 0.7)'
      if (glyphGrid) {
        const { minX, minY, cols, rows, step, cellOf } = glyphGrid
        dctx.beginPath()
        for (let gy = 0; gy < rows; gy++) {
          for (let gx = 0; gx < cols; gx++) {
            const c = cellOf[gy * cols + gx]
            if (c < 0) continue
            const right = gx + 1 < cols ? cellOf[gy * cols + gx + 1] : -1
            const below = gy + 1 < rows ? cellOf[(gy + 1) * cols + gx] : -1
            const x = minX + gx * step
            const y = minY + gy * step
            if (right >= 0 && right !== c) {
              dctx.moveTo(x + step, y)
              dctx.lineTo(x + step, y + step)
            }
            if (below >= 0 && below !== c) {
              dctx.moveTo(x, y + step)
              dctx.lineTo(x + step, y + step)
            }
          }
        }
        dctx.stroke()
      }
      dctx.fillStyle = 'rgba(40, 90, 220, 0.8)'
      for (const s of voroSeeds) {
        dctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3)
      }
      // Green: the cursor attraction trail.
      dctx.strokeStyle = 'rgba(30, 160, 60, 0.7)'
      for (const p of trail) {
        dctx.beginPath()
        dctx.arc(p.x, p.y, TRAIL_POINT_RANGE_PX / 3, 0, Math.PI * 2)
        dctx.stroke()
      }
      if (cursor && !dragging) {
        dctx.beginPath()
        dctx.arc(cursor.x, cursor.y, TRAIL_POINT_RANGE_PX / 2, 0, Math.PI * 2)
        dctx.stroke()
      }
      // Purple: separator attractor lines; orange: the settings panel box.
      for (const t of getTargets()) {
        const r = toPageRect(t.el.getBoundingClientRect())
        if (r.w === 0) continue
        if (t.kind === 'separator') {
          dctx.strokeStyle = 'rgba(140, 60, 200, 0.8)'
          dctx.beginPath()
          dctx.moveTo(r.x, r.y + r.h / 2)
          dctx.lineTo(r.x + r.w, r.y + r.h / 2)
          dctx.stroke()
        } else {
          dctx.strokeStyle = 'rgba(230, 130, 30, 0.8)'
          const pad = PANEL_RANGE_PX
          dctx.beginPath()
          dctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, BOX_CORNER_PX + pad)
          dctx.stroke()
        }
      }
    }

    const syncEffectors = () => {
      syncScheduled = false
      if (!engine || !name) return
      const range = Math.max(16, name.step * 2.2) / zoom
      const list: Effector[] = name.points.map((p) => ({
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
      drawDebug()
    }

    const scheduleSync = () => {
      if (syncScheduled) return
      syncScheduled = true
      requestAnimationFrame(syncEffectors)
    }

    /** Attract field following the cursor with a fading trail behind it. */
    const cursorEffectors = (now: number): Effector[] => {
      if (dragging || !cursor || globals.cursorStrength <= 0) return []
      let pathLen = 0
      for (let i = 1; i < trail.length; i++) {
        pathLen += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y)
      }
      // Longer trails expire faster, scaled by the falloff setting.
      const ttl = TRAIL_BASE_TTL_MS / (1 + globals.cursorFalloff * 4 * (pathLen / 600))
      trail = trail.filter((p) => now - p.t < ttl)
      const gamma = 0.4 + (1 - globals.trailIntensity) * 2.6
      const n = trail.length
      const list: Effector[] = trail.map((p, i) => {
        const fromHead = (n - i) / (n + 1)
        const fade = Math.max(0, 1 - (now - p.t) / ttl)
        return {
          shape: 'circle' as const,
          mode: 'attract' as const,
          x: p.x / zoom,
          y: p.y / zoom,
          range: TRAIL_POINT_RANGE_PX / zoom,
          halfW: 0,
          halfH: 0,
          strength: globals.cursorStrength * Math.pow(1 - fromHead, gamma) * fade,
        }
      })
      list.push({
        shape: 'circle',
        mode: 'attract',
        x: cursor.x / zoom,
        y: cursor.y / zoom,
        range: (TRAIL_POINT_RANGE_PX * 1.4) / zoom,
        halfW: 0,
        halfH: 0,
        strength: globals.cursorStrength,
      })
      return list
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
        effectors.setDynamic(cursorEffectors(now))
        dynamicDirty = trail.length > 0
        if (bridge.debugOn) drawDebug()
      }
      for (let i = 0; i < DENSITY_DRAIN_PER_FRAME && teleportQueue.length > 0; i++) {
        const t = teleportQueue.pop()!
        engine.setParticle(t.index, {
          position: pageToWorld(t.x, t.y),
          velocity: { x: 0, y: 0 },
          size: 3,
          mass: 1,
          color: { r: 1, g: 1, b: 1, a: 1 },
        })
        teleportCount++
      }
      if (now - teleportWindowStart > 1000) {
        teleportRate = teleportCount
        teleportCount = 0
        teleportWindowStart = now
      }
      enforceDensity(now)
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
    }

    /** Voronoi cell index for a page position, or -1 outside the glyphs. */
    const cellAt = (px: number, py: number): number => {
      if (!glyphGrid) return -1
      const gx = Math.floor((px - glyphGrid.minX) / glyphGrid.step)
      const gy = Math.floor((py - glyphGrid.minY) / glyphGrid.step)
      if (gx < 0 || gy < 0 || gx >= glyphGrid.cols || gy >= glyphGrid.rows) return -1
      return glyphGrid.cellOf[gy * glyphGrid.cols + gx]
    }

    // Keeps every Voronoi cell of the name at the minimum particle count by
    // teleporting donors — first from the densest name cells, then from
    // particles outside the name. The heavy filtering runs on the GPU via
    // the engine's bounded radius query; writes are targeted setParticle
    // calls. Physics is untouched — only positions move.
    const enforceDensity = (now: number) => {
      if (!engine || !name || !glyphGrid || voroSeeds.length === 0) return
      const min = Math.round(globals.nameDensity)
      if (min <= 0 || densityBusy || now - lastDensity < DENSITY_INTERVAL_MS) return
      // No work while the name is scrolled out of view.
      if (window.scrollY > name.bottom + 200) return
      densityBusy = true
      lastDensity = now
      const w = name.width
      const h = name.bottom - name.topY
      const center = pageToWorld(NAME_MARGIN_PX + w / 2, name.topY + h / 2)
      const radius = (Math.hypot(w, h) / 2 + 300) / zoom
      engine
        .getParticlesInRadius(center, radius, { maxResults: 6000 })
        .then((res) => {
          if (disposed || !engine || !name) return
          const members: number[][] = voroSeeds.map(() => [])
          const outside: ParticleQuery[] = []
          for (const q of res.particles) {
            const ci = cellAt(q.position.x * zoom, q.position.y * zoom)
            if (ci >= 0) members[ci].push(q.index)
            else outside.push(q)
          }
          // Queue the moves; the tick loop drains a few per frame so the
          // name refills continuously instead of in visible bursts.
          const queue: { index: number; x: number; y: number }[] = []
          let budget = DENSITY_TELEPORT_BUDGET
          for (let ci = 0; ci < members.length && budget > 0; ci++) {
            const cellPts = voroCellPoints[ci]
            if (cellPts.length === 0) continue
            let need = min - members[ci].length
            while (need > 0 && budget > 0) {
              let donor = -1
              let densest = -1
              let densestCount = min
              for (let i = 0; i < members.length; i++) {
                if (members[i].length > densestCount) {
                  densestCount = members[i].length
                  densest = i
                }
              }
              if (densest >= 0) {
                const list = members[densest]
                donor = list.splice(Math.floor(Math.random() * list.length), 1)[0]
              } else if (outside.length > 0) {
                donor = outside.splice(Math.floor(Math.random() * outside.length), 1)[0].index
              } else {
                break
              }
              const pt = name.points[cellPts[Math.floor(Math.random() * cellPts.length)]]
              const jitter = name.step
              queue.push({
                index: donor,
                x: pt.x + (Math.random() - 0.5) * jitter,
                y: pt.y + (Math.random() - 0.5) * jitter,
              })
              members[ci].push(donor)
              need--
              budget--
            }
          }
          teleportQueue = queue
        })
        .catch(() => {})
        .finally(() => {
          densityBusy = false
        })
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
      const count = SWARM_BUDGET(webgpu)
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
      setMaxParticlesAnimated(Math.floor(SWARM_BUDGET(webgpu) * preset.budgetFactor), ms)
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
    bridge.getAllSettings = () => ({
      global: {
        ...globals,
        nameFont: NAME_FONTS[globals.nameFont]?.label ?? 'Georgia',
        enabledModes: [...bridge.enabledModes],
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
      bridge.applyGlobal = () => {}
      bridge.getGlobals = () => null
      bridge.setModeEnabled = () => {}
      bridge.getAllSettings = () => ({})
      bridge.setDebug = () => {}
      bridge.getTelemetry = () => null
    })

    const start = async () => {
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
        runtime: 'auto',
        maxParticles: 80_000,
        cellSize: 16,
        maxNeighbors: 100,
        constrainIterations: 1,
      })
      await eng.initialize()
      if (disposed) {
        void eng.destroy()
        return
      }
      engine = eng
      webgpu = engine.getActualRuntime() === 'webgpu'
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__party = {
          engine: eng,
          probe: () => ({ zoom, seeds: voroSeeds.length, name: !!name, points: name?.points.length }),
        }
      }
      layout()
      measureName()
      measureContent()
      lastPageW = holder.clientWidth
      spawnAll()
      syncEffectors()
      applyDemo(0, true)
      engine.play()
      tickRaf = requestAnimationFrame(tick)
    }

    // While pressed the pointer is the classic repel field; released, it is
    // an attractor with a fading trail.
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element && target.closest('a, button, input, select, .settings-panel')
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || isInteractive(e.target)) return
      dragging = true
      trail = []
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
      cursor = null
      trail = []
      effectors.setDynamic([])
      dynamicDirty = false
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
          engine.setMaxParticles(
            Math.floor(SWARM_BUDGET(webgpu) * DEMO_PRESETS[demoIndex].budgetFactor),
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

    void start().catch((err: unknown) => {
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
