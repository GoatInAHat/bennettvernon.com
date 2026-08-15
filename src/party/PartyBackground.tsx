import { useEffect, useRef } from 'react'
import { Engine, Interaction, type IParticle } from '@cazala/party'
import { Effectors, type Effector } from './effectors'
import { createPartyModules, applyPreset, DEMO_PRESETS } from './presets'
import { getTargets, getHovered, onTargetsChanged } from './targets'

const NAME_LINES = ['BENNETT', 'VERNON']
const NAME_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", system-ui, sans-serif'
const GUTTER_PX = 22
// Fixed drag interaction, same values as the caza.la/party homepage.
const DRAG_STRENGTH = 100_000
const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768
const DESIRED_ZOOM = () => (isMobile() ? 0.2 : 0.3)
const DRAG_RADIUS = () => (isMobile() ? 700 : 800)
const SWARM_BUDGET = (webgpu: boolean) => (webgpu ? (isMobile() ? 24_000 : 80_000) : 2_500)
const MAX_CANVAS_HEIGHT = 8_000

/** Effector tuning (world units are CSS px / zoom). */
const NAME_POINT_STRENGTH = 10_000
const BLOCK_STRENGTH = 100_000
const BLOCK_RANGE_PX = 120
const BLOCK_FRAME_PAD_PX = 14
const BLOCK_FRAME_RANGE_PX = 90
const BLOCK_FRAME_STRENGTH = 14_000
const DOT_STRENGTH = 100_000
const DOT_RANGE_PX = 70
const NAV_ATTRACT_STRENGTH = 28_000
const NAV_ATTRACT_RANGE_PX = 110
const NAV_UNDERLINE_OFFSET_PX = 10
const NAV_UNDERLINE_HALF_H_PX = 3
const NAV_PILL_STRENGTH = 100_000
const NAV_PILL_PAD_PX = 12

function nameWidth(pageW: number): number {
  // ~1/3 of the page on desktop (min sized for a regular ~1440px desktop);
  // below the width where that would exceed 3/4 of the page, span the page.
  const desktop = Math.max(pageW / 3, 480)
  return desktop >= pageW * 0.75 ? pageW - GUTTER_PX * 2 : desktop
}

interface NameLayout {
  /** Page-space glyph sample points the particles are attracted to. */
  points: { x: number; y: number }[]
  bottom: number
  width: number
  /** Sampling step in page px; also drives attractor range and spawn jitter. */
  step: number
}

/** Samples the bold name glyphs into page-space points, top-left justified. */
function sampleName(pageW: number, viewportH: number): NameLayout {
  const off = document.createElement('canvas')
  const ctx = off.getContext('2d', { willReadFrequently: true })
  const width = nameWidth(pageW)
  if (!ctx) return { points: [], bottom: viewportH * 0.4, width, step: 10 }
  ctx.font = `700 100px ${NAME_FONT}`
  const widest = Math.max(...NAME_LINES.map((l) => ctx.measureText(l).width))
  const size = (100 * width) / widest
  const lineGap = size * 1.08
  const topY = Math.max(48, viewportH * 0.08)
  const step = Math.max(8, Math.round(size / 16))

  const points: { x: number; y: number }[] = []
  NAME_LINES.forEach((text, i) => {
    off.width = Math.ceil(width) + step * 2
    off.height = Math.ceil(size * 1.3)
    const c = off.getContext('2d', { willReadFrequently: true })
    if (!c) return
    c.clearRect(0, 0, off.width, off.height)
    c.font = `700 ${size}px ${NAME_FONT}`
    c.textBaseline = 'top'
    c.fillStyle = '#fff'
    c.fillText(text, 0, 0)
    const data = c.getImageData(0, 0, off.width, off.height).data
    for (let y = 0; y < off.height; y += step) {
      for (let x = 0; x < off.width; x += step) {
        if (data[(y * off.width + x) * 4 + 3] > 64) {
          points.push({ x: GUTTER_PX + x, y: topY + i * lineGap + y })
        }
      }
    }
  })
  return { points, bottom: topY + lineGap + size * 1.1, width, step }
}

export function PartyBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const holder = holderRef.current
    if (!canvas || !holder) return

    let disposed = false
    let engine: Engine | null = null
    let zoom = DESIRED_ZOOM()
    let webgpu = false
    let demoIndex = 0
    let demoTimer = 0
    let maxParticlesRaf = 0
    let syncScheduled = false
    let name: NameLayout = { points: [], bottom: 0, width: 0, step: 10 }
    const cleanups: (() => void)[] = []

    const mods = createPartyModules()
    const interaction = new Interaction({
      mode: 'repel',
      strength: DRAG_STRENGTH,
      radius: DRAG_RADIUS(),
      active: false,
    })
    const effectors = new Effectors()

    const pageToWorld = (px: number, py: number) => ({ x: px / zoom, y: py / zoom })

    const nameEffectors = (): Effector[] => {
      const range = Math.max(20, name.step * 2) / zoom
      return name.points.map((p) => ({
        shape: 'circle' as const,
        mode: 'attract' as const,
        x: p.x / zoom,
        y: p.y / zoom,
        range,
        halfW: 0,
        halfH: 0,
        strength: NAME_POINT_STRENGTH,
      }))
    }

    const syncEffectors = () => {
      syncScheduled = false
      if (!engine) return
      const hovered = getHovered()
      const list: Effector[] = nameEffectors()
      for (const t of getTargets()) {
        const r = t.el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        const cx = (r.left + window.scrollX + r.width / 2) / zoom
        const cy = (r.top + window.scrollY + r.height / 2) / zoom
        if (t.kind === 'block') {
          // Push particles out of the text, gather them on a frame around it.
          list.push({
            shape: 'rect',
            mode: 'repel',
            x: cx,
            y: cy,
            range: BLOCK_RANGE_PX / zoom,
            halfW: r.width / 2 / zoom,
            halfH: r.height / 2 / zoom,
            strength: BLOCK_STRENGTH,
          })
          list.push({
            shape: 'rect',
            mode: 'attract',
            x: cx,
            y: cy,
            range: BLOCK_FRAME_RANGE_PX / zoom,
            halfW: (r.width / 2 + BLOCK_FRAME_PAD_PX) / zoom,
            halfH: (r.height / 2 + BLOCK_FRAME_PAD_PX) / zoom,
            strength: BLOCK_FRAME_STRENGTH,
          })
        } else if (t.kind === 'dot') {
          if (hovered?.kind === 'dot' && hovered.id !== t.id) continue
          list.push({
            shape: 'circle',
            mode: 'repel',
            x: cx,
            y: cy,
            range: DOT_RANGE_PX / zoom,
            halfW: 0,
            halfH: 0,
            strength: DOT_STRENGTH,
          })
        } else {
          // nav: attract underline normally, tight repel pill while hovered
          if (hovered?.kind === 'nav' && hovered.id !== t.id) continue
          if (hovered?.kind === 'nav' && hovered.id === t.id) {
            list.push({
              shape: 'pill',
              mode: 'repel',
              x: cx,
              y: cy,
              range: (r.height / 2 + NAV_PILL_PAD_PX) / zoom,
              halfW: r.width / 2 / zoom,
              halfH: 0,
              strength: NAV_PILL_STRENGTH,
            })
          } else {
            const underlineY = (r.bottom + window.scrollY + NAV_UNDERLINE_OFFSET_PX) / zoom
            list.push({
              shape: 'rect',
              mode: 'attract',
              x: cx,
              y: underlineY,
              range: NAV_ATTRACT_RANGE_PX / zoom,
              halfW: r.width / 2 / zoom,
              halfH: NAV_UNDERLINE_HALF_H_PX / zoom,
              strength: NAV_ATTRACT_STRENGTH,
            })
          }
        }
      }
      effectors.set(list)
    }

    const scheduleSync = () => {
      if (syncScheduled) return
      syncScheduled = true
      requestAnimationFrame(syncEffectors)
    }

    const layout = () => {
      if (!engine) return
      // The overflow-hidden holder tracks the content height, so the canvas
      // itself never feeds back into the document height measurement.
      const w = holder.clientWidth
      const h = Math.min(holder.clientHeight, MAX_CANVAS_HEIGHT)
      if (w < 1 || h < 1) return
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      engine.setSize(w, h)
      engine.setZoom(DESIRED_ZOOM())
      zoom = engine.getZoom() // may be clamped on tall pages
      engine.setCamera(w / (2 * zoom), h / (2 * zoom))
    }

    const measureName = () => {
      name = sampleName(holder.clientWidth, window.innerHeight)
      document.documentElement.style.setProperty('--name-bottom', `${Math.round(name.bottom)}px`)
    }

    // Free particles are born in the shape of the name and merely guided
    // back to it by the glyph attractors afterwards. A fifth of them seed
    // the rest of the page so the underline and block-frame attractors have
    // roamers to gather from the start.
    const spawnAll = () => {
      if (!engine || name.points.length === 0) return
      const count = SWARM_BUDGET(webgpu)
      const jitter = name.step
      const pageW = holder.clientWidth
      const pageH = Math.min(holder.clientHeight, MAX_CANVAS_HEIGHT)
      const particles: IParticle[] = []
      for (let i = 0; i < count; i++) {
        const roamer = i % 5 === 0
        const p = roamer
          ? { x: Math.random() * pageW, y: Math.random() * pageH }
          : name.points[Math.floor(Math.random() * name.points.length)]
        const { x, y } = pageToWorld(
          p.x + (Math.random() - 0.5) * jitter,
          p.y + (Math.random() - 0.5) * jitter,
        )
        particles.push({
          position: { x, y },
          velocity: { x: 0, y: 0 },
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
      const tick = (t: number) => {
        if (!engine) return
        const p = Math.min((t - t0) / durationMs, 1)
        const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
        engine.setMaxParticles(Math.round(start + (target - start) * eased))
        if (p < 1) maxParticlesRaf = requestAnimationFrame(tick)
      }
      maxParticlesRaf = requestAnimationFrame(tick)
    }

    const applyDemo = (index: number) => {
      if (!engine) return
      demoIndex = index
      const preset = DEMO_PRESETS[index]
      applyPreset(engine, mods, preset, { isMobile: isMobile(), isWebGPU: webgpu })
      setMaxParticlesAnimated(
        Math.floor(SWARM_BUDGET(webgpu) * preset.budgetFactor),
        preset.transitionMs,
      )
      window.dispatchEvent(new CustomEvent('party:demo', { detail: index }))
      window.clearTimeout(demoTimer)
      demoTimer = window.setTimeout(
        () => applyDemo((index + 1) % DEMO_PRESETS.length),
        preset.duration[isMobile() ? 1 : 0],
      )
    }

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
      layout()
      measureName()
      lastPageW = holder.clientWidth
      spawnAll()
      syncEffectors()
      applyDemo(0)
      engine.play()
    }

    // Pointer drag moves the repel field, like the reference landing page —
    // holding it over the name dissolves it.
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element && target.closest('a, button')
    let dragging = false
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || isInteractive(e.target)) return
      dragging = true
      const { x, y } = pageToWorld(e.pageX, e.pageY)
      interaction.setPosition(x, y)
      interaction.setActive(true)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      const { x, y } = pageToWorld(e.pageX, e.pageY)
      interaction.setPosition(x, y)
      interaction.setActive(true)
    }
    const stopDrag = () => {
      dragging = false
      interaction.setActive(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    cleanups.push(() => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
    })

    // The fixed-position demo dots move in page space while scrolling.
    window.addEventListener('scroll', scheduleSync, { passive: true })
    cleanups.push(() => window.removeEventListener('scroll', scheduleSync))
    cleanups.push(onTargetsChanged(scheduleSync))

    // Viewport/document size changes: always relayout and resync; only
    // respawn (and re-measure the name) when the width actually changed,
    // so tab switches that change page height don't reset the swarm.
    let resizeTimer = 0
    let lastPageW = 0
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        if (!engine) return
        const pageW = holder.clientWidth
        layout()
        measureName()
        if (pageW !== lastPageW) {
          lastPageW = pageW
          spawnAll()
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

    // Dot clicks select a demo and the rotation resumes from it.
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
      if (engine) {
        void engine.destroy()
        engine = null
      }
    }
  }, [])

  return (
    <div ref={holderRef} className="party-holder" aria-hidden="true">
      <canvas ref={canvasRef} className="party-canvas" />
    </div>
  )
}
