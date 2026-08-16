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
const SEPARATOR_HALF_H_PX = 2
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
const DENSITY_INTERVAL_MS = 400
const DENSITY_TELEPORT_BUDGET = 250

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
  const step = Math.max(8, Math.round(size / 16))

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
    let staticEffectors: Effector[] = []
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
    const kernelRadius = (b: CharBall) => (b.r + globals.textPadding) * globals.textSmoothing
    // Iso threshold so an isolated ball's surface sits at r + padding.
    const isoThreshold = () => {
      const k = Math.max(1.05, globals.textSmoothing)
      const q = 1 - 1 / (k * k)
      return q * q
    }

    const toPageRect = (r: DOMRect) => ({
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
    })

    /** Renders the merged metaball field once into an offscreen layer. */
    const renderBlobCache = () => {
      blobCacheDirty = false
      if (!blobCache) blobCache = document.createElement('canvas')
      blobCache.width = debugCanvas.width
      blobCache.height = debugCanvas.height
      const ctx = blobCache.getContext('2d')
      if (!ctx || charBalls.length === 0) return
      ctx.fillStyle = 'rgba(220, 40, 40, 0.22)'
      const iso = isoThreshold()
      const sorted = [...charBalls].sort((a, b) => a.y - b.y)
      const maxR = Math.max(...sorted.map(kernelRadius))
      const minX = Math.min(...sorted.map((b) => b.x - kernelRadius(b)))
      const maxX = Math.max(...sorted.map((b) => b.x + kernelRadius(b)))
      const minY = sorted[0].y - maxR
      const maxY = sorted[sorted.length - 1].y + maxR
      const G = 3
      let lo = 0
      for (let y = minY; y <= maxY && y < blobCache.height; y += G) {
        while (lo < sorted.length && sorted[lo].y < y - maxR) lo++
        const row: { x: number; y: number; R2: number }[] = []
        for (let i = lo; i < sorted.length && sorted[i].y <= y + maxR; i++) {
          const R = kernelRadius(sorted[i])
          if (Math.abs(sorted[i].y - y) <= R) row.push({ x: sorted[i].x, y: sorted[i].y, R2: R * R })
        }
        if (row.length === 0) continue
        for (let x = minX; x <= maxX; x += G) {
          let S = 0
          for (const b of row) {
            const dx = x - b.x
            const dy = y - b.y
            const d2 = dx * dx + dy * dy
            if (d2 < b.R2) {
              const q = 1 - d2 / b.R2
              S += q * q
              if (S > iso) break
            }
          }
          if (S > iso) ctx.fillRect(x, y, G, G)
        }
      }
    }

    const drawDebug = () => {
      const dctx = debugCanvas.getContext('2d')
      if (!dctx) return
      dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
      if (!bridge.debugOn || !name) return
      if (blobCacheDirty) renderBlobCache()
      if (blobCache) dctx.drawImage(blobCache, 0, 0)
      dctx.strokeStyle = 'rgba(220, 40, 40, 0.8)'
      dctx.lineWidth = 1
      // Name: outline of the type the attractor points were sampled from.
      dctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      dctx.textBaseline = 'top'
      NAME_LINES.forEach((text, i) => {
        dctx.strokeText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      // Voronoi seeds of the name-density cells.
      dctx.fillStyle = 'rgba(40, 90, 220, 0.8)'
      for (const s of voroSeeds) {
        dctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3)
      }
      // Separator lines and the settings panel.
      for (const t of getTargets()) {
        const r = toPageRect(t.el.getBoundingClientRect())
        if (r.w === 0) continue
        if (t.kind === 'separator') {
          dctx.strokeRect(r.x, r.y + r.h / 2 - SEPARATOR_HALF_H_PX, r.w, SEPARATOR_HALF_H_PX * 2)
        } else {
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
      const iso = isoThreshold()
      for (const b of charBalls) {
        list.push({
          shape: 'ball',
          mode: 'repel',
          x: b.x / zoom,
          y: b.y / zoom,
          range: kernelRadius(b) / zoom,
          halfW: iso,
          halfH: 0,
          strength: globals.boxAttraction,
        })
      }
      for (const t of getTargets()) {
        const r = toPageRect(t.el.getBoundingClientRect())
        if (r.w === 0 && r.h === 0) continue
        if (t.kind === 'separator') {
          list.push({
            shape: 'rect',
            mode: 'attract',
            x: (r.x + r.w / 2) / zoom,
            y: (r.y + r.h / 2) / zoom,
            range: SEPARATOR_RANGE_PX / zoom,
            halfW: r.w / 2 / zoom,
            halfH: SEPARATOR_HALF_H_PX / zoom,
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
      effectors.set([...staticEffectors, ...cursorEffectors(performance.now())])
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

    // Per-frame driver: cursor trail decay and smooth mode transitions.
    const tick = () => {
      tickRaf = requestAnimationFrame(tick)
      if (!engine) return
      const now = performance.now()
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
      if (cursor || trail.length > 0) {
        effectors.set([...staticEffectors, ...cursorEffectors(now)])
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
              members[ci].push(donor)
              need--
              budget--
            }
          }
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
      else if (key === 'textPadding' || key === 'textSmoothing') {
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
      scheduleSync()
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
      effectors.set(staticEffectors)
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
