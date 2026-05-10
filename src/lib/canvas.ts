/**
 * Canvas utilities for resolution-preserving background removal.
 *
 * The segmentation model runs at a fixed 1024×1024 input and emits a mask at
 * the same resolution. To avoid destroying the original image's resolution
 * we:
 *
 *   1. Keep the source image at its true size.
 *   2. Build a mask canvas at the model's output resolution.
 *   3. Upscale the mask to the source's resolution with high-quality
 *      bilinear/bicubic resampling (browser-native, via imageSmoothingQuality
 *      = 'high').
 *   4. Composite original ⊗ upscaled-mask using `destination-in`, so the mask
 *      acts as the alpha channel of the original.
 *
 * The heavy version of this lives inside the worker (see bgRemover.worker.ts)
 * using OffscreenCanvas. The helpers here are exported so the same logic can
 * be used or tested from the main thread if needed.
 */

/** Decode a File / Blob to an ImageBitmap at native resolution. */
export async function blobToBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/**
 * Apply a low-res alpha mask to a full-resolution bitmap.
 *
 * Both inputs may differ in resolution: `maskCanvas` is upscaled to the
 * bitmap's dimensions with high-quality smoothing before being used as the
 * alpha source. The returned canvas has the same dimensions as the bitmap.
 */
export function applyMaskToBitmap(
  bitmap: ImageBitmap | HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
): HTMLCanvasElement {
  const width = bitmap.width;
  const height = bitmap.height;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);

  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskCanvas as CanvasImageSource, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  return out;
}

/** Encode a canvas to a Blob in the requested format. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'png' | 'webp',
  quality = 0.95,
): Promise<Blob> {
  const mime = format === 'webp' ? 'image/webp' : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      mime,
      format === 'webp' ? quality : undefined,
    );
  });
}
