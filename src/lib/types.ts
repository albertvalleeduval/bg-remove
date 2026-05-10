export type OutputFormat = 'png' | 'webp';

export type WorkerRequest =
  | { type: 'init' }
  | {
      type: 'process';
      id: string;
      bitmap: ImageBitmap;
      format: OutputFormat;
    };

export type WorkerResponse =
  | { type: 'init:progress'; message: string; ratio?: number }
  | { type: 'init:ready'; device: 'webgpu' | 'wasm' }
  | { type: 'init:error'; error: string }
  | { type: 'process:progress'; id: string; stage: string; ratio?: number }
  | {
      type: 'process:done';
      id: string;
      blob: Blob;
      width: number;
      height: number;
    }
  | { type: 'process:error'; id: string; error: string };
