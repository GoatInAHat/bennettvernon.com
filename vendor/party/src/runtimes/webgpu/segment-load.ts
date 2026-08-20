import type { SegmentLoadConfig, SegmentLoadResult } from "../../interfaces";
import type { GPUResources } from "./gpu-resources";

/**
 * SegmentLoad
 *
 * How crowded each of a few line segments is: for every segment, the sum over
 * live particles of `L^2 / (d^2 + L^2)`, where `d` is the particle's distance
 * to the segment and `L` a softening length. That weight is the same falloff
 * an inverse-square force uses, so a particle sitting on the segment counts
 * as one, one at `L` away counts as a half, and one far off counts for almost
 * nothing. The result is a smooth measure of concentration rather than a
 * count inside an arbitrary radius, with no edge for a particle to jitter
 * across.
 *
 * A sum of floats across threads is the awkward part -- WGSL has no float
 * atomics -- so the weight is accumulated in fixed point: scaled by
 * `WEIGHT_SCALE` into a u32 and divided back out on the host. Every particle
 * contributes at most `WEIGHT_SCALE`, so the budget is `u32 max /
 * WEIGHT_SCALE` particles per segment, ~1.0M at this scale against a pool of
 * 80k.
 *
 * Unlike the cell census this keeps ONE readback in flight rather than a
 * ring. The census drives discrete corrections, where a result arriving every
 * third frame means the corrections arrive in bursts of three frames' worth.
 * This drives a continuous scalar that the caller eases anyway, so a value
 * two or three frames old is indistinguishable from a fresh one, and the
 * pipelining would buy nothing for the extra state.
 */

/** Fixed-point denominator for the per-particle weight (see above). */
const WEIGHT_SCALE = 4096;

export class SegmentLoad {
  private pipeline: GPUComputePipeline | null = null;
  private uniform: GPUBuffer | null = null;
  private segments: GPUBuffer | null = null;
  private segmentCapacity = 0;
  private result: GPUBuffer | null = null;
  private staging: GPUBuffer | null = null;
  private zeroes: Uint32Array<ArrayBuffer> | null = null;
  private device: GPUDevice | null = null;
  private count = -1;
  private inFlight = false;
  private nextSerial = 0;
  private latest: SegmentLoadResult | null = null;

  dispose(): void {
    this.pipeline = null;
    this.uniform?.destroy();
    this.segments?.destroy();
    this.result?.destroy();
    this.staging?.destroy();
    this.uniform = null;
    this.segments = null;
    this.result = null;
    this.staging = null;
    this.zeroes = null;
    this.device = null;
    this.segmentCapacity = 0;
    this.count = -1;
    this.inFlight = false;
    this.nextSerial = 0;
    this.latest = null;
  }

  private ensure(device: GPUDevice, config: SegmentLoadConfig): void {
    if (!this.segments || config.count > this.segmentCapacity) {
      this.segments?.destroy();
      this.segmentCapacity = Math.max(config.count, 8);
      this.segments = device.createBuffer({
        size: this.segmentCapacity * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }

    if (config.count !== this.count) {
      this.count = config.count;
      this.result?.destroy();
      this.staging?.destroy();
      const len = Math.max(config.count, 1);
      this.result = device.createBuffer({
        size: len * 4,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });
      this.staging = device.createBuffer({
        size: len * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.zeroes = new Uint32Array(len);
      this.inFlight = false;
      // The old result counts segments that no longer exist.
      this.latest = null;
    }

    if (!this.uniform) {
      this.uniform = device.createBuffer({
        size: 4 * 4,
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

struct LoadUniforms {
  v0: vec4<f32>, // particleCount, segmentCount, soften, weightScale
};

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> cfg: LoadUniforms;
@group(0) @binding(2) var<storage, read> segments: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> res: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(cfg.v0.x)) { return; }
  let p = particles[i];
  if (p.mass <= 0.0) { return; }

  let n = u32(cfg.v0.y);
  let L = cfg.v0.z;
  let LL = L * L;
  let scale = cfg.v0.w;

  for (var s: u32 = 0u; s < n; s = s + 1u) {
    let seg = segments[s];
    let vx = seg.z - seg.x;
    let vy = seg.w - seg.y;
    let len2 = vx * vx + vy * vy;
    var t = 0.0;
    if (len2 > 0.0) {
      t = clamp(((p.position.x - seg.x) * vx + (p.position.y - seg.y) * vy) / len2, 0.0, 1.0);
    }
    let dx = p.position.x - (seg.x + vx * t);
    let dy = p.position.y - (seg.y + vy * t);
    // Same falloff the force law uses, so "load" is in the same currency as
    // the pull the segment would exert.
    let w = LL / (dx * dx + dy * dy + LL);
    atomicAdd(&res[s], u32(w * scale));
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
    config: SegmentLoadConfig,
    particleCount: number
  ): SegmentLoadResult | null {
    const device = resources.getDevice();
    const particleBuffer = resources.getParticleBuffer();
    if (!particleBuffer || config.count <= 0) return null;
    if (this.device && this.device !== device) {
      this.dispose();
    }
    this.device = device;
    this.ensure(device, config);

    device.queue.writeBuffer(
      this.segments!,
      0,
      config.segments.buffer,
      config.segments.byteOffset,
      Math.min(config.segments.byteLength, this.segmentCapacity * 16)
    );

    if (!this.inFlight && particleCount > 0) {
      this.inFlight = true;
      const serial = this.nextSerial++;
      device.queue.writeBuffer(this.result!, 0, this.zeroes!);
      device.queue.writeBuffer(
        this.uniform!,
        0,
        new Float32Array([particleCount, config.count, config.soften, WEIGHT_SCALE])
      );

      const bindGroup = device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: particleBuffer } },
          { binding: 1, resource: { buffer: this.uniform! } },
          { binding: 2, resource: { buffer: this.segments! } },
          { binding: 3, resource: { buffer: this.result! } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(particleCount / 256));
      pass.end();
      encoder.copyBufferToBuffer(this.result!, 0, this.staging!, 0, Math.max(config.count, 1) * 4);
      device.queue.submit([encoder.finish()]);

      const staging = this.staging!;
      const count = config.count;
      staging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (staging !== this.staging) return; // disposed or reshaped meanwhile
          try {
            const view = new Uint32Array(staging.getMappedRange());
            const loads = new Float32Array(count);
            for (let i = 0; i < count; i++) loads[i] = view[i] / WEIGHT_SCALE;
            this.latest = { serial, loads };
          } finally {
            // Whether or not the result was used: a staging buffer left
            // mapped can never be copied into again.
            staging.unmap();
          }
        })
        .catch(() => {})
        .then(() => {
          if (staging === this.staging) this.inFlight = false;
        });
    }

    return this.latest;
  }
}
