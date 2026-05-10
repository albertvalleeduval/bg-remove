# bg-remove

A tiny browser tool that removes image backgrounds **entirely on your device**. Drop one or many images, get back transparent PNGs (or WebPs) at the **same resolution as the input**. No server, no API key, no upload — the model runs in a Web Worker via WebGPU (or WASM as fallback).

> **Repo:** https://github.com/albertvalleeduval/bg-remove
> **Live demo:** `<add your Vercel URL after deploy>`

## Features

- Drag-and-drop or click-to-select, single image or batch
- Preserves full input resolution — drop a 4K image, get back a 4K cutout
- PNG (lossless transparency) or WebP output
- Per-image download + "download all as `.zip`"
- Dark / light mode
- Runs offline after the model is cached on first use
- Zero telemetry

## Tech stack

- **Vite** + **React 19** + **TypeScript** (strict)
- **Tailwind CSS v4**
- **[`@huggingface/transformers`](https://huggingface.co/docs/transformers.js)** — in-browser ONNX runtime
- **Model: [`briaai/RMBG-1.4`](https://huggingface.co/briaai/RMBG-1.4)** by BRIA AI
- `react-dropzone`, `lucide-react`, `jszip` — and that's it

## How it works

The interesting bit is the **resolution-preserving pipeline**. A naive browser background-remover destroys image quality because the segmentation model only accepts a small fixed input (1024×1024). If you simply send a downscaled image to the model and use its output, your 4000×3000 photo comes back as 1024×1024 — useless for actual design work.

bg-remove keeps the original at full resolution end-to-end:

1. The original `ImageBitmap` is held in memory at native size.
2. A 1024×1024 copy is fed to **RMBG-1.4** for inference.
3. The model returns a soft alpha mask at 1024×1024.
4. The mask is **upscaled to the original image's resolution** on a `Canvas` with `imageSmoothingQuality = 'high'` (browser-native bilinear+).
5. The upscaled mask is composited onto the original via `globalCompositeOperation = 'destination-in'`, so the mask becomes the alpha channel of the original — preserving every source pixel where the subject is opaque, and producing soft edges (hair, fur, semi-transparent regions) where the mask was a partial value.
6. The result is encoded as PNG or WebP at the original dimensions.

The whole pipeline runs in a `Web Worker` so the UI thread stays responsive during batch processing. Inference is queued — one image at a time — to avoid GPU/CPU OOM on large batches. The model file (~80 MB) is fetched once from the Hugging Face CDN and then cached by the browser via the Cache API.

WebGPU is used when available; otherwise the runtime transparently falls back to WebAssembly.

The core of this is in [`src/lib/bgRemover.worker.ts`](src/lib/bgRemover.worker.ts) (model loading, mask generation, compositing) and [`src/lib/canvas.ts`](src/lib/canvas.ts) (the upscale + composite primitives).

## Local development

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # outputs static site to dist/
pnpm preview      # serve the built site locally
```

The build is fully static — `dist/` can be hosted anywhere (Vercel, GitHub Pages, S3, …).

## Deploy to Vercel

```bash
vercel deploy        # preview deploy
vercel deploy --prod # production
```

No environment variables needed. No backend.

## Privacy

Your images **never leave the browser tab**. The only network requests this app makes are:

- The initial download of the model weights and ONNX runtime, from `huggingface.co` and the `unpkg`/CDN that ships the WASM/WebGPU runtime.

After that first load, the app works offline. There is no analytics, no telemetry, no tracking.

## License

MIT — see [`LICENSE`](LICENSE).

## Credits

- **[BRIA AI](https://bria.ai)** for the open-source [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) model. The 1.4 license permits non-commercial **and** commercial use under the terms documented on the model card; please review before using outputs commercially.
- **[Hugging Face](https://huggingface.co)** for `@huggingface/transformers` (formerly `@xenova/transformers`).
- **[Xenova](https://github.com/xenova)** for the ONNX-on-the-web work that makes this possible.
