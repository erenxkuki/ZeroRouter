/** Small shared UI primitives for the ZeroRouter console. */
import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

export function Panel({
  title,
  actions,
  children,
  className = '',
  dense = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section className={`rounded-[10px] border border-hairline bg-panel ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">{title}</div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={dense ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'cyan'; children: ReactNode }) {
  const map: Record<string, string> = {
    ok: 'text-ok border-ok/40 bg-ok/10',
    warn: 'text-amber border-amber/40 bg-amber/10',
    danger: 'text-danger border-danger/40 bg-danger/10',
    neutral: 'text-ink-dim border-hairline-strong bg-panel-raised',
    cyan: 'text-cyan border-cyan/40 bg-cyan/10',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider ${map[tone]}`}>
      {children}
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block size-3.5 animate-spin rounded-full border border-hairline-strong border-t-cyan ${className}`}
      aria-hidden
    />
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-ink-dim">
      <Spinner /> {label}…
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.';
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && (
        <button type="button" className="zr-btn shrink-0" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-ink-faint">{children}</div>;
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="zr-label block pb-1.5">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 disabled:opacity-40"
    >
      <span className={`relative h-4 w-8 rounded-full border transition-colors ${checked ? 'border-cyan/60 bg-cyan/20' : 'border-hairline-strong bg-panel-raised'}`}>
        <span
          className={`absolute top-[1px] size-[12px] rounded-full transition-all ${checked ? 'left-[17px] bg-cyan' : 'left-[1px] bg-ink-faint'}`}
        />
      </span>
      {label && <span className="text-[13px] text-ink-dim">{label}</span>}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className={`w-full ${width} rounded-[10px] border border-hairline-strong bg-panel shadow-2xl shadow-black/50`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div className="font-display text-[15px] font-semibold tracking-tight">{title}</div>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-faint hover:bg-panel-raised hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'amber' | 'cyan' }) {
  return (
    <div className="rounded-[10px] border border-hairline bg-panel p-4">
      <div className="zr-label pb-1.5">{label}</div>
      <div className={`font-display text-[26px] font-semibold leading-7 tracking-tight tabular-nums ${tone === 'amber' ? 'text-amber' : tone === 'cyan' ? 'text-cyan' : 'text-ink'}`}>
        {value}
      </div>
      {sub && <div className="pt-1 font-mono text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

export function StatusDot({ ok }: { ok: boolean | null }) {
  return <span className={`inline-block size-2 rounded-full ${ok === null ? 'bg-ink-faint' : ok ? 'bg-ok' : 'bg-danger'}`} />;
}

/** Renders bounded JSON (safely) for config payloads. */
export function JsonBlock({ value, max = 600 }: { value: unknown; max?: number }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? '';
  } catch {
    text = String(value);
  }
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return (
    <pre className="overflow-x-auto rounded-md border border-hairline bg-canvas p-3 font-mono text-[11.5px] leading-relaxed text-ink-dim">
      {clipped}
    </pre>
  );
}
