import { useEffect, useRef } from 'react'
import { Engine, Interaction, type IParticle } from '@cazala/party'
import {
  bridge,
  NAME_FONTS,
  SETTING_KEYS,
  type GlobalSettings,
  type ModeSettings,
  type SettingKey,
} from './bridge'
import { Effectors, type Effector } from './effectors'
import { createPartyModules, applyPreset, DEMO_PRESETS } from './presets'
import { getTargets, onTargetsChanged } from './targets'

const NAME_LINES = ['BENNETT', 'VERNON']
const GUTTER_PX = 22
/** The name sits this far from both the left and the top edge. */
const NAME_MARGIN_PX = GUTTER_PX * 2
const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768
const DESIRED_ZOOM = () => (isMobile() ? 0.2 : 0.3)
const DRAG_RADIUS = () => (isMobile() ? 700 : 800)
const SWARM_BUDGET = (webgpu: boolean) => (webgpu ? (isMobile() ? 24_000 : 80_000) : 2_500)
/** Backing-store cap; taller pages render uniformly downscaled so the
 * simulation always reaches the bottom of the page. */
const MAX_CANVAS_HEIGHT = 8_000

/** Effector tuning (world units are CSS px / zoom). */
const PANEL_RANGE_PX = 6
const BOX_CORNER_PX = 6
const SEPARATOR_RANGE_PX = 90
const SEPARATOR_HALF_H_PX = 2
const NAME_ATTRACTION_DEFAULT = 10_000
const BOX_STRENGTH_DEFAULT = 100_000
const DRAG_STRENGTH_DEFAULT = 100_000
const TEXT_PADDING_DEFAULT = 8
const SEPARATOR_ATTRACTION_DEFAULT = 15_000
const NAME_WEIGHT_DEFAULT = 700
const SPAWN_SPREAD_PX = 60
const SPAWN_SPEED = 100

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
function sampleName(
  pageW: number,
  viewportH: number,
  font: string,
  weight: number,
): NameLayout {
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

interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

/** Page-space rects of every rendered text line in the main content. */
function collectTextRects(): PageRect[] {
  const root = document.querySelector('main')
  if (!root) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  const rects: PageRect[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue
    range.selectNodeContents(node)
    for (const r of range.getClientRects()) {
      if (r.width > 1 && r.height > 1) {
        rects.push({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height })
      }
    }
  }
  return rects
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
    let nameAttraction = NAME_ATTRACTION_DEFAULT
    let boxAttraction = BOX_STRENGTH_DEFAULT
    let textPadding = TEXT_PADDING_DEFAULT
    let separatorAttraction = SEPARATOR_ATTRACTION_DEFAULT
    const globals: GlobalSettings = { nameFont: 0, nameWeight: NAME_WEIGHT_DEFAULT }
    const overrides: Partial<Record<number, Partial<ModeSettings>>> = {}
    let name: NameLayout | null = null
    let textRects: PageRect[] = []
    const cleanups: (() => void)[] = []

    const mods = createPartyModules()
    const interaction = new Interaction({
      mode: 'repel',
      strength: DRAG_STRENGTH_DEFAULT,
      radius: DRAG_RADIUS(),
      active: false,
    })
    const effectors = new Effectors()

    const nameFontStack = () => NAME_FONTS[globals.nameFont]?.stack ?? NAME_FONTS[0].stack
    const pageToWorld = (px: number, py: number) => ({ x: px / zoom, y: py / zoom })

    // Same field as the caza.la/party center circle (repel, linear falloff,
    // particles settle at the influence edge) but rect-shaped with rounded
    // corners: shrinking the rect by the corner radius and extending the
    // range by it makes the settle boundary a rounded box hugging the shape.
    const boxEffector = (r: PageRect, rangePx: number, cornerPx: number): Effector => ({
      shape: 'rect',
      mode: 'repel',
      x: (r.x + r.w / 2) / zoom,
      y: (r.y + r.h / 2) / zoom,
      range: (rangePx + cornerPx) / zoom,
      halfW: Math.max(2, r.w / 2 - cornerPx) / zoom,
      halfH: Math.max(2, r.h / 2 - cornerPx) / zoom,
      strength: boxAttraction,
    })

    const toPageRect = (r: DOMRect): PageRect => ({
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
    })

    const drawDebug = () => {
      const dctx = debugCanvas.getContext('2d')
      if (!dctx) return
      dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
      if (!bridge.debugOn || !name) return
      dctx.strokeStyle = 'rgba(220, 40, 40, 0.8)'
      dctx.lineWidth = 1
      // Name: outline of the type the attractor points were sampled from.
      dctx.font = `${globals.nameWeight} ${name.size}px ${nameFontStack()}`
      dctx.textBaseline = 'top'
      NAME_LINES.forEach((text, i) => {
        dctx.strokeText(text, NAME_MARGIN_PX, name!.topY + i * name!.lineGap)
      })
      // Text lines: the padded boundary particles are pushed out to.
      for (const r of textRects) {
        const corner = Math.min(BOX_CORNER_PX, r.h / 3)
        dctx.beginPath()
        dctx.roundRect(
          r.x - textPadding,
          r.y - textPadding,
          r.w + textPadding * 2,
          r.h + textPadding * 2,
          corner + textPadding,
        )
        dctx.stroke()
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
        strength: nameAttraction,
      }))
      for (const r of textRects) {
        list.push(boxEffector(r, textPadding, Math.min(BOX_CORNER_PX, r.h / 3)))
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
            strength: separatorAttraction,
          })
        } else {
          list.push(boxEffector(r, PANEL_RANGE_PX, BOX_CORNER_PX))
        }
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
      engine.setSize(Math.round(w * scale), Math.round(h * scale))
      engine.setZoom(DESIRED_ZOOM() * scale)
      zoom = engine.getZoom() / scale // effective page-px zoom
      engine.setCamera(w / (2 * zoom), h / (2 * zoom))
    }

    const measureName = () => {
      name = sampleName(holder.clientWidth, window.innerHeight, nameFontStack(), globals.nameWeight)
      document.documentElement.style.setProperty('--name-bottom', `${Math.round(name.bottom)}px`)
    }

    const measureContent = () => {
      textRects = collectTextRects()
    }

    // Like the reference page's spawn-around-the-circle: particles are born
    // scattered around the name and around the content text, with the same
    // random launch speed.
    const spawnAll = () => {
      if (!engine || !name || name.points.length === 0) return
      const anchors: { x: number; y: number }[] = []
      for (const r of textRects) {
        for (let x = 0; x <= r.w; x += 12) {
          anchors.push({ x: r.x + x, y: r.y }, { x: r.x + x, y: r.y + r.h })
        }
      }
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
        case 'textPadding':
          textPadding = v
          scheduleSync()
          break
        case 'separatorAttraction':
          separatorAttraction = v
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
        textPadding: TEXT_PADDING_DEFAULT,
        separatorAttraction: SEPARATOR_ATTRACTION_DEFAULT,
      }
    }

    const getSettings = (index: number): ModeSettings => ({
      ...baseSettings(index),
      ...overrides[index],
    })

    const scheduleNextDemo = () => {
      window.clearTimeout(demoTimer)
      if (!bridge.autoRotateOn) return
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

    bridge.setAutoRotate = (on: boolean) => {
      bridge.autoRotateOn = on
      scheduleNextDemo()
    }
    bridge.applySetting = (key, value) => {
      overrides[demoIndex] = { ...overrides[demoIndex], [key]: value }
      applySettingValue(key, value)
    }
    bridge.getCurrentSettings = () => getSettings(demoIndex)
    bridge.applyGlobal = (key, value) => {
      globals[key] = value
      measureName()
      scheduleSync()
    }
    bridge.getGlobals = () => ({ ...globals })
    bridge.getAllSettings = () => ({
      global: {
        nameFont: NAME_FONTS[globals.nameFont]?.label ?? 'Georgia',
        nameWeight: globals.nameWeight,
      },
      ...Object.fromEntries(DEMO_PRESETS.map((p, i) => [p.session.name, getSettings(i)])),
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
      bridge.getGlobals = () => ({ nameFont: 0, nameWeight: NAME_WEIGHT_DEFAULT })
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
      measureContent()
      lastPageW = holder.clientWidth
      spawnAll()
      syncEffectors()
      applyDemo(0)
      engine.play()
    }

    // Pointer drag moves the repel field, like the reference landing page —
    // holding it over the name dissolves it.
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element && target.closest('a, button, input, select, .settings-panel')
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
