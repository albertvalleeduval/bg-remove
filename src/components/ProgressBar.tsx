interface Props {
  ratio?: number;
  label?: string;
  indeterminate?: boolean;
}

export function ProgressBar({
  ratio,
  label,
  indeterminate,
}: Props): React.ReactElement {
  const pct =
    typeof ratio === 'number'
      ? Math.max(0, Math.min(100, Math.round(ratio * 100)))
      : null;

  return (
    <div className="w-full">
      {label !== undefined && (
        <div className="mb-1 flex items-center justify-between font-mono text-[11px] text-[var(--color-fg-muted)]">
          <span className="truncate">{label}</span>
          {pct !== null && !indeterminate && <span>{pct}%</span>}
        </div>
      )}
      <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        {indeterminate || pct === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--color-accent)]" />
        ) : (
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
