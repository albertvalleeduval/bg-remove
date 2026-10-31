import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { removeBackground, type OutputFormat } from './pipeline.js';

export interface BatchRequest {
  inputs: string[];
  outputPath?: string | undefined;
  outputDir?: string | undefined;
  format?: OutputFormat | undefined;
  overwrite: boolean;
  trim: boolean;
}

export type FileResult =
  | {
      ok: true;
      input_path: string;
      output_path: string;
      width: number;
      height: number;
      source_width: number;
      source_height: number;
      duration_ms: number;
    }
  | {
      ok: false;
      input_path: string;
      error: string;
      duration_ms: number;
    };

/**
 * Normalize a user-supplied absolute path. Accepts native paths on every
 * platform, plus on Windows the MSYS / Git Bash form (/c/path/...) and
 * forward slashes. Relative paths are rejected: the server's cwd is not
 * something the caller controls.
 */
export function normalizeAbsolutePath(raw: string, label: string): string {
  let p = raw.trim();
  if (
    p.length >= 2 &&
    ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
  ) {
    p = p.slice(1, -1);
  }
  if (p === '') throw new Error(`${label} is empty`);
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
    if (msys) p = `${msys[1]!.toUpperCase()}:\\${msys[3] ?? ''}`;
    // A bare "/foo" on Windows is drive-relative, not absolute.
    if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('\\\\')) {
      throw new Error(`${label} must be an absolute path (got "${raw}")`);
    }
  } else if (!path.isAbsolute(p)) {
    throw new Error(`${label} must be an absolute path (got "${raw}")`);
  }
  return path.resolve(p);
}

function formatFromExtension(file: string): OutputFormat | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface Planned {
  input: string;
  output: string;
  format: OutputFormat;
  /** Output name derived from the input (no explicit output_path). */
  derived: boolean;
}

type PlanOrError = Planned | { input: string; error: string };

function plan(rawInput: string, req: BatchRequest): Planned {
  const input = normalizeAbsolutePath(rawInput, 'input path');
  let format: OutputFormat = req.format ?? 'png';
  let output: string;
  let derived = false;

  if (req.outputPath !== undefined) {
    output = normalizeAbsolutePath(req.outputPath, 'output_path');
    const extFormat = formatFromExtension(output);
    if (!extFormat) {
      throw new Error('output_path must end in .png or .webp');
    }
    if (req.format && req.format !== extFormat) {
      throw new Error(
        `format "${req.format}" does not match the output_path extension (${path.extname(output)})`,
      );
    }
    format = extFormat;
  } else {
    const dir = req.outputDir
      ? normalizeAbsolutePath(req.outputDir, 'output_dir')
      : path.dirname(input);
    const name = path.basename(input, path.extname(input));
    output = path.join(dir, `${name}-nobg.${format}`);
    derived = true;
  }

  if (samePath(input, output)) {
    throw new Error('Output path would overwrite the input image');
  }
  return { input, output, format, derived };
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Plan every output before processing anything, so that two inputs with the
 * same base name (a/x.jpg and b/x.jpg into one output_dir) never write to the
 * same file: later ones get a numeric suffix, x-nobg-2.png, x-nobg-3.png, ...
 */
function planBatch(req: BatchRequest): PlanOrError[] {
  const used = new Set<string>();
  return req.inputs.map((rawInput) => {
    let job: Planned;
    try {
      job = plan(rawInput, req);
    } catch (err) {
      return { input: rawInput, error: err instanceof Error ? err.message : String(err) };
    }
    if (job.derived && used.has(pathKey(job.output))) {
      const ext = path.extname(job.output);
      const stem = job.output.slice(0, -ext.length);
      let n = 2;
      while (used.has(pathKey(`${stem}-${n}${ext}`))) n++;
      job.output = `${stem}-${n}${ext}`;
    }
    used.add(pathKey(job.output));
    return job;
  });
}

async function processOne(planned: PlanOrError, req: BatchRequest): Promise<FileResult> {
  const started = Date.now();
  const inputLabel = planned.input;
  try {
    if ('error' in planned) throw new Error(planned.error);
    const job = planned;

    let source: Buffer;
    try {
      source = await readFile(job.input);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? 'Input file not found'
          : code === 'EISDIR'
            ? 'Input path is a directory'
            : `Cannot read input file (${code ?? String(err)})`,
      );
    }

    if (!req.overwrite && (await exists(job.output))) {
      throw new Error(
        `Output already exists: ${job.output} (pass overwrite: true to replace it)`,
      );
    }

    const result = await removeBackground(source, { format: job.format, trim: req.trim });
    await mkdir(path.dirname(job.output), { recursive: true });
    await writeFile(job.output, result.data);

    return {
      ok: true,
      input_path: job.input,
      output_path: job.output,
      width: result.width,
      height: result.height,
      source_width: result.sourceWidth,
      source_height: result.sourceHeight,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      input_path: inputLabel,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    };
  }
}

/** Process every input sequentially; one failure never stops the batch. */
export async function processBatch(req: BatchRequest): Promise<FileResult[]> {
  if (req.inputs.length === 0) throw new Error('No input image given');
  if (req.outputPath !== undefined && req.inputs.length > 1) {
    throw new Error('output_path only works with a single input; use output_dir for batches');
  }
  if (req.outputPath !== undefined && req.outputDir !== undefined) {
    throw new Error('Pass either output_path or output_dir, not both');
  }
  const results: FileResult[] = [];
  for (const planned of planBatch(req)) {
    results.push(await processOne(planned, req));
  }
  return results;
}
