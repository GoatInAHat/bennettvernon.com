import { useEffect, useRef } from 'react'
import { Engine, Interaction, Spawner, type IParticle } from '@cazala/party'
import { Effectors, type Effector } from './effectors'
import { createPartyModules, applyPreset, DEMO_PRESETS } from './presets'
import { getTargets, getHovered, onTargetsChanged } from './targets'

const NAME_LINES = ['BENNETT', 'VERNON']
const NAME_FONT = 'Georgia, "Times New Roman", serif'
// Fixed drag interaction, same values as the caza.la/party homepage.
const DRAG_STRENGTH = 100_000
const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768
const DESIRED_ZOOM = () => (isMobile() ? 0.2 : 0.3)
const DRAG_RADIUS = () => (isMobile() ? 700 : 800)
const SWARM_BUDGET = (webgpu: boolean) => (webgpu ? (isMobile() ? 24_000 : 80_000) : 2_500)
const PINNED_RESERVE = 9_000
const MAX_CANVAS_HEIGHT = 8_000

/** Effector tuning (world units are CSS px / zoom). */
const BLOCK_STRENGTH = 100_000
const BLOCK_RANGE_PX = 120
const DOT_STRENGTH = 100_000
const DOT_RANGE_PX = 85
const NAV_ATTRACT_STRENGTH = 12_000
const NAV_ATTRACT_RANGE_PX = 70
const NAV_UNDERLINE_OFFSET_PX = 16
const NAV_UNDERLINE_HALF_H_PX = 2
const NAV_BUBBLE_STRENGTH = 100_000
const NAV_BUBBLE_PAD_PX = 30

function measureNameWidth(pageW: number): number {
  // ~1/3 of the page on desktop (min sized for a regular ~1440px desktop);
  // below the width where that would exceed 3/4 of the page, span the page.
  const desktop = Math.max(pageW / 3, 480)
  return desktop >= pageW * 0.75 ? pageW * 0.96 : desktop
}

function spawnName(pageW: number, viewportH: number, zoom: number): IParticle[] {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  ctx.font = `100px ${NAME_FONT}`
  const widest = Math.max(...NAME_LINES.map((l) => ctx.measureText(l).width))
  const sizePx = (100 * measureNameWidth(pageW)) / widest
  const sizeWorld = sizePx / zoom
  const lineGap = sizeWorld * 1.12
  const centerX = pageW / 2 / zoom
  const centerY = (viewportH * 0.42) / zoom - lineGap / 2
  const spawner = new Spawner()
  const particles: IParticle[] = []
  NAME_LINES.forEach((text, i) => {
    const line = spawner.initParticles({
      count: 3_600,
      shape: 'text',
      text,
      font: NAME_FONT,
      textSize: sizeWorld,
      center: { x: centerX, y: centerY + i * lineGap },
      position: { x: centerX, y: centerY + i * lineGap },
      align: { horizontal: 'center', vertical: 'center' },
      size: 1.9 / zoom,
      mass: 1,
      velocity: { speed: 0, direction: 'out' },
      colors: ['#ffffff'],
    })
    particles.push(...line)
  })
  for (const p of particles) p.mass = -1 // pinned
  return particles.slice(0, PINNED_RESERVE)
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
    let pinnedCount = 0
    let webgpu = false
    let demoIndex = 0
    let demoTimer = 0
    let maxParticlesRaf = 0
    let syncScheduled = false
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

    const syncEffectors = () => {
      syncScheduled = false
      if (!engine) return
      const hovered = getHovered()
      const list: Effector[] = []
      for (const t of getTargets()) {
        const r = t.el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        const pageX = r.left + window.scrollX + r.width / 2
        const pageY = r.top + window.scrollY + r.height / 2
        const { x, y } = pageToWorld(pageX, pageY)
        if (t.kind === 'block') {
          list.push({
            shape: 'rect',
            mode: 'repel',
            x,
            y,
            range: BLOCK_RANGE_PX / zoom,
            halfW: r.width / 2 / zoom,
            halfH: r.height / 2 / zoom,
            strength: BLOCK_STRENGTH,
          })
        } else if (t.kind === 'dot') {
          if (hovered?.kind === 'dot' && hovered.id !== t.id) continue
          list.push({
            shape: 'circle',
            mode: 'repel',
            x,
            y,
            range: DOT_RANGE_PX / zoom,
            halfW: 0,
            halfH: 0,
            strength: DOT_STRENGTH,
          })
        } else {
          // nav: attract underline normally, repel bubble while hovered
          if (hovered?.kind === 'nav' && hovered.id !== t.id) continue
          if (hovered?.kind === 'nav' && hovered.id === t.id) {
            list.push({
              shape: 'circle',
              mode: 'repel',
              x,
              y,
              range: (r.width / 2 + NAV_BUBBLE_PAD_PX) / zoom,
              halfW: 0,
              halfH: 0,
              strength: NAV_BUBBLE_STRENGTH,
            })
          } else {
            const underlineY = r.bottom + window.scrollY + NAV_UNDERLINE_OFFSET_PX
            list.push({
              shape: 'rect',
              mode: 'attract',
              x,
              y: underlineY / zoom,
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

    const spawnAll = () => {
      if (!engine) return
      const w = holder.clientWidth
      const viewportH = window.innerHeight
      const name = spawnName(w, viewportH, zoom)
      pinnedCount = name.length
      const center = pageToWorld(w / 2, viewportH / 2)
      const swarm = new Spawner().initParticles({
        count: SWARM_BUDGET(webgpu),
        shape: 'circle',
        center,
        radius: isMobile() ? 600 : 500,
        size: 3,
        mass: 1,
        colors: ['#ffffff'],
        velocity: { speed: 100, direction: 'random' },
      })
      engine.setParticles([...name, ...swarm])
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
      const cap = pinnedCount + Math.floor(SWARM_BUDGET(webgpu) * preset.budgetFactor)
      setMaxParticlesAnimated(cap, preset.transitionMs)
      window.dispatchEvent(new CustomEvent('party:demo', { detail: index }))
      window.clearTimeout(demoTimer)
      demoTimer = window.setTimeout(
        () => applyDemo((index + 1) % DEMO_PRESETS.length),
        preset.duration[isMobile() ? 1 : 0],
      )
    }

    const start = async () => {
      engine = new Engine({
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
        maxParticles: PINNED_RESERVE + 80_000,
        cellSize: 16,
        maxNeighbors: 100,
        constrainIterations: 1,
      })
      await engine.initialize()
      if (disposed) {
        void engine.destroy()
        engine = null
        return
      }
      webgpu = engine.getActualRuntime() === 'webgpu'
      layout()
      spawnAll()
      syncEffectors()
      applyDemo(0)
      engine.play()
    }

    // Pointer drag moves the repel field, like the reference landing page.
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

    // Relayout when the viewport or document height changes.
    let resizeTimer = 0
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        if (!engine) return
        layout()
        spawnAll()
        syncEffectors()
        applyDemo(demoIndex)
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
