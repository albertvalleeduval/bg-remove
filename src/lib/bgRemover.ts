import type { OutputFormat, WorkerRequest, WorkerResponse } from './types';

export type InitState =
  | { status: 'idle' }
  | { status: 'loading'; message: string; ratio?: number }
  | { status: 'ready'; device: 'webgpu' | 'wasm' }
  | { status: 'error'; message: string };

export interface ProcessProgress {
  stage: string;
  ratio?: number;
}

export interface ProcessResult {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Main-thread client around the worker that runs RMBG-1.4.
 *
 * - One worker instance per page; the model is loaded lazily on the first
 *   `init()` call and kept in memory for the lifetime of the page.
 * - `process()` calls are serialized internally: a batch of images gets
 *   sent one-at-a-time to avoid GPU/CPU OOM on large inputs.
 */
export class BgRemover {
  private worker: Worker | null = null;
  private initListeners = new Set<(state: InitState) => void>();
  private state: InitState = { status: 'idle' };
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;

  getState(): InitState {
    return this.state;
  }

  onInit(listener: (state: InitState) => void): () => void {
    this.initListeners.add(listener);
    listener(this.state);
    return () => this.initListeners.delete(listener);
  }

  private setState(state: InitState): void {
    this.state = state;
    for (const l of this.initListeners) l(state);
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(
        new URL('./bgRemover.worker.ts', import.meta.url),
        { type: 'module', name: 'bg-remover' },
      );
    }
    return this.worker;
  }

  /** Boot the worker and download/initialize the model. Idempotent. */
  init(): void {
    if (
      this.state.status === 'loading' ||
      this.state.status === 'ready'
    ) {
      return;
    }
    this.setState({ status: 'loading', message: 'Starting…' });
    const worker = this.getWorker();

    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      const msg = event.data;
      if (msg.type === 'init:progress') {
        this.setState({
          status: 'loading',
          message: msg.message,
          ...(msg.ratio !== undefined ? { ratio: msg.ratio } : {}),
        });
      } else if (msg.type === 'init:ready') {
        this.setState({ status: 'ready', device: msg.device });
        worker.removeEventListener('message', onMessage);
      } else if (msg.type === 'init:error') {
        this.setState({ status: 'error', message: msg.error });
        worker.removeEventListener('message', onMessage);
      }
    };
    worker.addEventListener('message', onMessage);

    const req: WorkerRequest = { type: 'init' };
    worker.postMessage(req);
  }

  /**
   * Process a single image. Calls are queued — the next image starts only
   * after the previous one finishes.
   */
  process(
    file: File | Blob,
    format: OutputFormat,
    onProgress?: (p: ProcessProgress) => void,
  ): Promise<ProcessResult> {
    const id = `${this.nextId++}`;
    const task = (): Promise<ProcessResult> =>
      new Promise<ProcessResult>((resolve, reject) => {
        // Make sure the model is initializing before we ask it to process.
        this.init();
        const worker = this.getWorker();

        const onMessage = async (
          event: MessageEvent<WorkerResponse>,
        ): Promise<void> => {
          const msg = event.data;
          if ('id' in msg && msg.id !== id) return;
          if (msg.type === 'process:progress') {
            onProgress?.({
              stage: msg.stage,
              ...(msg.ratio !== undefined ? { ratio: msg.ratio } : {}),
            });
          } else if (msg.type === 'process:done') {
            worker.removeEventListener('message', onMessage);
            resolve({ blob: msg.blob, width: msg.width, height: msg.height });
          } else if (msg.type === 'process:error') {
            worker.removeEventListener('message', onMessage);
            reject(new Error(msg.error));
          }
        };
        worker.addEventListener('message', onMessage);

        // Decode on the main thread, transfer bitmap to the worker.
        createImageBitmap(file).then(
          (bitmap) => {
            const req: WorkerRequest = {
              type: 'process',
              id,
              bitmap,
              format,
            };
            worker.postMessage(req, [bitmap]);
          },
          (err: unknown) => {
            worker.removeEventListener('message', onMessage);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });

    const next = this.queue.then(task, task);
    // Don't let a failed task break the chain for subsequent ones.
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initListeners.clear();
    this.state = { status: 'idle' };
  }
}

export const bgRemover = new BgRemover();
