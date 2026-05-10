import { Scissors } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

export function Header(): React.ReactElement {
  return (
    <header className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
      <div className="flex items-center gap-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)]">
          <Scissors className="h-4 w-4" strokeWidth={2.2} />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">bg-remove</div>
          <div className="font-mono text-[11px] text-[var(--color-fg-muted)]">
            local · private · open source
          </div>
        </div>
      </div>
      <ThemeToggle />
    </header>
  );
}
