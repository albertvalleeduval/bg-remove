# bg-remove MCP server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Code (or Claude Desktop, or any MCP client) a `remove_background` tool working directly on files on your disk. It runs the same pipeline as the bg-remove web app: **BRIA RMBG-1.4**, inference at 1024×1024, a soft alpha mask upscaled to the original size and applied as the alpha channel of the untouched original. A 4000×3000 photo comes back as a 4000×3000 cutout.

Everything runs on your machine, on the CPU. Images are never uploaded anywhere and there is no telemetry. The only network access is the one-time model download from the Hugging Face Hub.

## Requirements

- Node.js 20 or later
- About 90 MB of disk for the model (fp16 ONNX weights), downloaded on first use

## Install and build

```bash
cd <path-to-repo>/mcp
npm install
npm run build      # compiles to mcp/dist/
npm test           # optional: runs the pipeline on sample images + an end-to-end MCP session
```

This folder is a separate package with its own `package.json` and lockfile. It does not affect the web app's dependencies or build, and it is excluded from Vercel deployments (`.vercelignore`).

## Register the server

### Claude Code

```bash
claude mcp add --scope user bg-remove -- node "<path-to-repo>/mcp/dist/index.js"
claude mcp list    # should show bg-remove as connected
```

`--scope user` makes the tool available in every project. Use `--scope project` to share it through a `.mcp.json` in one repository instead.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "bg-remove": {
      "command": "node",
      "args": ["<path-to-repo>/mcp/dist/index.js"]
    }
  }
}
```

On Windows, write the path with forward slashes or escaped backslashes (`C:\\path\\to\\repo\\mcp\\dist\\index.js`).

## Tool reference

### `remove_background`

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `input_path` | string | | Absolute path of one image. |
| `input_paths` | string[] | | Absolute paths of several images (batch). Can be combined with `input_path`. |
| `output_path` | string | | Absolute output file (`.png` or `.webp`). Single input only. |
| `output_dir` | string | next to each input | Directory for outputs, named `<name>-nobg.<format>`. Created if missing. When several inputs of one call share a base name (`a/x.jpg`, `b/x.jpg`), later ones get a numeric suffix (`x-nobg-2.png`) instead of overwriting each other. |
| `format` | `png` \| `webp` | `png` | Output format. Inferred from `output_path` when given. WebP is encoded at quality 95 with lossless alpha, like the web app. |
| `overwrite` | boolean | `false` | Replace existing output files. Without it, an existing output is reported as an error for that file. |
| `trim` | boolean | `false` | Crop to the visible subject (alpha ≥ 5%) plus a margin of 1% of the subject's longer side (at least 2 px), clamped to the image. Handy for logos and assets. |

Paths must be absolute. Native Windows (`C:\…`, `C:/…`) and POSIX paths are accepted, as well as the Git Bash form `/c/…` on Windows.

Inputs: PNG, JPEG, WebP, AVIF, TIFF and GIF (first frame). EXIF orientation is applied, embedded colour profiles are converted to sRGB, and outputs carry no metadata.

Files are processed one after another (tool calls are queued too). A file that fails (not found, not an image, output already exists, …) is reported with its error and the rest of the batch continues. The call is only flagged as an error when every file failed.

The result has a short text summary and a `structuredContent.results` array, one entry per input:

```json
{
  "ok": true,
  "input_path": "/photos/shoe.jpg",
  "output_path": "/photos/shoe-nobg.png",
  "width": 4000,
  "height": 3000,
  "source_width": 4000,
  "source_height": 3000,
  "duration_ms": 1650
}
```

`width`/`height` are the output dimensions (they differ from `source_*` only with `trim`). Failed entries are `{ "ok": false, "input_path", "error", "duration_ms" }`.

## Model loading and cache

The model is loaded lazily on the first call and kept in memory for the life of the server process. Weights are cached on disk by transformers.js, by default in `mcp/node_modules/@huggingface/transformers/.cache/` (so a clean reinstall downloads them again). To keep them elsewhere, set `BG_REMOVE_CACHE_DIR`:

```bash
claude mcp add --scope user bg-remove -e BG_REMOVE_CACHE_DIR="<cache-dir>" -- node "<path-to-repo>/mcp/dist/index.js"
```

Download progress and other logs go to stderr only; stdout is reserved for the MCP protocol.

## How it maps to the web app

| Step | Web app (`src/lib/bgRemover.worker.ts`) | MCP server (`mcp/src/pipeline.ts`) |
| --- | --- | --- |
| Model | `briaai/RMBG-1.4`, fp16, `model_type: 'custom'`, WebGPU or WASM | same model, dtype and config, onnxruntime-node on CPU |
| Decode | `createImageBitmap` (EXIF orientation, sRGB) | sharp `.rotate()`, sRGB, 8-bit RGBA |
| Preprocessing | processor config: resize 1024×1024 (bilinear), rescale 1/255, mean 0.5, std 1 | identical config object |
| Mask | `output` tensor, clamped to [0, 1], rounded to 8-bit | identical |
| Upscale | canvas `imageSmoothingQuality = 'high'` | sharp `mitchell` kernel (the cubic filter Chromium uses for high-quality upscaling) |
| Composite | `destination-in`: alpha = source alpha × mask | same arithmetic on raw pixels |
| Encode | PNG, or WebP quality 0.95 | PNG, or WebP quality 95 |

Expected small differences: CPU and GPU kernels round differently, the 1024×1024 resize is done by sharp instead of a canvas, and browsers other than Chromium use their own smoothing filter. A canvas also stores premultiplied colour, which slightly alters the RGB of semi-transparent pixels in the browser; the MCP server keeps the original colours exactly. Masks are visually identical. `trim` and the AVIF/TIFF/GIF inputs are additions of the MCP server.

## Model license

RMBG-1.4 is published by BRIA AI under the [bria-rmbg-1.4 license](https://bria.ai/bria-huggingface-model-license-agreement/): it is available for non-commercial use, and commercial use requires an agreement with BRIA. The MIT license of this repository covers the code only, not the model weights. Review the [model card](https://huggingface.co/briaai/RMBG-1.4) before using outputs commercially.

## Test images

`test/fixtures/` holds two small CC0 photos from Wikimedia Commons (see the README in that folder). The logo and the EXIF-rotated image used by the tests are generated at test time. Test outputs are written to the system temp directory and deleted afterwards.
