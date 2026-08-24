import {
  AbstractEngine,
  CellCensusConfig,
  CellCensusResult,
  SegmentLoadConfig,
  SegmentLoadResult,
  IParticle,
} from "../../interfaces";
import {
  Module,
  ModuleRole,
  CanvasComposition,
  CPUDescriptor,
  CPURenderDescriptor,
  CPUForceDescriptor,
} from "../../module";
import { SpatialGrid } from "./spatial-grid";
import { Particle } from "../../particle";
import { Vector } from "../../vector";

export class CPUEngine extends AbstractEngine {
  private particles: Particle[] = [];
  private canvas: HTMLCanvasElement;
  private grid: SpatialGrid;
  private animationId: number | null = null;
  private destroyed: boolean = false;
  private particleIdToIndex: Map<number, number> = new Map();
  private censusSerial: number = 0;
  private segmentSerial: number = 0;
  // cpu() descriptors are pure functions of the module class, but they were
  // being rebuilt -- closures and all -- several times per module per frame.
  private cpuDescriptors: WeakMap<Module, CPUDescriptor> = new WeakMap();
  // Scratch for getNeighbors so a neighbor query does not allocate a Vector.
  private neighborPoint: Vector = new Vector(0, 0);
  // Per-particle prev/post integration positions, with records reused across
  // frames instead of reallocated for every particle every frame.
  private positionState: Map<
    number,
    { prev: { x: number; y: number }; post: { x: number; y: number } }
  > = new Map();

  private cpuOf(module: Module): CPUDescriptor {
    let d = this.cpuDescriptors.get(module);
    if (!d) {
      d = module.cpu();
      this.cpuDescriptors.set(module, d);
    }
    return d;
  }

  // One read() per module instead of one per input key: read() copies the
  // whole uniform state, so the per-key form was quadratic in key count.
  private readInputs(module: Module): Record<string, number | number[]> {
    const state = module.read() as Record<string, number | number[]>;
    const input: Record<string, number | number[]> = {};
    for (const key of Object.keys(module.inputs)) {
      input[key] = state[key] ?? 0;
    }
    input.enabled = module.isEnabled() ? 1 : 0;
    return input;
  }

  constructor(options: {
    canvas: HTMLCanvasElement;
    forces: Module[];
    render: Module[];
    constrainIterations?: number;
    clearColor?: { r: number; g: number; b: number; a: number };
    cellSize?: number;
    onFrame?: (dtSeconds: number) => void;
  }) {
    super(options);
    this.canvas = options.canvas;
    this.grid = new SpatialGrid({
      width: this.canvas.width,
      height: this.canvas.height,
      cellSize: this.cellSize,
    });
  }

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  // Implement abstract methods for animation loop
  protected startAnimationLoop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.animate();
  }

  protected stopAnimationLoop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Resets animation timing to prevent large deltaTime spikes.
   * Useful when starting after engine restoration or long pauses.
   */
  public resetTiming(): void {
    this.lastTime = performance.now();
  }

  /**
   * Resets the simulation to its initial state.
   *
   * This method:
   * - Pauses the simulation
   * - Clears all particles
   * - Resets timing and FPS data
   * - Clears force-specific caches
   */
  public reset(): void {
    this.pause();
    // Ensure animation frame is properly cancelled
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.particles = [];
    this.lastTime = 0;
    // Clear FPS tracking data
    this.fpsEstimate = 60;
  }

  clear(): void {
    this.particles = [];
    this.grid.clear();
    this.fpsEstimate = 60;
    // Reset maxSize tracking
    this.resetMaxSize();
    this.particleIdToIndex.clear();
  }

  getCount(): number {
    const actualCount = this.particles.length;
    if (this.maxParticles === null) {
      return actualCount;
    }
    return Math.min(actualCount, this.maxParticles);
  }

  protected getEffectiveCount(): number {
    return this.getCount();
  }

  // Override setSize to also update spatial grid
  setSize(width: number, height: number): void {
    this.view.setSize(width, height);
    this.grid.setSize(width, height);
  }

  setParticles(particle: IParticle[]): void {
    this.particles = particle.map((p) => new Particle(p));
    // Update maxSize tracking
    this.resetMaxSize();
    for (const p of particle) {
      this.updateMaxSize(p.size);
    }
    this.particleIdToIndex.clear();
  }

  addParticle(particle: IParticle): number {
    const index = this.particles.length;
    this.particles.push(new Particle(particle));
    // Update maxSize tracking
    this.updateMaxSize(particle.size);
    const created = this.particles[index];
    if (created) this.particleIdToIndex.set(created.id, index);
    return index;
  }

  setParticle(index: number, p: IParticle): void {
    if (index < 0) return;
    if (index >= this.particles.length) return;
    this.particles[index] = new Particle(p);
    // Best-effort maxSize tracking (monotonic)
    this.updateMaxSize(p.size);
  }

  setParticleRange(start: number, list: IParticle[]): void {
    for (let i = 0; i < list.length; i++) this.setParticle(start + i, list[i]);
  }

  setParticleMass(index: number, mass: number): void {
    if (index < 0) return;
    if (index >= this.particles.length) return;
    this.particles[index].mass = mass;
  }

  getParticles(): Promise<IParticle[]> {
    return Promise.resolve(this.particles.map((p) => p.toJSON()));
  }

  getParticle(index: number): Promise<IParticle> {
    return Promise.resolve(this.particles[index]);
  }

  /** Synchronous mirror of the WebGPU cell census compute pass. */
  updateCellCensus(config: CellCensusConfig): CellCensusResult | null {
    const c = config.cellCount;
    if (c <= 0) return null;
    const k = config.samplesPerCell;
    const m = config.outsideSamples;
    const counts = new Uint32Array(c);
    const samples = new Uint32Array(c * k);
    const samplePos = new Float32Array(c * k * 2);
    const outside = new Uint32Array(m);
    const outsidePos = new Float32Array(m * 2);
    let outsideCount = 0;
    const r2 = config.radius * config.radius;
    const n = this.getEffectiveCount();
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      if (p.mass <= 0) continue;
      const dx = p.position.x - config.centerX;
      const dy = p.position.y - config.centerY;
      if (dx * dx + dy * dy > r2) continue;
      const gx = Math.floor((p.position.x - config.gridMinX) / config.gridCell);
      const gy = Math.floor((p.position.y - config.gridMinY) / config.gridCell);
      let cell = -1;
      if (gx >= 0 && gy >= 0 && gx < config.gridCols && gy < config.gridRows) {
        cell = config.cells[gy * config.gridCols + gx];
      }
      if (cell >= 0 && cell < c) {
        const slot = counts[cell]++;
        if (slot < k) {
          samples[cell * k + slot] = i;
          samplePos[(cell * k + slot) * 2] = p.position.x;
          samplePos[(cell * k + slot) * 2 + 1] = p.position.y;
        }
      } else {
        const slot = outsideCount++;
        if (slot < m) {
          outside[slot] = i;
          outsidePos[slot * 2] = p.position.x;
          outsidePos[slot * 2 + 1] = p.position.y;
        }
      }
    }
    // Synchronous, so this census already contains every edit made before the
    // call and an edit made after it first shows up in the next one. Same
    // contract the WebGPU ring states, with a lag of zero.
    const serial = this.censusSerial++;
    return {
      serial,
      issued: this.censusSerial,
      version: config.version,
      counts,
      samples,
      samplePos,
      samplesPerCell: k,
      outside,
      outsidePos,
      outsideCount,
    };
  }

  updateSegmentLoad(config: SegmentLoadConfig): SegmentLoadResult | null {
    if (config.count <= 0) return null;
    const loads = new Float32Array(config.count);
    const LL = config.soften * config.soften;
    const n = this.getEffectiveCount();
    for (let s = 0; s < config.count; s++) {
      const x1 = config.segments[s * 4];
      const y1 = config.segments[s * 4 + 1];
      const vx = config.segments[s * 4 + 2] - x1;
      const vy = config.segments[s * 4 + 3] - y1;
      const len2 = vx * vx + vy * vy;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const p = this.particles[i];
        if (p.mass <= 0) continue;
        const t =
          len2 > 0
            ? Math.max(
                0,
                Math.min(1, ((p.position.x - x1) * vx + (p.position.y - y1) * vy) / len2)
              )
            : 0;
        const dx = p.position.x - (x1 + vx * t);
        const dy = p.position.y - (y1 + vy * t);
        sum += LL / (dx * dx + dy * dy + LL);
      }
      loads[s] = sum;
    }
    return { serial: this.segmentSerial++, loads };
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    this.pause();
    this.stopAnimationLoop();
    this.particles = [];
    this.grid.clear();
    this.particleIdToIndex.clear();
    return Promise.resolve();
  }

  // Handle configuration changes
  protected onClearColorChanged(): void {
    // Clear color changes don't require any immediate system updates
    // The new color will be used in the next render pass
  }

  protected onCellSizeChanged(): void {
    // Rebuild spatial grid with new cell size
    this.grid.setCellSize(this.cellSize);
  }

  protected onConstrainIterationsChanged(): void {
    // Constrain iterations changes don't require any immediate system updates
    // The new value will be used in the next simulation pass
  }

  protected onMaxNeighborsChanged(): void {
    // No additional state to update on CPU when max neighbors changes
  }

  protected onMaxParticlesChanged(): void {
    // No additional state to update on CPU when max particles changes
  }

  private animate = (): void => {
    if (this.destroyed) return;
    const dt = this.getTimeDelta();
    this.updateFPS(dt);

    // Host per-frame hook, before the physics step (parity with WebGPU).
    this.onFrame?.(dt);

    if (this.playing) {
      this.update(dt);
    }

    this.render();

    this.animationId = requestAnimationFrame(this.animate);
  };

  private getNeighbors(position: { x: number; y: number }, radius: number) {
    // Reuse one scratch Vector: this is called once per particle per
    // neighbor-based module per frame, and getParticles does not retain it.
    this.neighborPoint.x = position.x;
    this.neighborPoint.y = position.y;
    return this.grid.getParticles(
      this.neighborPoint,
      radius,
      this.getMaxNeighbors()
    );
  }

  private getImageData(
    x: number,
    y: number,
    width: number,
    height: number
  ): ImageData | null {
    try {
      // willReadFrequently keeps the canvas in CPU memory: sensor modules
      // call this per particle per frame, and each readback from a
      // GPU-backed canvas is a synchronous pipeline stall.
      const context = this.canvas.getContext("2d", {
        willReadFrequently: true,
      })!;

      // Clamp to canvas bounds
      const clampedX = Math.max(0, Math.min(x, this.canvas.width));
      const clampedY = Math.max(0, Math.min(y, this.canvas.height));
      const clampedWidth = Math.max(
        0,
        Math.min(width, this.canvas.width - clampedX)
      );
      const clampedHeight = Math.max(
        0,
        Math.min(height, this.canvas.height - clampedY)
      );

      if (clampedWidth <= 0 || clampedHeight <= 0) {
        return null;
      }

      return context.getImageData(
        clampedX,
        clampedY,
        clampedWidth,
        clampedHeight
      );
    } catch (error) {
      return null;
    }
  }

  private update(dt: number): void {
    const effectiveCount = this.getEffectiveCount();
    
    // Update spatial grid with current particle positions and camera
    this.grid.setCamera(
      this.view.getCamera().x,
      this.view.getCamera().y,
      this.view.getZoom()
    );
    this.grid.clear();
    this.particleIdToIndex.clear();
    for (let i = 0; i < effectiveCount; i++) {
      this.grid.insert(this.particles[i]);
      this.particleIdToIndex.set(this.particles[i].id, i);
    }

    // Global state for modules that need it
    const globalState: Record<number, Record<string, number>> = {};

    // Position tracking for correct pass (persistent records; see the
    // integration pass)
    const positionState = this.positionState;

    // Get neighbors function
    const getNeighbors = (position: { x: number; y: number }, radius: number) =>
      this.getNeighbors(position, radius);

    // Image data access function
    const getImageData = (
      x: number,
      y: number,
      width: number,
      height: number
    ) => this.getImageData(x, y, width, height);

    // First pass: state computation for all modules
    for (const module of this.modules) {
      try {
        // Skip disabled modules
        if (!module.isEnabled()) continue;
        if (module.role === ModuleRole.Force) {
          const force = this.cpuOf(module) as CPUForceDescriptor;
          if (force.state) {
            const input = this.readInputs(module);

            // One closure per pass, not one per particle: it reads the loop
            // variable, so hoisting it out of the loop changes nothing but
            // the allocation count.
            let particle: Particle = this.particles[0];
            const setState = (name: string, value: number) => {
              if (!globalState[particle.id]) {
                globalState[particle.id] = {};
              }
              globalState[particle.id][name] = value;
            };
            for (let pi = 0; pi < effectiveCount; pi++) {
              particle = this.particles[pi];
              if (particle.mass <= 0) continue;

              force.state({
                particle: particle,
                dt,
                getNeighbors,
                input,
                setState,
                view: this.view,
                index: pi,
                particles: this.particles,
                getImageData,
              });
            }
          }
        }
      } catch (error) {}
    }

    // Second pass: apply forces for all modules
    for (const module of this.modules) {
      try {
        // Skip disabled modules
        if (!module.isEnabled()) continue;
        if (module.role === ModuleRole.Force) {
          const force = this.cpuOf(module) as CPUForceDescriptor;
          if (force.apply) {
            const input = this.readInputs(module);
            const maxSize = this.getMaxSize();

            let particle: Particle = this.particles[0];
            const getState = (name: string, pid?: number) => {
              return globalState[pid ?? particle.id]?.[name] ?? 0;
            };
            for (let pi = 0; pi < effectiveCount; pi++) {
              particle = this.particles[pi];
              if (particle.mass <= 0) continue;

              force.apply({
                particle: particle,
                dt,
                maxSize,
                getNeighbors,
                input,
                getState,
                view: this.view,
                index: pi,
                particles: this.particles,
                getImageData,
              });
            }
          }
        }
      } catch (error) {}
    }

    // Third pass: integration (once per particle). Inlined arithmetic and
    // reused position records: the clone()-based form allocated five objects
    // per particle per frame, which at thousands of particles was most of
    // this runtime's GC load.
    for (let i = 0; i < effectiveCount; i++) {
      const particle = this.particles[i];
      if (particle.mass <= 0) continue;
      let entry = positionState.get(particle.id);
      if (!entry) {
        entry = { prev: { x: 0, y: 0 }, post: { x: 0, y: 0 } };
        positionState.set(particle.id, entry);
      }
      // Capture position before integration
      entry.prev.x = particle.position.x;
      entry.prev.y = particle.position.y;

      particle.velocity.x += particle.acceleration.x * dt;
      particle.velocity.y += particle.acceleration.y * dt;
      particle.position.x += particle.velocity.x * dt;
      particle.position.y += particle.velocity.y * dt;
      particle.acceleration.zero();

      // Capture position after integration
      entry.post.x = particle.position.x;
      entry.post.y = particle.position.y;
    }

    // Fourth pass: constraints for all modules (multiple iterations)
    const iterations = Math.max(1, this.constrainIterations);
    for (let iter = 0; iter < iterations; iter++) {
      for (const module of this.modules) {
        try {
          // Skip disabled modules
          if (!module.isEnabled()) continue;
          if (module.role === ModuleRole.Force) {
            const force = this.cpuOf(module) as CPUForceDescriptor;
            if (force.constrain) {
              const input = this.readInputs(module);
              const maxSize = this.getMaxSize();
              let particle: Particle = this.particles[0];
              const getState = (name: string, pid?: number) => {
                return globalState[pid ?? particle.id]?.[name] ?? 0;
              };
              for (let pi = 0; pi < effectiveCount; pi++) {
                particle = this.particles[pi];
                if (particle.mass <= 0) continue;

                force.constrain({
                  particle: particle,
                  getNeighbors,
                  dt: dt,
                  maxSize,
                  input,
                  getState,
                  view: this.view,
                  index: pi,
                  particles: this.particles,
                  getImageData,
                });
              }
            }
          }
        } catch (error) {}
      }
    }

    // Fifth pass: corrections for all modules
    for (const module of this.modules) {
      try {
        // Skip disabled modules
        if (!module.isEnabled()) continue;
        if (module.role === ModuleRole.Force) {
          const force = this.cpuOf(module) as CPUForceDescriptor;
          if (force.correct) {
            const input = this.readInputs(module);
            const maxSize = this.getMaxSize();

            let particle: Particle = this.particles[0];
            const getState = (name: string, pid?: number) => {
              return globalState[pid ?? particle.id]?.[name] ?? 0;
            };
            for (let index = 0; index < effectiveCount; index++) {
              particle = this.particles[index];
              if (particle.mass <= 0) continue;

              const positions = positionState.get(particle.id);
              const prevPos = positions?.prev ?? {
                x: particle.position.x,
                y: particle.position.y,
              };
              const postPos = positions?.post ?? {
                x: particle.position.x,
                y: particle.position.y,
              };

              force.correct({
                particle: particle,
                getNeighbors,
                dt: dt,
                maxSize,
                prevPos,
                postPos,
                input,
                getState,
                view: this.view,
                index,
                particles: this.particles,
                getImageData,
              });
            }
          }
        }
      } catch (error) {}
    }
  }

  private createRenderUtils(context: CanvasRenderingContext2D) {
    // Memoize the last color string: particles overwhelmingly share a color,
    // and building a fresh rgba() string per particle per frame was both
    // steady garbage and a per-call style reparse.
    let lastR = NaN;
    let lastG = NaN;
    let lastB = NaN;
    let lastA = NaN;
    let lastStyle = "";
    const formatColor = (color: {
      r: number;
      g: number;
      b: number;
      a: number;
    }): string => {
      if (
        color.r !== lastR ||
        color.g !== lastG ||
        color.b !== lastB ||
        color.a !== lastA
      ) {
        lastR = color.r;
        lastG = color.g;
        lastB = color.b;
        lastA = color.a;
        lastStyle = `rgba(${color.r * 255}, ${color.g * 255}, ${
          color.b * 255
        }, ${color.a})`;
      }
      return lastStyle;
    };
    return {
      formatColor,
      drawCircle: (
        x: number,
        y: number,
        radius: number,
        color: { r: number; g: number; b: number; a: number }
      ): void => {
        context.fillStyle = formatColor(color);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      },
      drawRect: (
        x: number,
        y: number,
        width: number,
        height: number,
        color: { r: number; g: number; b: number; a: number }
      ): void => {
        context.fillStyle = formatColor(color);
        context.fillRect(x, y, width, height);
      },
    };
  }

  private render(): void {
    // Same attributes as getImageData: the first getContext call fixes them.
    const context = this.canvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    // Get camera and canvas info for coordinate transformation
    const camera = this.view.getCamera();
    const zoom = this.view.getZoom();
    const size = this.view.getSize();
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    const utils = this.createRenderUtils(context);

    // Check composition requirements of enabled render modules
    const hasBackgroundHandler = this.modules.some((module) => {
      if (!module.isEnabled() || module.role !== ModuleRole.Render)
        return false;
      const descriptor = this.cpuOf(module) as CPURenderDescriptor;
      return descriptor.composition === CanvasComposition.HandlesBackground;
    });

    // Determine if there are any enabled renderers
    const hasEnabledRenderer = this.modules.some(
      (module) => module.isEnabled() && module.role === ModuleRole.Render
    );

    // Only clear canvas if no module handles background AND either some module requires clearing
    // or there are no enabled renderers (to avoid leaving a stale frame on canvas)
    if (!hasBackgroundHandler) {
      const needsClearing = this.modules.some((module) => {
        if (!module.isEnabled() || module.role !== ModuleRole.Render)
          return false;
        const descriptor = this.cpuOf(module) as CPURenderDescriptor;
        return descriptor.composition === CanvasComposition.RequiresClear;
      });

      if (needsClearing || !hasEnabledRenderer) {
        context.fillStyle = `rgba(${this.clearColor.r * 255}, ${
          this.clearColor.g * 255
        }, ${this.clearColor.b * 255}, ${this.clearColor.a})`;
        context.fillRect(0, 0, context.canvas.width, context.canvas.height);
      }
    }

    for (const module of this.modules) {
      try {
        // Skip disabled modules
        if (!module.isEnabled()) continue;
        if (module.role === ModuleRole.Render) {
          const descriptor = this.cpuOf(module) as CPURenderDescriptor;
          const render = descriptor;
          const input = this.readInputs(module);

          // Setup phase
          render.setup?.({
            context,
            input,
            view: this.view,
            clearColor: this.clearColor,
            utils,
            particles: this.particles,
          });

          // Render each visible particle
          const effectiveCount = this.getEffectiveCount();
          for (let i = 0; i < effectiveCount; i++) {
            const particle = this.particles[i];
            if (particle.mass == 0) continue;

            // Transform world position to screen position
            const worldX = (particle.position.x - camera.x) * zoom;
            const worldY = (particle.position.y - camera.y) * zoom;
            const screenX = centerX + worldX;
            const screenY = centerY + worldY;
            const screenSize = particle.size * zoom;

            // Skip rendering if particle is outside canvas bounds (culling)
            if (
              screenX + screenSize < 0 ||
              screenX - screenSize > size.width ||
              screenY + screenSize < 0 ||
              screenY - screenSize > size.height
            ) {
              continue;
            }

            render.render?.({
              context,
              particle,
              screenX,
              screenY,
              screenSize,
              input,
              utils,
            });
          }

          // Teardown phase
          render.teardown?.({
            context,
            input,
            utils,
          });
        }
      } catch (error) {}
    }
  }
}
