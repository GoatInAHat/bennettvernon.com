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
 * resolved asynchronously.
 *
 * The readback is PIPELINED over a ring of buffer pairs, so one dispatch is
 * issued and one result completes per frame. A single pair would serialize
 * them: nothing may be dispatched while the one staging buffer is mapped, so
 * a fresh census would only appear once per round trip and every frame in
 * between would hand back the identical object. Callers that act on new data
 * would then act in bursts, one frame in every three or four, with each burst
 * carrying the drift of all the frames it skipped.
 *
 * A result is still the same age either way -- a round trip is a round trip.
 * The ring changes the RATE, not the latency.
 *
 * Every result carries `serial`, the dispatch that produced it, and `issued`,
 * the number of dispatches made as of the call that returned it. A caller
 * that mutates particles can tell exactly when its change becomes visible:
 * the dispatch for this frame has already been submitted by the time `update`
 * returns, so a write made now first appears in the result whose `serial`
 * reaches `issued`.
 *
 * Result buffer layout (u32): [outsideCount, counts[cellCount],
 * samples[cellCount * samplesPerCell], outside[outsideSamples],
 * outsidePos[outsideSamples * 2], samplePos[cellCount * samplesPerCell * 2]]. Positions are f32 bit-cast into the same
 * u32 storage so one readback carries both.
 */

/** Buffer pairs in the readback ring. A dispatch occupies its pair until the
 * map resolves; measured on this site that is two to four frames, and five
 * once the ring itself is the constraint. Six pairs leave headroom above the
 * observed worst case, which is what keeps a fresh census landing on EVERY
 * frame rather than on most of them -- at four, one frame in eleven found no
 * free pair and had to reuse the census it had already acted on.
 *
 * A frame that finds every pair busy simply skips its dispatch, which is what
 * the single-pair version did on every frame of every round trip, so the ring
 * degrades into the old behaviour rather than into an error. Cost is linear:
 * each pair is two buffers of the full result, ~1.9 MB at this site's cell
 * and sample counts. */
const RING = 6;

type Slot = {
  result: GPUBuffer;
  staging: GPUBuffer;
  busy: boolean;
};

export class CellCensus {
  private pipeline: GPUComputePipeline | null = null;
  private uniform: GPUBuffer | null = null;
  private cellsBuf: GPUBuffer | null = null;
  private slots: Slot[] | null = null;
  private zeroes: Uint32Array<ArrayBuffer> | null = null;
  private device: GPUDevice | null = null;
  private cellsVersion = -1;
  private cellsCapacity = 0;
  private resultLen = 0;
  private shape = "";
  /** Monotonic dispatch id. Survives a reshape -- results from before it are
   * still in flight, and a serial that restarted would let one of them
   * overwrite a newer census. Reset only in dispose(), where `latest` is
   * dropped along with it. */
  private nextSerial = 0;
  private latest: CellCensusResult | null = null;

  private freeSlots(): void {
    if (!this.slots) return;
    for (const s of this.slots) {
      s.result.destroy();
      s.staging.destroy();
    }
    this.slots = null;
  }

  dispose(): void {
    this.pipeline = null;
    this.uniform?.destroy();
    this.cellsBuf?.destroy();
    this.freeSlots();
    this.uniform = null;
    this.cellsBuf = null;
    this.zeroes = null;
    this.device = null;
    this.cellsVersion = -1;
    this.cellsCapacity = 0;
    this.resultLen = 0;
    this.shape = "";
    this.nextSerial = 0;
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
      // Replaced wholesale rather than mutated: the async completion closes
      // over the array it was dispatched against, so one identity check
      // covers both a reshape and a dispose.
      this.freeSlots();
      this.resultLen =
        1 +
        config.cellCount +
        config.cellCount * config.samplesPerCell +
        config.outsideSamples +
        config.outsideSamples * 2 +
        config.cellCount * config.samplesPerCell * 2;
      const slots: Slot[] = [];
      for (let i = 0; i < RING; i++) {
        slots.push({
          result: device.createBuffer({
            size: this.resultLen * 4,
            usage:
              GPUBufferUsage.STORAGE |
              GPUBufferUsage.COPY_DST |
              GPUBufferUsage.COPY_SRC,
          }),
          staging: device.createBuffer({
            size: this.resultLen * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          busy: false,
        });
      }
      this.slots = slots;
      this.zeroes = new Uint32Array(1 + config.cellCount);
      // An old-shape census counts a partition that no longer exists.
      this.latest = null;
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
      let sbase = 1u + cellCount + cellCount * k + m + m * 2u + (u32(cell) * k + slot) * 2u;
      atomicStore(&res[sbase], bitcast<u32>(p.position.x));
      atomicStore(&res[sbase + 1u], bitcast<u32>(p.position.y));
    }
  } else {
    let slot = atomicAdd(&res[0], 1u);
    if (slot < m) {
      atomicStore(&res[1u + cellCount + cellCount * k + slot], i);
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
    // Same shape as the tail return: `issued` must always mean "as of this
    // call", never the value frozen when the readback resolved.
    if (!particleBuffer || config.cellCount <= 0) {
      return this.latest && { ...this.latest, issued: this.nextSerial };
    }
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

    const slots = this.slots!;
    const slot = particleCount > 0 ? slots.find((s) => !s.busy) : undefined;
    if (slot) {
      slot.busy = true;
      const serial = this.nextSerial++;
      // Only the counters accumulate (atomicAdd); every other word is
      // atomicStore, and the caller reads none of them past the count. So
      // zeroing the header is enough, per slot as it was for the single pair.
      device.queue.writeBuffer(slot.result, 0, this.zeroes!);
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
          { binding: 3, resource: { buffer: slot.result } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(particleCount / 256));
      pass.end();
      encoder.copyBufferToBuffer(slot.result, 0, slot.staging, 0, this.resultLen * 4);
      device.queue.submit([encoder.finish()]);

      const c = config.cellCount;
      const k = config.samplesPerCell;
      const m = config.outsideSamples;
      const version = config.version;
      slot.staging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (this.slots !== slots) return; // disposed/reshaped meanwhile
          try {
            const view = new Uint32Array(slot.staging.getMappedRange());
            // Nothing orders map callbacks across separate buffers, and the
            // promise chains add microtask hops of their own, so an older
            // dispatch may land after a newer one. Publish forward only.
            if (serial > (this.latest?.serial ?? -1)) {
              this.latest = {
                serial,
                issued: this.nextSerial,
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
                samplePos: new Float32Array(
                  view.buffer.slice(
                    view.byteOffset + (1 + c + c * k + m + m * 2) * 4,
                    view.byteOffset + (1 + c + c * k + m + m * 2 + c * k * 2) * 4
                  )
                ),
                outsideCount: view[0],
              };
            }
          } finally {
            // Unconditional: a slot left mapped can never be copied into
            // again, so skipping this on the discard path would retire a
            // ring position for the lifetime of the shape.
            slot.staging.unmap();
          }
        })
        .catch(() => {})
        .then(() => {
          // After the unmap, never before it: a mapped buffer is not a legal
          // copy destination, so a slot freed early fails validation.
          if (this.slots === slots) slot.busy = false;
        });
    }

    // `issued` moves every dispatch while the rest of the result does not, so
    // the caller gets it as of THIS call rather than as of the readback. The
    // arrays are shared, not copied; this is seven fields.
    return this.latest && { ...this.latest, issued: this.nextSerial };
  }
}
