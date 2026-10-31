#!/usr/bin/env node
// stdout is the MCP channel: route any stray console output from
// dependencies to stderr before anything else is loaded.
import './stdio-guard.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { processBatch, type FileResult } from './files.js';

const server = new McpServer({ name: 'bg-remove', version: '0.1.0' });

// Tool calls are processed one at a time, even if a client sends several in
// parallel: inference is CPU-heavy and memory scales with image size.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function summarize(results: FileResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const lines = [`${ok}/${results.length} image(s) processed.`];
  for (const r of results) {
    if (r.ok) {
      lines.push(
        `OK ${r.output_path} (${r.width}x${r.height}, ${(r.duration_ms / 1000).toFixed(1)} s)`,
      );
    } else {
      lines.push(`FAILED ${r.input_path}: ${r.error}`);
    }
  }
  return lines.join('\n');
}

server.registerTool(
  'remove_background',
  {
    title: 'Remove background',
    description:
      'Remove the background of local image files (PNG, JPEG, WebP, AVIF, TIFF, GIF) and save transparent PNG or WebP cutouts at the full original resolution. Runs the BRIA RMBG-1.4 model locally on CPU; images never leave the machine. Paths must be absolute. By default each output is written next to its input as <name>-nobg.png. Files are processed sequentially and a failing file does not stop the batch. The first call downloads the model (about 90 MB) once.',
    inputSchema: {
      input_path: z.string().optional().describe('Absolute path of one image.'),
      input_paths: z
        .array(z.string())
        .optional()
        .describe('Absolute paths of several images (batch). Can be combined with input_path.'),
      output_path: z
        .string()
        .optional()
        .describe('Absolute output file path (.png or .webp). Single input only.'),
      output_dir: z
        .string()
        .optional()
        .describe('Absolute directory for outputs, named <name>-nobg.<format>. Created if missing.'),
      format: z
        .enum(['png', 'webp'])
        .optional()
        .describe('Output format. Default png (or inferred from output_path).'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace existing output files. Default false.'),
      trim: z
        .boolean()
        .optional()
        .describe(
          'Crop the output to the visible subject with a small transparent margin. Default false (keeps the original dimensions).',
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const inputs = [
      ...(args.input_path !== undefined ? [args.input_path] : []),
      ...(args.input_paths ?? []),
    ];
    try {
      const results = await enqueue(() =>
        processBatch({
          inputs,
          outputPath: args.output_path,
          outputDir: args.output_dir,
          format: args.format,
          overwrite: args.overwrite ?? false,
          trim: args.trim ?? false,
        }),
      );
      const failed = results.filter((r) => !r.ok).length;
      return {
        content: [{ type: 'text', text: summarize(results) }],
        structuredContent: { results },
        isError: failed === results.length,
      };
    } catch (err) {
      return {
        content: [
          { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[bg-remove] MCP server ready on stdio\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`[bg-remove] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
