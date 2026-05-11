import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Github, Loader2, Trash2 } from 'lucide-react';
import { Header } from './components/Header';
import { DropZone } from './components/DropZone';
import { ImageCard } from './components/ImageCard';
import { ProgressBar } from './components/ProgressBar';
import { bgRemover, type InitState } from './lib/bgRemover';
import { downloadAllAsZip, suggestOutputName } from './lib/download';
import type { OutputFormat } from './lib/types';

export interface ImageJob {
  id: string;
  file: File;
  format: OutputFormat;
  status: 'queued' | 'processing' | 'done' | 'error';
  stage?: string;
  error?: string;
  inputUrl?: string;
  outputUrl?: string;
  outputBlob?: Blob;
  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
}

let jobCounter = 0;
const newJobId = (): string => `job-${++jobCounter}`;

export function App(): React.ReactElement {
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [initState, setInitState] = useState<InitState>(bgRemover.getState());
  const [format, setFormat] = useState<OutputFormat>('png');
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  useEffect(() => {
    return bgRemover.onInit(setInitState);
  }, []);

  // Warm the model on mount so the download finishes while the user is still
  // picking their image. By the time they drop, inference is usually instant.
  useEffect(() => {
    bgRemover.init();
  }, []);

  // Free object URLs when jobs unmount.
  useEffect(() => {
    return () => {
      for (const j of jobsRef.current) {
        if (j.inputUrl) URL.revokeObjectURL(j.inputUrl);
        if (j.outputUrl) URL.revokeObjectURL(j.outputUrl);
      }
    };
  }, []);

  const patchJob = useCallback(
    (id: string, patch: Partial<ImageJob>): void => {
      setJobs((prev) =>
        prev.map((j) => (j.id === id ? { ...j, ...patch } : j)),
      );
    },
    [],
  );

  const handleFiles = useCallback(
    (files: File[]) => {
      bgRemover.init();
      const newJobs: ImageJob[] = files.map((file) => ({
        id: newJobId(),
        file,
        format,
        status: 'queued',
        inputUrl: URL.createObjectURL(file),
      }));
      setJobs((prev) => [...prev, ...newJobs]);

      // Probe input dimensions in the background.
      for (const job of newJobs) {
        if (!job.inputUrl) continue;
        const img = new Image();
        img.onload = () =>
          patchJob(job.id, {
            inputWidth: img.naturalWidth,
            inputHeight: img.naturalHeight,
          });
        img.src = job.inputUrl;
      }

      for (const job of newJobs) {
        patchJob(job.id, { status: 'processing', stage: 'Queued' });
        bgRemover
          .process(
            job.file,
            job.format,
            (p) => patchJob(job.id, { stage: p.stage }),
          )
          .then((res) => {
            const url = URL.createObjectURL(res.blob);
            patchJob(job.id, {
              status: 'done',
              outputBlob: res.blob,
              outputUrl: url,
              outputWidth: res.width,
              outputHeight: res.height,
              stage: 'Done',
            });
          })
          .catch((err: unknown) => {
            patchJob(job.id, {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    },
    [format, patchJob],
  );

  const removeJob = useCallback((id: string) => {
    setJobs((prev) => {
      const job = prev.find((j) => j.id === id);
      if (job?.inputUrl) URL.revokeObjectURL(job.inputUrl);
      if (job?.outputUrl) URL.revokeObjectURL(job.outputUrl);
      return prev.filter((j) => j.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    for (const j of jobsRef.current) {
      if (j.inputUrl) URL.revokeObjectURL(j.inputUrl);
      if (j.outputUrl) URL.revokeObjectURL(j.outputUrl);
    }
    setJobs([]);
  }, []);

  const doneJobs = useMemo(
    () => jobs.filter((j) => j.status === 'done' && j.outputBlob),
    [jobs],
  );
  const anyProcessing = useMemo(
    () => jobs.some((j) => j.status === 'processing' || j.status === 'queued'),
    [jobs],
  );

  const handleDownloadAll = useCallback(async () => {
    if (doneJobs.length === 0) return;
    await downloadAllAsZip(
      doneJobs.map((j) => ({
        blob: j.outputBlob as Blob,
        filename: suggestOutputName(j.file.name, j.format),
      })),
    );
  }, [doneJobs]);

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {/* Hero / empty state */}
        {jobs.length === 0 && (
          <section className="mb-8 space-y-3 text-center">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Remove backgrounds, locally.
            </h1>
            <p className="mx-auto max-w-xl text-sm text-[var(--color-fg-muted)] sm:text-base">
              A tiny browser tool that runs the{' '}
              <span className="font-mono text-[var(--color-fg)]">
                RMBG-1.4
              </span>{' '}
              segmentation model on your device. Your images never leave this
              tab.
            </p>
          </section>
        )}

        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <FormatToggle
            value={format}
            onChange={setFormat}
            disabled={anyProcessing}
          />
          <div className="flex items-center gap-2">
            {doneJobs.length > 1 && (
              <button
                type="button"
                onClick={handleDownloadAll}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-90"
              >
                <Download className="h-3.5 w-3.5" />
                Download all ({doneJobs.length}) as .zip
              </button>
            )}
            {jobs.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-3 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-border)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Model load status — hidden during the silent preload on first
            paint, shown only if the user drops an image before it finishes
            (or if it errored out). */}
        {(initState.status === 'error' ||
          (jobs.length > 0 && initState.status === 'loading')) && (
          <ModelStatus state={initState} />
        )}

        {/* Drop zone */}
        <div className="my-6">
          <DropZone
            onFiles={handleFiles}
            disabled={initState.status === 'error'}
          />
        </div>

        {/* Results grid */}
        {jobs.length > 0 && (
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="animate-in fade-in [animation-duration:300ms]"
              >
                <ImageCard job={job} onRemove={() => removeJob(job.id)} />
              </div>
            ))}
          </section>
        )}
      </main>

      <footer className="border-t border-[var(--color-border)] px-6 py-6">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 text-center sm:flex-row sm:text-left">
          <p className="text-xs text-[var(--color-fg-muted)]">
            Built locally, runs locally. Your images never leave your browser.
          </p>
          <a
            href="https://github.com/albertvalleeduval/bg-remove"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            <Github className="h-3.5 w-3.5" />
            source
          </a>
        </div>
      </footer>
    </div>
  );
}

function FormatToggle({
  value,
  onChange,
  disabled,
}: {
  value: OutputFormat;
  onChange: (f: OutputFormat) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div
      className={[
        'inline-flex h-8 items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-0.5',
        disabled ? 'pointer-events-none opacity-60' : '',
      ].join(' ')}
      role="radiogroup"
      aria-label="Output format"
    >
      {(['png', 'webp'] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          onClick={() => onChange(opt)}
          className={[
            'h-7 rounded px-2.5 font-mono text-[11px] uppercase tracking-wider transition-colors',
            value === opt
              ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
              : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
          ].join(' ')}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function ModelStatus({ state }: { state: InitState }): React.ReactElement | null {
  if (state.status === 'idle') {
    return (
      <p className="font-mono text-[11px] text-[var(--color-fg-muted)]">
        Model will load on first image (~80 MB, cached after).
      </p>
    );
  }
  if (state.status === 'loading') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{state.message}</span>
        </div>
        <ProgressBar
          ratio={state.ratio}
          indeterminate={state.ratio === undefined}
        />
      </div>
    );
  }
  if (state.status === 'ready') {
    return (
      <p className="font-mono text-[11px] text-[var(--color-fg-muted)]">
        Model ready ·{' '}
        <span className="text-[var(--color-fg)]">{state.device}</span>
      </p>
    );
  }
  return (
    <p className="font-mono text-[11px] text-red-500">
      Model failed to load: {state.message}
    </p>
  );
}
