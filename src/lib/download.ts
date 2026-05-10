import JSZip from 'jszip';
import type { OutputFormat } from './types';

export function suggestOutputName(
  inputName: string,
  format: OutputFormat,
): string {
  const dot = inputName.lastIndexOf('.');
  const base = dot > 0 ? inputName.slice(0, dot) : inputName;
  return `${base}-nobg.${format}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the browser has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadAllAsZip(
  items: { blob: Blob; filename: string }[],
  zipName = 'bg-removed.zip',
): Promise<void> {
  const zip = new JSZip();
  for (const { blob, filename } of items) {
    zip.file(filename, blob);
  }
  const out = await zip.generateAsync({ type: 'blob' });
  downloadBlob(out, zipName);
}
