import type { CellCensusConfig, CellCensusResult } from "../../interfaces";
import type { GPUResources } from "./gpu-resources";

/**
 * CellCensus
 *
 * A persistent compute pass that classifies every live particle inside a
 * world-space disc into caller-defined cells (via a coarse lookup grid),
 * counting members per cell and collecting a bounded set of candidate
 * indices per cell plus a reservoir of unclassified particles.
 *
 * Unlike LocalQuery this never stalls the pipeline: each update kicks a
 * dispatch and copies the packed result into a staging buffer whose map is
 * resolved asynchronously; callers always receive the latest completed
 * census (typically one or two frames old), which is fine for steering
 * decisions made every frame.
 *
 * Result buffer layout (u32): [outsideCount, counts[cellCount],
 * samples[cellCount * samplesPerCell], outside[outsideSamples],
 * outsidePos[outsideSamples * 2]]. Positions are f32 bit-cast into the same
 * u32 storage so one readback carries both.
 */
export class CellCensus {
  private pipeline: GPUComputePipeline | null = null;
  private uniform: GPUBuffer | null = null;
  private cellsBuf: GPUBuffer | null = null;
  private result: GPUBuffer | null = null;
  private staging: GPUBuffer | null = null;
  private zeroes: Uint32Array<ArrayBuffer> | null = null;
  private device: GPUDevice | null = null;
  private cellsVersion = -1;
  private cellsCapacity = 0;
  private resultLen = 0;
  private shape = "";
  private inFlight = false;
  private latest: CellCensusResult | null = null;

  dispose(): void {
    this.pipeline = null;
    this.uniform?.destroy();
    this.cellsBuf?.destroy();
    this.result?.destroy();
    this.staging?.destroy();
    this.uniform = null;
    this.cellsBuf = null;
    this.result = null;
    this.staging = null;
    this.zeroes = null;
    this.device = null;
    this.cellsVersion = -1;
    this.cellsCapacity = 0;
    this.resultLen = 0;
    this.shape = "";
    this.inFlight = false;
    this.latest = null;
  }

  private ensure(device: GPUDevice, config: CellCensusConfig): void {
    const gridSize = config.gridCols * config.gridRows;
    if (!this.cellsBuf || gridSize > this.cellsCapacity) {
      this.cellsBuf?.destroy();
      this.cellsCapacity = Math.max(gridSize, 1024);
      this.cellsBuf = device.createBuffer({
        size: this.cellsCapacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.cellsVersion = -1; // force re-upload into the fresh buffer
    }

    const shape = `${config.cellCount}:${config.samplesPerCell}:${config.outsideSamples}`;
    if (shape !== this.shape) {
      this.shape = shape;
      this.result?.destroy();
      this.staging?.destroy();
      this.resultLen =
        1 +
        config.cellCount +
        config.cellCount * config.samplesPerCell +
        config.outsideSamples +
        config.outsideSamples * 2;
      this.result = device.createBuffer({
        size: this.resultLen * 4,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });
      this.staging = device.createBuffer({
        size: this.resultLen * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.zeroes = new Uint32Array(1 + config.cellCount);
      this.inFlight = false;
    }

    if (!this.uniform) {
      this.uniform = device.createBuffer({
        size: 12 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    if (this.pipeline) return;
    const code = `
struct Particle {
  position: vec2<f32>,
  velocity: vec2<f32>,
  acceleration: vec2<f32>,
  size: f32,
  mass: f32,
  color: vec4<f32>,
};

struct CensusUniforms {
  v0: vec4<f32>, // center.x, center.y, radius, particleCount
  v1: vec4<f32>, // gridMinX, gridMinY, gridCell, gridCols
  v2: vec4<f32>, // gridRows, cellCount, samplesPerCell, outsideSamples
};

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> census: CensusUniforms;
@group(0) @binding(2) var<storage, read> cells: array<i32>;
@group(0) @binding(3) var<storage, read_write> res: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(census.v0.w)) { return; }
  let p = particles[i];
  if (p.mass <= 0.0) { return; }

  let dx = p.position.x - census.v0.x;
  let dy = p.position.y - census.v0.y;
  let r = census.v0.z;
  if (dx * dx + dy * dy > r * r) { return; }

  let cols = i32(census.v1.w);
  let rows = i32(census.v2.x);
  let cellCount = u32(census.v2.y);
  let k = u32(census.v2.z);
  let m = u32(census.v2.w);

  let gx = i32(floor((p.position.x - census.v1.x) / census.v1.z));
  let gy = i32(floor((p.position.y - census.v1.y) / census.v1.z));
  var cell: i32 = -1;
  if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) {
    cell = cells[u32(gy) * u32(cols) + u32(gx)];
  }

  if (cell >= 0 && u32(cell) < cellCount) {
    let slot = atomicAdd(&res[1u + u32(cell)], 1u);
    if (slot < k) {
      atomicStore(&res[1u + cellCount + u32(cell) * k + slot], i);
    }
  } else {
    let slot = atomicAdd(&res[0], 1u);
    if (slot < m) {
      atomicStore(&res[1u + cellCount + cellCount * k + slot], i);
      // Record where it is as well as which it is: callers that relocate a
      // particle to an existing one need the position, and fetching it any
      // other way would sync the whole particle buffer back off the GPU.
      let pbase = 1u + cellCount + cellCount * k + m + slot * 2u;
      atomicStore(&res[pbase], bitcast<u32>(p.position.x));
      atomicStore(&res[pbase + 1u], bitcast<u32>(p.position.y));
    }
  }
}
`;
    this.pipeline = device.createComputePipeline({
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code }),
        entryPoint: "main",
      },
    });
  }

  update(
    resources: GPUResources,
    config: CellCensusConfig,
    particleCount: number
  ): CellCensusResult | null {
    const device = resources.getDevice();
    const particleBuffer = resources.getParticleBuffer();
    if (!particleBuffer || config.cellCount <= 0) return this.latest;
    if (this.device && this.device !== device) {
      this.dispose();
    }
    this.device = device;
    this.ensure(device, config);

    if (config.version !== this.cellsVersion) {
      this.cellsVersion = config.version;
      device.queue.writeBuffer(
        this.cellsBuf!,
        0,
        config.cells.buffer,
        config.cells.byteOffset,
        config.cells.byteLength
      );
    }

    // One census in flight at a time: kick the next dispatch only once the
    // previous readback resolved, so the CPU never waits on the GPU.
    if (!this.inFlight && particleCount > 0) {
      this.inFlight = true;
      device.queue.writeBuffer(this.result!, 0, this.zeroes!);
      const u = new Float32Array(12);
      u[0] = config.centerX;
      u[1] = config.centerY;
      u[2] = config.radius;
      u[3] = particleCount;
      u[4] = config.gridMinX;
      u[5] = config.gridMinY;
      u[6] = config.gridCell;
      u[7] = config.gridCols;
      u[8] = config.gridRows;
      u[9] = config.cellCount;
      u[10] = config.samplesPerCell;
      u[11] = config.outsideSamples;
      device.queue.writeBuffer(this.uniform!, 0, u);

      const bindGroup = device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: particleBuffer } },
          { binding: 1, resource: { buffer: this.uniform! } },
          { binding: 2, resource: { buffer: this.cellsBuf! } },
          { binding: 3, resource: { buffer: this.result! } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(particleCount / 256));
      pass.end();
      encoder.copyBufferToBuffer(this.result!, 0, this.staging!, 0, this.resultLen * 4);
      device.queue.submit([encoder.finish()]);

      const staging = this.staging!;
      const c = config.cellCount;
      const k = config.samplesPerCell;
      const m = config.outsideSamples;
      const version = config.version;
      staging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (staging !== this.staging) return; // disposed/reshaped meanwhile
          const view = new Uint32Array(staging.getMappedRange());
          this.latest = {
            version,
            counts: view.slice(1, 1 + c),
            samples: view.slice(1 + c, 1 + c + c * k),
            samplesPerCell: k,
            outside: view.slice(1 + c + c * k, 1 + c + c * k + m),
            outsidePos: new Float32Array(
              view.buffer.slice(
                view.byteOffset + (1 + c + c * k + m) * 4,
                view.byteOffset + (1 + c + c * k + m + m * 2) * 4
              )
            ),
            outsideCount: view[0],
          };
          staging.unmap();
        })
        .catch(() => {})
        .then(() => {
          if (staging === this.staging) this.inFlight = false;
        });
    }

    return this.latest;
  }
}
