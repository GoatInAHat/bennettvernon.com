import { Fragment, useEffect, useRef, useState } from 'react'
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
  /** Sliders sharing a group render under one small heading. */
  group?: string
}

// Ranges cover every session value and oscillator swing in the demo presets
// with headroom. Angles are radians.
const MODE_SLIDERS: SliderDef<ModeSettingKey>[] = [
  { group: 'environment', key: 'gravity', label: 'gravity', min: 0, max: 4000, step: 50 },
  { group: 'environment', key: 'inertia', label: 'inertia', min: 0, max: 100, step: 1 },
  { group: 'environment', key: 'envFriction', label: 'friction', min: 0, max: 2, step: 0.01 },
  { group: 'environment', key: 'damping', label: 'damping', min: 0, max: 1, step: 0.01 },
  { group: 'boundary', key: 'restitution', label: 'restitution', min: 0, max: 1, step: 0.05 },
  { group: 'boundary', key: 'boundaryFriction', label: 'friction', min: 0, max: 1, step: 0.05 },
  { group: 'collisions', key: 'collisionRestitution', label: 'restitution', min: 0, max: 1, step: 0.05 },
  { group: 'fluids', key: 'influenceRadius', label: 'influence radius', min: 1, max: 200, step: 1 },
  { group: 'fluids', key: 'targetDensity', label: 'target density', min: 0, max: 10, step: 0.1 },
  { group: 'fluids', key: 'pressure', label: 'pressure', min: 0, max: 200, step: 1 },
  { group: 'fluids', key: 'viscosity', label: 'viscosity', min: 0, max: 10, step: 0.05 },
  { group: 'fluids', key: 'nearPressure', label: 'near pressure', min: 0, max: 200, step: 1 },
  { group: 'fluids', key: 'nearThreshold', label: 'near threshold', min: 0, max: 100, step: 1 },
  { group: 'fluids', key: 'maxAcceleration', label: 'max acceleration', min: 0, max: 200, step: 1 },
  { group: 'fluids', key: 'flipRatio', label: 'flip ratio', min: 0, max: 1, step: 0.01 },
  { group: 'behavior', key: 'wander', label: 'wander', min: 0, max: 100, step: 1 },
  { group: 'behavior', key: 'cohesion', label: 'cohesion', min: 0, max: 10, step: 0.1 },
  { group: 'behavior', key: 'alignment', label: 'alignment', min: 0, max: 10, step: 0.1 },
  { group: 'behavior', key: 'repulsion', label: 'repulsion', min: 0, max: 20, step: 0.1 },
  { group: 'behavior', key: 'chase', label: 'chase', min: 0, max: 10, step: 0.1 },
  { group: 'behavior', key: 'avoid', label: 'avoid', min: 0, max: 10, step: 0.1 },
  { group: 'behavior', key: 'separation', label: 'separation', min: 0, max: 100, step: 1 },
  { group: 'behavior', key: 'viewRadius', label: 'view radius', min: 0, max: 300, step: 5 },
  { group: 'behavior', key: 'viewAngle', label: 'view angle', min: 0, max: 6.3, step: 0.05 },
  { group: 'sensors', key: 'sensorDistance', label: 'distance', min: 0, max: 200, step: 1 },
  { group: 'sensors', key: 'sensorAngle', label: 'angle', min: 0, max: 1.57, step: 0.01 },
  { group: 'sensors', key: 'sensorRadius', label: 'radius', min: 1, max: 20, step: 0.5 },
  { group: 'sensors', key: 'sensorThreshold', label: 'threshold', min: 0, max: 1, step: 0.01 },
  { group: 'sensors', key: 'sensorStrength', label: 'strength', min: 0, max: 5000, step: 50 },
  { group: 'sensors', key: 'colorSimilarity', label: 'color similarity', min: 0, max: 1, step: 0.01 },
  { group: 'sensors', key: 'fleeAngle', label: 'flee angle', min: 0, max: 3.14, step: 0.01 },
  { group: 'trails', key: 'trailDecay', label: 'trail decay', min: 1, max: 100, step: 1 },
]

/** Slider value readout, truncated to two decimals. */
const fmt = (v: number) => String(Number(v.toFixed(2)))

/** Native range-knob width (px; Chrome renders a 16px circle): the knob's
 * center travels from THUMB_W/2 to trackWidth - THUMB_W/2, so live markers
 * must map onto that span — a plain percentage of the track misses at both
 * ends. */
const THUMB_W = 16
const SLIDER_BY_KEY = new Map(MODE_SLIDERS.map((s) => [s.key, s]))

const GLOBAL_SLIDERS: SliderDef<GlobalSettingKey>[] = [
  { key: 'particleCount', label: 'particles', min: 500, max: 80000, step: 500 },
  { key: 'dragStrength', label: 'drag power', min: 0, max: 200000, step: 1000 },
  { key: 'dragRadius', label: 'drag radius', min: 100, max: 2000, step: 10 },
  { key: 'nameAttraction', label: 'name pull', min: 0, max: 50000, step: 500 },
  { key: 'nameRange', label: 'name pull radius', min: 10, max: 300, step: 5 },
  { key: 'nameSharpness', label: 'name sharpness', min: 0.2, max: 6, step: 0.05 },
  { key: 'concaveAvoidance', label: 'concave avoidance', min: 1, max: 10, step: 0.1 },
  { key: 'boxAttraction', label: 'text repel', min: 0, max: 200000, step: 1000 },
  { key: 'textPaddingInner', label: 'inner padding', min: 0, max: 60, step: 1 },
  { key: 'textPaddingOuter', label: 'outer padding', min: 2, max: 150, step: 1 },
  { key: 'textSmoothing', label: 'blob smoothing', min: 1.05, max: 3, step: 0.05 },
  { key: 'separatorAttraction', label: 'separator pull', min: 0, max: 100000, step: 500 },
  { key: 'separatorRange', label: 'separator radius', min: 10, max: 300, step: 5 },
  { key: 'cursorStrength', label: 'cursor pull', min: 0, max: 50000, step: 500 },
  { key: 'trailIntensity', label: 'trail intensity', min: 0, max: 1, step: 0.01 },
  { key: 'cursorFalloff', label: 'trail falloff', min: 0, max: 1, step: 0.01 },
  { key: 'modeDuration', label: 'mode time (s)', min: 3, max: 60, step: 1 },
  { key: 'transitionLength', label: 'fade time (s)', min: 0, max: 8, step: 0.1 },
  { key: 'nameDensity', label: 'name density', min: 0, max: 4000, step: 25 },
  { key: 'nameDensityRes', label: 'density cells', min: 8, max: 120, step: 2 },
  { key: 'nameBaseOpacity', label: 'name opacity', min: 0, max: 1, step: 0.01 },
  { key: 'nameDensityOpacity', label: 'density opacity', min: 0, max: 1, step: 0.01 },
  { key: 'opacityDamping', label: 'opacity damping', min: 0, max: 0.98, step: 0.01 },
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
  const [runtimePref, setRuntimePref] = useState(bridge.runtimePref)
  const [autoResolved, setAutoResolved] = useState(bridge.autoResolved)

  // Runtime switches reboot the engine and reset the device particle budget.
  useEffect(() => {
    const onRuntime = () => {
      setRuntimePref(bridge.runtimePref)
      setAutoResolved(bridge.autoResolved)
      setGlobals(bridge.getGlobals())
      setValues(bridge.getCurrentSettings())
    }
    window.addEventListener('party:runtime', onRuntime)
    return () => window.removeEventListener('party:runtime', onRuntime)
  }, [])

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

  // The knob shows the target value; an outline ghost of the knob tracks the
  // value the simulation is actually applying (transition easing, preset
  // oscillators). Positions update imperatively at frame rate — routing them
  // through React state capped them at the poll interval and re-rendered the
  // whole panel for every movement.
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const liveVals = bridge.getLiveSettings()
      const targets = bridge.getCurrentSettings()
      const root = ref.current
      if (liveVals && targets && root) {
        for (const el of root.querySelectorAll<HTMLElement>('.slider-live')) {
          const key = el.dataset.key as ModeSettingKey
          const def = SLIDER_BY_KEY.get(key)
          const lv = liveVals[key]
          if (!def || lv === undefined) {
            el.style.visibility = 'hidden'
            continue
          }
          const show = Math.abs(lv - targets[key]) > def.step / 2
          el.style.visibility = show ? 'visible' : 'hidden'
          if (show) {
            const f = Math.min(1, Math.max(0, (lv - def.min) / (def.max - def.min)))
            el.style.left = `calc(${f} * (100% - ${THUMB_W}px) + ${THUMB_W / 2}px)`
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
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
      {MODE_SLIDERS.map((s, i) => {
        const groupHead =
          s.group && s.group !== MODE_SLIDERS[i - 1]?.group ? (
            <div className="settings-group">{s.group}</div>
          ) : null
        return (
          <Fragment key={s.key}>
            {groupHead}
            <label className="settings-row">
            <span>{s.label}</span>
            <span className="settings-value">{fmt(values[s.key])}</span>
            <span className="slider-wrap">
              <span
                className="slider-track"
                // Longhand only: the `background` shorthand would reset the
                // stylesheet's background-clip and bleed the fill under the
                // border at the rounded caps.
                style={{
                  backgroundImage: `linear-gradient(to right, #000 calc((100% - ${THUMB_W}px) * ${
                    (Math.min(Math.max(values[s.key], s.min), s.max) - s.min) / (s.max - s.min)
                  } + ${THUMB_W / 2}px), #ececec 0)`,
                }}
              />
              <span className="slider-live" data-key={s.key} style={{ visibility: 'hidden' }} />
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
            </span>
            </label>
          </Fragment>
        )
      })}
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
      <div className="settings-row settings-toggle">
        <span>physics runtime</span>
        <span className="runtime-switch">
          {(['cpu', 'gpu', 'auto'] as const).map((opt) => {
            const pref = opt === 'gpu' ? 'webgpu' : opt
            return (
              <button
                key={opt}
                className={runtimePref === pref ? 'active' : ''}
                onClick={() => {
                  bridge.setRuntime(pref)
                  setRuntimePref(pref)
                }}
              >
                {opt === 'auto'
                  ? `auto${autoResolved ? ` (${autoResolved === 'webgpu' ? 'gpu' : 'cpu'})` : ''}`
                  : opt}
              </button>
            )
          })}
        </span>
      </div>
    </div>
  )
}
