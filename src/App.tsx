import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PartyBackground } from './party/PartyBackground'
import { DEMO_PRESETS } from './party/presets'
import { setHovered, useEffectorTarget } from './party/targets'
import { site, work } from './content'

const NAV = [
  { id: 'about', label: 'About' },
  { id: 'projects', label: 'Projects' },
  { id: 'work', label: 'Work' },
  { id: 'research', label: 'Research' },
]

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

function DemoDots() {
  const [active, setActive] = useState(0)
  useEffect(() => {
    const onDemo = (e: Event) => setActive((e as CustomEvent<number>).detail)
    window.addEventListener('party:demo', onDemo)
    return () => window.removeEventListener('party:demo', onDemo)
  }, [])
  return (
    <div className="demo-dots" aria-label="Simulation mode selector">
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

function NavButton({ id, label }: { id: string; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null)
  useEffectorTarget(`nav-${id}`, 'nav', ref)
  return (
    <a
      ref={ref}
      className="nav-button"
      href={`#${id}`}
      data-label={label}
      onPointerEnter={() => setHovered({ kind: 'nav', id: `nav-${id}` })}
      onPointerLeave={() => setHovered(null)}
    >
      {label}
    </a>
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

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="section-label" aria-hidden="true">
      <span>{label}</span>
      <div className="rule" />
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
  return (
    <>
      <PartyBackground />
      <DemoDots />
      <header className="hero">
        <h1 className="sr-only">Bennett Vernon</h1>
      </header>
      <main className="container">
        <nav className="site-nav" aria-label="Sections">
          {NAV.map((item) => (
            <NavButton key={item.id} id={item.id} label={item.label} />
          ))}
        </nav>

        <section id="about">
          <SectionLabel label="about" />
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
        </section>

        <section id="projects">
          <SectionLabel label="projects" />
          <ComingSoon />
        </section>

        <section id="work">
          <SectionLabel label="work" />
          {work.map((item) => (
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
          ))}
        </section>

        <section id="research">
          <SectionLabel label="research" />
          <ComingSoon />
        </section>
      </main>
    </>
  )
}
