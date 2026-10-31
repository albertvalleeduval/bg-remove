import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// sharp caches open file handles, which keeps temp files locked on Windows.
sharp.cache(false);

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export async function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'bg-remove-mcp-test-'));
}

export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** A flat "logo": coloured shapes and text on a solid white background. */
export async function writeLogo(file) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">
    <rect width="900" height="600" fill="#ffffff"/>
    <circle cx="300" cy="300" r="140" fill="#e63946"/>
    <rect x="470" y="190" width="220" height="220" rx="36" fill="#1d3557"/>
    <text x="450" y="520" font-family="Arial, Helvetica, sans-serif" font-size="72"
          font-weight="bold" fill="#2a9d8f" text-anchor="middle">ACME</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

/**
 * Re-encode a fixture rotated 90 degrees counter-clockwise, with EXIF
 * orientation 6 telling viewers to rotate it back. Displayed size equals the
 * original fixture's size.
 */
export async function writeExifRotated(src, file) {
  await sharp(src).rotate(-90).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toFile(file);
}

/** Decoded size after EXIF orientation, like a browser would display it. */
export async function displaySize(file) {
  const meta = await sharp(file).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  return swap
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

/** Alpha channel of an image as a 1-byte-per-pixel buffer. */
export async function readAlpha(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { alpha: data, width: info.width, height: info.height };
}

/**
 * Share of near-transparent pixels (alpha < 16) in each corner square whose
 * side is 8% of the shorter image side.
 */
export function cornerTransparency({ alpha, width, height }) {
  const side = Math.max(4, Math.round(Math.min(width, height) * 0.08));
  const corners = {
    topLeft: [0, 0],
    topRight: [width - side, 0],
    bottomLeft: [0, height - side],
    bottomRight: [width - side, height - side],
  };
  const out = {};
  for (const [name, [x0, y0]] of Object.entries(corners)) {
    let clear = 0;
    for (let y = y0; y < y0 + side; y++) {
      for (let x = x0; x < x0 + side; x++) {
        if (alpha[y * width + x] < 16) clear++;
      }
    }
    out[name] = clear / (side * side);
  }
  return out;
}

/** Share of pixels that are essentially opaque (alpha > 240). */
export function opaqueShare({ alpha }) {
  let n = 0;
  for (const a of alpha) if (a > 240) n++;
  return n / alpha.length;
}
