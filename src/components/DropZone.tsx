import { useDropzone, type FileRejection } from 'react-dropzone';
import { ImagePlus, Upload } from 'lucide-react';

interface Props {
  onFiles: (files: File[]) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function DropZone({
  onFiles,
  compact,
  disabled,
}: Props): React.ReactElement {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
      'image/bmp': ['.bmp'],
    },
    multiple: true,
    disabled: disabled ?? false,
    onDrop: (accepted: File[], _rejected: FileRejection[]) => {
      if (accepted.length > 0) onFiles(accepted);
    },
  });

  if (compact) {
    return (
      <div
        {...getRootProps()}
        className={[
          'cursor-pointer rounded-md border border-dashed px-4 py-3 text-center text-xs transition-colors',
          isDragActive
            ? 'border-[var(--color-accent)] bg-[var(--color-bg-elev)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-fg-muted)]',
          disabled ? 'pointer-events-none opacity-50' : '',
        ].join(' ')}
      >
        <input {...getInputProps()} />
        <div className="flex items-center justify-center gap-2 font-mono text-[var(--color-fg-muted)]">
          <Upload className="h-3.5 w-3.5" />
          <span>Drop more or click to add</span>
        </div>
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={[
        'group relative mx-auto grid w-full max-w-4xl cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-8 py-28 text-center transition-all duration-200',
        isDragActive
          ? 'border-[var(--color-accent)] bg-[var(--color-bg-elev)] scale-[1.005]'
          : 'border-[var(--color-border)] hover:border-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elev)]',
        disabled ? 'pointer-events-none opacity-50' : '',
      ].join(' ')}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-4">
        <div className="grid h-14 w-14 place-items-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] transition-transform duration-300 group-hover:-translate-y-0.5">
          <ImagePlus
            className="h-6 w-6 text-[var(--color-fg-muted)]"
            strokeWidth={1.6}
          />
        </div>
        <div className="space-y-1">
          <div className="text-base font-medium tracking-tight">
            {isDragActive ? 'Drop to start' : 'Drop images or click to select'}
          </div>
          <div className="font-mono text-[11px] text-[var(--color-fg-muted)]">
            png · jpg · webp · bmp — batches welcome
          </div>
        </div>
      </div>
    </div>
  );
}
