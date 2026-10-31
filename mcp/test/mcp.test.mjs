// End-to-end: spawn the built server over stdio with the official SDK client,
// then initialize, list tools and call remove_background.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';

import { FIXTURES, makeTempDir, removeDir } from './helpers.mjs';

const PKG = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let tmp;
let client;
let stderr = '';

before(async () => {
  tmp = await makeTempDir();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: 'bg-remove-test', version: '0.0.0' });
  await client.connect(transport); // performs initialize + initialized
});

after(async () => {
  await client?.close();
  await removeDir(tmp);
});

test('initialize reports the server', () => {
  const info = client.getServerVersion();
  assert.equal(info?.name, 'bg-remove');
  assert.equal(info?.version, PKG.version);
  assert.ok(client.getServerCapabilities()?.tools);
});

test('tools/list exposes remove_background', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['remove_background'],
  );
  const props = Object.keys(tools[0].inputSchema.properties ?? {});
  for (const key of ['input_path', 'input_paths', 'output_path', 'output_dir', 'format', 'overwrite', 'trim']) {
    assert.ok(props.includes(key), `missing input ${key}`);
  }
});

test('tools/call processes a batch and reports per-file errors', async (t) => {
  const outDir = path.join(tmp, 'out');
  const started = Date.now();
  const result = await client.callTool({
    name: 'remove_background',
    arguments: {
      input_paths: [path.join(FIXTURES, 'mug.jpg'), path.join(tmp, 'does-not-exist.png')],
      output_dir: outDir,
      format: 'webp',
    },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.isError, false);
  const { results } = result.structuredContent;
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].output_path, path.join(outDir, 'mug-nobg.webp'));
  assert.equal(results[0].width, 640);
  assert.equal(results[0].height, 853);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /not found/);
  assert.match(result.content[0].text, /1\/2 image\(s\) processed/);

  const meta = await sharp(results[0].output_path).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.hasAlpha, true);
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 853);

  t.diagnostic(`tools/call round trip ${elapsed} ms (model load included), image ${results[0].duration_ms} ms`);
});

test('tools/call with no input is an error result, not a crash', async () => {
  const result = await client.callTool({ name: 'remove_background', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No input image/);
});

test('server logs went to stderr', () => {
  assert.match(stderr, /MCP server ready/);
});

test('stdout carries nothing but JSON-RPC, model load included', async () => {
  // Raw session without the SDK client, so nothing filters stdout for us.
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (err += c.toString()));
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const hasResponse = (id) =>
    out.split('\n').some((l) => {
      try {
        return JSON.parse(l).id === id;
      } catch {
        return false;
      }
    });

  const lastResponse = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for tools/call')), 300_000);
    child.stdout.on('data', () => {
      if (hasResponse(3)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${err}`)));
  });

  send({
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({
    id: 3,
    method: 'tools/call',
    params: {
      name: 'remove_background',
      arguments: { input_path: path.join(FIXTURES, 'dog.jpg'), output_dir: path.join(tmp, 'raw'), overwrite: true },
    },
  });
  try {
    await lastResponse;
  } finally {
    child.kill();
  }

  const lines = out.split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 3, `expected 3 responses, got ${lines.length}`);
  for (const line of lines) {
    let msg;
    assert.doesNotThrow(() => (msg = JSON.parse(line)), `non-JSON line on stdout: ${line.slice(0, 200)}`);
    assert.equal(msg.jsonrpc, '2.0', `not a JSON-RPC message: ${line.slice(0, 200)}`);
  }
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).id).filter((id) => id !== undefined),
    [1, 2, 3],
  );
  // The model's own warnings did happen, on stderr.
  assert.match(err, /Model ready/);
});
