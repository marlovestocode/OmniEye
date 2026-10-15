'use client';

/**
 * Interface primitives.
 *
 * Instrument, not dashboard. Values are monospaced and tabular so a changing
 * number does not shift its neighbours; labels are small, letter-spaced and
 * quiet; panels are hairline-edged translucent glass so the sky reads through
 * them and stays the subject.
 */
import type { ReactNode } from 'react';

export function Panel({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`panel rounded-md ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--panel-edge)] px-3 py-2">
      <span className="label-caps">{title}</span>
      {right}
    </div>
  );
}

/** A labelled value. The unit of every readout in the app. */
export function Field({
  label,
  value,
  tone = 'default',
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'predicted' | 'observed' | 'matched' | 'warn' | 'dim';
  title?: string;
}) {
  const colour = {
    default: 'var(--text)',
    predicted: 'var(--predicted)',
    observed: 'var(--observed)',
    matched: 'var(--matched)',
    warn: 'var(--warn)',
    dim: 'var(--text-dim)',
  }[tone];

  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="label-caps">{label}</span>
      <span className="readout text-[13px] leading-tight" style={{ color: colour }}>
        {value}
      </span>
    </div>
  );
}

/** A switch for one of the three layers, or for a scene option. */
export function Toggle({
  label,
  checked,
  onChange,
  accent,
  hint,
  glyph,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  accent?: string;
  hint?: string;
  glyph?: string;
}) {
  const colour = accent ?? 'var(--text-dim)';
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      title={hint}
      aria-pressed={checked}
      className="group flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-all"
        style={{
          borderColor: checked ? colour : 'var(--panel-edge-strong)',
          background: checked ? colour : 'transparent',
          boxShadow: checked ? `0 0 10px -2px ${colour}` : 'none',
        }}
      >
        {checked && (
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="var(--ink)" strokeWidth="2">
            <path d="M2 5.2 4 7.2 8 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {glyph && (
        <span className="readout w-3 text-[13px] leading-none" style={{ color: checked ? colour : 'var(--text-faint)' }}>
          {glyph}
        </span>
      )}
      <span
        className="label-caps flex-1 !normal-case !tracking-[0.08em] !text-[11px] transition-colors"
        style={{ color: checked ? 'var(--text)' : 'var(--text-faint)' }}
      >
        {label}
      </span>
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="flex flex-col gap-1 px-2 py-1.5">
      <span className="flex items-baseline justify-between">
        <span className="label-caps">{label}</span>
        <span className="readout text-[11px] text-[var(--text-dim)]">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--panel-edge-strong)] accent-[var(--predicted)]"
      />
    </label>
  );
}

/**
 * A confidence chip. Never shown without a reason attached -- a bare percentage
 * invites more trust than a number deserves.
 */
export function Confidence({
  level,
  children,
  title,
}: {
  level: 'exact' | 'estimated' | 'assumed' | 'unknown';
  children: ReactNode;
  title?: string;
}) {
  const tone = {
    exact: { fg: 'var(--matched)', bg: 'rgba(111,240,205,0.10)' },
    estimated: { fg: 'var(--warn)', bg: 'rgba(255,207,112,0.10)' },
    assumed: { fg: 'var(--alert)', bg: 'rgba(255,123,123,0.10)' },
    unknown: { fg: 'var(--text-faint)', bg: 'rgba(140,165,220,0.07)' },
  }[level];

  return (
    <span
      title={title}
      className="readout inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]"
      style={{ color: tone.fg, background: tone.bg }}
    >
      {children}
    </span>
  );
}

/** Thin separator that reads as engraving rather than as a border. */
export function Rule({ className = '' }: { className?: string }) {
  return <div className={`h-px w-full bg-[var(--panel-edge)] ${className}`} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-[11px] leading-relaxed text-[var(--text-faint)]">{children}</p>;
}
