import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PartyBackground } from './party/PartyBackground'
import { bridge } from './party/bridge'
import { DEMO_PRESETS } from './party/presets'
import { useEffectorTarget } from './party/targets'
import { SettingsPanel } from './SettingsPanel'
import { site, projects, research, work, type WorkItem } from './content'

/** Wraps every non-space character in a glitchable span. */
function Chars({ text }: { text: string }) {
  return (
    <>
      {text.split('').map((ch, i) =>
        ch === ' ' ? ch : (
          <span key={i} className="g">
            {ch}
          </span>
        ),
      )}
    </>
  )
}

/** The site descriptions only use **bold** and _italic_. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**')) return <strong key={i}><Chars text={part.slice(2, -2)} /></strong>
        if (part.startsWith('_')) return <em key={i}><Chars text={part.slice(1, -1)} /></em>
        return <Chars key={i} text={part} />
      })}
    </>
  )
}

interface GlitchState {
  orig: string
  timer: number
  hovering: boolean
  leftAt: number
}

/** Hovered characters rapidly cycle through ASCII, slowing to a stop over
 * half a second once the cursor moves off them. Selection stays usable:
 * glitches mutate the existing text node's data (never replacing nodes, so
 * selection anchors survive), highlighted characters are restored at once and
 * never re-glitch while selected (copy always yields the true text), and no
 * glitch starts while the primary button is down (drag-selection sweeps
 * across characters without scrambling them). */
function useGlitchText() {
  useEffect(() => {
    const states = new WeakMap<HTMLElement, GlitchState>()
    /** Spans with a glitch in flight (WeakMap alone can't be iterated). */
    const active = new Set<HTMLElement>()
    let dragging = false
    const randChar = () => String.fromCharCode(33 + Math.floor(Math.random() * 94))

    // Same-length data writes on the existing Text node keep selection
    // ranges anchored in this or any other span valid.
    const setChar = (el: HTMLElement, c: string) => {
      const tn = el.firstChild
      if (tn?.nodeType === Node.TEXT_NODE) (tn as Text).data = c
      else el.textContent = c
    }

    const stop = (el: HTMLElement, st: GlitchState) => {
      window.clearTimeout(st.timer)
      st.timer = 0
      st.hovering = false
      setChar(el, st.orig)
      active.delete(el)
    }

    const isSelected = (el: HTMLElement) => {
      const sel = document.getSelection()
      return !!sel && !sel.isCollapsed && sel.containsNode(el, true)
    }

    const run = (el: HTMLElement, st: GlitchState) => {
      const tick = () => {
        // Highlighted characters must not change, visually or actually.
        if (isSelected(el)) {
          stop(el, st)
          return
        }
        // A missed pointerout (window blur, layout shifts) must never leave
        // a character cycling forever: trust the live :hover state.
        if (st.hovering && !el.matches(':hover')) {
          st.hovering = false
          st.leftAt = Date.now()
        }
        if (st.hovering) {
          setChar(el, randChar())
          st.timer = window.setTimeout(tick, 100)
          return
        }
        const u = (Date.now() - st.leftAt) / 500
        if (u >= 1) {
          setChar(el, st.orig)
          st.timer = 0
          active.delete(el)
          return
        }
        setChar(el, randChar())
        // Switching rate falls off smoothly over the half second.
        st.timer = window.setTimeout(tick, Math.min(400, 100 / (1 - u * u)))
      }
      active.add(el)
      tick()
    }

    const onOver = (e: Event) => {
      if (dragging) {
        // Self-heal a button released outside the window (no pointerup fires).
        if ((e as PointerEvent).buttons !== 0) return
        dragging = false
      }
      const el = (e.target as Element).closest?.('.g') as HTMLElement | null
      if (!el) return
      let st = states.get(el)
      if (!st) {
        st = { orig: el.textContent ?? '', timer: 0, hovering: true, leftAt: 0 }
        states.set(el, st)
      }
      st.hovering = true
      if (!st.timer) run(el, st)
    }
    const onOut = (e: Event) => {
      const el = (e.target as Element).closest?.('.g') as HTMLElement | null
      if (!el) return
      const st = states.get(el)
      if (st) {
        st.hovering = false
        st.leftAt = Date.now()
      }
    }
    // The instant a selection covers a mid-glitch character, restore it —
    // don't wait out its pending timer.
    const onSelectionChange = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed) return
      for (const el of [...active]) {
        if (sel.containsNode(el, true)) stop(el, states.get(el)!)
      }
    }
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) dragging = true
    }
    const onUp = () => {
      dragging = false
    }
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }
  }, [])
}

/** Frame telemetry readout shown top right while debug view is enabled. */
function DebugHud({ panelOpen }: { panelOpen: boolean }) {
  const [visible, setVisible] = useState(bridge.debugOn)
  const [t, setT] = useState(bridge.getTelemetry)
  const sparkRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const onDebug = (e: Event) => setVisible((e as CustomEvent<boolean>).detail)
    window.addEventListener('party:debug', onDebug)
    return () => window.removeEventListener('party:debug', onDebug)
  }, [])

  useEffect(() => {
    if (!visible) return
    const iv = window.setInterval(() => {
      const next = bridge.getTelemetry()
      setT(next)
      const canvas = sparkRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx || !next) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.strokeStyle = 'rgba(30, 160, 60, 0.9)'
      ctx.beginPath()
      const n = next.dts.length
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * canvas.width
        const y = canvas.height - Math.min(next.dts[i] / 33.3, 1) * canvas.height
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      // 60fps budget line.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)'
      ctx.beginPath()
      ctx.moveTo(0, canvas.height / 2)
      ctx.lineTo(canvas.width, canvas.height / 2)
      ctx.stroke()
    }, 250)
    return () => window.clearInterval(iv)
  }, [visible])

  if (!visible || !t) return null
  const load = Math.round((t.avgMs / 16.7) * 100)
  return (
    <div className={`debug-hud ${panelOpen ? 'shifted' : ''}`} aria-hidden="true">
      <canvas ref={sparkRef} width={150} height={28} />
      <div>
        {t.fps.toFixed(0)} fps · {t.avgMs.toFixed(1)} ms · load {load}%
      </div>
      <div>worst {t.maxMs.toFixed(0)} ms</div>
      <div>
        {t.particles.toLocaleString()} particles · {t.effectors} fx
      </div>
      <div>{t.teleportsPerSec} teleports/s</div>
    </div>
  )
}

function GearButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className={`demo-dot-button gear-button ${open ? 'active' : ''}`}
      onClick={onToggle}
      aria-pressed={open}
      aria-label="Physics settings"
    >
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="1" y1="2.5" x2="12" y2="2.5" />
          <line x1="1" y1="6.5" x2="12" y2="6.5" />
          <line x1="1" y1="10.5" x2="12" y2="10.5" />
        </g>
        <g fill="currentColor">
          <circle cx="4" cy="2.5" r="1.8" />
          <circle cx="9" cy="6.5" r="1.8" />
          <circle cx="5.5" cy="10.5" r="1.8" />
        </g>
      </svg>
    </button>
  )
}

function DemoDots({
  settingsOpen,
  onToggleSettings,
}: {
  settingsOpen: boolean
  onToggleSettings: () => void
}) {
  const [active, setActive] = useState(0)
  const [enabled, setEnabled] = useState<boolean[]>(() => [...bridge.enabledModes])
  useEffect(() => {
    const onDemo = (e: Event) => setActive((e as CustomEvent<number>).detail)
    const onModes = (e: Event) => setEnabled([...(e as CustomEvent<boolean[]>).detail])
    window.addEventListener('party:demo', onDemo)
    window.addEventListener('party:modes', onModes)
    return () => {
      window.removeEventListener('party:demo', onDemo)
      window.removeEventListener('party:modes', onModes)
    }
  }, [])
  return (
    <div className="demo-dots" aria-label="Simulation mode selector">
      <GearButton open={settingsOpen} onToggle={onToggleSettings} />
      {DEMO_PRESETS.map((_, index) =>
        enabled[index] ? (
          <button
            key={index}
            className={`demo-dot-button ${index === active ? 'active' : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent('party:select', { detail: index }))}
            aria-pressed={index === active}
            aria-label={`Simulation mode ${index + 1}`}
          >
            <span className="demo-dot" />
          </button>
        ) : null,
      )}
    </div>
  )
}

/** Warning shown when the auto runtime lands on CPU physics. */
function FallbackPopup() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onFallback = () => setOpen(true)
    window.addEventListener('party:fallback', onFallback)
    return () => window.removeEventListener('party:fallback', onFallback)
  }, [])
  if (!open) return null
  return (
    <div className="fallback-popup" role="alertdialog" aria-label="Performance warning">
      <p>
        <strong>WebGPU isn’t available in this browser.</strong>
      </p>
      <p>The particle simulation fell back to CPU physics, which can run slowly.</p>
      <div className="fallback-actions">
        <button
          onClick={() => {
            bridge.setParticlesDisabled(true)
            setOpen(false)
          }}
        >
          Disable particles
        </button>
        <button onClick={() => setOpen(false)}>Continue with CPU physics (not recommended)</button>
      </div>
    </div>
  )
}

function Block({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`pblock ${className ?? ''}`}>{children}</div>
}

/** Bold section title over a full-width line the particles are drawn to. */
function SectionSeparator({ title }: { title: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffectorTarget(`separator-${title}`, 'separator', ref)
  return (
    <div className="section-sep">
      <h2>
        <Chars text={title} />
      </h2>
      <div ref={ref} className="sep-rule" />
    </div>
  )
}

function WorkItemBlock({ item }: { item: WorkItem }) {
  return (
    <Block>
      <article>
        <div className="work-head">
          <div>
            <div className="meta subtitle">
              <Chars text={item.subtitle} />
            </div>
            <h3>
              <Chars text={item.title} />
            </h3>
          </div>
          <div className="meta">
            <Chars text={item.date} />
          </div>
        </div>
        <p className="md-muted">
          <Rich text={item.description} />
        </p>
      </article>
    </Block>
  )
}

const SECTIONS: { title: string; items: WorkItem[] }[] = [
  { title: 'Projects', items: projects },
  { title: 'Research', items: research },
  { title: 'Work', items: work },
]

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [particlesOff, setParticlesOff] = useState(bridge.particlesDisabled)
  useGlitchText()
  useEffect(() => {
    const onDisabled = (e: Event) => setParticlesOff((e as CustomEvent<boolean>).detail)
    window.addEventListener('party:disabled', onDisabled)
    return () => window.removeEventListener('party:disabled', onDisabled)
  }, [])
  return (
    <>
      {particlesOff ? null : <PartyBackground />}
      {particlesOff ? null : (
        <DemoDots settingsOpen={settingsOpen} onToggleSettings={() => setSettingsOpen((v) => !v)} />
      )}
      {particlesOff ? null : <DebugHud panelOpen={settingsOpen} />}
      {settingsOpen && !particlesOff ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      <FallbackPopup />
      <header className="hero">
        {particlesOff ? (
          <h1 className="hero-name">
            BENNETT
            <br />
            VERNON
          </h1>
        ) : (
          <h1 className="sr-only">Bennett Vernon</h1>
        )}
      </header>
      <main className="container">
        <Block>
          <p className="lede">
            <Chars text={site.description} />
          </p>
          <div className="hero-links">
            {site.links.map((link, index) => (
              <span key={link.href}>
                <a href={link.href} target="_blank" rel="noreferrer">
                  <Chars text={link.label} />
                </a>
                {index < site.links.length - 1 ? (
                  <span className="dot" aria-hidden="true">
                    {' '}
                    <span className="g">·</span>
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </Block>

        {SECTIONS.filter((s) => s.items.length > 0).map((s) => (
          <section key={s.title}>
            <SectionSeparator title={s.title} />
            {s.items.map((item) => (
              <WorkItemBlock key={item.title} item={item} />
            ))}
          </section>
        ))}
      </main>
    </>
  )
}
