import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PartyBackground } from './party/PartyBackground'
import { DEMO_PRESETS } from './party/presets'
import { setHovered, useEffectorTarget } from './party/targets'
import { SettingsPanel } from './SettingsPanel'
import { site, work } from './content'

const SECTIONS = ['About', 'Projects', 'Work', 'Research'] as const
type Section = (typeof SECTIONS)[number]

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
  const ref = useRef<HTMLButtonElement>(null)
  useEffectorTarget('dot-gear', 'dot', ref)
  return (
    <button
      ref={ref}
      className={`demo-dot-button gear-button ${open ? 'active' : ''}`}
      onClick={onToggle}
      onPointerEnter={() => setHovered({ kind: 'dot', id: 'dot-gear' })}
      onPointerLeave={() => setHovered(null)}
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
        <DemoDot key={index} index={index} active={index === active} />
      ))}
    </div>
  )
}

function DemoDot({ index, active }: { index: number; active: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffectorTarget(`dot-${index}`, 'dot', ref)
  return (
    <button
      ref={ref}
      className={`demo-dot-button ${active ? 'active' : ''}`}
      onClick={() => window.dispatchEvent(new CustomEvent('party:select', { detail: index }))}
      onPointerEnter={() => setHovered({ kind: 'dot', id: `dot-${index}` })}
      onPointerLeave={() => setHovered(null)}
      aria-pressed={active}
      aria-label={`Simulation mode ${index + 1}`}
    >
      <span className="demo-dot" />
    </button>
  )
}

function NavButton({
  label,
  active,
  onSelect,
}: {
  label: Section
  active: boolean
  onSelect: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffectorTarget(`nav-${label}`, 'nav', ref)
  return (
    <button
      ref={ref}
      className={`nav-button ${active ? 'active' : ''}`}
      data-label={label}
      onClick={onSelect}
      onPointerEnter={() => setHovered({ kind: 'nav', id: `nav-${label}` })}
      onPointerLeave={() => setHovered(null)}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}

function Block({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useRef(`block-${Math.random().toString(36).slice(2)}`)
  useEffectorTarget(id.current, 'block', ref)
  return (
    <div ref={ref} className={`pblock ${className ?? ''}`}>
      {children}
    </div>
  )
}

function ComingSoon() {
  return (
    <Block className="coming-soon">
      <p>coming soon</p>
    </Block>
  )
}

export default function App() {
  const [section, setSection] = useState<Section>('About')
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
        <nav className="site-nav" aria-label="Sections">
          {SECTIONS.map((label) => (
            <NavButton
              key={label}
              label={label}
              active={section === label}
              onSelect={() => setSection(label)}
            />
          ))}
        </nav>

        {section === 'About' ? (
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
        ) : null}

        {section === 'Projects' ? <ComingSoon /> : null}

        {section === 'Work'
          ? work.map((item) => (
              <Block key={item.title}>
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
            ))
          : null}

        {section === 'Research' ? <ComingSoon /> : null}
      </main>
    </>
  )
}
