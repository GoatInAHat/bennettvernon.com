import {
  Behavior,
  Boundary,
  Collisions,
  Environment,
  Fluids,
  FluidsMethod,
  Particles,
  ParticlesColorType,
  Sensors,
  Trails,
  type Engine,
  type GravityDirection,
  type SensorBehavior,
} from '@cazala/party'
import demo1 from './sessions/demo1.json'
import demo2 from './sessions/demo2.json'
import demo3 from './sessions/demo3.json'
import demo4 from './sessions/demo4.json'
import demo5 from './sessions/demo5.json'
import demo6 from './sessions/demo6.json'
import demo7 from './sessions/demo7.json'

/** Module set shared by every preset; created once and mutated in place. */
export interface PartyModules {
  environment: Environment
  boundary: Boundary
  collisions: Collisions
  fluids: Fluids
  behavior: Behavior
  sensors: Sensors
  trails: Trails
  particles: Particles
}

export function createPartyModules(): PartyModules {
  return {
    environment: new Environment(),
    boundary: new Boundary({ mode: 'warp' }),
    collisions: new Collisions({ enabled: false }),
    fluids: new Fluids({ enabled: false }),
    behavior: new Behavior(),
    sensors: new Sensors({ enabled: false }),
    trails: new Trails({ trailDecay: 10, trailDiffuse: 0 }),
    particles: new Particles({ colorType: ParticlesColorType.Default }),
  }
}

interface SessionModule {
  enabled: boolean
  [key: string]: number | boolean | string | object
}

interface SessionData {
  name: string
  modules: {
    environment: SessionModule & {
      gravityStrength: number
      dirX: number
      dirY: number
      inertia: number
      friction: number
      damping: number
      mode: string
    }
    boundary: SessionModule & {
      restitution: number
      friction: number
      mode: string
      repelDistance: number
      repelStrength: number
    }
    collisions: SessionModule & { restitution: number }
    fluids: SessionModule & {
      method: string
      influenceRadius: number
      targetDensity: number
      pressureMultiplier: number
      viscosity: number
      nearPressureMultiplier: number
      nearThreshold: number
      enableNearPressure: boolean
      maxAcceleration: number
      flipRatio?: number
    }
    behavior: SessionModule & {
      wander: number
      cohesion: number
      alignment: number
      repulsion: number
      chase: number
      avoid: number
      separation: number
      viewRadius: number
      viewAngle: number
    }
    sensors: SessionModule & {
      sensorDistance: number
      sensorAngle: number
      sensorRadius: number
      sensorThreshold: number
      sensorStrength: number
      followValue: string
      fleeValue: string
      colorSimilarityThreshold: number
      fleeAngle: number
    }
    trails: SessionModule & { trailDecay: number; trailDiffuse: number }
    particles: SessionModule & {
      colorType: number
      customColor: { r: number; g: number; b: number; a: number }
      hue: number
    }
  }
  engine: { constrainIterations: number; gridCellSize: number; maxNeighbors: number }
  oscillators?: Record<
    string,
    {
      moduleName?: string
      inputName?: string
      customMin: number
      customMax: number
      speedHz: number
    }
  >
}

export interface DemoPreset {
  session: SessionData
  /** Fraction of the device particle budget this demo simulates. */
  budgetFactor: number
}

// Same order and particle budgets as the caza.la/party homepage rotation
// (playground useDemo.ts); timing is user-configurable and lives in settings.
export const DEMO_PRESETS: DemoPreset[] = [
  { session: demo3 as SessionData, budgetFactor: 1 },
  { session: demo1 as SessionData, budgetFactor: 1 / 4 },
  { session: demo4 as SessionData, budgetFactor: 1 },
  { session: demo5 as SessionData, budgetFactor: 1 / 4 },
  { session: demo6 as SessionData, budgetFactor: 1 / 6 },
  { session: demo7 as SessionData, budgetFactor: 1 / 4 },
  { session: demo2 as SessionData, budgetFactor: 1 / 2.5 },
]

/**
 * Every numeric physics parameter that smoothly interpolates during a mode
 * transition. Keys overlapping the mode sliders share their names.
 */
export interface ParamDef {
  key: string
  from: (preset: DemoPreset, isMobile: boolean) => number
  set: (mods: PartyModules, v: number) => void
}

/**
 * Force-magnitude params of modules whose "disabled" state is representable in
 * param space read as 0 when the preset disables the module. Transitions keep
 * such modules enabled (union of both presets) and let the ordinary param
 * interpolation fade their forces continuously; the real enabled flag only
 * flips while the module's force contribution is exactly zero.
 */
export const PARAM_DEFS: ParamDef[] = [
  {
    key: 'gravity',
    // Mobile lowers Demo3's inward gravity, matching the playground.
    from: (p, mobile) =>
      !p.session.modules.environment.enabled
        ? 0
        : p.session.name === 'Demo3' && mobile
          ? 1000
          : p.session.modules.environment.gravityStrength,
    set: (m, v) => m.environment.setGravityStrength(v),
  },
  { key: 'inertia', from: (p) => (p.session.modules.environment.enabled ? p.session.modules.environment.inertia : 0), set: (m, v) => m.environment.setInertia(v) },
  { key: 'envFriction', from: (p) => (p.session.modules.environment.enabled ? p.session.modules.environment.friction : 0), set: (m, v) => m.environment.setFriction(v) },
  { key: 'damping', from: (p) => (p.session.modules.environment.enabled ? p.session.modules.environment.damping : 0), set: (m, v) => m.environment.setDamping(v) },
  { key: 'restitution', from: (p) => p.session.modules.boundary.restitution, set: (m, v) => m.boundary.setRestitution(v) },
  { key: 'boundaryFriction', from: (p) => p.session.modules.boundary.friction, set: (m, v) => m.boundary.setFriction(v) },
  { key: 'collisionRestitution', from: (p) => p.session.modules.collisions.restitution, set: (m, v) => m.collisions.setRestitution(v) },
  { key: 'influenceRadius', from: (p) => p.session.modules.fluids.influenceRadius, set: (m, v) => m.fluids.setInfluenceRadius(v) },
  { key: 'targetDensity', from: (p) => p.session.modules.fluids.targetDensity, set: (m, v) => m.fluids.setTargetDensity(v) },
  { key: 'pressure', from: (p) => p.session.modules.fluids.pressureMultiplier, set: (m, v) => m.fluids.setPressureMultiplier(v) },
  { key: 'viscosity', from: (p) => p.session.modules.fluids.viscosity, set: (m, v) => m.fluids.setViscosity(v) },
  { key: 'nearPressure', from: (p) => p.session.modules.fluids.nearPressureMultiplier, set: (m, v) => m.fluids.setNearPressureMultiplier(v) },
  { key: 'nearThreshold', from: (p) => p.session.modules.fluids.nearThreshold, set: (m, v) => m.fluids.setNearThreshold(v) },
  { key: 'maxAcceleration', from: (p) => p.session.modules.fluids.maxAcceleration, set: (m, v) => m.fluids.setMaxAcceleration(v) },
  { key: 'flipRatio', from: (p) => p.session.modules.fluids.flipRatio ?? 0.9, set: (m, v) => m.fluids.setFlipRatio(v) },
  { key: 'wander', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.wander : 0), set: (m, v) => m.behavior.setWander(v) },
  { key: 'cohesion', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.cohesion : 0), set: (m, v) => m.behavior.setCohesion(v) },
  { key: 'alignment', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.alignment : 0), set: (m, v) => m.behavior.setAlignment(v) },
  { key: 'repulsion', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.repulsion : 0), set: (m, v) => m.behavior.setRepulsion(v) },
  { key: 'chase', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.chase : 0), set: (m, v) => m.behavior.setChase(v) },
  { key: 'avoid', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.avoid : 0), set: (m, v) => m.behavior.setAvoid(v) },
  { key: 'separation', from: (p) => (p.session.modules.behavior.enabled ? p.session.modules.behavior.separation : 0), set: (m, v) => m.behavior.setSeparation(v) },
  { key: 'viewRadius', from: (p) => p.session.modules.behavior.viewRadius, set: (m, v) => m.behavior.setViewRadius(v) },
  { key: 'viewAngle', from: (p) => p.session.modules.behavior.viewAngle, set: (m, v) => m.behavior.setViewAngle(v) },
  { key: 'sensorDistance', from: (p) => p.session.modules.sensors.sensorDistance, set: (m, v) => m.sensors.setSensorDistance(v) },
  { key: 'sensorAngle', from: (p) => p.session.modules.sensors.sensorAngle, set: (m, v) => m.sensors.setSensorAngle(v) },
  { key: 'sensorRadius', from: (p) => p.session.modules.sensors.sensorRadius, set: (m, v) => m.sensors.setSensorRadius(v) },
  { key: 'sensorThreshold', from: (p) => p.session.modules.sensors.sensorThreshold, set: (m, v) => m.sensors.setSensorThreshold(v) },
  { key: 'sensorStrength', from: (p) => p.session.modules.sensors.sensorStrength, set: (m, v) => m.sensors.setSensorStrength(v) },
  { key: 'colorSimilarity', from: (p) => p.session.modules.sensors.colorSimilarityThreshold, set: (m, v) => m.sensors.setColorSimilarityThreshold(v) },
  { key: 'fleeAngle', from: (p) => p.session.modules.sensors.fleeAngle, set: (m, v) => m.sensors.setFleeAngle(v) },
  { key: 'fluidStrength', from: (p) => (p.session.modules.fluids.enabled ? 1 : 0), set: (m, v) => m.fluids.setStrength(v) },
  { key: 'collisionStrength', from: (p) => (p.session.modules.collisions.enabled ? 1 : 0), set: (m, v) => m.collisions.setStrength(v) },
  { key: 'sensorGate', from: (p) => (p.session.modules.sensors.enabled ? 1 : 0), set: (m, v) => m.sensors.setStrength(v) },
  {
    key: 'trailDecay',
    // Demo5/Demo6 historically disabled trails, which froze stale smears on
    // the scene texture; a high decay gives the same trail-less look while
    // the texture keeps fading all the way back to the background.
    from: (p) =>
      p.session.name === 'Demo5' || p.session.name === 'Demo6'
        ? 80
        : p.session.modules.trails.trailDecay,
    set: (m, v) => m.trails.setTrailDecay(v),
  },
]

/**
 * Everything a preset configures that cannot interpolate: enable flags, enum
 * sub-modes, and spatial-grid engine settings. Transitions stage these so that
 * every switch lands while the affected force is exactly zero:
 *  - start: modules enabled by either preset turn on (their force params /
 *    master gates start at the outgoing preset's values, 0 for modules that
 *    were off); sub-modes of modules that were off are set here, invisibly.
 *  - mid: sub-modes of modules active on both sides flip at the zero crossing
 *    of their dipped force params, together with boundary mode and engine
 *    settings.
 *  - end: enable flags settle to the incoming preset's real values (any module
 *    turning off has ramped its force to zero by now).
 */
export interface DiscreteState {
  env: boolean
  envMode: GravityDirection
  envDirX: number
  envDirY: number
  fluids: boolean
  fluidsMethod: FluidsMethod
  fluidsNearP: boolean
  behavior: boolean
  sensors: boolean
  sensorsFollow: SensorBehavior
  sensorsFlee: SensorBehavior
  collisions: boolean
  boundaryMode: 'bounce' | 'warp' | 'kill' | 'none'
  constrainIterations: number
  cellSize: number
  maxNeighbors: number
}

export function discreteOf(preset: DemoPreset): DiscreteState {
  const m = preset.session.modules
  return {
    env: m.environment.enabled,
    envMode: m.environment.mode as GravityDirection,
    envDirX: m.environment.dirX,
    envDirY: m.environment.dirY,
    fluids: m.fluids.enabled,
    fluidsMethod: m.fluids.method === 'picflip' ? FluidsMethod.Picflip : FluidsMethod.Sph,
    fluidsNearP: m.fluids.enableNearPressure,
    behavior: m.behavior.enabled,
    sensors: m.sensors.enabled,
    sensorsFollow: m.sensors.followValue as SensorBehavior,
    sensorsFlee: m.sensors.fleeValue as SensorBehavior,
    collisions: m.collisions.enabled,
    boundaryMode: preset.session.modules.boundary.mode as 'bounce' | 'warp' | 'kill' | 'none',
    constrainIterations: preset.session.engine.constrainIterations,
    cellSize: preset.session.engine.gridCellSize,
    maxNeighbors: preset.session.engine.maxNeighbors,
  }
}

const envChanged = (a: DiscreteState, b: DiscreteState) =>
  a.envMode !== b.envMode ||
  (b.envMode === 'custom' && (a.envDirX !== b.envDirX || a.envDirY !== b.envDirY))
const fluidsChanged = (a: DiscreteState, b: DiscreteState) =>
  a.fluidsMethod !== b.fluidsMethod || a.fluidsNearP !== b.fluidsNearP
const sensorsChanged = (a: DiscreteState, b: DiscreteState) =>
  a.sensorsFollow !== b.sensorsFollow || a.sensorsFlee !== b.sensorsFlee

function applyEnvSubMode(mods: PartyModules, d: DiscreteState): void {
  mods.environment.setGravityDirection(d.envMode)
  if (d.envMode === 'custom') mods.environment.setDirection(d.envDirX, d.envDirY)
}
function applyFluidsSubMode(mods: PartyModules, d: DiscreteState): void {
  mods.fluids.setMethod(d.fluidsMethod)
  mods.fluids.setEnableNearPressure(d.fluidsNearP)
}
function applySensorsSubMode(mods: PartyModules, d: DiscreteState): void {
  mods.sensors.setFollowBehavior(d.sensorsFollow)
  mods.sensors.setFleeBehavior(d.sensorsFlee)
}

/** When to apply grid/solver engine settings during a transition: at whichever
 * staged moment the strong neighbor-based modules (fluids, collisions) carry
 * the least strength, so the discrete neighborhood change moves no force. */
export function engineTiming(prev: DiscreteState, next: DiscreteState): 'start' | 'mid' | 'end' {
  if (!prev.fluids && !prev.collisions) return 'start'
  if (!next.fluids && !next.collisions) return 'end'
  return 'mid'
}

export function applyEngineSettings(engine: Engine, d: DiscreteState, opts: { isWebGPU: boolean }): void {
  // ponytail: CPU fallback caps constraint iterations, heavy demos assume GPU
  engine.setConstrainIterations(
    opts.isWebGPU ? d.constrainIterations : Math.min(d.constrainIterations, 10),
  )
  // Changing the cell size destroys and reallocates the GPU grid buffers
  // synchronously — skip it when the target keeps the current size so mode
  // switches stay hitch-free.
  if (engine.getCellSize() !== d.cellSize) engine.setCellSize(d.cellSize)
  engine.setMaxNeighbors(opts.isWebGPU ? d.maxNeighbors : Math.min(d.maxNeighbors, 100))
}

/** Instant apply (boot / zero-length transitions): the full discrete state. */
export function applyDiscrete(
  engine: Engine,
  mods: PartyModules,
  d: DiscreteState,
  opts: { isWebGPU: boolean },
): void {
  applyEnvSubMode(mods, d)
  applyFluidsSubMode(mods, d)
  applySensorsSubMode(mods, d)
  mods.boundary.setMode(d.boundaryMode)
  mods.environment.setEnabled(d.env)
  mods.fluids.setEnabled(d.fluids)
  mods.behavior.setEnabled(d.behavior)
  mods.sensors.setEnabled(d.sensors)
  mods.collisions.setEnabled(d.collisions)
  mods.boundary.setEnabled(true)
  // Trails stay enabled so the scene texture always decays to background.
  mods.trails.setEnabled(true)
  applyEngineSettings(engine, d, opts)
}

/** Transition start: union-enable and pre-set sub-modes of inactive modules.
 * Returns the discrete state actually applied now. */
export function applyDiscreteStart(
  mods: PartyModules,
  prev: DiscreteState,
  next: DiscreteState,
): DiscreteState {
  const now: DiscreteState = {
    ...prev,
    env: prev.env || next.env,
    fluids: prev.fluids || next.fluids,
    behavior: prev.behavior || next.behavior,
    sensors: prev.sensors || next.sensors,
    collisions: prev.collisions || next.collisions,
  }
  mods.environment.setEnabled(now.env)
  mods.fluids.setEnabled(now.fluids)
  mods.behavior.setEnabled(now.behavior)
  mods.sensors.setEnabled(now.sensors)
  mods.collisions.setEnabled(now.collisions)
  if (!prev.env) {
    now.envMode = next.envMode
    now.envDirX = next.envDirX
    now.envDirY = next.envDirY
    applyEnvSubMode(mods, now)
  }
  if (!prev.fluids) {
    now.fluidsMethod = next.fluidsMethod
    now.fluidsNearP = next.fluidsNearP
    applyFluidsSubMode(mods, now)
  }
  if (!prev.sensors) {
    now.sensorsFollow = next.sensorsFollow
    now.sensorsFlee = next.sensorsFlee
    applySensorsSubMode(mods, now)
  }
  return now
}

/** Transition midpoint: flip remaining sub-modes at the force zero crossing,
 * plus boundary mode and engine settings. Returns the state applied now. */
export function applyDiscreteMid(
  engine: Engine,
  mods: PartyModules,
  cur: DiscreteState,
  next: DiscreteState,
  opts: { isWebGPU: boolean; applyEngine: boolean },
): DiscreteState {
  const now: DiscreteState = {
    ...next,
    env: cur.env,
    fluids: cur.fluids,
    behavior: cur.behavior,
    sensors: cur.sensors,
    collisions: cur.collisions,
  }
  // Sub-modes flip here only for modules active on BOTH sides (mirroring
  // dipKeys, whose zero dip makes the flip forceless). A module ramping OFF
  // has no dip — its gate is ~0.5 at the midpoint — so its sub-modes must
  // stay put; the incoming preset's values for a disabled module are
  // irrelevant, and applyDiscreteStart re-applies sub-modes before the
  // module can ever re-enable.
  if (cur.env && next.env && envChanged(cur, next)) {
    applyEnvSubMode(mods, now)
  } else {
    now.envMode = cur.envMode
    now.envDirX = cur.envDirX
    now.envDirY = cur.envDirY
  }
  if (cur.fluids && next.fluids && fluidsChanged(cur, next)) {
    applyFluidsSubMode(mods, now)
  } else {
    now.fluidsMethod = cur.fluidsMethod
    now.fluidsNearP = cur.fluidsNearP
  }
  if (cur.sensors && next.sensors && sensorsChanged(cur, next)) {
    applySensorsSubMode(mods, now)
  } else {
    now.sensorsFollow = cur.sensorsFollow
    now.sensorsFlee = cur.sensorsFlee
  }
  if (cur.boundaryMode !== next.boundaryMode) mods.boundary.setMode(now.boundaryMode)
  if (opts.applyEngine) applyEngineSettings(engine, now, opts)
  return now
}

/** Transition end: settle enable flags to the incoming preset's real values
 * (forces of modules turning off have ramped to zero). */
export function applyDiscreteEnd(mods: PartyModules, cur: DiscreteState, next: DiscreteState): DiscreteState {
  mods.environment.setEnabled(next.env)
  mods.fluids.setEnabled(next.fluids)
  mods.behavior.setEnabled(next.behavior)
  mods.sensors.setEnabled(next.sensors)
  mods.collisions.setEnabled(next.collisions)
  return { ...cur, env: next.env, fluids: next.fluids, behavior: next.behavior, sensors: next.sensors, collisions: next.collisions }
}

/** Force params that must dip through zero mid-transition because a sub-mode
 * of their still-active module flips there (a monotonic ramp can't hide the
 * switch). Modules merely turning on/off need no dip: their gate already
 * starts or ends at zero. */
export function dipKeys(prev: DiscreteState, next: DiscreteState): Set<string> {
  const dip = new Set<string>()
  if (prev.env && next.env && envChanged(prev, next)) dip.add('gravity')
  if (prev.fluids && next.fluids && fluidsChanged(prev, next)) dip.add('fluidStrength')
  if (prev.sensors && next.sensors && sensorsChanged(prev, next)) dip.add('sensorGate')
  return dip
}

/** Host-side oscillators: the playground sessions' oscillator configs mapped
 * onto PARAM_DEFS keys. The engine no longer owns oscillators — the host
 * evaluates these every frame (deterministic phase from a shared clock) so
 * transitions can blend toward the moving value with no snap on either end.
 * particles.hue has no PARAM_DEF (render settings are not applied) and drops
 * out via the map. */
const OSC_INPUT_TO_KEY: Record<string, string> = {
  'environment.gravityStrength': 'gravity',
  'environment.inertia': 'inertia',
  'environment.friction': 'envFriction',
  'environment.damping': 'damping',
  'fluids.influenceRadius': 'influenceRadius',
  'fluids.targetDensity': 'targetDensity',
  'fluids.pressureMultiplier': 'pressure',
  'fluids.viscosity': 'viscosity',
  'fluids.nearPressureMultiplier': 'nearPressure',
  'fluids.nearThreshold': 'nearThreshold',
  'fluids.maxAcceleration': 'maxAcceleration',
  'fluids.flipRatio': 'flipRatio',
  'behavior.wander': 'wander',
  'behavior.cohesion': 'cohesion',
  'behavior.alignment': 'alignment',
  'behavior.repulsion': 'repulsion',
  'behavior.chase': 'chase',
  'behavior.avoid': 'avoid',
  'behavior.separation': 'separation',
  'behavior.viewRadius': 'viewRadius',
  'behavior.viewAngle': 'viewAngle',
  'sensors.sensorDistance': 'sensorDistance',
  'sensors.sensorAngle': 'sensorAngle',
  'sensors.sensorRadius': 'sensorRadius',
  'sensors.sensorThreshold': 'sensorThreshold',
  'sensors.sensorStrength': 'sensorStrength',
  'sensors.colorSimilarityThreshold': 'colorSimilarity',
  'sensors.fleeAngle': 'fleeAngle',
  'trails.trailDecay': 'trailDecay',
}

export interface OscConfig {
  key: string
  min: number
  max: number
  speedHz: number
}

export function presetOscillators(preset: DemoPreset): OscConfig[] {
  const out: OscConfig[] = []
  for (const [sliderId, config] of Object.entries(preset.session.oscillators ?? {})) {
    const [fallbackModule, fallbackInput] = sliderId.split('.')
    const moduleName = config.moduleName ?? fallbackModule
    const inputName = config.inputName ?? fallbackInput
    const key = OSC_INPUT_TO_KEY[`${moduleName}.${inputName}`]
    if (!key) continue
    out.push({ key, min: config.customMin, max: config.customMax, speedHz: config.speedHz })
  }
  return out
}

/** Same waveform as the upstream OscillatorManager with its defaults (curve
 * exponent 2, no jitter): sign(sin)·sin² between min and max. */
export function oscValue(o: OscConfig, tSeconds: number): number {
  const amp = (o.max - o.min) / 2
  const center = o.min + amp
  if (amp <= 0) return center
  const s = Math.sin(tSeconds * o.speedHz * 2 * Math.PI)
  return center + Math.sign(s) * s * s * amp
}
