import { useEffect, useRef } from 'react'
import Pressure from 'pressure'
import {
  Engine,
  type IParticle,
  type CellCensusResult,
  type VizGroup,
} from '@cazala/party'
import { drawViz, vizFmax, vizCss, vizRgb } from './viz'
import {
  bridge,
  NAME_FONTS,
  MODE_SETTING_KEYS,
  type GlobalSettings,
  type GlobalSettingKey,
  type ModeSettingKey,
  type ModeSettings,
} from './bridge'
import { Effectors, type Effector, type TrailNode } from './effectors'
import {
  createPartyModules,
  applyDiscrete,
  applyDiscreteStart,
  applyDiscreteMid,
  applyDiscreteEnd,
  applyEngineSettings,
  engineTiming,
  dipKeys,
  discreteOf,
  presetOscillators,
  oscValue,
  DEMO_PRESETS,
  PARAM_DEFS,
  type DiscreteState,
  type OscConfig,
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
const BOX_CORNER_PX = 6
/**
 * The one length the force law needs. Every body's pull is half its surface
 * peak at this distance and falls off as the inverse square beyond it, so
 * this sets how wide every force feels — the dial to reach for first if the
 * field reads too tight or too diffuse. It is global rather than per-body so
 * that one strength value means the same reach everywhere, which is what
 * lets a single slider drive two different bodies.
 */
const SOFTEN_PX = 30
const SPAWN_SPREAD_PX = 60
const SPAWN_SPEED = 100
const TRAIL_BASE_TTL_MS = 900
const TRAIL_MIN_SPACING_PX = 10
const TRAIL_MAX_POINTS = 32

/** Cursor speed and trackpad pressure modulate the cursor forces. Speed
 * saturates around SPEED_HALF px/s; analog pressure comes from Safari's
 * Force Touch events (other browsers only report a binary press). Each
 * trail point remembers the boosts it was born with. */
const SPEED_HALF_PX_S = 700
const SPEED_STRENGTH_GAIN = 4
const PRESSURE_STRENGTH_GAIN = 1.6
/** Pressed-hard trail points live this much longer (×pressure). */
const PRESSURE_TTL_GAIN = 2
/** Drag trail push strength as a fraction of the drag repel setting. */
const DRAG_TRAIL_SCALE = 0.08
/** Fixed dynamic-array size: (points+head-1) spans x 3 samples + tail. */
const TRAIL_NODES_PAD = (TRAIL_MAX_POINTS + 1) * 3 + 2

/**
 * Every effector starts at the same surface acceleration, so one glow is
 * directly comparable to another and the debug view's global anchor puts
 * them all at the same peak opacity. Only the SENSE differs: the name and
 * the section separators pull particles toward themselves, the text, panel
 * and drag push them away. Under one force law with one softening length,
 * equal strength really does mean equal reach.
 */
const EFFECTOR_STRENGTH = 20_000

const GLOBAL_DEFAULTS: GlobalSettings = {
  particleCount: 0, // resolved to the device budget once the runtime is known
  dragStrength: EFFECTOR_STRENGTH,
  nameAttraction: EFFECTOR_STRENGTH,
  concaveAvoidance: 1,
  boxAttraction: EFFECTOR_STRENGTH,
  textStandoff: 44,
  textSmoothing: 1.8,
  separatorAttraction: EFFECTOR_STRENGTH,
  cursorStrength: EFFECTOR_STRENGTH,
  trailIntensity: 0.5,
  cursorFalloff: 0.5,
  modeDuration: 15,
  transitionLength: 2.5,
  nameFont: 1, // Helvetica
  nameWeight: 700,
  nameDensity: 1000,
  nameDensityRes: 36,
  nameBaseOpacity: 0.05,
  nameDensityOpacity: 0.35,
  opacityDamping: 0.85,
  debugOpacity: 0.85,
}
// Name-density enforcement runs off the engine's cell census: a per-frame
// GPU compute pass with an asynchronous readback, so it never stalls the
// pipeline. Corrections apply whenever a fresh census lands (~every frame).
const CENSUS_SAMPLES_PER_CELL = 64
const CENSUS_OUTSIDE_SAMPLES = 512
/** Distance-field raster resolution in page px per cell. */
const FIELD_CELL_PX = 3
/**
 * How far past a body's own bounds its distance grid is rasterized. The
 * force is unbounded, but a grid is not: past this the field simply stops.
 * At 10x the softening length the force there is under 1% of peak, which is
 * below what an 8-bit glow can show.
 */
const FIELD_REACH_PX = 10 * SOFTEN_PX

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
  const nameTextRef = useRef<HTMLCanvasElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const debugCanvas = debugRef.current
    const nameTextCanvas = nameTextRef.current
    const holder = holderRef.current
    if (!canvas || !debugCanvas || !holder) return

    let disposed = false
    let engine: Engine | null = null
    let zoom = DESIRED_ZOOM()
    let webgpu = false
    let demoIndex = 0
    let demoTimer = 0
    let maxParticlesRaf = 0
    /** Field-grid reach the name field was last built with. */
    let syncScheduled = false
    const globals: GlobalSettings = { ...GLOBAL_DEFAULTS }
    const overrides: Partial<Record<number, Partial<ModeSettings>>> = {}
    /** Per-mode user retunes of preset oscillator swings (range sliders). */
    const oscOverrides: Partial<Record<number, Record<string, { min: number; max: number }>>> = {}
    const currentParams: Record<string, number> = {}
    let transition: {
      from: Record<string, number>
      to: Record<string, number>
      t0: number
      ms: number
      next: DiscreteState
      dip: Set<string>
      osc: OscConfig[]
      oscByKey: Map<string, OscConfig>
      midDone: boolean
      engineAt: 'start' | 'mid' | 'end'
    } | null = null
    /** Discrete module state (enable flags, sub-modes, engine settings)
     * actually applied right now — the baseline transitions stage against. */
    let discreteNow: DiscreteState | null = null
    /** Oscillators of the settled demo, evaluated host-side every tick. */
    let activeOsc: OscConfig[] = []
    let name: NameLayout | null = null
    let charBalls: CharBall[] = []
    /** Signed distances (page px) of the name glyphs, for the pull field. */
    let nameField: { minX: number; minY: number; cell: number; cols: number; rows: number; d: Float32Array } | null = null
    let nameMask: HTMLCanvasElement | null = null
    /** Native-resolution cell ownership of every name pixel (from the
     * analytic power diagram) with per-cell pixel lists, so the opacity
     * cells share the same smooth division lines as the debug view. */
    let nameOwner: { cellPx: Uint32Array[] } | null = null
    let nameAlphaImg: ImageData | null = null
    let lastOpacityRender = 0
    /** The balanced power diagram (seed positions + weights, page space):
     * the analytic geometry behind the grid partition, used to render cell
     * borders at native resolution. */
    let voroPower: { sx: number[]; sy: number[]; w: Float64Array } | null = null
    /** Per-cell density weight targets (0..1) driving the name opacity. */
    let cellWeights = new Float32Array(0)
    /** Displayed weights, eased toward the targets by opacity damping. */
    let cellWeightsShown = new Float32Array(0)
    let voroSeeds: { x: number; y: number }[] = []
    /** Fine-grid indices of the glyph pixels owned by each Voronoi cell. */
    let voroCellPx: number[][] = []
    let glyphGrid: {
      minX: number
      minY: number
      cols: number
      rows: number
      step: number
      cellOf: Int16Array
    } | null = null
    let particleCountTouched = false
    /** Overlay canvases render at native device resolution, capped by an
     * area budget so very tall pages don't allocate absurd backing stores. */
    let debugDpr = 1
    const overlayDpr = (w: number, h: number) => {
      const dpr = window.devicePixelRatio || 1
      return Math.min(dpr, Math.sqrt(64_000_000 / Math.max(1, w * h)))
    }
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
    let densityRound = 0
    /** Particle index → round it was relocated (stale in census samples). */
    const recentlyMoved = new Map<number, number>()
    let teleportCount = 0
    let teleportWindowStart = 0
    let teleportRate = 0
    let staticEffectors: Effector[] = []
    let dynamicDirty = false
    const frameDts = new Float32Array(120)
    let frameDtIndex = 0
    let lastTickAt = 0
    /** Accumulated clamped frame time driving host oscillators. */
    let oscClock = 0
    /** Trail points remember the speed/pressure boosts and the mode (pull
     * vs push) they were born with, for as long as they live. */
    interface TrailPoint {
      x: number
      y: number
      t: number
      sb: number // strength boost at birth
      press: number // pressure at birth (extends lifetime)
      push: boolean // captured while repelling: pushes instead of pulls
    }
    /** Every active pointer (the mouse, each touch) is its own force head
     * with its own trail, pressure, and speed — full multi-touch. */
    interface PointerField {
      x: number
      y: number
      speed: number // EMA, page px/s
      lastAt: number
      lastX: number
      lastY: number
      pressure: number
      pressureTarget: number
      /** 0 = attract, 1 = repel; eased so mode changes never pop. */
      repelMix: number
      down: boolean
      isTouch: boolean
      /** Head hidden (mouse left the window / touch lifted); the trail
       * keeps aging until empty, then the field is dropped. */
      ended: boolean
      trail: TrailPoint[]
    }
    const pointers = new Map<number, PointerField>()
    /** Cross-platform mouse pressure from pressure.js (real Force Touch on
     * Safari, a time-ramped hold elsewhere via its polyfill). */
    let mouseForce = 0
    // Debug overlay layers, cached separately because they invalidate on
    // different events (name geometry vs static physics layout).
    let voroCache: HTMLCanvasElement | null = null
    let voroCacheDirty = true
    let staticVizCache: HTMLCanvasElement | null = null
    let staticVizDirty = true
    /** Anchor the static cache was rendered against, so a changed anchor
     * rescales it instead of forcing a re-render. */
    let staticVizFmax = 0
    const cleanups: (() => void)[] = []

    // Rebuilt on every engine boot: a destroyed runtime leaves stale uniform
    // writers attached to old module instances, so reuse is unsafe.
    let mods = createPartyModules()
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
      const minX = Math.min(...rects.map((r) => r.x)) - FIELD_REACH_PX
      const minY = Math.min(...rects.map((r) => r.y)) - FIELD_REACH_PX
      const maxX = Math.max(...rects.map((r) => r.x + r.w)) + FIELD_REACH_PX
      const maxY = Math.max(...rects.map((r) => r.y + r.h)) + FIELD_REACH_PX
      const cell = FIELD_CELL_PX
      const cols = Math.ceil((maxX - minX) / cell)
      const rows = Math.ceil((maxY - minY) / cell)
      // Bailing here leaves textField null, so the previously uploaded field
      // has to be retired too — otherwise a stale grid keeps driving physics
      // against a layout that no longer exists.
      if (cols < 4 || rows < 4 || cols * rows > 2_000_000) {
        effectors.setField(null)
        return
      }

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
        // The keep-out surface: the body is the text shape dilated by
        // this much, and the push saturates anywhere inside it.
        padding: globals.textStandoff / zoom,
        distances: world,
      })
    }

    /** Density-system overlay: the glyph outline the partition samples, the
     * equal-area Voronoi borders clipped to the letters, and the cell
     * centroids. Colors derive from the layer keys like all debug colors. */
    const renderVoroCache = () => {
      voroCacheDirty = false
      if (!voroCache) voroCache = document.createElement('canvas')
      voroCache.width = debugCanvas.width
      voroCache.height = debugCanvas.height
      const ctx = voroCache.getContext('2d')
      if (!ctx || !name || name.size <= 0) return
      // Page coordinates on a native-resolution backing store.
      ctx.setTransform(debugDpr, 0, 0, debugDpr, 0, 0)
      ctx.strokeStyle = vizCss('density:glyphs', 0.8)
      ctx.lineWidth = 1
      ctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      ctx.textBaseline = 'top'
      NAME_LINES.forEach((text, i) => {
        ctx.strokeText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      if (!glyphGrid || !voroPower || voroSeeds.length === 0) return
      // Cell borders from the analytic power diagram at native resolution:
      // the census grid quantizes the partition for the GPU, but the
      // geometry behind it is exact, so the debug border can be too. The
      // glyphs are re-rasterized at device resolution and each glyph pixel
      // is assigned to its power-nearest seed; borders appear where two
      // assignments meet inside the letters.
      const { minX, minY, cols, rows, step } = glyphGrid
      const s = debugDpr
      const W = Math.ceil(cols * step * s)
      const H = Math.ceil(rows * step * s)
      const raster = document.createElement('canvas')
      raster.width = W
      raster.height = H
      const rctx = raster.getContext('2d', { willReadFrequently: true })
      if (!rctx) return
      rctx.setTransform(s, 0, 0, s, -minX * s, -minY * s)
      rctx.fillStyle = '#fff'
      rctx.textBaseline = 'top'
      rctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      NAME_LINES.forEach((text, i) => {
        rctx.fillText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      const alpha = rctx.getImageData(0, 0, W, H).data
      const { sx, sy, w: pw } = voroPower
      const n = sx.length
      const owner = new Int16Array(W * H).fill(-1)
      for (let iy = 0; iy < H; iy++) {
        const py = minY + (iy + 0.5) / s
        for (let ix = 0; ix < W; ix++) {
          const i = iy * W + ix
          if (alpha[i * 4 + 3] <= 64) continue
          const px = minX + (ix + 0.5) / s
          let bi = 0
          let bs = Infinity
          for (let k = 0; k < n; k++) {
            const d = (px - sx[k]) ** 2 + (py - sy[k]) ** 2 - pw[k]
            if (d < bs) {
              bs = d
              bi = k
            }
          }
          owner[i] = bi
        }
      }
      const [br, bg, bb] = vizRgb('density:cells')
      const img = new ImageData(W, H)
      for (let iy = 0; iy < H - 1; iy++) {
        for (let ix = 0; ix < W - 1; ix++) {
          const i = iy * W + ix
          const c = owner[i]
          if (c < 0) continue
          const r = owner[i + 1]
          const b = owner[i + W]
          if ((r >= 0 && r !== c) || (b >= 0 && b !== c)) {
            img.data[i * 4] = br
            img.data[i * 4 + 1] = bg
            img.data[i * 4 + 2] = bb
            img.data[i * 4 + 3] = 200
          }
        }
      }
      // putImageData ignores the transform: place at native coordinates.
      const off = document.createElement('canvas')
      off.width = W
      off.height = H
      off.getContext('2d')?.putImageData(img, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(off, Math.round(minX * s), Math.round(minY * s))
      ctx.setTransform(debugDpr, 0, 0, debugDpr, 0, 0)
      ctx.fillStyle = vizCss('density:cells', 0.95)
      for (const sd of voroSeeds) {
        ctx.beginPath()
        ctx.arc(sd.x, sd.y, 2.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    /** Live physics description from every module that describes itself;
     * new physics with a viz() renders with zero viewer changes. */
    const collectViz = (): VizGroup[] => {
      const groups: VizGroup[] = []
      for (const m of [effectors, ...Object.values(mods)]) {
        if (m.viz) groups.push(...m.viz())
      }
      return groups
    }

    /** Static module physics drawn by the generic viz renderer. */
    const renderStaticViz = (statics: VizGroup[], fmax: number) => {
      staticVizDirty = false
      staticVizFmax = fmax
      if (!staticVizCache) staticVizCache = document.createElement('canvas')
      staticVizCache.width = debugCanvas.width
      staticVizCache.height = debugCanvas.height
      const ctx = staticVizCache.getContext('2d')
      if (!ctx) return
      ctx.setTransform(debugDpr, 0, 0, debugDpr, 0, 0)
      drawViz(ctx, statics, zoom, fmax, globals.debugOpacity)
    }

    const drawDebug = () => {
      const dctx = debugCanvas.getContext('2d')
      if (!dctx) return
      dctx.setTransform(1, 0, 0, 1, 0, 0)
      dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
      if (!bridge.debugOn || !name) return
      if (voroCacheDirty) renderVoroCache()
      // Collect once and partition: every module's viz() runs on this call,
      // so collecting again for the static cache rebuilds and discards the
      // same groups a second time on the frames that need it least.
      const groups = collectViz()
      // One anchor across statics and dynamics: the strongest force anywhere
      // in the system is what maxOpacity means, so a drag that outweighs the
      // name has to dim the name, not rescale itself.
      const fmax = vizFmax(groups)
      if (staticVizDirty) renderStaticViz(groups.filter((g) => !g.dynamic), fmax)
      if (voroCache) dctx.drawImage(voroCache, 0, 0)
      if (staticVizCache) {
        // Opacity is linear in 1/fmax, so a cache drawn against an older
        // anchor is exact after one multiply — no re-render on every frame
        // of a drag.
        dctx.globalAlpha = staticVizFmax > 0 && fmax > 0 ? Math.min(1, staticVizFmax / fmax) : 1
        dctx.drawImage(staticVizCache, 0, 0)
        dctx.globalAlpha = 1
      }
      dctx.setTransform(debugDpr, 0, 0, debugDpr, 0, 0)
      drawViz(dctx, groups.filter((g) => g.dynamic), zoom, fmax, globals.debugOpacity)
    }

    const syncEffectors = () => {
      syncScheduled = false
      if (!engine || !name) return
      // The name attraction is the glyph distance field (pushNameField);
      // only separators and the settings panel remain as shape effectors.
      const list: Effector[] = []
      for (const t of getTargets()) {
        const r = toPageRect(t.el.getBoundingClientRect())
        if (r.w === 0 && r.h === 0) continue
        if (t.kind === 'separator') {
          // A genuine line: the pill kernel attracts to a segment.
          list.push({
            shape: 'pill',
            x: (r.x + r.w / 2) / zoom,
            y: (r.y + r.h / 2) / zoom,
            halfW: r.w / 2 / zoom,
            halfH: 0,
            strength: globals.separatorAttraction,
          })
        } else {
          list.push({
            shape: 'rect',
            x: (r.x + r.w / 2) / zoom,
            y: (r.y + r.h / 2) / zoom,
            // BOX_CORNER_PX shrinks the body so the effective surface sits
            // where the rounded corner does, not where the bounding box does.
            halfW: Math.max(2, r.w / 2 - BOX_CORNER_PX) / zoom,
            halfH: Math.max(2, r.h / 2 - BOX_CORNER_PX) / zoom,
            // Negative pushes: the panel repels.
            strength: -globals.boxAttraction,
          })
        }
      }
      staticEffectors = list
      effectors.set(staticEffectors)
      staticVizDirty = true
      drawDebug()
    }

    const scheduleSync = () => {
      if (syncScheduled) return
      syncScheduled = true
      requestAnimationFrame(syncEffectors)
    }

    /** Saturating speed fraction (0..1) for one pointer. */
    const speedNorm = (ps: PointerField) => ps.speed / (ps.speed + SPEED_HALF_PX_S)
    const strengthBoost = (ps: PointerField) =>
      1 + speedNorm(ps) * SPEED_STRENGTH_GAIN + ps.pressure * PRESSURE_STRENGTH_GAIN
    const totalTrailPoints = () => {
      let n = 0
      for (const ps of pointers.values()) n += ps.trail.length
      return n
    }

    /** Every pointer's force as one smooth tapered blob: a Catmull-Rom
     * curve through its trail points, sampled densely, each sample a cone
     * whose radius and strength shrink down the tail. The field takes the
     * MAX-magnitude cone at every point, so overlapping samples never
     * seam, and a stationary pointer is simply its head cone. Points carry
     * their birth boosts and pull-vs-push mode; pressure-born points live
     * longer. Each pointer's head blends continuously between attract and
     * repel via its eased repelMix. Padded to a fixed length so the
     * module's array offsets stay stable. */
    const trailNodes = (now: number): TrailNode[] => {
      const nodes: TrailNode[] = []
      const push = (x: number, y: number, s: number) => {
        if (nodes.length >= TRAIL_NODES_PAD) return
        nodes.push({ x: x / zoom, y: y / zoom, s })
      }
      const gamma = 0.4 + (1 - globals.trailIntensity) * 2.6

      for (const [id, ps] of pointers) {
        let pathLen = 0
        for (let i = 1; i < ps.trail.length; i++) {
          pathLen += Math.hypot(
            ps.trail[i].x - ps.trail[i - 1].x,
            ps.trail[i].y - ps.trail[i - 1].y,
          )
        }
        // Longer trails expire faster, scaled by the falloff setting;
        // points born under pressure hold on longer.
        const ttl = TRAIL_BASE_TTL_MS / (1 + globals.cursorFalloff * 4 * (pathLen / 600))
        ps.trail = ps.trail.filter((p) => now - p.t < ttl * (1 + p.press * PRESSURE_TTL_GAIN))
        if (ps.ended && ps.trail.length === 0) {
          pointers.delete(id)
          continue
        }

        // Signed per-point strength (pull positive, push negative), ready
        // for spline interpolation. The taper down the tail is carried by
        // the strength alone -- under one global softening length that is
        // the only shape a sample has.
        const pts: { x: number; y: number; s: number }[] = []
        const n = ps.trail.length
        ps.trail.forEach((p, i) => {
          const fromHead = (n - i) / (n + 1)
          const pttl = ttl * (1 + p.press * PRESSURE_TTL_GAIN)
          const fade = Math.max(0, 1 - (now - p.t) / pttl)
          const f = Math.pow(1 - fromHead, gamma) * fade
          const base = p.push
            ? -globals.dragStrength * DRAG_TRAIL_SCALE
            : globals.cursorStrength
          pts.push({ x: p.x, y: p.y, s: base * f * p.sb })
        })
        // The live head blends attract → repel continuously with repelMix
        // (mouse press, or touch pressure crossing half strength).
        if (!ps.ended) {
          const sb = strengthBoost(ps)
          const m = ps.repelMix
          const s = (1 - m) * globals.cursorStrength * sb - m * globals.dragStrength * sb
          if (s !== 0) pts.push({ x: ps.x, y: ps.y, s })
        }

        if (pts.length === 1) {
          push(pts[0].x, pts[0].y, pts[0].s)
        } else if (pts.length > 1) {
          // Catmull-Rom through the points, three samples per span, so the
          // cone chain follows a smooth curve rather than the raw polyline.
          const at = (i: number) => pts[Math.min(pts.length - 1, Math.max(0, i))]
          for (let i = 0; i < pts.length - 1; i++) {
            const p0 = at(i - 1)
            const p1 = at(i)
            const p2 = at(i + 1)
            const p3 = at(i + 2)
            for (let j = 0; j < 3; j++) {
              const u = j / 3
              const u2 = u * u
              const u3 = u2 * u
              const cr = (a: number, b: number, c: number, d: number) =>
                0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (3 * b - a - 3 * c + d) * u3)
              push(
                cr(p0.x, p1.x, p2.x, p3.x),
                cr(p0.y, p1.y, p2.y, p3.y),
                p1.s + (p2.s - p1.s) * u,
              )
            }
          }
          const last = pts[pts.length - 1]
          push(last.x, last.y, last.s)
        }
      }
      while (nodes.length < TRAIL_NODES_PAD) {
        nodes.push({ x: 0, y: 0, s: 0 })
      }
      return nodes
    }

    // Per-frame driver: transitions, cursor trail, density, telemetry.
    // Runs as the engine's onFrame hook, before each simulation step, so
    // parameter lerps and particle writes land in the same frame.
    const tick = () => {
      if (!engine) return
      const now = performance.now()
      if (lastTickAt > 0) {
        frameDts[frameDtIndex] = now - lastTickAt
        frameDtIndex = (frameDtIndex + 1) % frameDts.length
        // Advance the oscillator clock by clamped frame time (matching the
        // engine's own 100ms dt clamp): after a hidden tab or a long frame
        // the phase moves one step, not the whole wall-clock gap — an
        // unclamped clock would snap every oscillated param on resume.
        oscClock += Math.min(now - lastTickAt, 100) / 1000
      }
      lastTickAt = now
      const oscSec = oscClock
      if (transition) {
        const p = Math.min((now - transition.t0) / transition.ms, 1)
        const e = easeInOutCubic(p)
        // Sub-modes that survive on both sides flip exactly where their
        // dipped force params cross zero (e = 0.5), so the discrete switch
        // never applies a force.
        if (!transition.midDone && e >= 0.5 && discreteNow) {
          discreteNow = applyDiscreteMid(engine, mods, discreteNow, transition.next, {
            isWebGPU: webgpu,
            applyEngine: transition.engineAt === 'mid',
          })
          transition.midDone = true
        }
        for (const def of PARAM_DEFS) {
          // Oscillated params chase the incoming oscillator's live value, so
          // the blend lands exactly on the moving curve at p = 1.
          const o = transition.oscByKey.get(def.key)
          const target = o ? oscValue(o, oscSec) : transition.to[def.key]
          const f = transition.from[def.key]
          const v = transition.dip.has(def.key)
            ? f * Math.max(0, 1 - 2 * e) + target * Math.max(0, 2 * e - 1)
            : f + (target - f) * e
          def.set(mods, v)
          currentParams[def.key] = v
        }
        if (p >= 1) {
          if (discreteNow) discreteNow = applyDiscreteEnd(mods, discreteNow, transition.next)
          if (transition.engineAt === 'end') {
            applyEngineSettings(engine, transition.next, { isWebGPU: webgpu })
          }
          activeOsc = transition.osc
          transition = null
        }
      } else {
        for (const o of activeOsc) {
          const v = oscValue(o, oscSec)
          paramByKey.get(o.key)?.set(mods, v)
          currentParams[o.key] = v
        }
      }
      // Ease every pointer's boost inputs so force changes stay
      // continuous: speed decays once movement stops, pressure eases
      // toward its latest reading, and the attract/repel mix follows its
      // mode target (mouse press, or touch pressure past half strength).
      const dtF = Math.min(
        4,
        Math.max(0.25, frameDts[(frameDtIndex + frameDts.length - 1) % frameDts.length] / 16.7),
      )
      let anyLive = false
      for (const ps of pointers.values()) {
        if (now - ps.lastAt > 90) ps.speed *= Math.pow(0.82, dtF)
        const target = ps.isTouch
          ? ps.pressureTarget
          : Math.max(ps.down ? mouseForce : 0, ps.pressureTarget)
        ps.pressure += (target - ps.pressure) * Math.min(1, 0.25 * dtF)
        const mixTarget = ps.isTouch
          ? Math.min(1, Math.max(0, (ps.pressure - 0.45) / 0.2))
          : ps.down
            ? 1
            : 0
        ps.repelMix += (mixTarget - ps.repelMix) * Math.min(1, 0.35 * dtF)
        if (
          ps.trail.length > 0 ||
          (!ps.ended && (ps.speed > 5 || ps.pressure > 0.005 || ps.repelMix > 0.005))
        ) {
          anyLive = true
        }
      }
      // Only the small dynamic array is written per frame; the static list
      // stays untouched. Skip entirely when every pointer field is idle.
      if (anyLive || dynamicDirty) {
        effectors.setDynamic(trailNodes(now))
        dynamicDirty = anyLive
        if (bridge.debugOn) drawDebug()
      }
      if (now - teleportWindowStart > 1000) {
        teleportRate = teleportCount
        teleportCount = 0
        teleportWindowStart = now
      }
      enforceDensity()
      // Ease the displayed per-cell opacity toward the density targets;
      // the damping setting controls how much it may move per frame.
      // Frame-rate independent: the per-60Hz-frame retention is the
      // setting, scaled to the actual frame interval.
      if (
        cellWeightsShown.length > 0 &&
        cellWeightsShown.length === cellWeights.length &&
        name &&
        window.scrollY <= name.bottom + 200
      ) {
        const dtFrames = frameDts[(frameDtIndex + frameDts.length - 1) % frameDts.length] / 16.7
        const keep = Math.pow(
          Math.min(0.98, Math.max(0, globals.opacityDamping)),
          Math.min(4, Math.max(0.25, dtFrames)),
        )
        let maxDelta = 0
        for (let i = 0; i < cellWeights.length; i++) {
          const next = cellWeightsShown[i] * keep + cellWeights[i] * (1 - keep)
          maxDelta = Math.max(maxDelta, Math.abs(next - cellWeightsShown[i]))
          cellWeightsShown[i] = next
        }
        // Repaints are capped at ~30Hz; the damping makes the eased motion
        // between repaints imperceptible.
        if (maxDelta > 0.0015 && now - lastOpacityRender > 30) {
          lastOpacityRender = now
          renderNameOpacity()
        }
      }
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
      const debugH = Math.min(h, 16_000)
      debugDpr = overlayDpr(w, debugH)
      debugCanvas.width = Math.round(w * debugDpr)
      debugCanvas.height = Math.round(debugH * debugDpr)
      staticVizDirty = true
      voroCacheDirty = true
      engine.setSize(Math.round(w * scale), Math.round(h * scale))
      engine.setZoom(DESIRED_ZOOM() * scale)
      zoom = engine.getZoom() / scale // effective page-px zoom
      engine.setCamera(w / (2 * zoom), h / (2 * zoom))
      effectors.setSoften(SOFTEN_PX / zoom)
    }

    // Equal-area Voronoi partition of the letter shapes themselves: the
    // glyphs are rasterized to a fine grid and split with a capacity-
    // balanced power diagram (Lloyd moves plus per-cell weights), so every
    // cell covers the same share of the actual letter area — no bounding
    // box. The same raster also yields the name's signed distance field
    // (the attraction physics) and the opacity text mask. Computed once
    // here; measureName re-runs it whenever the name font settings or
    // layout change.
    const rebuildVoronoi = () => {
      voroSeeds = []
      voroCellPx = []
      voroPower = null
      glyphGrid = null
      censusCells = null
      lastCensus = null
      pendingDelta1 = []
      cellWeights = new Float32Array(0)
      cellWeightsShown = new Float32Array(0)
      voroCacheDirty = true
      if (!name || name.points.length === 0 || name.size <= 0) {
        effectors.setNameField(null)
        renderNameOpacity()
        return
      }

      const step = FIELD_CELL_PX
      // Fixed margin: it no longer tracks any slider, so strength drags
      // never need the grid rebuilt.
      const margin = FIELD_REACH_PX + step * 4
      const minX = NAME_MARGIN_PX - margin
      const minY = name.topY - margin
      const cols = Math.ceil((name.width + margin * 2) / step)
      const rows = Math.ceil((name.bottom - name.topY + margin * 2) / step)
      if (cols < 4 || rows < 4 || cols * rows > 1_000_000) return
      const raster = document.createElement('canvas')
      raster.width = cols
      raster.height = rows
      const ctx = raster.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.setTransform(1 / step, 0, 0, 1 / step, -minX / step, -minY / step)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'top'
      ctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      NAME_LINES.forEach((text, i) => {
        ctx.fillText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      const alpha = ctx.getImageData(0, 0, cols, rows).data
      const px: number[] = [] // fine-grid indices of glyph pixels
      const pxX: number[] = [] // page-space centers
      const pxY: number[] = []
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          if (alpha[(gy * cols + gx) * 4 + 3] > 64) {
            px.push(gy * cols + gx)
            pxX.push(minX + (gx + 0.5) * step)
            pxY.push(minY + (gy + 0.5) * step)
          }
        }
      }
      const n = px.length
      const target = Math.max(4, Math.min(Math.round(globals.nameDensityRes), Math.floor(n / 4)))
      if (n < 16) return

      // Best-candidate initial seeds spread over the glyph pixels.
      const sx: number[] = []
      const sy: number[] = []
      const first = Math.floor(Math.random() * n)
      sx.push(pxX[first])
      sy.push(pxY[first])
      while (sx.length < target) {
        let bi = 0
        let bd = -1
        for (let c = 0; c < 12; c++) {
          const cand = Math.floor(Math.random() * n)
          let d = Infinity
          for (let s = 0; s < sx.length; s++) {
            d = Math.min(d, (pxX[cand] - sx[s]) ** 2 + (pxY[cand] - sy[s]) ** 2)
          }
          if (d > bd) {
            bd = d
            bi = cand
          }
        }
        sx.push(pxX[bi])
        sy.push(pxY[bi])
      }

      // Two phases: plain Lloyd first for compact, well-placed cells, then
      // capacity balancing on frozen seed positions — a power diagram whose
      // per-cell weights grow or shrink until every cell owns an equal
      // share of the glyph pixels (moving centroids while balancing makes
      // the weights chase a moving target and never converge).
      const w = new Float64Array(target)
      const own = new Int16Array(n)
      const avg = n / target
      const r2 = (avg * step * step) / Math.PI // typical cell radius²
      const assign = () => {
        const count = new Float64Array(target)
        const cx = new Float64Array(target)
        const cy = new Float64Array(target)
        for (let p = 0; p < n; p++) {
          let bi = 0
          let bs = Infinity
          for (let s = 0; s < target; s++) {
            const d = (pxX[p] - sx[s]) ** 2 + (pxY[p] - sy[s]) ** 2 - w[s]
            if (d < bs) {
              bs = d
              bi = s
            }
          }
          own[p] = bi
          count[bi]++
          cx[bi] += pxX[p]
          cy[bi] += pxY[p]
        }
        return { count, cx, cy }
      }
      for (let iter = 0; iter < 20; iter++) {
        const { count, cx, cy } = assign()
        for (let s = 0; s < target; s++) {
          if (count[s] > 0) {
            sx[s] = cx[s] / count[s]
            sy[s] = cy[s] / count[s]
          }
        }
      }
      for (let iter = 0; iter < 100; iter++) {
        const { count } = assign()
        let worst = 0
        for (let s = 0; s < target; s++) {
          const off = (avg - count[s]) / avg
          worst = Math.max(worst, Math.abs(off))
          w[s] += off * r2
        }
        if (worst < 0.03) break
      }
      assign()

      const cellOf = new Int16Array(cols * rows).fill(-1)
      voroCellPx = Array.from({ length: target }, () => [])
      for (let p = 0; p < n; p++) {
        cellOf[px[p]] = own[p]
        voroCellPx[own[p]].push(px[p])
      }
      voroSeeds = Array.from({ length: target }, (_, s) => ({ x: sx[s], y: sy[s] }))
      voroPower = { sx: [...sx], sy: [...sy], w: Float64Array.from(w) }
      glyphGrid = { minX, minY, cols, rows, step, cellOf }
      censusCells = Int32Array.from(cellOf)
      censusVersion++

      // The name's signed distance field, derived from the same raster:
      // this IS the attraction physics — particles are pulled toward the
      // font's actual letter surface, not a cloud of sample points.
      const mask = new Uint8Array(cols * rows)
      for (const i of px) mask[i] = 1
      const inverse = new Uint8Array(cols * rows)
      for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] ? 0 : 1
      const outer = edt2d(mask, cols, rows)
      const inner = edt2d(inverse, cols, rows)
      const d = new Float32Array(cols * rows)
      for (let i = 0; i < d.length; i++) {
        d[i] = (mask[i] ? -inner[i] : outer[i]) * step
      }
      nameField = { minX, minY, cell: step, cols, rows, d }
      pushNameField()

      // Concave pockets: inside a letter's convex hull but outside the
      // letter itself (the notch of an N, the bays of an E). Per connected
      // component: monotone-chain hull of its cells, scanline-filled, minus
      // the glyph mask.
      const zone = new Float32Array(cols * rows)
      {
        const label = new Int32Array(cols * rows).fill(-1)
        const stack: number[] = []
        let comp = 0
        for (let seed = 0; seed < mask.length; seed++) {
          if (!mask[seed] || label[seed] >= 0) continue
          const cells: number[] = []
          stack.length = 0
          stack.push(seed)
          label[seed] = comp
          while (stack.length) {
            const c = stack.pop()!
            cells.push(c)
            const cx = c % cols
            for (const nb of [
              cx > 0 ? c - 1 : -1,
              cx < cols - 1 ? c + 1 : -1,
              c - cols,
              c + cols,
            ]) {
              if (nb >= 0 && nb < mask.length && mask[nb] && label[nb] < 0) {
                label[nb] = comp
                stack.push(nb)
              }
            }
          }
          comp++
          if (cells.length < 24) continue
          const pts = cells.map((c) => [c % cols, (c / cols) | 0])
          pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
          const cross = (o: number[], a: number[], b: number[]) =>
            (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
          const half = (list: number[][]) => {
            const h: number[][] = []
            for (const p of list) {
              while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
              h.push(p)
            }
            h.pop()
            return h
          }
          const hull = [...half(pts), ...half([...pts].reverse())]
          if (hull.length < 3) continue
          let hy0 = rows
          let hy1 = 0
          for (const p of hull) {
            hy0 = Math.min(hy0, p[1])
            hy1 = Math.max(hy1, p[1])
          }
          for (let gy = hy0; gy <= hy1; gy++) {
            const xs: number[] = []
            for (let e = 0; e < hull.length; e++) {
              const [x1, y1] = hull[e]
              const [x2, y2] = hull[(e + 1) % hull.length]
              if (y1 === y2) continue
              if (gy >= Math.min(y1, y2) && gy < Math.max(y1, y2)) {
                xs.push(x1 + ((gy - y1) * (x2 - x1)) / (y2 - y1))
              }
            }
            xs.sort((a, b) => a - b)
            for (let s = 0; s + 1 < xs.length; s += 2) {
              const a = Math.ceil(xs[s])
              const b = Math.floor(xs[s + 1])
              for (let gx = a; gx <= b; gx++) {
                const i = gy * cols + gx
                if (!mask[i]) zone[i] = 1
              }
            }
          }
        }
      }
      effectors.setNameZone(zone)

      cellWeights = new Float32Array(target)
      cellWeightsShown = new Float32Array(target)
      renderNameMask()
      buildNameOwner()
      renderNameOpacity()
    }

    /** Name-pull tuning (world units); tiny upload, safe to call per slider
     * tick — the multi-MB distance array itself stays byte-stable. */
    const pushNameParams = () => {
      effectors.setNameParams(globals.nameAttraction, globals.concaveAvoidance)
    }

    /** Uploads the name distance field; tuning lives in nameParams. */
    const pushNameField = () => {
      if (!nameField) {
        effectors.setNameField(null)
        return
      }
      const world = new Float32Array(nameField.d.length)
      for (let i = 0; i < world.length; i++) world[i] = nameField.d[i] / zoom
      effectors.setNameField({
        originX: nameField.minX / zoom,
        originY: nameField.minY / zoom,
        cols: nameField.cols,
        rows: nameField.rows,
        cell: nameField.cell / zoom,
        // Vestigial header slots (tuning moved to nameParams): fixed zeros
        // keep the big array's bytes stable across slider drags.
        strength: 0,
        padding: 0,
        distances: world,
      })
      pushNameParams()
    }

    /** Crisp vector text mask used to clip the per-cell opacity field,
     * backed at native device resolution. */
    const renderNameMask = () => {
      if (!glyphGrid || !name) {
        nameMask = null
        return
      }
      if (!nameMask) nameMask = document.createElement('canvas')
      const { minX, minY, cols, rows, step } = glyphGrid
      const dpr = window.devicePixelRatio || 1
      nameMask.width = Math.round(cols * step * dpr)
      nameMask.height = Math.round(rows * step * dpr)
      const ctx = nameMask.getContext('2d')
      if (!ctx) {
        nameMask = null
        return
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#000'
      ctx.textBaseline = 'top'
      ctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      NAME_LINES.forEach((text, i) => {
        ctx.fillText(text, NAME_MARGIN_PX - minX, name!.topY + i * name!.lineGap - minY)
      })
    }

    /** Assigns every native pixel of the text mask to its power-nearest
     * Voronoi cell (dilated a little past the antialiased glyph edges) and
     * builds per-cell pixel lists. One-time per rebuild; per-frame opacity
     * updates then only write alpha bytes. */
    const buildNameOwner = () => {
      nameOwner = null
      nameAlphaImg = null
      if (!nameMask || !voroPower || !glyphGrid) return
      const W = nameMask.width
      const H = nameMask.height
      const s = W / (glyphGrid.cols * glyphGrid.step) // native px per page px
      const mctx = nameMask.getContext('2d', { willReadFrequently: true })
      if (!mctx || s <= 0) return
      const alpha = mctx.getImageData(0, 0, W, H).data
      const { sx, sy, w: pw } = voroPower
      const n = sx.length
      let owner = new Int16Array(W * H).fill(-1)
      const minX = glyphGrid.minX
      const minY = glyphGrid.minY
      for (let iy = 0; iy < H; iy++) {
        const py = minY + (iy + 0.5) / s
        for (let ix = 0; ix < W; ix++) {
          const i = iy * W + ix
          if (alpha[i * 4 + 3] <= 8) continue
          const px = minX + (ix + 0.5) / s
          let bi = 0
          let bs = Infinity
          for (let k = 0; k < n; k++) {
            const d = (px - sx[k]) ** 2 + (py - sy[k]) ** 2 - pw[k]
            if (d < bs) {
              bs = d
              bi = k
            }
          }
          owner[i] = bi
        }
      }
      // Two dilation passes so the mask's antialiased fringe still finds
      // an owning cell.
      for (let pass = 0; pass < 2; pass++) {
        const next = owner.slice()
        for (let iy = 0; iy < H; iy++) {
          for (let ix = 0; ix < W; ix++) {
            const i = iy * W + ix
            if (owner[i] >= 0) continue
            const l = ix > 0 ? owner[i - 1] : -1
            const r = ix + 1 < W ? owner[i + 1] : -1
            const u = iy > 0 ? owner[i - W] : -1
            const dn = iy + 1 < H ? owner[i + W] : -1
            const v = Math.max(l, r, u, dn)
            if (v >= 0) next[i] = v
          }
        }
        owner = next
      }
      const counts = new Uint32Array(n)
      for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) counts[owner[i]]++
      const cellPx = Array.from({ length: n }, (_, c) => new Uint32Array(counts[c]))
      const cursors = new Uint32Array(n)
      for (let i = 0; i < owner.length; i++) {
        const c = owner[i]
        if (c >= 0) cellPx[c][cursors[c]++] = i
      }
      nameOwner = { cellPx }
      nameAlphaImg = new ImageData(W, H)
    }

    // The name rendered as real text whose opacity varies per Voronoi cell,
    // divided by the analytic power-diagram lines at native resolution.
    // Per update: alpha-byte writes over the per-cell pixel lists, one
    // putImageData, and one masking drawImage.
    const renderNameOpacity = () => {
      const out = nameTextCanvas
      if (!out) return
      const octx = out.getContext('2d')
      if (!octx) return
      if (!glyphGrid || !nameMask || !nameOwner || !nameAlphaImg) {
        octx.clearRect(0, 0, out.width, out.height)
        return
      }
      const { minX, minY, cols, rows, step } = glyphGrid
      if (out.width !== nameMask.width || out.height !== nameMask.height) {
        out.width = nameMask.width
        out.height = nameMask.height
        out.style.width = `${cols * step}px`
        out.style.height = `${rows * step}px`
        out.style.left = `${minX}px`
        out.style.top = `${minY}px`
      }
      const base = globals.nameBaseOpacity
      const top = globals.nameDensityOpacity
      const data = nameAlphaImg.data
      for (let c = 0; c < nameOwner.cellPx.length; c++) {
        const a = Math.round(
          Math.min(1, Math.max(0, base + (top - base) * (cellWeightsShown[c] ?? 0))) * 255,
        )
        const px = nameOwner.cellPx[c]
        for (let j = 0; j < px.length; j++) data[px[j] * 4 + 3] = a
      }
      octx.putImageData(nameAlphaImg, 0, 0)
      octx.globalCompositeOperation = 'destination-in'
      octx.drawImage(nameMask, 0, 0)
      octx.globalCompositeOperation = 'source-over'
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
        // With enforcement off, the density opacity eases back to baseline
        // instead of freezing at the last enforced snapshot.
        cellWeights.fill(0)
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
      if (perCell <= 0) {
        cellWeights.fill(0)
        return
      }
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
      // A result dispatched against a previous partition (font change or
      // resize rebuilt the cells while it was in flight) must be discarded:
      // its counts are keyed to the old cell geometry.
      if (res.version !== censusVersion || res.counts.length !== voroSeeds.length) {
        densityStats.mismatch++
        return
      }
      lastCensus = res
      lastCpuRound = lastTickAt
      densityStats.rounds++
      densityRound++
      // Particles this system relocated in the last two rounds still appear
      // at their OLD location in the (one-round-stale) census samples;
      // re-donating one would silently drain the cell it was just placed
      // into. Skip them as donor candidates until a census has seen them.
      for (const [idx, r] of recentlyMoved) {
        if (densityRound - r > 2) recentlyMoved.delete(idx)
      }
      const isFreshDonor = (idx: number) => !recentlyMoved.has(idx)
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
        const cellPx = voroCellPx[ci]
        if (!cellPx || cellPx.length === 0) continue
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
          if (densest < 0 && outsideUsed >= outsideAvail) {
            // Last tier: margin donors and the outside pool are exhausted.
            // Take from any cell still above the bare minimum so no cell is
            // left under it while surplus exists anywhere.
            let dc = perCell
            for (let i = 0; i < counts.length; i++) {
              if (counts[i] > dc && used[i] < Math.min(res.counts[i], k)) {
                dc = counts[i]
                densest = i
              }
            }
          }
          let donor = -1
          if (densest >= 0) {
            const avail = Math.min(res.counts[densest], k)
            while (used[densest] < avail) {
              const cand = res.samples[densest * k + used[densest]++]
              if (isFreshDonor(cand)) {
                donor = cand
                break
              }
            }
            if (donor < 0) continue // cursor exhausted; rescan donors
            counts[densest]--
            pendingDelta1[densest]--
            densityStats.fromCells++
          } else if (outsideUsed < outsideAvail) {
            while (outsideUsed < outsideAvail) {
              const cand = res.outside[outsideUsed++]
              if (isFreshDonor(cand)) {
                donor = cand
                break
              }
            }
            if (donor < 0) continue // pool exhausted; the last tier scans next
            densityStats.fromOutside++
          } else {
            break
          }
          recentlyMoved.set(donor, densityRound)
          // Land on a random glyph pixel of the deficient cell; jitter
          // stays within that pixel so the next census counts it here.
          const gi = cellPx[Math.floor(Math.random() * cellPx.length)]
          const g = glyphGrid
          const tx = g.minX + ((gi % g.cols) + 0.5 + (Math.random() - 0.5) * 0.8) * g.step
          const ty = g.minY + (Math.floor(gi / g.cols) + 0.5 + (Math.random() - 0.5) * 0.8) * g.step
          engine.setParticle(donor, {
            position: pageToWorld(tx, ty),
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

      // Density-weighted name opacity targets: the densest cell pins the
      // max, the rest interpolate by their surplus above the minimum.
      // Derived from the post-refill counts so the weights match the
      // enforced state; the tick loop eases the displayed opacity toward
      // these targets (opacity damping) to eliminate flicker.
      if (cellWeights.length === counts.length) {
        let maxCount = 0
        for (let i = 0; i < counts.length; i++) maxCount = Math.max(maxCount, counts[i])
        const span = maxCount - perCell
        for (let i = 0; i < counts.length; i++) {
          cellWeights[i] =
            span > 0 ? Math.min(1, Math.max(0, (counts[i] - perCell) / span)) : 0
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
      staticVizDirty = true
    }

    // Like the reference page's spawn-around-the-circle: particles are born
    // scattered around the name and around the content text, with the same
    // random launch speed.
    const spawnOne = (i: number, anchors: { x: number; y: number }[]): IParticle => {
      const anchor =
        anchors.length > 0 && i % 2 === 0
          ? anchors[Math.floor(Math.random() * anchors.length)]
          : name!.points[Math.floor(Math.random() * name!.points.length)]
      const spread = SPAWN_SPREAD_PX * Math.sqrt(Math.random())
      const angle = Math.random() * Math.PI * 2
      const { x, y } = pageToWorld(
        anchor.x + Math.cos(angle) * spread,
        anchor.y + Math.sin(angle) * spread,
      )
      const heading = Math.random() * Math.PI * 2
      return {
        position: { x, y },
        velocity: { x: Math.cos(heading) * SPAWN_SPEED, y: Math.sin(heading) * SPAWN_SPEED },
        size: 3,
        mass: 1,
        color: { r: 1, g: 1, b: 1, a: 1 },
      }
    }

    const spawnAll = () => {
      if (!engine || !name || name.points.length === 0) return
      const anchors = charBalls.filter((_, i) => i % 3 === 0)
      const count = PARTICLE_POOL(webgpu)
      const particles: IParticle[] = []
      for (let i = 0; i < count; i++) particles.push(spawnOne(i, anchors))
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
      let prevCap = start
      const step = (t: number) => {
        if (!engine) return
        const p = Math.min((t - t0) / durationMs, 1)
        const cap = Math.round(start + (target - start) * easeInOutCubic(p))
        // Particles revealed by a rising cap were frozen at stale positions
        // with stale velocities from an old mode; respawn them like fresh
        // particles so they enter as scattered texture, not as a burst. One
        // range write per frame (the span is contiguous), clamped to the
        // spawned pool.
        const revealTo = Math.min(cap, PARTICLE_POOL(webgpu))
        if (revealTo > prevCap && name && name.points.length > 0) {
          const anchors = charBalls.filter((_, i) => i % 3 === 0)
          const fresh: IParticle[] = []
          for (let i = prevCap; i < revealTo; i++) fresh.push(spawnOne(i, anchors))
          engine.setParticleRange(prevCap, fresh)
        }
        prevCap = cap
        engine.setMaxParticles(cap)
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
      const modeOverrides = overrides[index] ?? {}
      const next = discreteOf(preset)
      const to: Record<string, number> = {}
      for (const def of PARAM_DEFS) {
        to[def.key] =
          (modeOverrides as Record<string, number | undefined>)[def.key] ??
          def.from(preset, isMobile())
      }
      // User-overridden params stay static; their preset oscillator is
      // dropped. Range-slider retunes replace the oscillator's swing.
      const osc = presetOscillators(preset).filter(
        (o) => (modeOverrides as Record<string, number | undefined>)[o.key] === undefined,
      )
      for (const o of osc) {
        const ov = oscOverrides[index]?.[o.key]
        if (ov) {
          o.min = ov.min
          o.max = ov.max
        }
      }
      const ms = instant ? 0 : globals.transitionLength * 1000
      if (ms <= 0 || !discreteNow) {
        applyDiscrete(engine, mods, next, { isWebGPU: webgpu })
        discreteNow = next
        for (const def of PARAM_DEFS) {
          def.set(mods, to[def.key])
          currentParams[def.key] = to[def.key]
        }
        activeOsc = osc
        transition = null
      } else {
        const dip = dipKeys(discreteNow, next)
        const engineAt = engineTiming(discreteNow, next)
        discreteNow = applyDiscreteStart(mods, discreteNow, next)
        if (engineAt === 'start') applyEngineSettings(engine, next, { isWebGPU: webgpu })
        transition = {
          from: { ...currentParams },
          to,
          t0: performance.now(),
          ms,
          next,
          dip,
          osc,
          oscByKey: new Map(osc.map((o) => [o.key, o])),
          midDone: false,
          engineAt,
        }
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
      // The user takes over: pin the target and drop any oscillator on it.
      if (transition) {
        transition.to[key] = value
        transition.oscByKey.delete(key)
        transition.osc = transition.osc.filter((o) => o.key !== key)
      }
      activeOsc = activeOsc.filter((o) => o.key !== key)
    }
    bridge.getModeOscillators = () => {
      const preset = DEMO_PRESETS[demoIndex]
      const modeOverrides = (overrides[demoIndex] ?? {}) as Record<string, number | undefined>
      const out: Partial<Record<ModeSettingKey, { min: number; max: number }>> = {}
      for (const o of presetOscillators(preset)) {
        if (modeOverrides[o.key] !== undefined) continue
        const ov = oscOverrides[demoIndex]?.[o.key]
        out[o.key as ModeSettingKey] = { min: ov?.min ?? o.min, max: ov?.max ?? o.max }
      }
      return out
    }
    bridge.applyOscRange = (key: ModeSettingKey, min: number, max: number) => {
      oscOverrides[demoIndex] = { ...oscOverrides[demoIndex], [key]: { min, max } }
      // Live retune: the transition's osc list and activeOsc share entry
      // objects, so mutating both collections covers every phase.
      for (const list of [activeOsc, transition?.osc ?? []]) {
        for (const o of list) {
          if (o.key === key) {
            o.min = min
            o.max = max
          }
        }
      }
    }
    bridge.getCurrentSettings = () => getSettings(demoIndex)
    bridge.getLiveSettings = () => ({ ...currentParams }) as Partial<ModeSettings>
    bridge.applyGlobal = (key: GlobalSettingKey, value: number) => {
      globals[key] = value
      if (key === 'nameFont' || key === 'nameWeight') {
        measureName()
        staticVizDirty = true
        scheduleSync()
      } else if (key === 'modeDuration') scheduleNextDemo()
      else if (key === 'textStandoff' || key === 'boxAttraction') {
        pushField()
        staticVizDirty = true
        scheduleSync()
      } else if (key === 'textSmoothing') {
        buildTextField()
        staticVizDirty = true
        scheduleSync()
      } else if (key === 'nameAttraction' || key === 'concaveAvoidance') {
        // Two floats; the grid margin is fixed now, so a strength drag never
        // needs the multi-MB distance field rebuilt.
        pushNameParams()
        staticVizDirty = true
        if (bridge.debugOn) drawDebug()
      } else if (key === 'nameBaseOpacity' || key === 'nameDensityOpacity') {
        renderNameOpacity()
      } else if (key === 'debugOpacity') {
        // Debug-only: rescales the glow, touches no physics.
        staticVizDirty = true
        if (bridge.debugOn) drawDebug()
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
      modes: Object.fromEntries(
        DEMO_PRESETS.map((p, i) => {
          const modeOverrides = (overrides[i] ?? {}) as Record<string, number | undefined>
          const oscillators: Record<string, { min: number; max: number }> = {}
          for (const o of presetOscillators(p)) {
            if (modeOverrides[o.key] !== undefined) continue
            const ov = oscOverrides[i]?.[o.key]
            oscillators[o.key] = { min: ov?.min ?? o.min, max: ov?.max ?? o.max }
          }
          return [p.session.name, { ...getSettings(i), oscillators }]
        }),
      ),
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
        effectors: staticEffectors.length + totalTrailPoints(),
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
      effectors = new Effectors()
      pointers.clear()
      dynamicDirty = false
      lastCensus = null
      // Fresh modules carry default discrete state; the instant applyDemo in
      // boot re-seeds these from the active preset.
      discreteNow = null
      activeOsc = []
      transition = null
      const eng = new Engine({
        canvas,
        forces: [
          mods.environment,
          mods.boundary,
          mods.collisions,
          mods.fluids,
          mods.behavior,
          mods.sensors,
          effectors,
        ],
        render: [mods.trails, mods.particles],
        runtime: pref,
        maxParticles: 80_000,
        cellSize: 16,
        maxNeighbors: 100,
        constrainIterations: 1,
        onFrame: tick,
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
          bridge,
          effectors,
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
            cellAreas: voroCellPx.map((a) => a.length),
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

    // Every pointer — the mouse or each touch — is its own force field.
    // A hovering mouse attracts; pressing repels. A touch starts as an
    // attractor and blends into repulsion once its pressure crosses half
    // strength. Everything scales with that pointer's speed and pressure.
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element && target.closest('a, button, input, select, .settings-panel')
    const fieldOf = (e: PointerEvent): PointerField => {
      let ps = pointers.get(e.pointerId)
      if (!ps) {
        ps = {
          x: e.pageX,
          y: e.pageY,
          speed: 0,
          lastAt: 0,
          lastX: e.pageX,
          lastY: e.pageY,
          pressure: 0,
          pressureTarget: 0,
          repelMix: 0,
          down: false,
          isTouch: e.pointerType !== 'mouse',
          ended: false,
          trail: [],
        }
        pointers.set(e.pointerId, ps)
      }
      ps.ended = false
      return ps
    }
    const updateField = (e: PointerEvent, ps: PointerField) => {
      const now = performance.now()
      if (ps.lastAt > 0) {
        const dt = now - ps.lastAt
        if (dt > 0) {
          const v = (Math.hypot(e.pageX - ps.lastX, e.pageY - ps.lastY) / dt) * 1000
          ps.speed += (v - ps.speed) * Math.min(1, dt / 120)
        }
      }
      ps.lastAt = now
      ps.lastX = e.pageX
      ps.lastY = e.pageY
      ps.x = e.pageX
      ps.y = e.pageY
      // Touches report analog per-finger pressure through pointer events;
      // the mouse path uses pressure.js (blended in during tick).
      if (ps.isTouch) ps.pressureTarget = e.pressure
      dynamicDirty = true
    }
    const collectTrailPoint = (e: PointerEvent, ps: PointerField) => {
      const last = ps.trail[ps.trail.length - 1]
      if (last && Math.hypot(e.pageX - last.x, e.pageY - last.y) < TRAIL_MIN_SPACING_PX) return
      // The point budget is shared across pointers: drop the oldest point
      // of the longest trail when full.
      if (totalTrailPoints() >= TRAIL_MAX_POINTS) {
        let longest: PointerField | null = null
        for (const other of pointers.values()) {
          if (!longest || other.trail.length > longest.trail.length) longest = other
        }
        longest?.trail.shift()
      }
      ps.trail.push({
        x: e.pageX,
        y: e.pageY,
        t: performance.now(),
        sb: strengthBoost(ps),
        press: ps.pressure,
        push: ps.repelMix > 0.5,
      })
    }
    const onPointerDown = (e: PointerEvent) => {
      if (isInteractive(e.target)) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const ps = fieldOf(e)
      ps.down = true
      updateField(e, ps)
    }
    const onPointerMove = (e: PointerEvent) => {
      const ps = fieldOf(e)
      updateField(e, ps)
      collectTrailPoint(e, ps)
    }
    const onPointerUp = (e: PointerEvent) => {
      const ps = pointers.get(e.pointerId)
      if (!ps) return
      ps.down = false
      ps.pressureTarget = 0
      if (ps.isTouch) {
        // The finger is gone: hide the head, let the trail decay out.
        ps.ended = true
      }
      dynamicDirty = true
    }
    const onLeaveWindow = () => {
      // Mouse head detaches; its trail keeps aging in tick().
      for (const ps of pointers.values()) {
        if (!ps.isTouch) ps.ended = true
      }
      dynamicDirty = true
    }
    const onEnterWindow = () => {
      for (const ps of pointers.values()) {
        if (!ps.isTouch) ps.ended = false
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    document.documentElement.addEventListener('pointerleave', onLeaveWindow)
    document.documentElement.addEventListener('pointerenter', onEnterWindow)
    cleanups.push(() => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.documentElement.removeEventListener('pointerleave', onLeaveWindow)
      document.documentElement.removeEventListener('pointerenter', onEnterWindow)
    })

    // pressure.js supplies cross-platform mouse pressure: real Force Touch
    // on Safari, and a time-ramped hold via its polyfill elsewhere, so
    // pressing harder (or longer) always deepens the field.
    Pressure.set(
      document.body,
      {
        change: (force) => {
          mouseForce = force
        },
        end: () => {
          mouseForce = 0
        },
      },
      { only: 'mouse', polyfill: true, polyfillSpeedUp: 700, polyfillSpeedDown: 300, preventSelect: false },
    )

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
      if (engine) {
        void engine.destroy()
        engine = null
      }
    }
  }, [])

  return (
    <div ref={holderRef} className="party-holder" aria-hidden="true">
      <canvas ref={canvasRef} className="party-canvas" />
      <canvas ref={nameTextRef} className="party-nametext" />
      <canvas ref={debugRef} className="party-debug" />
    </div>
  )
}
