export const SETTING_KEYS = [
  'gravity',
  'wander',
  'cohesion',
  'alignment',
  'separation',
  'viscosity',
  'pressure',
  'trailDecay',
  'dragStrength',
  'dragRadius',
  'nameAttraction',
  'boxAttraction',
  'textPadding',
  'separatorAttraction',
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]
export type ModeSettings = Record<SettingKey, number>

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

export interface GlobalSettings {
  /** Index into NAME_FONTS. */
  nameFont: number
  nameWeight: number
}

/**
 * Runtime handles the settings panel uses to read and tweak the live physics.
 * PartyBackground assigns these once the engine is up. Numeric settings are
 * per demo mode (edits persist as overrides across mode switches); the name
 * font and weight are global.
 */
export const bridge: {
  /** Turns the automatic demo rotation on or off. */
  setAutoRotate: (on: boolean) => void
  autoRotateOn: boolean
  /** Applies a value to the current mode and stores it as that mode's override. */
  applySetting: (key: SettingKey, value: number) => void
  getCurrentSettings: () => ModeSettings | null
  applyGlobal: (key: keyof GlobalSettings, value: number) => void
  getGlobals: () => GlobalSettings
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
  getGlobals: () => ({ nameFont: 0, nameWeight: 700 }),
  getAllSettings: () => ({}),
  setDebug: () => {},
  debugOn: false,
}
