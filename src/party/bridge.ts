/** Per-mode physics settings (defaults come from each demo preset). */
export const MODE_SETTING_KEYS = [
  'gravity',
  'wander',
  'cohesion',
  'alignment',
  'separation',
  'viscosity',
  'pressure',
  'trailDecay',
] as const

/** Site-wide settings, independent of the active mode. */
export const GLOBAL_SETTING_KEYS = [
  'dragStrength',
  'dragRadius',
  'nameAttraction',
  'boxAttraction',
  'textPadding',
  'textSmoothing',
  'separatorAttraction',
  'cursorStrength',
  'trailIntensity',
  'cursorFalloff',
  'modeDuration',
  'transitionLength',
  'nameFont',
  'nameWeight',
] as const

export type ModeSettingKey = (typeof MODE_SETTING_KEYS)[number]
export type GlobalSettingKey = (typeof GLOBAL_SETTING_KEYS)[number]
export type ModeSettings = Record<ModeSettingKey, number>
export type GlobalSettings = Record<GlobalSettingKey, number>

/** Popular design font stacks selectable for the name. */
export const NAME_FONTS = [
  { label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { label: 'Helvetica', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'SF Pro', stack: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif' },
  { label: 'Futura', stack: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif' },
  { label: 'Avenir', stack: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  { label: 'Gill Sans', stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
  { label: 'Garamond', stack: '"Apple Garamond", Garamond, "EB Garamond", serif' },
  { label: 'Baskerville', stack: 'Baskerville, "Baskerville Old Face", "Times New Roman", serif' },
  { label: 'Didot', stack: 'Didot, "Bodoni MT", "Times New Roman", serif' },
  { label: 'Palatino', stack: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  { label: 'Courier', stack: '"Courier New", Courier, monospace' },
  { label: 'Impact', stack: 'Impact, "Arial Black", sans-serif' },
]

/**
 * Runtime handles the settings panel uses to read and tweak the live physics.
 * PartyBackground assigns these once the engine is up. Mode settings persist
 * as per-mode overrides across switches; global settings apply site-wide.
 */
export const bridge: {
  setAutoRotate: (on: boolean) => void
  autoRotateOn: boolean
  applySetting: (key: ModeSettingKey, value: number) => void
  getCurrentSettings: () => ModeSettings | null
  applyGlobal: (key: GlobalSettingKey, value: number) => void
  getGlobals: () => GlobalSettings | null
  /** Enable/disable a demo mode; disabled modes lose their dot and are
   * skipped by the rotation. */
  setModeEnabled: (index: number, on: boolean) => void
  enabledModes: boolean[]
  /** Effective settings of every mode plus globals (for copy/export). */
  getAllSettings: () => Record<string, unknown>
  setDebug: (on: boolean) => void
  debugOn: boolean
} = {
  setAutoRotate: () => {},
  autoRotateOn: true,
  applySetting: () => {},
  getCurrentSettings: () => null,
  applyGlobal: () => {},
  getGlobals: () => null,
  setModeEnabled: () => {},
  enabledModes: [true, true, true, true, true, true, true],
  getAllSettings: () => ({}),
  setDebug: () => {},
  debugOn: false,
}
