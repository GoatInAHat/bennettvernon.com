import { useEffect, useRef, useState } from 'react'
import {
  bridge,
  NAME_FONTS,
  type GlobalSettingKey,
  type GlobalSettings,
  type ModeSettingKey,
  type ModeSettings,
} from './party/bridge'
import { DEMO_PRESETS } from './party/presets'
import { useEffectorTarget } from './party/targets'

interface SliderDef<K> {
  key: K
  label: string
  min: number
  max: number
  step: number
}

const MODE_SLIDERS: SliderDef<ModeSettingKey>[] = [
  { key: 'gravity', label: 'gravity', min: 0, max: 4000, step: 50 },
  { key: 'wander', label: 'wander', min: 0, max: 100, step: 1 },
  { key: 'cohesion', label: 'cohesion', min: 0, max: 10, step: 0.1 },
  { key: 'alignment', label: 'alignment', min: 0, max: 10, step: 0.1 },
  { key: 'separation', label: 'separation', min: 0, max: 100, step: 1 },
  { key: 'viscosity', label: 'viscosity', min: 0, max: 10, step: 0.05 },
  { key: 'pressure', label: 'pressure', min: 0, max: 200, step: 1 },
  { key: 'trailDecay', label: 'trail decay', min: 1, max: 100, step: 1 },
]

/** Slider value readout, truncated to two decimals. */
const fmt = (v: number) => String(Number(v.toFixed(2)))

const GLOBAL_SLIDERS: SliderDef<GlobalSettingKey>[] = [
  { key: 'dragStrength', label: 'drag power', min: 0, max: 200000, step: 1000 },
  { key: 'dragRadius', label: 'drag radius', min: 100, max: 2000, step: 10 },
  { key: 'nameAttraction', label: 'name pull', min: 0, max: 50000, step: 500 },
  { key: 'boxAttraction', label: 'text repel', min: 0, max: 200000, step: 1000 },
  { key: 'textPadding', label: 'text padding', min: 0, max: 40, step: 1 },
  { key: 'textSmoothing', label: 'blob smoothing', min: 1.05, max: 3, step: 0.05 },
  { key: 'separatorAttraction', label: 'separator pull', min: 0, max: 100000, step: 500 },
  { key: 'cursorStrength', label: 'cursor pull', min: 0, max: 50000, step: 500 },
  { key: 'trailIntensity', label: 'trail intensity', min: 0, max: 1, step: 0.01 },
  { key: 'cursorFalloff', label: 'trail falloff', min: 0, max: 1, step: 0.01 },
  { key: 'modeDuration', label: 'mode time (s)', min: 3, max: 60, step: 1 },
  { key: 'transitionLength', label: 'fade time (s)', min: 0, max: 8, step: 0.1 },
  { key: 'nameDensity', label: 'name density', min: 0, max: 80, step: 1 },
  { key: 'nameDensityRes', label: 'density cells', min: 8, max: 120, step: 2 },
]

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffectorTarget('settings-panel', 'panel', ref)
  const [values, setValues] = useState<ModeSettings | null>(bridge.getCurrentSettings)
  const [globals, setGlobals] = useState<GlobalSettings | null>(bridge.getGlobals)
  const [modes, setModes] = useState<boolean[]>(() => [...bridge.enabledModes])
  const [modeIndex, setModeIndex] = useState(0)
  const [autoRotate, setAutoRotate] = useState(bridge.autoRotateOn)
  const [debug, setDebug] = useState(bridge.debugOn)
  const [copied, setCopied] = useState(false)

  // The dots still switch modes while the panel is open; the mode sliders
  // re-read that mode's settings when they do.
  useEffect(() => {
    const onDemo = (e: Event) => {
      setModeIndex((e as CustomEvent<number>).detail)
      setValues(bridge.getCurrentSettings())
    }
    window.addEventListener('party:demo', onDemo)
    return () => window.removeEventListener('party:demo', onDemo)
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

  if (values === null || globals === null) {
    return (
      <div ref={ref} className="settings-panel" role="dialog" aria-label="Physics settings">
        <button className="settings-icon settings-close" onClick={onClose} aria-label="Close settings">
          ×
        </button>
        <p className="meta">simulation still starting…</p>
      </div>
    )
  }

  return (
    <div ref={ref} className="settings-panel" role="dialog" aria-label="Physics settings">
      <button className="settings-icon settings-copy" onClick={copy} aria-label="Copy settings JSON">
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M2 7.5 5.5 11 12 3.5" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" />
            <path d="M9.5 1.5H3A1.5 1.5 0 0 0 1.5 3v6.5" />
          </svg>
        )}
      </button>
      <button className="settings-icon settings-close" onClick={onClose} aria-label="Close settings">
        ×
      </button>
      <div className="settings-title">physics</div>

      <div className="settings-subtitle">mode {modeIndex + 1}</div>
      {MODE_SLIDERS.map((s) => (
        <label key={s.key} className="settings-row">
          <span>{s.label}</span>
          <span className="settings-value">{fmt(values[s.key])}</span>
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
        <span>enabled modes</span>
        <span className="mode-checks">
          {DEMO_PRESETS.map((_, i) => (
            <input
              key={i}
              type="checkbox"
              checked={modes[i]}
              aria-label={`Enable mode ${i + 1}`}
              onChange={(e) => {
                bridge.setModeEnabled(i, e.target.checked)
                setModes([...bridge.enabledModes])
              }}
            />
          ))}
        </span>
      </label>

      <div className="settings-subtitle">global</div>
      {GLOBAL_SLIDERS.map((s) => (
        <label key={s.key} className="settings-row">
          <span>{s.label}</span>
          <span className="settings-value">{fmt(globals[s.key])}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={globals[s.key]}
            onChange={(e) => {
              const v = Number(e.target.value)
              bridge.applyGlobal(s.key, v)
              setGlobals((prev) => (prev ? { ...prev, [s.key]: v } : prev))
            }}
          />
        </label>
      ))}
      <label className="settings-row">
        <span>name font</span>
        <select
          value={globals.nameFont}
          onChange={(e) => {
            const v = Number(e.target.value)
            bridge.applyGlobal('nameFont', v)
            setGlobals((g) => (g ? { ...g, nameFont: v } : g))
          }}
        >
          {NAME_FONTS.map((f, i) => (
            <option key={f.label} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-row">
        <span>name weight</span>
        <span className="settings-value">{fmt(globals.nameWeight)}</span>
        <input
          type="range"
          min={100}
          max={900}
          step={100}
          value={globals.nameWeight}
          onChange={(e) => {
            const v = Number(e.target.value)
            bridge.applyGlobal('nameWeight', v)
            setGlobals((g) => (g ? { ...g, nameWeight: v } : g))
          }}
        />
      </label>
      <label className="settings-row settings-toggle">
        <span>auto switch</span>
        <input
          type="checkbox"
          checked={autoRotate}
          onChange={(e) => {
            setAutoRotate(e.target.checked)
            bridge.setAutoRotate(e.target.checked)
          }}
        />
      </label>
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
    </div>
  )
}
