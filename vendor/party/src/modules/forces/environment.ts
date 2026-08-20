/**
 * Environment (Force Module)
 *
 * Applies global influences: gravity (fixed/inwards/outwards/custom), inertia,
 * friction, and velocity damping. Gravity direction can be vector- or mode-driven,
 * with center computed from grid extents for inwards/outwards.
 */
import { Vector } from "../../vector";
import {
  Module,
  type WebGPUDescriptor,
  ModuleRole,
  CPUDescriptor,
  DataType,
  type VizGroup,
} from "../../module";

export const DEFAULT_ENVIRONMENT_GRAVITY_STRENGTH = 0;
export const DEFAULT_ENVIRONMENT_GRAVITY_DIRECTION: GravityDirection = "down";
export const DEFAULT_ENVIRONMENT_GRAVITY_ANGLE = Math.PI / 2; // radians, default down
export const DEFAULT_ENVIRONMENT_INERTIA = 0;
export const DEFAULT_ENVIRONMENT_FRICTION = 0;
export const DEFAULT_ENVIRONMENT_DAMPING = 0;

export type GravityDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "inwards"
  | "outwards"
  | "custom";

type EnvironmentInputs = {
  gravityStrength: number;
  dirX: number;
  dirY: number;
  inertia: number;
  friction: number;
  damping: number;
  mode: number;
  /** Explicit centre for inwards/outwards gravity, in world units. Used
   * only when `useCenter` is set; otherwise the centre is the middle of the
   * grid, which is the middle of the whole world and not necessarily
   * anywhere the viewer is looking. */
  centerX: number;
  centerY: number;
  useCenter: number;
};

export class Environment extends Module<"environment", EnvironmentInputs> {
  readonly name = "environment" as const;
  readonly role = ModuleRole.Force;
  readonly inputs = {
    gravityStrength: DataType.NUMBER,
    dirX: DataType.NUMBER,
    dirY: DataType.NUMBER,
    inertia: DataType.NUMBER,
    friction: DataType.NUMBER,
    damping: DataType.NUMBER,
    mode: DataType.NUMBER,
    centerX: DataType.NUMBER,
    centerY: DataType.NUMBER,
    useCenter: DataType.NUMBER,
  } as const;

  private gravityDirection: GravityDirection = "down";
  private gravityAngle: number = Math.PI / 2; // radians, default down

  constructor(opts?: {
    enabled?: boolean;
    gravityStrength?: number;
    dirX?: number;
    dirY?: number;
    inertia?: number;
    friction?: number;
    damping?: number;
    gravityDirection?: GravityDirection;
    gravityAngle?: number; // radians, only used when direction is custom
  }) {
    super();

    this.gravityDirection =
      opts?.gravityDirection ?? DEFAULT_ENVIRONMENT_GRAVITY_DIRECTION;
    this.gravityAngle = opts?.gravityAngle ?? DEFAULT_ENVIRONMENT_GRAVITY_ANGLE;

    // Initialize direction
    const initial = this.directionFromOptions(
      this.gravityDirection,
      this.gravityAngle,
      opts?.dirX,
      opts?.dirY
    );

    this.write({
      gravityStrength:
        opts?.gravityStrength ?? DEFAULT_ENVIRONMENT_GRAVITY_STRENGTH,
      dirX: initial.x,
      dirY: initial.y,
      inertia: opts?.inertia ?? DEFAULT_ENVIRONMENT_INERTIA,
      friction: opts?.friction ?? DEFAULT_ENVIRONMENT_FRICTION,
      damping: opts?.damping ?? DEFAULT_ENVIRONMENT_DAMPING,
      mode:
        this.gravityDirection === "inwards"
          ? 1
          : this.gravityDirection === "outwards"
          ? 2
          : 0,
      centerX: 0,
      centerY: 0,
      useCenter: 0,
    });
    if (opts?.enabled !== undefined) {
      this.setEnabled(!!opts.enabled);
    }
  }

  private directionFromOptions(
    dir: GravityDirection,
    angleRad: number,
    dirXOverride?: number,
    dirYOverride?: number
  ): { x: number; y: number } {
    // If explicit vector provided, use it
    if (dirXOverride !== undefined || dirYOverride !== undefined) {
      return { x: dirXOverride ?? 0, y: dirYOverride ?? 0 };
    }
    switch (dir) {
      case "up":
        return { x: 0, y: -1 };
      case "down":
        return { x: 0, y: 1 };
      case "left":
        return { x: -1, y: 0 };
      case "right":
        return { x: 1, y: 0 };
      case "inwards":
        // Approximate as downward for now (screen space inward not available here)
        return { x: 0, y: 1 };
      case "outwards":
        // Approximate as upward for now
        return { x: 0, y: -1 };
      case "custom":
      default: {
        const x = Math.cos(angleRad);
        const y = Math.sin(angleRad);
        return { x, y };
      }
    }
  }

  setGravityStrength(value: number): void {
    this.write({ gravityStrength: value });
  }

  /**
   * Pin the centre inwards/outwards gravity acts about, in world units.
   *
   * Without one the centre is the middle of the grid, which is the middle of
   * the whole simulated world. That is only where a viewer is looking when
   * the world is one screen; on a page taller than the viewport it is
   * usually off-screen, so the clump forms somewhere nobody can see.
   */
  setGravityCenter(x: number, y: number): void {
    this.write({ centerX: x, centerY: y, useCenter: 1 });
  }

  /** Back to the grid centre. */
  clearGravityCenter(): void {
    this.write({ useCenter: 0 });
  }
  setDirection(x: number, y: number): void {
    this.write({ dirX: x, dirY: y });
  }
  setGravityDirection(direction: GravityDirection): void {
    this.gravityDirection = direction;
    const v = this.directionFromOptions(
      this.gravityDirection,
      this.gravityAngle
    );
    this.setDirection(v.x, v.y);
    this.write({
      mode: direction === "inwards" ? 1 : direction === "outwards" ? 2 : 0,
    });
  }
  setGravityAngle(angleRadians: number): void {
    this.gravityAngle = angleRadians;
    if (this.gravityDirection === "custom") {
      const v = this.directionFromOptions("custom", this.gravityAngle);
      this.setDirection(v.x, v.y);
    }
  }
  setInertia(value: number): void {
    this.write({ inertia: value });
  }
  setFriction(value: number): void {
    this.write({ friction: value });
  }
  setDamping(value: number): void {
    this.write({ damping: value });
  }

  getGravityStrength(): number {
    return this.readValue("gravityStrength");
  }
  getDirX(): number {
    return this.readValue("dirX");
  }
  getDirY(): number {
    return this.readValue("dirY");
  }
  getInertia(): number {
    return this.readValue("inertia");
  }
  getFriction(): number {
    return this.readValue("friction");
  }
  getDamping(): number {
    return this.readValue("damping");
  }
  getMode(): number {
    return this.readValue("mode");
  }

  /**
   * Where inwards/outwards gravity acts about -- and nothing else.
   *
   * This pull is the same magnitude at every distance (`dir/|dir| *
   * strength`), so there is no falloff for a glow to draw: rendered as a
   * body it would be one flat wash over the entire page, which is a true
   * picture carrying no information and covering every glow that does. The
   * centre is the one thing about it that has a place on the page, so the
   * centre is what is reported, as a node.
   *
   * Only an EXPLICIT centre can be reported. The implicit one is the middle
   * of the runtime's grid, which the module never sees.
   */
  viz(): VizGroup[] {
    const mode = this.readValue("mode");
    if (mode !== 1 && mode !== 2) return [];
    if (!this.isEnabled()) return [];
    if (!this.readValue("useCenter")) return [];
    if (this.readValue("gravityStrength") === 0) return [];
    return [
      {
        key: "environment:gravity",
        // The host moves it as the page scrolls, so it must not be baked
        // into a viewer's static cache.
        dynamic: true,
        nodes: [[this.readValue("centerX"), this.readValue("centerY")]],
        primitives: [],
      },
    ];
  }

  webgpu(): WebGPUDescriptor<EnvironmentInputs> {
    return {
      apply: ({ particleVar, dtVar, getUniform }) => `
  // Gravity as force: acceleration += dir * strength
  let mode = ${getUniform("mode")};
  var gdir = vec2<f32>(${getUniform("dirX")}, ${getUniform("dirY")});
  if (mode == 1.0 || mode == 2.0) {
    var c = vec2<f32>(
      (GRID_MINX() + GRID_MAXX()) * 0.5,
      (GRID_MINY() + GRID_MAXY()) * 0.5
    );
    if (${getUniform("useCenter")} != 0.0) {
      c = vec2<f32>(${getUniform("centerX")}, ${getUniform("centerY")});
    }
    if (mode == 1.0) {
      gdir = c - ${particleVar}.position;
    } else {
      gdir = ${particleVar}.position - c;
    }
  }
  let glen = length(gdir);
  if (glen > 0.0) {
    ${particleVar}.acceleration += (gdir / glen) * ${getUniform(
        "gravityStrength"
      )};
  }

  // Inertia, friction, and damping are all velocity rates in 1/s: inertia
  // grows speed, friction and damping shed it. They compose into a single
  // exponential because exp(a*dt)*exp(b*dt) == exp((a+b)*dt), and exp is the
  // only form that is exact under any dt — two half-steps equal one whole
  // step — so the per-second result is identical at every frame rate.
  // Inertia and friction keep their upstream positive-only gates; damping
  // stays signed.
  let rate = max(${getUniform("inertia")}, 0.0)
    - max(${getUniform("friction")}, 0.0)
    - ${getUniform("damping")};
  if (rate != 0.0) {
    ${particleVar}.velocity *= exp(rate * (${dtVar}));
  }
`,
    };
  }

  cpu(): CPUDescriptor<EnvironmentInputs> {
    return {
      apply: ({ particle, dt, input, view }) => {
        const gdir = new Vector(input.dirX, input.dirY);

        if (input.mode === 1 || input.mode === 2) {
          // Centre is the explicit one when set, else the camera position
          // (which matches the WebGPU grid centre).
          const camera = input.useCenter
            ? { x: input.centerX, y: input.centerY }
            : view.getCamera();
          if (input.mode === 1) {
            gdir.set(camera.x, camera.y).subtract(particle.position);
          } else {
            gdir.set(
              particle.position.x - camera.x,
              particle.position.y - camera.y
            );
          }
        }
        const glen = gdir.magnitude();
        if (glen > 0) {
          const gravityForce = gdir
            .clone()
            .divide(glen)
            .multiply(input.gravityStrength);
          particle.acceleration.add(gravityForce);
        }

        // Inertia, friction, and damping are all velocity rates in 1/s:
        // inertia grows speed, friction and damping shed it. They compose into
        // a single exponential because exp(a*dt)*exp(b*dt) == exp((a+b)*dt),
        // and exp is the only form that is exact under any dt — two half-steps
        // equal one whole step — so the per-second result is identical at every
        // frame rate. Inertia and friction keep their upstream positive-only
        // gates; damping stays signed.
        const rate =
          Math.max(input.inertia, 0) -
          Math.max(input.friction, 0) -
          input.damping;
        if (rate !== 0) {
          particle.velocity.multiply(Math.exp(rate * dt));
        }
      },
    };
  }
}
