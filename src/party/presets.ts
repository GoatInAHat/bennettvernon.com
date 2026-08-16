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

export const PARAM_DEFS: ParamDef[] = [
  {
    key: 'gravity',
    // Mobile lowers Demo3's inward gravity, matching the playground.
    from: (p, mobile) =>
      p.session.name === 'Demo3' && mobile ? 1000 : p.session.modules.environment.gravityStrength,
    set: (m, v) => m.environment.setGravityStrength(v),
  },
  { key: 'inertia', from: (p) => p.session.modules.environment.inertia, set: (m, v) => m.environment.setInertia(v) },
  { key: 'envFriction', from: (p) => p.session.modules.environment.friction, set: (m, v) => m.environment.setFriction(v) },
  { key: 'damping', from: (p) => p.session.modules.environment.damping, set: (m, v) => m.environment.setDamping(v) },
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
  { key: 'wander', from: (p) => p.session.modules.behavior.wander, set: (m, v) => m.behavior.setWander(v) },
  { key: 'cohesion', from: (p) => p.session.modules.behavior.cohesion, set: (m, v) => m.behavior.setCohesion(v) },
  { key: 'alignment', from: (p) => p.session.modules.behavior.alignment, set: (m, v) => m.behavior.setAlignment(v) },
  { key: 'repulsion', from: (p) => p.session.modules.behavior.repulsion, set: (m, v) => m.behavior.setRepulsion(v) },
  { key: 'chase', from: (p) => p.session.modules.behavior.chase, set: (m, v) => m.behavior.setChase(v) },
  { key: 'avoid', from: (p) => p.session.modules.behavior.avoid, set: (m, v) => m.behavior.setAvoid(v) },
  { key: 'separation', from: (p) => p.session.modules.behavior.separation, set: (m, v) => m.behavior.setSeparation(v) },
  { key: 'viewRadius', from: (p) => p.session.modules.behavior.viewRadius, set: (m, v) => m.behavior.setViewRadius(v) },
  { key: 'viewAngle', from: (p) => p.session.modules.behavior.viewAngle, set: (m, v) => m.behavior.setViewAngle(v) },
  { key: 'sensorDistance', from: (p) => p.session.modules.sensors.sensorDistance, set: (m, v) => m.sensors.setSensorDistance(v) },
  { key: 'sensorAngle', from: (p) => p.session.modules.sensors.sensorAngle, set: (m, v) => m.sensors.setSensorAngle(v) },
  { key: 'sensorRadius', from: (p) => p.session.modules.sensors.sensorRadius, set: (m, v) => m.sensors.setSensorRadius(v) },
  { key: 'sensorThreshold', from: (p) => p.session.modules.sensors.sensorThreshold, set: (m, v) => m.sensors.setSensorThreshold(v) },
  { key: 'sensorStrength', from: (p) => p.session.modules.sensors.sensorStrength, set: (m, v) => m.sensors.setSensorStrength(v) },
  { key: 'colorSimilarity', from: (p) => p.session.modules.sensors.colorSimilarityThreshold, set: (m, v) => m.sensors.setColorSimilarityThreshold(v) },
  { key: 'fleeAngle', from: (p) => p.session.modules.sensors.fleeAngle, set: (m, v) => m.sensors.setFleeAngle(v) },
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

/** Applies everything that cannot interpolate: enable flags, enum modes, and
 * spatial-grid engine settings. Runs at the start of a transition. */
export function applyDiscretePreset(
  engine: Engine,
  mods: PartyModules,
  preset: DemoPreset,
  opts: { isWebGPU: boolean },
): void {
  const m = preset.session.modules
  mods.environment.setEnabled(m.environment.enabled)
  mods.environment.setGravityDirection(m.environment.mode as GravityDirection)
  if (m.environment.mode === 'custom') {
    mods.environment.setDirection(m.environment.dirX, m.environment.dirY)
  }
  mods.boundary.setEnabled(m.boundary.enabled)
  mods.boundary.setMode(m.boundary.mode as 'bounce' | 'warp' | 'kill' | 'none')
  mods.collisions.setEnabled(m.collisions.enabled)
  mods.fluids.setEnabled(m.fluids.enabled)
  mods.fluids.setMethod(m.fluids.method === 'picflip' ? FluidsMethod.Picflip : FluidsMethod.Sph)
  mods.fluids.setEnableNearPressure(m.fluids.enableNearPressure)
  mods.behavior.setEnabled(m.behavior.enabled)
  mods.sensors.setEnabled(m.sensors.enabled)
  mods.sensors.setFollowBehavior(m.sensors.followValue as SensorBehavior)
  mods.sensors.setFleeBehavior(m.sensors.fleeValue as SensorBehavior)
  // Trails stay enabled so the scene texture always decays to background.
  mods.trails.setEnabled(true)

  const eng = preset.session.engine
  // ponytail: CPU fallback caps constraint iterations, heavy demos assume GPU
  engine.setConstrainIterations(
    opts.isWebGPU ? eng.constrainIterations : Math.min(eng.constrainIterations, 10),
  )
  // Changing the cell size destroys and reallocates the GPU grid buffers
  // synchronously — skip it when the preset keeps the current size so mode
  // switches stay hitch-free.
  if (engine.getCellSize() !== eng.gridCellSize) engine.setCellSize(eng.gridCellSize)
  engine.setMaxNeighbors(opts.isWebGPU ? eng.maxNeighbors : Math.min(eng.maxNeighbors, 100))
}

/** Registers a preset's oscillators; call after a transition completes. */
export function applyPresetOscillators(engine: Engine, preset: DemoPreset): void {
  const oscillators = (preset.session.oscillators ?? {}) as Record<
    string,
    { moduleName?: string; inputName?: string; customMin: number; customMax: number; speedHz: number }
  >
  for (const [sliderId, config] of Object.entries(oscillators)) {
    const [fallbackModule, fallbackInput] = sliderId.split('.')
    const moduleName = config.moduleName ?? fallbackModule
    const inputName = config.inputName ?? fallbackInput
    if (!moduleName || !inputName) continue
    engine.addOscillator({
      moduleName,
      inputName,
      min: config.customMin,
      max: config.customMax,
      speedHz: config.speedHz,
    })
  }
}
