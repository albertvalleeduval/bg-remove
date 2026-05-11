/// <reference lib="webworker" />
import {
  AutoModel,
  AutoProcessor,
  env,
  RawImage,
  type PreTrainedModel,
  type Processor,
  type Tensor,
} from '@huggingface/transformers';

import type { WorkerRequest, WorkerResponse, OutputFormat } from './types';

// Transformers.js: don't try local models, only remote.
env.allowLocalModels = false;
// Default WASM backend bundled by transformers.js is fine; cache it via the HTTP cache.

const MODEL_ID = 'briaai/RMBG-1.4';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function send(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

let modelPromise: Promise<{
  model: PreTrainedModel;
  processor: Processor;
  device: 'webgpu' | 'wasm';
}> | null = null;

async function detectWebGPU(): Promise<boolean> {
  type WithGPU = { gpu?: { requestAdapter: () => Promise<unknown | null> } };
  const nav = (ctx.navigator as unknown) as WithGPU;
  if (!nav.gpu) return false;
  try {
    const adapter = await nav.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

async function loadModel(): Promise<{
  model: PreTrainedModel;
  processor: Processor;
  device: 'webgpu' | 'wasm';
}> {
  const useWebGPU = await detectWebGPU();
  const device: 'webgpu' | 'wasm' = useWebGPU ? 'webgpu' : 'wasm';

  send({
    type: 'init:progress',
    message: `Loading model (${device.toUpperCase()})…`,
  });

  const progressCallback = (data: {
    status: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
  }): void => {
    if (data.status === 'progress' && typeof data.progress === 'number') {
      send({
        type: 'init:progress',
        message: `Downloading ${data.file ?? 'model'}…`,
        ratio: data.progress / 100,
      });
    } else if (data.status === 'done') {
      send({
        type: 'init:progress',
        message: `Loaded ${data.file ?? 'file'}.`,
      });
    } else if (data.status === 'ready') {
      send({ type: 'init:progress', message: 'Initializing runtime…' });
    }
  };

  // RMBG-1.4 is a custom architecture; transformers.js loads it as a generic
  // model when we declare model_type: 'custom'. The library's typed options
  // object doesn't expose this knob directly, so we widen via `unknown`.
  // fp16 cuts the download from ~176 MB to ~88 MB with no visible quality
  // difference on a segmentation mask that gets quantized to 8-bit alpha anyway.
  const modelOptions = {
    config: { model_type: 'custom' },
    device,
    dtype: 'fp16',
    progress_callback: progressCallback,
  } as unknown as Parameters<typeof AutoModel.from_pretrained>[1];
  const model = await AutoModel.from_pretrained(MODEL_ID, modelOptions);

  // Same story for the processor: spell out the preprocessing the RMBG model
  // expects (repo's preprocessor_config is minimal).
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
      size: { width: 1024, height: 1024 },
      feature_extractor_type: 'ImageFeatureExtractor',
    },
    progress_callback: progressCallback,
  } as unknown as Parameters<typeof AutoProcessor.from_pretrained>[1];
  const processor = await AutoProcessor.from_pretrained(
    MODEL_ID,
    processorOptions,
  );

  return { model, processor, device };
}

function getModel(): Promise<{
  model: PreTrainedModel;
  processor: Processor;
  device: 'webgpu' | 'wasm';
}> {
  if (!modelPromise) modelPromise = loadModel();
  return modelPromise;
}

function tensorToMaskCanvas(maskTensor: Tensor): OffscreenCanvas {
  // Expect shape [1, H, W] or [H, W]; values are 0..1 alpha probabilities.
  const dims = maskTensor.dims;
  let height: number;
  let width: number;
  if (dims.length === 3) {
    height = dims[1] ?? 0;
    width = dims[2] ?? 0;
  } else if (dims.length === 2) {
    height = dims[0] ?? 0;
    width = dims[1] ?? 0;
  } else {
    throw new Error(`Unexpected mask shape: [${dims.join(', ')}]`);
  }
  if (width === 0 || height === 0) {
    throw new Error('Mask has zero dimension');
  }

  const data = maskTensor.data as Float32Array;
  const pixels = width * height;
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const v = data[i] ?? 0;
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    const a = Math.round(clamped * 255);
    const j = i * 4;
    // RGB doesn't matter for destination-in, but keep them white for any debug peek.
    rgba[j] = 255;
    rgba[j + 1] = 255;
    rgba[j + 2] = 255;
    rgba[j + 3] = a;
  }
  const imageData = new ImageData(rgba, width, height);
  const canvas = new OffscreenCanvas(width, height);
  const c2d = canvas.getContext('2d');
  if (!c2d) throw new Error('OffscreenCanvas 2D context unavailable');
  c2d.putImageData(imageData, 0, 0);
  return canvas;
}

function composite(
  bitmap: ImageBitmap,
  maskCanvas: OffscreenCanvas,
): OffscreenCanvas {
  const width = bitmap.width;
  const height = bitmap.height;
  const out = new OffscreenCanvas(width, height);
  const ctx2d = out.getContext('2d');
  if (!ctx2d) throw new Error('OffscreenCanvas 2D context unavailable');

  // 1) draw original at full resolution
  ctx2d.drawImage(bitmap, 0, 0, width, height);

  // 2) keep only pixels where the upscaled mask has alpha
  ctx2d.globalCompositeOperation = 'destination-in';
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.imageSmoothingQuality = 'high';
  ctx2d.drawImage(maskCanvas, 0, 0, width, height);
  ctx2d.globalCompositeOperation = 'source-over';

  return out;
}

async function encode(
  canvas: OffscreenCanvas,
  format: OutputFormat,
): Promise<Blob> {
  if (format === 'webp') {
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.95 });
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

async function processImage(
  id: string,
  bitmap: ImageBitmap,
  format: OutputFormat,
): Promise<void> {
  try {
    send({ type: 'process:progress', id, stage: 'Preparing…' });
    const { model, processor } = await getModel();

    // RawImage.fromCanvas accepts OffscreenCanvas in transformers.js v3.
    // Draw bitmap on an OffscreenCanvas to feed the processor (which will resize to 1024).
    const srcCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) throw new Error('OffscreenCanvas 2D context unavailable');
    srcCtx.drawImage(bitmap, 0, 0);
    const rawImage = await RawImage.fromCanvas(srcCanvas);

    send({ type: 'process:progress', id, stage: 'Running model…' });
    const { pixel_values } = await processor(rawImage);
    const outputs = (await model({ input: pixel_values })) as Record<
      string,
      Tensor
    >;

    // RMBG-1.4 returns the mask as a single output tensor. The key has historically
    // been "output"; fall back to the first tensor in case the runtime renames it.
    let maskTensor: Tensor | undefined = outputs.output;
    if (!maskTensor) {
      for (const v of Object.values(outputs)) {
        if (v && (v as Tensor).dims) {
          maskTensor = v as Tensor;
          break;
        }
      }
    }
    if (!maskTensor) throw new Error('Model produced no output tensor');

    // Squeeze leading batch dim if present (e.g. [1,1,1024,1024] -> [1,1024,1024]).
    let squeezed: Tensor = maskTensor;
    if (squeezed.dims.length === 4 && squeezed.dims[0] === 1) {
      const t = squeezed as unknown as { squeeze: (dim: number) => Tensor };
      squeezed = t.squeeze(0);
    }

    send({ type: 'process:progress', id, stage: 'Composing output…' });
    const maskCanvas = tensorToMaskCanvas(squeezed);
    const outCanvas = composite(bitmap, maskCanvas);
    const blob = await encode(outCanvas, format);

    send({
      type: 'process:done',
      id,
      blob,
      width: bitmap.width,
      height: bitmap.height,
    });
  } catch (err) {
    send({
      type: 'process:error',
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    bitmap.close();
  }
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    getModel().then(
      ({ device }) => send({ type: 'init:ready', device }),
      (err: unknown) =>
        send({
          type: 'init:error',
          error: err instanceof Error ? err.message : String(err),
        }),
    );
    return;
  }
  if (msg.type === 'process') {
    void processImage(msg.id, msg.bitmap, msg.format);
  }
});
