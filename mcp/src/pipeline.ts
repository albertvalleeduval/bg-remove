/**
 * Node port of the web app's background-removal pipeline
 * (src/lib/bgRemover.worker.ts + src/lib/canvas.ts).
 *
 *   1. Decode the source at native resolution (EXIF orientation applied).
 *   2. Feed it to RMBG-1.4 through the same processor config as the worker
 *      (resize to 1024x1024, rescale 1/255, mean 0.5, std 1).
 *   3. Read the soft mask, clamp to [0, 1] and quantize to 8-bit alpha.
 *   4. Upscale the mask to the source size with a high-quality cubic kernel.
 *   5. Use it as the alpha channel of the untouched original pixels
 *      (the equivalent of canvas `destination-in`).
 *   6. Encode as PNG or WebP (quality 95) at the original dimensions.
 *
 * Everything runs locally. The only network access is the one-time model
 * download from the Hugging Face Hub, handled by transformers.js.
 */
import {
  AutoModel,
  AutoProcessor,
  env,
  RawImage,
  type PreTrainedModel,
  type Processor,
  type Tensor,
} from '@huggingface/transformers';
import sharp, { type Metadata } from 'sharp';

export const MODEL_ID = 'briaai/RMBG-1.4';
const MODEL_SIZE = 1024;

export type OutputFormat = 'png' | 'webp';

export interface RemoveOptions {
  format: OutputFormat;
  /** Crop to the opaque bounding box (plus a small padding). */
  trim: boolean;
}

export interface RemoveResult {
  data: Buffer;
  /** Dimensions of the encoded output. */
  width: number;
  height: number;
  /** Dimensions of the (orientation-corrected) source image. */
  sourceWidth: number;
  sourceHeight: number;
}

// Same as the worker: only fetch the model from the Hub, never from a local
// "models" folder relative to the cwd.
env.allowLocalModels = false;
const cacheDirOverride = process.env.BG_REMOVE_CACHE_DIR;
if (cacheDirOverride && cacheDirOverride.trim() !== '') {
  env.cacheDir = cacheDirOverride;
}

export function modelCacheDir(): string {
  return String(env.cacheDir ?? '');
}

function log(message: string): void {
  process.stderr.write(`[bg-remove] ${message}\n`);
}

interface LoadedModel {
  model: PreTrainedModel;
  processor: Processor;
}

let modelPromise: Promise<LoadedModel> | null = null;

function makeProgressLogger(): (data: {
  status: string;
  file?: string;
  progress?: number;
}) => void {
  // transformers.js reports the same progress events for a cache read as for
  // a network download and does not say which one it is. A cache read is
  // over in well under a second, so only start logging for a file once it has
  // been loading for longer than that.
  const QUIET_MS = 1000;
  const startedAt = new Map<string, number>();
  const lastLogged = new Map<string, number>();
  return (data) => {
    const file = data.file ?? 'file';
    if (data.status === 'initiate' || data.status === 'download') {
      if (!startedAt.has(file)) startedAt.set(file, Date.now());
    } else if (data.status === 'progress' && typeof data.progress === 'number') {
      const since = startedAt.get(file) ?? Date.now();
      if (!startedAt.has(file)) startedAt.set(file, since);
      if (Date.now() - since < QUIET_MS) return;
      // Log every 10% per file to keep stderr readable.
      const step = Math.floor(data.progress / 10) * 10;
      if ((lastLogged.get(file) ?? -1) < step) {
        lastLogged.set(file, step);
        log(`Downloading ${file}: ${step}%`);
      }
    } else if (data.status === 'done') {
      if (lastLogged.has(file)) log(`Downloaded ${file}`);
    }
  };
}

async function loadModel(): Promise<LoadedModel> {
  const started = Date.now();
  log(`Loading ${MODEL_ID} (fp16, CPU). Cache: ${modelCacheDir()}`);
  const progress_callback = makeProgressLogger();

  // Identical options to the web worker, except the device: onnxruntime-node
  // on CPU instead of WebGPU/WASM.
  const modelOptions = {
    config: { model_type: 'custom' },
    device: 'cpu',
    dtype: 'fp16',
    progress_callback,
  } as unknown as Parameters<typeof AutoModel.from_pretrained>[1];
  const model = await AutoModel.from_pretrained(MODEL_ID, modelOptions);

  const processorOptions = {
    config: {
      do_normalize: true,
      do_pad: false,
      do_rescale: true,
      do_resize: true,
      image_mean: [0.5, 0.5, 0.5],
      image_std: [1, 1, 1],
      resample: 2,
      rescale_factor: 1 / 255,
      size: { width: MODEL_SIZE, height: MODEL_SIZE },
      feature_extractor_type: 'ImageFeatureExtractor',
    },
    progress_callback,
  } as unknown as Parameters<typeof AutoProcessor.from_pretrained>[1];
  const processor = await AutoProcessor.from_pretrained(
    MODEL_ID,
    processorOptions,
  );

  log(`Model ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return { model, processor };
}

/** Load the model once and keep it in memory for the life of the process. */
export function getModel(): Promise<LoadedModel> {
  if (!modelPromise) {
    modelPromise = loadModel().catch((err: unknown) => {
      // Allow a retry on the next call (e.g. after a network hiccup).
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

// sharp reports AVIF as the "heif" container with AV1 compression. HEIC
// (HEVC compression) is not decodable by sharp's prebuilt binaries, so only
// the AV1 flavour is accepted.
const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp', 'tiff', 'gif']);

export interface DecodedImage {
  rgba: Buffer;
  width: number;
  height: number;
}

export async function decode(input: Buffer): Promise<DecodedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new Error('Not a readable image (unsupported or corrupt file)');
  }
  const isAvif = meta.format === 'heif' && meta.compression === 'av1';
  if (!isAvif && !(meta.format && SUPPORTED_FORMATS.has(meta.format))) {
    const label = meta.format === 'heif' ? 'heic' : (meta.format ?? 'unknown');
    throw new Error(
      `Unsupported input format "${label}" (expected png, jpg, webp, avif, tiff or gif)`,
    );
  }
  // rotate() with no argument applies the EXIF orientation, like
  // createImageBitmap's default imageOrientation: 'from-image'. An embedded
  // ICC profile (Display P3, Adobe RGB, ...) is converted to sRGB, like its
  // default colorSpaceConversion. Output is 8-bit sRGB RGBA, which is what a
  // 2D canvas holds. Do not add keepIccProfile() or pipelineColourspace()
  // here: both skip that conversion and return the file's raw values.
  const { data, info } = await sharp(input, { failOn: 'error' })
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`Unexpected channel count after decode: ${info.channels}`);
  }
  return { rgba: data, width: info.width, height: info.height };
}

/**
 * Build the model input the way the worker does: a canvas-backed RGBA image
 * (`RawImage.fromCanvas`) that the processor converts to RGB. A canvas stores
 * premultiplied colour, so fully transparent pixels read back as black; mirror
 * that so transparent inputs are seen identically.
 */
function toRawImage(img: DecodedImage): RawImage {
  const { rgba, width, height } = img;
  const pixels = width * height;
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const j = i * 4;
    const a = rgba[j + 3] ?? 0;
    if (a === 0) continue; // stays 0,0,0,0
    data[j] = rgba[j] ?? 0;
    data[j + 1] = rgba[j + 1] ?? 0;
    data[j + 2] = rgba[j + 2] ?? 0;
    data[j + 3] = a;
  }
  return new RawImage(data, width, height, 4);
}

function pickMaskTensor(outputs: Record<string, Tensor>): Tensor {
  // Same lookup as the worker: "output", else the first tensor.
  let mask: Tensor | undefined = outputs.output;
  if (!mask) {
    for (const v of Object.values(outputs)) {
      if (v && (v as Tensor).dims) {
        mask = v;
        break;
      }
    }
  }
  if (!mask) throw new Error('Model produced no output tensor');
  return mask;
}

/** Tensor [1,1,H,W] / [1,H,W] / [H,W] of 0..1 probabilities -> 8-bit mask. */
function tensorToMask(maskTensor: Tensor): { data: Buffer; width: number; height: number } {
  let dims = maskTensor.dims;
  if (dims.length === 4 && dims[0] === 1) dims = dims.slice(1);
  let height: number;
  let width: number;
  if (dims.length === 3) {
    height = dims[1] ?? 0;
    width = dims[2] ?? 0;
  } else if (dims.length === 2) {
    height = dims[0] ?? 0;
    width = dims[1] ?? 0;
  } else {
    throw new Error(`Unexpected mask shape: [${maskTensor.dims.join(', ')}]`);
  }
  if (width === 0 || height === 0) throw new Error('Mask has zero dimension');

  const values = maskTensor.data as ArrayLike<number>;
  const pixels = width * height;
  const out = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i++) {
    const v = Number(values[i] ?? 0);
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    out[i] = Math.round(clamped * 255);
  }
  return { data: out, width, height };
}

/**
 * Upscale the mask to the source size. The browser draws it with
 * imageSmoothingQuality = 'high', whose filter is left to each browser;
 * sharp's 'mitchell' kernel is a comparable cubic filter.
 */
async function resizeMask(
  mask: { data: Buffer; width: number; height: number },
  width: number,
  height: number,
): Promise<Buffer> {
  if (mask.width === width && mask.height === height) return mask.data;
  const { data, info } = await sharp(mask.data, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .resize(width, height, { fit: 'fill', kernel: 'mitchell' })
    // sharp widens a 1-channel raw input to sRGB on output; keep one channel.
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || info.width !== width || info.height !== height) {
    throw new Error('Mask resize produced an unexpected buffer');
  }
  return data;
}

/**
 * destination-in: keep the original colours, alpha = source alpha x mask.
 * Writes into `rgba` to avoid a second full-size copy (48 MB at 12 MP).
 */
function applyMaskInPlace(rgba: Buffer, mask: Buffer): void {
  const pixels = mask.length;
  for (let i = 0; i < pixels; i++) {
    const j = i * 4 + 3;
    const a = rgba[j] ?? 0;
    const m = mask[i] ?? 0;
    rgba[j] = a === 255 ? m : Math.round((a * m) / 255);
  }
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Alpha at or above this counts as "opaque" for trimming (about 5%). */
const TRIM_ALPHA_THRESHOLD = 13;

/**
 * Bounding box of the visible subject, grown by a small padding (1% of the
 * longer side of the box, at least 2 px) and clamped to the image.
 * Returns null when nothing is visible.
 */
export function opaqueBoundingBox(
  rgba: Buffer,
  width: number,
  height: number,
): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if ((rgba[row + x * 4 + 3] ?? 0) >= TRIM_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = Math.max(2, Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 0.01));
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Run the full pipeline on an encoded image buffer. */
export async function removeBackground(
  input: Buffer,
  options: RemoveOptions,
): Promise<RemoveResult> {
  const decoded = await decode(input);
  const { width, height } = decoded;
  const { model, processor } = await getModel();

  const { pixel_values } = (await processor(toRawImage(decoded))) as {
    pixel_values: Tensor;
  };
  const outputs = (await model({ input: pixel_values })) as Record<string, Tensor>;
  const mask = tensorToMask(pickMaskTensor(outputs));
  const fullMask = await resizeMask(mask, width, height);
  // Safe to overwrite: the decoded buffer is ours alone, and the model input
  // was built from a separate copy (toRawImage) that is no longer needed.
  const rgba = decoded.rgba;
  applyMaskInPlace(rgba, fullMask);

  let pipeline = sharp(rgba, { raw: { width, height, channels: 4 } });
  let outWidth = width;
  let outHeight = height;
  if (options.trim) {
    const box = opaqueBoundingBox(rgba, width, height);
    if (box && (box.width !== width || box.height !== height)) {
      pipeline = pipeline.extract(box);
      outWidth = box.width;
      outHeight = box.height;
    }
  }

  const data =
    options.format === 'webp'
      ? await pipeline.webp({ quality: 95 }).toBuffer()
      : await pipeline.png().toBuffer();

  return {
    data,
    width: outWidth,
    height: outHeight,
    sourceWidth: width,
    sourceHeight: height,
  };
}
