'use client';

/**
 * The evidence grid.
 *
 * Prediction crossed against detection, with the counts live. Most sky apps
 * collapse this into "here are the stars" and discard the disagreements; the
 * off-diagonal cells are the most informative thing OmniEye produces, so they get
 * equal weight on screen.
 *
 * The fourth cell is drawn as permanently empty rather than omitted. Something
 * neither predicted nor observed is not a thing at all, and showing the hole
 * makes the model legible in a way that a three-item list would not.
 */
import type { EvidenceSummary } from '@/lib/sky/evidence';
import { Panel, PanelHeader } from './primitives';

export interface EvidenceGridProps {
  summary: EvidenceSummary;
  /** False before any media has been imported. */
  hasObservation: boolean;
  /** False until the registration step exists. */
  hasSolve: boolean;
}

export function EvidenceGrid({ summary, hasObservation, hasSolve }: EvidenceGridProps) {
  return (
    <Panel className="w-[248px] overflow-hidden">
      <PanelHeader title="Evidence" />

      <div className="p-2">
        <div className="grid grid-cols-[62px_1fr_1fr] gap-1 text-[9px]">
          <span />
          <span className="label-caps !text-[8.5px] pb-1 text-center">detected</span>
          <span className="label-caps !text-[8.5px] pb-1 text-center">not detected</span>

          <span className="label-caps !text-[8.5px] flex items-center justify-end pr-1 text-right leading-[1.3]">
            predicted
          </span>
          <Cell
            title="Matched"
            count={summary.matched}
            colour="var(--matched)"
            note={hasSolve ? 'confirmed' : 'awaiting solve'}
            active={summary.matched > 0}
          />
          <Cell
            title="Unconfirmed"
            count={summary.unconfirmed}
            colour="var(--predicted)"
            note={hasSolve ? 'in reach, not seen' : hasObservation ? 'not yet asked' : 'no media'}
            active={summary.unconfirmed > 0}
          />

          <span className="label-caps !text-[8.5px] flex items-center justify-end pr-1 text-right leading-[1.3]">
            not predicted
          </span>
          <Cell
            title="Unexplained"
            count={summary.unexplained}
            colour="var(--unexplained)"
            note={hasSolve ? 'nothing accounts for it' : 'nothing has been matched'}
            active={summary.unexplained > 0}
          />
          <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-[var(--panel-edge)] px-1 py-2.5">
            <span className="text-[9px] leading-tight text-[var(--text-faint)]">not</span>
            <span className="text-[9px] leading-tight text-[var(--text-faint)]">represented</span>
          </div>
        </div>

        {/* The two headline numbers, once there is something to be headline about. */}
        {hasSolve && (
          <div className="mt-2 flex items-baseline justify-between border-t border-[var(--panel-edge)] pt-2">
            <span className="label-caps">confirmed</span>
            <span className="readout text-[13px]" style={{ color: 'var(--matched)' }}>
              {summary.confirmedFraction !== null ? `${(summary.confirmedFraction * 100).toFixed(1)}%` : '—'}
            </span>
            <span className="label-caps">rms</span>
            <span className="readout text-[13px]" style={{ color: 'var(--matched)' }}>
              {summary.rmsResidualArcmin !== null ? `${summary.rmsResidualArcmin.toFixed(2)}'` : '—'}
            </span>
          </div>
        )}

        {hasSolve && summary.belowFloor > 0 && (
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-faint)]">
            A further {summary.belowFloor.toLocaleString()} predicted objects lie inside the frame but are
            fainter than anything this image yielded. They are not counted against the rate — that would
            measure the catalogue&rsquo;s depth, not the photograph.
          </p>
        )}

        {!hasSolve && (
          <p className="mt-2 border-t border-[var(--panel-edge)] pt-2 text-[10px] leading-relaxed text-[var(--text-faint)]">
            {hasObservation
              ? 'Two lanes, not yet joined. Sources have been traced and the sky has been predicted, but nothing has been aligned — so nothing is confirmed and nothing is ruled out.'
              : 'Import a photograph to fill the detected column.'}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Cell({
  title,
  count,
  colour,
  note,
  active,
}: {
  title: string;
  count: number;
  colour: string;
  note: string;
  active: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-sm border px-1 py-2 text-center transition-colors"
      style={{
        borderColor: active ? colour : 'var(--panel-edge)',
        background: active ? `color-mix(in srgb, ${colour} 8%, transparent)` : 'transparent',
      }}
    >
      <span
        className="readout text-[17px] leading-none"
        style={{ color: active ? colour : 'var(--text-faint)' }}
      >
        {count}
      </span>
      <span
        className="mt-1 text-[8.5px] uppercase leading-tight tracking-[0.1em]"
        style={{ color: active ? colour : 'var(--text-faint)' }}
      >
        {title}
      </span>
      <span className="mt-0.5 text-[8px] leading-tight text-[var(--text-faint)]">{note}</span>
    </div>
  );
}
