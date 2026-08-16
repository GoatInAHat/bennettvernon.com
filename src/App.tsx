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
 * half a second once the cursor moves off them. */
function useGlitchText() {
  useEffect(() => {
    const states = new WeakMap<HTMLElement, GlitchState>()
    const randChar = () => String.fromCharCode(33 + Math.floor(Math.random() * 94))

    const run = (el: HTMLElement, st: GlitchState) => {
      const tick = () => {
        // A missed pointerout (window blur, layout shifts) must never leave
        // a character cycling forever: trust the live :hover state.
        if (st.hovering && !el.matches(':hover')) {
          st.hovering = false
          st.leftAt = Date.now()
        }
        if (st.hovering) {
          el.textContent = randChar()
          st.timer = window.setTimeout(tick, 100)
          return
        }
        const u = (Date.now() - st.leftAt) / 500
        if (u >= 1) {
          el.textContent = st.orig
          st.timer = 0
          return
        }
        el.textContent = randChar()
        // Switching rate falls off smoothly over the half second.
        st.timer = window.setTimeout(tick, Math.min(400, 100 / (1 - u * u)))
      }
      tick()
    }

    const onOver = (e: Event) => {
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
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
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
  useGlitchText()
  return (
    <>
      <PartyBackground />
      <DemoDots settingsOpen={settingsOpen} onToggleSettings={() => setSettingsOpen((v) => !v)} />
      <DebugHud panelOpen={settingsOpen} />
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      <header className="hero">
        <h1 className="sr-only">Bennett Vernon</h1>
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
                    ·
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
