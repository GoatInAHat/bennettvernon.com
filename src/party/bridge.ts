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
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]
export type ModeSettings = Record<SettingKey, number>

/**
 * Runtime handles the settings panel uses to read and tweak the live physics.
 * PartyBackground assigns these once the engine is up. Settings are per demo
 * mode; edits persist as overrides across mode switches.
 */
export const bridge: {
  /** Pauses/resumes the automatic demo rotation. */
  setPaused: (paused: boolean) => void
  /** Applies a value to the current mode and stores it as that mode's override. */
  applySetting: (key: SettingKey, value: number) => void
  getCurrentSettings: () => ModeSettings | null
  /** Effective settings of every mode, keyed by session name (for copy/export). */
  getAllSettings: () => Record<string, ModeSettings>
  setDebug: (on: boolean) => void
  debugOn: boolean
} = {
  setPaused: () => {},
  applySetting: () => {},
  getCurrentSettings: () => null,
  getAllSettings: () => ({}),
  setDebug: () => {},
  debugOn: false,
}
