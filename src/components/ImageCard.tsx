import { Download, AlertCircle, Loader2, X } from 'lucide-react';
import type { ImageJob } from '../App';
import { ProgressBar } from './ProgressBar';
import { downloadBlob, suggestOutputName } from '../lib/download';

interface Props {
  job: ImageJob;
  onRemove: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function ImageCard({ job, onRemove }: Props): React.ReactElement {
  const inputUrl = job.inputUrl;
  const outputUrl = job.outputUrl;

  const dims =
    job.outputWidth && job.outputHeight
      ? `${job.outputWidth}×${job.outputHeight}`
      : job.inputWidth && job.inputHeight
        ? `${job.inputWidth}×${job.inputHeight}`
        : '';

  return (
    <div className="group relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] transition-colors">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{job.file.name}</div>
          <div className="font-mono text-[10px] text-[var(--color-fg-muted)]">
            {formatBytes(job.file.size)}
            {dims ? ` · ${dims}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="grid h-6 w-6 place-items-center rounded text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-border)] hover:text-[var(--color-fg)]"
          aria-label="Remove image"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-px bg-[var(--color-border)]">
        <div className="relative aspect-square bg-[var(--color-bg)]">
          {inputUrl && (
            <img
              src={inputUrl}
              alt="input"
              className="absolute inset-0 h-full w-full object-contain p-2"
            />
          )}
          <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-[var(--color-bg)]/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-muted)] backdrop-blur">
            input
          </div>
        </div>
        <div className="checker relative aspect-square bg-[var(--color-bg)]">
          {outputUrl && (
            <img
              src={outputUrl}
              alt="output"
              className="absolute inset-0 h-full w-full object-contain p-2 opacity-0 transition-opacity duration-500 [&.loaded]:opacity-100"
              onLoad={(e) => e.currentTarget.classList.add('loaded')}
            />
          )}
          {job.status === 'processing' && (
            <div className="absolute inset-0 grid place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--color-fg-muted)]" />
            </div>
          )}
          {job.status === 'error' && (
            <div className="absolute inset-0 grid place-items-center p-3 text-center">
              <div className="flex flex-col items-center gap-1 text-[var(--color-fg-muted)]">
                <AlertCircle className="h-4 w-4" />
                <div className="font-mono text-[10px]">
                  {job.error ?? 'Failed'}
                </div>
              </div>
            </div>
          )}
          <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-[var(--color-bg)]/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-muted)] backdrop-blur">
            output
          </div>
        </div>
      </div>

      <div className="space-y-2 px-3 py-2.5">
        {(job.status === 'queued' || job.status === 'processing') && (
          <ProgressBar
            label={
              job.status === 'queued'
                ? 'Queued'
                : (job.stage ?? 'Processing…')
            }
            indeterminate
          />
        )}
        {job.status === 'done' && job.outputBlob && (
          <button
            type="button"
            onClick={() =>
              downloadBlob(
                job.outputBlob as Blob,
                suggestOutputName(job.file.name, job.format),
              )
            }
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" />
            Download {job.format.toUpperCase()}
          </button>
        )}
      </div>
    </div>
  );
}
