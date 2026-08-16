import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PartyBackground } from './party/PartyBackground'
import { DEMO_PRESETS } from './party/presets'
import { useEffectorTarget } from './party/targets'
import { SettingsPanel } from './SettingsPanel'
import { site, projects, research, work, type WorkItem } from './content'

/** The site descriptions only use **bold** and _italic_. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
        if (part.startsWith('_')) return <em key={i}>{part.slice(1, -1)}</em>
        return part
      })}
    </>
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
  useEffect(() => {
    const onDemo = (e: Event) => setActive((e as CustomEvent<number>).detail)
    window.addEventListener('party:demo', onDemo)
    return () => window.removeEventListener('party:demo', onDemo)
  }, [])
  return (
    <div className="demo-dots" aria-label="Simulation mode selector">
      <GearButton open={settingsOpen} onToggle={onToggleSettings} />
      {DEMO_PRESETS.map((_, index) => (
        <button
          key={index}
          className={`demo-dot-button ${index === active ? 'active' : ''}`}
          onClick={() => window.dispatchEvent(new CustomEvent('party:select', { detail: index }))}
          aria-pressed={index === active}
          aria-label={`Simulation mode ${index + 1}`}
        >
          <span className="demo-dot" />
        </button>
      ))}
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
      <h2>{title}</h2>
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
            <div className="meta subtitle">{item.subtitle}</div>
            <h3>{item.title}</h3>
          </div>
          <div className="meta">{item.date}</div>
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
  return (
    <>
      <PartyBackground />
      <DemoDots settingsOpen={settingsOpen} onToggleSettings={() => setSettingsOpen((v) => !v)} />
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      <header className="hero">
        <h1 className="sr-only">Bennett Vernon</h1>
      </header>
      <main className="container">
        <Block>
          <p className="lede">{site.description}</p>
          <div className="hero-links">
            {site.links.map((link, index) => (
              <span key={link.href}>
                <a href={link.href} target="_blank" rel="noreferrer">
                  {link.label}
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
