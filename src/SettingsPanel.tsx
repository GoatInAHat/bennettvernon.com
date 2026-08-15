import { useEffect, useRef, useState } from 'react'
import { bridge, type ModeSettings, type SettingKey } from './party/bridge'
import { useEffectorTarget } from './party/targets'

const SLIDERS: { key: SettingKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'gravity', label: 'gravity', min: 0, max: 4000, step: 50 },
  { key: 'wander', label: 'wander', min: 0, max: 100, step: 1 },
  { key: 'cohesion', label: 'cohesion', min: 0, max: 10, step: 0.1 },
  { key: 'alignment', label: 'alignment', min: 0, max: 10, step: 0.1 },
  { key: 'separation', label: 'separation', min: 0, max: 100, step: 1 },
  { key: 'viscosity', label: 'viscosity', min: 0, max: 10, step: 0.05 },
  { key: 'pressure', label: 'pressure', min: 0, max: 200, step: 1 },
  { key: 'trailDecay', label: 'trail decay', min: 1, max: 50, step: 1 },
  { key: 'dragStrength', label: 'drag power', min: 0, max: 200000, step: 1000 },
  { key: 'dragRadius', label: 'drag radius', min: 100, max: 2000, step: 10 },
  { key: 'nameAttraction', label: 'name pull', min: 0, max: 50000, step: 500 },
  { key: 'boxAttraction', label: 'box pull', min: 0, max: 200000, step: 1000 },
]

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffectorTarget('settings-panel', 'panel', ref)
  const [values, setValues] = useState<ModeSettings | null>(bridge.getCurrentSettings)
  const [debug, setDebug] = useState(bridge.debugOn)
  const [copied, setCopied] = useState(false)

  // Pause the auto rotation while tweaking; the dots still switch modes and
  // the sliders re-read that mode's settings when they do.
  useEffect(() => {
    bridge.setPaused(true)
    const onDemo = () => setValues(bridge.getCurrentSettings())
    window.addEventListener('party:demo', onDemo)
    return () => {
      window.removeEventListener('party:demo', onDemo)
      bridge.setPaused(false)
    }
  }, [])

  const copy = async () => {
    const json = JSON.stringify(bridge.getAllSettings(), null, 2)
    try {
      await navigator.clipboard.writeText(json)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = json
      document.body.append(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div ref={ref} className="settings-panel" role="dialog" aria-label="Physics settings">
      <button className="settings-close" onClick={onClose} aria-label="Close settings">
        ×
      </button>
      <div className="settings-title">physics</div>
      {values === null ? (
        <p className="meta">simulation still starting…</p>
      ) : (
        <>
          {SLIDERS.map((s) => (
            <label key={s.key} className="settings-row">
              <span>{s.label}</span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={values[s.key]}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  bridge.applySetting(s.key, v)
                  setValues((prev) => (prev ? { ...prev, [s.key]: v } : prev))
                }}
              />
            </label>
          ))}
          <label className="settings-row settings-toggle">
            <span>debug view</span>
            <input
              type="checkbox"
              checked={debug}
              onChange={(e) => {
                setDebug(e.target.checked)
                bridge.setDebug(e.target.checked)
              }}
            />
          </label>
          <button className="settings-copy" onClick={copy}>
            {copied ? 'copied' : 'copy settings json'}
          </button>
        </>
      )}
    </div>
  )
}
