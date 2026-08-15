import { useEffect, useRef, useState } from 'react'
import { bridge } from './party/bridge'
import { useEffectorTarget } from './party/targets'

interface Slider {
  label: string
  min: number
  max: number
  step: number
  get: () => number
  set: (v: number) => void
}

function buildSliders(): Slider[] {
  const m = bridge.mods
  const drag = bridge.interaction
  if (!m || !drag) return []
  return [
    {
      label: 'gravity',
      min: 0,
      max: 4000,
      step: 50,
      get: () => m.environment.getGravityStrength(),
      set: (v) => m.environment.setGravityStrength(v),
    },
    {
      label: 'wander',
      min: 0,
      max: 100,
      step: 1,
      get: () => m.behavior.getWander(),
      set: (v) => m.behavior.setWander(v),
    },
    {
      label: 'cohesion',
      min: 0,
      max: 10,
      step: 0.1,
      get: () => m.behavior.getCohesion(),
      set: (v) => m.behavior.setCohesion(v),
    },
    {
      label: 'alignment',
      min: 0,
      max: 10,
      step: 0.1,
      get: () => m.behavior.getAlignment(),
      set: (v) => m.behavior.setAlignment(v),
    },
    {
      label: 'separation',
      min: 0,
      max: 100,
      step: 1,
      get: () => m.behavior.getSeparation(),
      set: (v) => m.behavior.setSeparation(v),
    },
    {
      label: 'viscosity',
      min: 0,
      max: 10,
      step: 0.05,
      get: () => m.fluids.getViscosity(),
      set: (v) => m.fluids.setViscosity(v),
    },
    {
      label: 'pressure',
      min: 0,
      max: 200,
      step: 1,
      get: () => m.fluids.getPressureMultiplier(),
      set: (v) => m.fluids.setPressureMultiplier(v),
    },
    {
      label: 'trail decay',
      min: 1,
      max: 50,
      step: 1,
      get: () => m.trails.readValue('trailDecay'),
      set: (v) => m.trails.setTrailDecay(v),
    },
    {
      label: 'drag strength',
      min: 0,
      max: 200000,
      step: 1000,
      get: () => drag.getStrength(),
      set: (v) => drag.setStrength(v),
    },
    {
      label: 'drag radius',
      min: 100,
      max: 2000,
      step: 10,
      get: () => drag.getRadius(),
      set: (v) => drag.setRadius(v),
    },
  ]
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffectorTarget('settings-panel', 'panel', ref)
  const [sliders] = useState(buildSliders)
  const [values, setValues] = useState(() => sliders.map((s) => s.get()))

  // Pause the demo rotation while tweaking, so presets don't overwrite the
  // sliders mid-adjustment.
  useEffect(() => {
    bridge.setPaused(true)
    return () => bridge.setPaused(false)
  }, [])

  return (
    <div ref={ref} className="settings-panel" role="dialog" aria-label="Physics settings">
      <button className="settings-close" onClick={onClose} aria-label="Close settings">
        ×
      </button>
      <div className="settings-title">physics</div>
      {sliders.length === 0 ? (
        <p className="meta">simulation still starting…</p>
      ) : (
        sliders.map((s, i) => (
          <label key={s.label} className="settings-row">
            <span>{s.label}</span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={values[i]}
              onChange={(e) => {
                const v = Number(e.target.value)
                s.set(v)
                setValues((prev) => prev.map((p, j) => (j === i ? v : p)))
              }}
            />
          </label>
        ))
      )}
    </div>
  )
}
