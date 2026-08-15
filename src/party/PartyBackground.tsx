import { useEffect, useRef } from 'react'
import { Engine, Interaction, type IParticle } from '@cazala/party'
import { bridge, SETTING_KEYS, type ModeSettings, type SettingKey } from './bridge'
import { Effectors, type Effector } from './effectors'
import { createPartyModules, applyPreset, DEMO_PRESETS } from './presets'
import { getTargets, onTargetsChanged } from './targets'

const NAME_LINES = ['BENNETT', 'VERNON']
const NAME_FONT = 'Georgia, "Times New Roman", serif'
const GUTTER_PX = 22
const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768
const DESIRED_ZOOM = () => (isMobile() ? 0.2 : 0.3)
const DRAG_RADIUS = () => (isMobile() ? 700 : 800)
const SWARM_BUDGET = (webgpu: boolean) => (webgpu ? (isMobile() ? 24_000 : 80_000) : 2_500)
const MAX_CANVAS_HEIGHT = 8_000

/** Effector tuning (world units are CSS px / zoom). */
const BOX_RANGE_PX = 22
const BOX_CORNER_PX = 12
const PANEL_RANGE_PX = 26
const NAME_ATTRACTION_DEFAULT = 10_000
const BOX_STRENGTH_DEFAULT = 100_000
const DRAG_STRENGTH_DEFAULT = 100_000
const SPAWN_SPREAD_PX = 60
const SPAWN_SPEED = 100

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
  /** Type geometry for the debug outline. */
  size: number
  topY: number
  lineGap: number
}

/** Samples the bold name glyphs into page-space points, top-left justified. */
function sampleName(pageW: number, viewportH: number): NameLayout {
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
  ctx.font = `100px ${NAME_FONT}`
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
    c.font = `${size}px ${NAME_FONT}`
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
  return { points, bottom: topY + lineGap + size * 1.1, width, step, size, topY, lineGap }
}

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
    let syncScheduled = false
    let rotationPaused = false
    let nameAttraction = NAME_ATTRACTION_DEFAULT
    let boxAttraction = BOX_STRENGTH_DEFAULT
    const overrides: Partial<Record<number, Partial<ModeSettings>>> = {}
    let name: NameLayout = sampleName(1440, 900)
    let boxRects: DOMRect[] = []
    const cleanups: (() => void)[] = []

    const mods = createPartyModules()
    const interaction = new Interaction({
      mode: 'repel',
      strength: DRAG_STRENGTH_DEFAULT,
      radius: DRAG_RADIUS(),
      active: false,
    })
    const effectors = new Effectors()

    const pageToWorld = (px: number, py: number) => ({ x: px / zoom, y: py / zoom })

    // Same field as the caza.la/party center circle (repel, linear falloff,
    // particles settle at the influence edge) but rect-shaped with rounded
    // corners: shrinking the rect by the corner radius and extending the
    // range by it makes the settle boundary a rounded box hugging the element.
    const boxEffector = (r: DOMRect, rangePx: number): Effector => ({
      shape: 'rect',
      mode: 'repel',
      x: (r.left + window.scrollX + r.width / 2) / zoom,
      y: (r.top + window.scrollY + r.height / 2) / zoom,
      range: (rangePx + BOX_CORNER_PX) / zoom,
      halfW: Math.max(4, r.width / 2 - BOX_CORNER_PX) / zoom,
      halfH: Math.max(4, r.height / 2 - BOX_CORNER_PX) / zoom,
      strength: boxAttraction,
    })

    const drawDebug = () => {
      const dctx = debugCanvas.getContext('2d')
      if (!dctx) return
      dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
      if (!bridge.debugOn) return
      dctx.strokeStyle = 'rgba(220, 40, 40, 0.8)'
      dctx.lineWidth = 1
      // Name: outline of the type the attractor points were sampled from.
      dctx.font = `${name.size}px ${NAME_FONT}`
      dctx.textBaseline = 'top'
      NAME_LINES.forEach((text, i) => {
        dctx.strokeText(text, GUTTER_PX, name.topY + i * name.lineGap)
      })
      // Boxes: the settle boundary each box effector produces.
      for (const r of boxRects) {
        const pad = BOX_RANGE_PX
        dctx.beginPath()
        dctx.roundRect(
          r.left + window.scrollX - pad,
          r.top + window.scrollY - pad,
          r.width + pad * 2,
          r.height + pad * 2,
          BOX_CORNER_PX + pad,
        )
        dctx.stroke()
      }
    }

    const syncEffectors = () => {
      syncScheduled = false
      if (!engine) return
      const range = Math.max(16, name.step * 2.2) / zoom
      const list: Effector[] = name.points.map((p) => ({
        shape: 'circle' as const,
        mode: 'attract' as const,
        x: p.x / zoom,
        y: p.y / zoom,
        range,
        halfW: 0,
        halfH: 0,
        strength: nameAttraction,
      }))
      boxRects = []
      for (const t of getTargets()) {
        const r = t.el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        boxRects.push(r)
        list.push(boxEffector(r, t.kind === 'panel' ? PANEL_RANGE_PX : BOX_RANGE_PX))
      }
      effectors.set(list)
      drawDebug()
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
      for (const c of [canvas, debugCanvas]) {
        c.style.width = `${w}px`
        c.style.height = `${h}px`
      }
      debugCanvas.width = w
      debugCanvas.height = h
      engine.setSize(w, h)
      engine.setZoom(DESIRED_ZOOM())
      zoom = engine.getZoom() // may be clamped on tall pages
      engine.setCamera(w / (2 * zoom), h / (2 * zoom))
    }

    const measureName = () => {
      name = sampleName(holder.clientWidth, window.innerHeight)
      document.documentElement.style.setProperty('--name-bottom', `${Math.round(name.bottom)}px`)
    }

    /** Page-space anchor points along the perimeter of each content box. */
    const boxAnchors = (): { x: number; y: number }[] => {
      const anchors: { x: number; y: number }[] = []
      for (const t of getTargets()) {
        const r = t.el.getBoundingClientRect()
        if (r.width === 0) continue
        const x0 = r.left + window.scrollX
        const y0 = r.top + window.scrollY
        for (let x = 0; x <= r.width; x += 12) {
          anchors.push({ x: x0 + x, y: y0 }, { x: x0 + x, y: y0 + r.height })
        }
        for (let y = 12; y < r.height; y += 12) {
          anchors.push({ x: x0, y: y0 + y }, { x: x0 + r.width, y: y0 + y })
        }
      }
      return anchors
    }

    // Like the reference page's spawn-around-the-circle: particles are born
    // scattered around the name and around every content box, with the same
    // random launch speed.
    const spawnAll = () => {
      if (!engine || name.points.length === 0) return
      const boxes = boxAnchors()
      const count = SWARM_BUDGET(webgpu)
      const particles: IParticle[] = []
      for (let i = 0; i < count; i++) {
        const anchor =
          boxes.length > 0 && i % 2 === 0
            ? boxes[Math.floor(Math.random() * boxes.length)]
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
      const tick = (t: number) => {
        if (!engine) return
        const p = Math.min((t - t0) / durationMs, 1)
        const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
        engine.setMaxParticles(Math.round(start + (target - start) * eased))
        if (p < 1) maxParticlesRaf = requestAnimationFrame(tick)
      }
      maxParticlesRaf = requestAnimationFrame(tick)
    }

    const applySettingValue = (key: SettingKey, v: number) => {
      switch (key) {
        case 'gravity':
          mods.environment.setGravityStrength(v)
          break
        case 'wander':
          mods.behavior.setWander(v)
          break
        case 'cohesion':
          mods.behavior.setCohesion(v)
          break
        case 'alignment':
          mods.behavior.setAlignment(v)
          break
        case 'separation':
          mods.behavior.setSeparation(v)
          break
        case 'viscosity':
          mods.fluids.setViscosity(v)
          break
        case 'pressure':
          mods.fluids.setPressureMultiplier(v)
          break
        case 'trailDecay':
          mods.trails.setTrailDecay(v)
          break
        case 'dragStrength':
          interaction.setStrength(v)
          break
        case 'dragRadius':
          interaction.setRadius(v)
          break
        case 'nameAttraction':
          nameAttraction = v
          scheduleSync()
          break
        case 'boxAttraction':
          boxAttraction = v
          scheduleSync()
          break
      }
    }

    const baseSettings = (index: number): ModeSettings => {
      const m = DEMO_PRESETS[index].session.modules
      return {
        gravity: m.environment.gravityStrength,
        wander: m.behavior.wander,
        cohesion: m.behavior.cohesion,
        alignment: m.behavior.alignment,
        separation: m.behavior.separation,
        viscosity: m.fluids.viscosity,
        pressure: m.fluids.pressureMultiplier,
        trailDecay: m.trails.trailDecay,
        dragStrength: DRAG_STRENGTH_DEFAULT,
        dragRadius: DRAG_RADIUS(),
        nameAttraction: NAME_ATTRACTION_DEFAULT,
        boxAttraction: BOX_STRENGTH_DEFAULT,
      }
    }

    const getSettings = (index: number): ModeSettings => ({
      ...baseSettings(index),
      ...overrides[index],
    })

    const scheduleNextDemo = () => {
      window.clearTimeout(demoTimer)
      if (rotationPaused) return
      demoTimer = window.setTimeout(
        () => applyDemo((demoIndex + 1) % DEMO_PRESETS.length),
        DEMO_PRESETS[demoIndex].duration[isMobile() ? 1 : 0],
      )
    }

    const applyDemo = (index: number) => {
      if (!engine) return
      demoIndex = index
      const preset = DEMO_PRESETS[index]
      applyPreset(engine, mods, preset, { isMobile: isMobile(), isWebGPU: webgpu })
      const settings = getSettings(index)
      for (const key of SETTING_KEYS) applySettingValue(key, settings[key])
      setMaxParticlesAnimated(
        Math.floor(SWARM_BUDGET(webgpu) * preset.budgetFactor),
        preset.transitionMs,
      )
      window.dispatchEvent(new CustomEvent('party:demo', { detail: index }))
      scheduleSync()
      scheduleNextDemo()
    }

    bridge.setPaused = (paused: boolean) => {
      rotationPaused = paused
      scheduleNextDemo()
    }
    bridge.applySetting = (key, value) => {
      overrides[demoIndex] = { ...overrides[demoIndex], [key]: value }
      applySettingValue(key, value)
    }
    bridge.getCurrentSettings = () => getSettings(demoIndex)
    bridge.getAllSettings = () =>
      Object.fromEntries(DEMO_PRESETS.map((p, i) => [p.session.name, getSettings(i)]))
    bridge.setDebug = (on) => {
      bridge.debugOn = on
      scheduleSync()
    }
    cleanups.push(() => {
      bridge.setPaused = () => {}
      bridge.applySetting = () => {}
      bridge.getCurrentSettings = () => null
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
      target instanceof Element && target.closest('a, button, input, .settings-panel')
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

    // The fixed-position settings panel moves in page space while scrolling.
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
      <canvas ref={debugRef} className="party-debug" />
    </div>
  )
}
