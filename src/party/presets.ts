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
  /** Auto-advance delay in ms (desktop, mobile). */
  duration: [number, number]
  /** Fraction of the device particle budget this demo simulates. */
  budgetFactor: number
  /** maxParticles interpolation duration in ms. */
  transitionMs: number
}

// Same order, durations, budgets, and transitions as the caza.la/party
// homepage rotation (playground useDemo.ts).
export const DEMO_PRESETS: DemoPreset[] = [
  { session: demo3 as SessionData, duration: [15000, 12000], budgetFactor: 1, transitionMs: 5000 },
  { session: demo1 as SessionData, duration: [15000, 12000], budgetFactor: 1 / 4, transitionMs: 0 },
  { session: demo4 as SessionData, duration: [15000, 15000], budgetFactor: 1, transitionMs: 5000 },
  { session: demo5 as SessionData, duration: [15000, 15000], budgetFactor: 1 / 4, transitionMs: 0 },
  { session: demo6 as SessionData, duration: [15000, 15000], budgetFactor: 1 / 6, transitionMs: 0 },
  { session: demo7 as SessionData, duration: [20000, 20000], budgetFactor: 1 / 4, transitionMs: 0 },
  { session: demo2 as SessionData, duration: [20000, 20000], budgetFactor: 1 / 2.5, transitionMs: 2500 },
]

/** Applies a demo session's module settings, engine tuning, and oscillators. */
export function applyPreset(
  engine: Engine,
  mods: PartyModules,
  preset: DemoPreset,
  opts: { isMobile: boolean; isWebGPU: boolean },
): void {
  const m = preset.session.modules
  const name = preset.session.name

  const env = m.environment
  mods.environment.setEnabled(env.enabled)
  // Mobile lowers Demo3's inward gravity, matching the playground.
  const gravity =
    name === 'Demo3' && opts.isMobile ? 1000 : env.gravityStrength
  mods.environment.setGravityStrength(gravity)
  mods.environment.setGravityDirection(env.mode as GravityDirection)
  if (env.mode === 'custom') {
    mods.environment.setDirection(env.dirX, env.dirY)
  }
  mods.environment.setInertia(env.inertia)
  mods.environment.setFriction(env.friction)
  mods.environment.setDamping(env.damping)

  const bounds = m.boundary
  mods.boundary.setEnabled(bounds.enabled)
  mods.boundary.setMode(bounds.mode as 'bounce' | 'warp' | 'kill' | 'none')
  mods.boundary.setRestitution(bounds.restitution)
  mods.boundary.setFriction(bounds.friction)
  mods.boundary.setRepelDistance(bounds.repelDistance)
  mods.boundary.setRepelStrength(bounds.repelStrength)

  mods.collisions.setEnabled(m.collisions.enabled)
  mods.collisions.setRestitution(m.collisions.restitution)

  const fl = m.fluids
  mods.fluids.setEnabled(fl.enabled)
  mods.fluids.setMethod(fl.method === 'picflip' ? FluidsMethod.Picflip : FluidsMethod.Sph)
  mods.fluids.setInfluenceRadius(fl.influenceRadius)
  mods.fluids.setTargetDensity(fl.targetDensity)
  mods.fluids.setPressureMultiplier(fl.pressureMultiplier)
  mods.fluids.setViscosity(fl.viscosity)
  mods.fluids.setNearPressureMultiplier(fl.nearPressureMultiplier)
  mods.fluids.setNearThreshold(fl.nearThreshold)
  mods.fluids.setEnableNearPressure(fl.enableNearPressure)
  mods.fluids.setMaxAcceleration(fl.maxAcceleration)
  if ('flipRatio' in fl && typeof fl.flipRatio === 'number') {
    mods.fluids.setFlipRatio(fl.flipRatio)
  }

  const be = m.behavior
  mods.behavior.setEnabled(be.enabled)
  mods.behavior.setWander(be.wander)
  mods.behavior.setCohesion(be.cohesion)
  mods.behavior.setAlignment(be.alignment)
  mods.behavior.setRepulsion(be.repulsion)
  mods.behavior.setChase(be.chase)
  mods.behavior.setAvoid(be.avoid)
  mods.behavior.setSeparation(be.separation)
  mods.behavior.setViewRadius(be.viewRadius)
  mods.behavior.setViewAngle(be.viewAngle)

  const se = m.sensors
  mods.sensors.setEnabled(se.enabled)
  mods.sensors.setSensorDistance(se.sensorDistance)
  mods.sensors.setSensorAngle(se.sensorAngle)
  mods.sensors.setSensorRadius(se.sensorRadius)
  mods.sensors.setSensorThreshold(se.sensorThreshold)
  mods.sensors.setSensorStrength(se.sensorStrength)
  mods.sensors.setFollowBehavior(se.followValue as SensorBehavior)
  mods.sensors.setFleeBehavior(se.fleeValue as SensorBehavior)
  mods.sensors.setColorSimilarityThreshold(se.colorSimilarityThreshold)
  mods.sensors.setFleeAngle(se.fleeAngle)

  // Render settings are not loaded from sessions (like the homepage quickload):
  // particles stay per-particle white (black after CSS inversion) and trails
  // keep their startup decay. Demo5/Demo6 run without trails.
  mods.trails.setEnabled(name !== 'Demo5' && name !== 'Demo6')

  const eng = preset.session.engine
  // ponytail: CPU fallback caps constraint iterations, heavy demos assume GPU
  engine.setConstrainIterations(
    opts.isWebGPU ? eng.constrainIterations : Math.min(eng.constrainIterations, 10),
  )
  engine.setCellSize(eng.gridCellSize)
  engine.setMaxNeighbors(opts.isWebGPU ? eng.maxNeighbors : Math.min(eng.maxNeighbors, 100))

  engine.clearOscillators()
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
