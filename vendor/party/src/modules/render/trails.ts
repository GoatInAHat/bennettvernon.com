/**
 * Trails (Render Module)
 *
 * Two compute image passes over the scene texture:
 * - decay: exponential fade toward clear color with alpha decay
 * - diffuse: gaussian-like blur with configurable radius
 * Both read from input texture and write to output, participating in ping-pong.
 */
import {
  Module,
  type WebGPUDescriptor,
  ModuleRole,
  RenderPassKind,
  CPUDescriptor,
  CanvasComposition,
  DataType,
} from "../../module";

export const DEFAULT_TRAILS_TRAIL_DECAY = 10;
export const DEFAULT_TRAILS_TRAIL_DIFFUSE = 0.0;

type TrailsInputs = {
  trailDecay: number;
  trailDiffuse: number;
};

export class Trails extends Module<"trails", TrailsInputs> {
  readonly name = "trails" as const;
  readonly role = ModuleRole.Render;
  readonly inputs = {
    trailDecay: DataType.NUMBER,
    trailDiffuse: DataType.NUMBER,
  } as const;

  /** Rotating strip index for the CPU residue snap (see cpu() setup). */
  private snapStrip = 0;

  constructor(opts?: {
    enabled?: boolean;
    trailDecay?: number;
    trailDiffuse?: number;
  }) {
    super();
    this.write({
      trailDecay: opts?.trailDecay ?? DEFAULT_TRAILS_TRAIL_DECAY,
      trailDiffuse: opts?.trailDiffuse ?? DEFAULT_TRAILS_TRAIL_DIFFUSE,
    });

    if (opts?.enabled !== undefined) {
      this.setEnabled(!!opts.enabled);
    }
  }

  setTrailDecay(value: number): void {
    this.write({ trailDecay: value });
  }

  setTrailDiffuse(value: number): void {
    this.write({ trailDiffuse: value });
  }

  getTrailDecay(): number {
    return this.readValue("trailDecay");
  }
  getTrailDiffuse(): number {
    return this.readValue("trailDiffuse");
  }

  webgpu(): WebGPUDescriptor<TrailsInputs> {
    return {
      passes: [
        {
          kind: RenderPassKind.Compute,
          kernel: ({ getUniform, readScene, writeScene }) => `{
  let coords = vec2<i32>(i32(gid.x), i32(gid.y));
  let current = ${readScene("coords")};
  let d = clamp(${getUniform("trailDecay")} * 0.005, 0.0, 1.0);
  if (d <= 0.00001) { ${writeScene("coords", "current")}; return; }
  let bg = vec3<f32>(${getUniform("clearColorR")}, ${getUniform(
            "clearColorG"
          )}, ${getUniform("clearColorB")});
  // The scene texture is rgba8unorm: a plain exponential fade sticks once
  // per-channel distance-to-background times d rounds below half an LSB
  // (round(V * (1 - d)) == V for V < 0.5 / d), leaving a permanent film up
  // to ~10 LSB at the default decay. Decrementing by at least one LSB per
  // frame guarantees every channel reaches the background exactly.
  let lsb = 1.0 / 255.0;
  let diff = current.rgb - bg;
  let mag = max(abs(diff) - max(abs(diff) * d, vec3<f32>(lsb)), vec3<f32>(0.0));
  let out_rgb = bg + sign(diff) * mag;
  let out_a = max(current.a - max(current.a * d, lsb), 0.0);
  ${writeScene("coords", "vec4<f32>(out_rgb, out_a)")};
}`,
          bindings: ["trailDecay"] as const,
          readsScene: true,
          writesScene: true,
        },
        {
          kind: RenderPassKind.Compute,
          kernel: ({ getUniform, readScene, writeScene }) => `{
  let coords = vec2<i32>(i32(gid.x), i32(gid.y));
  let dims = textureDimensions(input_texture);
  let radius_i = clamp(i32(round(${getUniform("trailDiffuse")})), 0, 12);
  if (radius_i <= 0) { ${writeScene(
    "coords",
    `${readScene("coords")}`
  )}; return; }
  let sigma = max(0.5, f32(radius_i) * 0.5);
  let twoSigma2 = 2.0 * sigma * sigma;
  var sum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var wsum: f32 = 0.0;
  for (var dy = -radius_i; dy <= radius_i; dy++) {
    for (var dx = -radius_i; dx <= radius_i; dx++) {
      let d2 = f32(dx*dx + dy*dy);
      let w = exp(-d2 / twoSigma2);
      if (w < 1e-5) { continue; }
      let sample_coords = coords + vec2<i32>(dx, dy);
      let clamped_coords = clamp(sample_coords, vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1));
      let c = ${readScene("clamped_coords")};
      sum += c * w;
      wsum += w;
    }
  }
  if (wsum > 0.0) {
    ${writeScene("coords", "sum / vec4<f32>(wsum)")};
  } else {
    ${writeScene("coords", `${readScene("coords")}`)};
  }
}`,
          bindings: ["trailDiffuse"] as const,
          readsScene: true,
          writesScene: true,
        },
      ],
    };
  }

  cpu(): CPUDescriptor<TrailsInputs> {
    return {
      composition: CanvasComposition.HandlesBackground,
      setup: ({ context, input, clearColor }) => {
        // Trail effect with decay and blur - match WebGPU behavior
        const canvas = context.canvas;
        const decay = Math.max(0, Math.min(100, input.trailDecay));
        const diffuse = Math.max(
          0,
          Math.min(12, Math.round(input.trailDiffuse))
        );

        // Apply decay (fade effect) - simple overlay approach with factor to match WebGPU speed
        if (decay > 0.00001) {
          const adjustedDecay = Math.min(1.0, decay * 0.005);
          context.save();
          context.globalCompositeOperation = "source-over";
          context.fillStyle = `rgba(${clearColor.r * 255}, ${
            clearColor.g * 255
          }, ${clearColor.b * 255}, ${adjustedDecay})`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.restore();

          // Canvas alpha compositing has the same u8 rounding fixed point as
          // the GPU path (pixels near the background stop fading), which
          // getImageData can fix but is too slow for the full canvas every
          // frame. Snap one rotating horizontal strip per frame instead, so
          // the whole canvas fully reaches the background within ~1s.
          const strips = 48;
          const stripH = Math.ceil(canvas.height / strips);
          const y = (this.snapStrip % strips) * stripH;
          this.snapStrip = (this.snapStrip + 1) % strips;
          const h = Math.min(stripH, canvas.height - y);
          if (h > 0 && canvas.width > 0) {
            const img = context.getImageData(0, y, canvas.width, h);
            const px = img.data;
            const br = Math.round(clearColor.r * 255);
            const bgc = Math.round(clearColor.g * 255);
            const bb = Math.round(clearColor.b * 255);
            const near = Math.max(2, Math.ceil(0.5 / adjustedDecay));
            let touched = false;
            for (let i = 0; i < px.length; i += 4) {
              if (
                Math.abs(px[i] - br) <= near &&
                Math.abs(px[i + 1] - bgc) <= near &&
                Math.abs(px[i + 2] - bb) <= near &&
                (px[i] !== br || px[i + 1] !== bgc || px[i + 2] !== bb)
              ) {
                px[i] = br;
                px[i + 1] = bgc;
                px[i + 2] = bb;
                touched = true;
              }
            }
            if (touched) context.putImageData(img, 0, y);
          }
        }

        // Apply blur effect if diffuse > 0
        if (diffuse > 0) {
          // Use canvas filter for blur - more performant than manual pixel manipulation
          const tempCanvas = document.createElement("canvas");
          const tempCtx = tempCanvas.getContext("2d")!;
          tempCanvas.width = canvas.width;
          tempCanvas.height = canvas.height;

          // Copy current canvas to temp canvas
          tempCtx.drawImage(canvas, 0, 0);

          // Apply blur filter and draw back
          context.filter = `blur(${diffuse * 0.5}px)`;
          context.drawImage(tempCanvas, 0, 0);
          context.filter = "none";
        }
      },
    };
  }
}
