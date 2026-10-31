// Runs the real pipeline (model included) on sample images and checks the
// properties the web app guarantees: same dimensions, an alpha channel, a
// transparent background and an opaque subject. Requires `npm run build`.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import sharp from 'sharp';

import { normalizeAbsolutePath, processBatch } from '../dist/files.js';
import { getModel } from '../dist/pipeline.js';
import {
  FIXTURES,
  cornerTransparency,
  displaySize,
  makeTempDir,
  opaqueShare,
  readAlpha,
  removeDir,
  writeExifRotated,
  writeLogo,
} from './helpers.mjs';

let tmp;
const inputs = {};

before(async () => {
  tmp = await makeTempDir();
  inputs.mug = path.join(FIXTURES, 'mug.jpg');
  inputs.dog = path.join(FIXTURES, 'dog.jpg');
  inputs.logo = path.join(tmp, 'logo.png');
  inputs.rotated = path.join(tmp, 'mug-exif6.jpg');
  await writeLogo(inputs.logo);
  await writeExifRotated(inputs.mug, inputs.rotated);
  // Load (and on first run download) the model outside the timed cases.
  await getModel();
});

after(async () => {
  await removeDir(tmp);
});

async function run(input, extra = {}) {
  const [result] = await processBatch({
    inputs: [input],
    outputDir: path.join(tmp, 'out'),
    overwrite: true,
    trim: false,
    ...extra,
  });
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result;
}

describe('pipeline', () => {
  for (const name of ['mug', 'dog', 'logo']) {
    test(`${name}: full resolution, alpha, transparent corners, opaque subject`, async (t) => {
      const input = inputs[name];
      const expected = await displaySize(input);
      const result = await run(input);

      const meta = await sharp(result.output_path).metadata();
      assert.equal(meta.format, 'png');
      assert.equal(meta.hasAlpha, true);
      assert.equal(meta.width, expected.width);
      assert.equal(meta.height, expected.height);
      assert.equal(result.width, expected.width);
      assert.equal(result.height, expected.height);

      const alpha = await readAlpha(result.output_path);
      const corners = cornerTransparency(alpha);
      for (const [corner, share] of Object.entries(corners)) {
        assert.ok(share >= 0.95, `${corner} corner only ${(share * 100).toFixed(1)}% transparent`);
      }
      const opaque = opaqueShare(alpha);
      assert.ok(opaque > 0.01 && opaque < 0.9, `opaque share ${opaque}`);

      t.diagnostic(
        `${name}: ${meta.width}x${meta.height}, ${result.duration_ms} ms, ` +
          `opaque ${(opaque * 100).toFixed(1)}%, corners ${Object.values(corners)
            .map((c) => `${(c * 100).toFixed(0)}%`)
            .join('/')}`,
      );
    });
  }

  test('EXIF orientation is applied (same cutout as the upright image)', async (t) => {
    const upright = await run(inputs.mug);
    const rotated = await run(inputs.rotated);
    assert.equal(rotated.width, upright.width);
    assert.equal(rotated.height, upright.height);

    const a = await readAlpha(upright.output_path);
    const b = await readAlpha(rotated.output_path);
    let diff = 0;
    for (let i = 0; i < a.alpha.length; i++) diff += Math.abs(a.alpha[i] - b.alpha[i]);
    const meanDiff = diff / a.alpha.length;
    // JPEG re-encoding changes pixels slightly; a wrong orientation would
    // give a mean difference in the tens.
    assert.ok(meanDiff < 4, `mean alpha difference ${meanDiff}`);
    t.diagnostic(`mean alpha difference upright vs EXIF-rotated: ${meanDiff.toFixed(2)}`);
  });

  test('webp output keeps alpha and size', async () => {
    const result = await run(inputs.dog, { format: 'webp' });
    assert.match(result.output_path, /dog-nobg\.webp$/);
    const meta = await sharp(result.output_path).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.hasAlpha, true);
    assert.equal(meta.width, 640);
    assert.equal(meta.height, 480);
  });

  test('trim crops to the subject with a small margin', async (t) => {
    const result = await run(inputs.logo, {
      outputPath: path.join(tmp, 'out', 'logo-trimmed.png'),
      outputDir: undefined,
      trim: true,
    });
    assert.equal(result.source_width, 900);
    assert.equal(result.source_height, 600);
    assert.ok(result.width < 900 && result.height < 600, `${result.width}x${result.height}`);
    const meta = await sharp(result.output_path).metadata();
    assert.equal(meta.width, result.width);
    assert.equal(meta.height, result.height);
    t.diagnostic(`logo trimmed from 900x600 to ${result.width}x${result.height}`);
  });
});

describe('file handling', () => {
  test('default output goes next to the input as <name>-nobg.png', async () => {
    const dir = path.join(tmp, 'side');
    const input = path.join(dir, 'photo.jpg');
    await mkdir(dir, { recursive: true });
    await copyFile(inputs.mug, input);

    const [first] = await processBatch({ inputs: [input], overwrite: false, trim: false });
    assert.ok(first.ok);
    assert.equal(first.output_path, path.join(dir, 'photo-nobg.png'));

    const [second] = await processBatch({ inputs: [input], overwrite: false, trim: false });
    assert.equal(second.ok, false);
    assert.match(second.error, /already exists/);
  });

  test('a bad file does not stop the batch', async () => {
    const notAnImage = path.join(tmp, 'notes.png');
    await writeFile(notAnImage, 'hello');
    const results = await processBatch({
      inputs: [path.join(tmp, 'missing.jpg'), notAnImage, 'relative/path.jpg', inputs.dog],
      outputDir: path.join(tmp, 'batch'),
      overwrite: true,
      trim: false,
    });
    assert.deepEqual(
      results.map((r) => r.ok),
      [false, false, false, true],
    );
    assert.match(results[0].error, /not found/);
    assert.match(results[1].error, /Not a readable image/);
    assert.match(results[2].error, /absolute path/);
    const written = await readFile(results[3].output_path);
    assert.ok(written.length > 0);
  });

  test('same-named inputs in one output_dir get distinct outputs', async () => {
    const a = path.join(tmp, 'dupes', 'a', 'x.jpg');
    const b = path.join(tmp, 'dupes', 'b', 'x.jpg');
    await mkdir(path.dirname(a), { recursive: true });
    await mkdir(path.dirname(b), { recursive: true });
    await copyFile(inputs.mug, a);
    await copyFile(inputs.dog, b);
    const outDir = path.join(tmp, 'dupes', 'out');

    for (const overwrite of [true, false]) {
      await rm(outDir, { recursive: true, force: true });
      const results = await processBatch({ inputs: [a, b], outputDir: outDir, overwrite, trim: false });
      assert.deepEqual(
        results.map((r) => r.ok),
        [true, true],
      );
      assert.equal(results[0].output_path, path.join(outDir, 'x-nobg.png'));
      assert.equal(results[1].output_path, path.join(outDir, 'x-nobg-2.png'));
      const sizes = await Promise.all(results.map((r) => sharp(r.output_path).metadata()));
      assert.deepEqual(
        sizes.map((m) => `${m.width}x${m.height}`),
        ['640x853', '640x480'],
      );
    }
  });

  test('invalid output options are rejected', async () => {
    const [jpg] = await processBatch({
      inputs: [inputs.dog],
      outputPath: path.join(tmp, 'x.jpg'),
      overwrite: true,
      trim: false,
    });
    assert.equal(jpg.ok, false);
    assert.match(jpg.error, /\.png or \.webp/);

    await assert.rejects(
      processBatch({
        inputs: [inputs.dog, inputs.mug],
        outputPath: path.join(tmp, 'x.png'),
        overwrite: true,
        trim: false,
      }),
      /single input/,
    );
  });

  test('path normalization', () => {
    if (process.platform === 'win32') {
      assert.equal(normalizeAbsolutePath('C:/a/b.png', 'p'), 'C:\\a\\b.png');
      assert.equal(normalizeAbsolutePath('/c/a/b.png', 'p'), 'C:\\a\\b.png');
      assert.equal(normalizeAbsolutePath('"D:\\x y\\z.jpg"', 'p'), 'D:\\x y\\z.jpg');
      assert.throws(() => normalizeAbsolutePath('\\a\\b.png', 'p'), /absolute/);
    } else {
      assert.equal(normalizeAbsolutePath('/a/./b.png', 'p'), '/a/b.png');
    }
    assert.throws(() => normalizeAbsolutePath('a/b.png', 'p'), /absolute/);
  });
});
