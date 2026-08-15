import type { Interaction } from '@cazala/party'
import type { PartyModules } from './presets'

/**
 * Runtime handles the settings panel uses to read and tweak the live physics.
 * PartyBackground assigns these once the engine is up.
 */
export const bridge: {
  mods: PartyModules | null
  interaction: Interaction | null
  /** Pauses/resumes the automatic demo rotation. */
  setPaused: (paused: boolean) => void
} = {
  mods: null,
  interaction: null,
  setPaused: () => {},
}
