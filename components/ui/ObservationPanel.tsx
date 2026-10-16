'use client';

/**
 * Observation Reconstruction.
 *
 * Importing media is framed as an instrument beginning to reconstruct an
 * observation, not as a file upload. The pipeline steps are named and shown in
 * sequence -- including the one that has not been built yet, which sits greyed
 * out and honest rather than hidden.
 *
 * The panel reads top to bottom as the argument the app is making: here is the
 * frame, here is what was traced in it, here is how well that agreed with the
 * predicted sky, and here is what the file claimed about when and where. The
 * alignment block sits above the metadata deliberately -- the fit is the finding,
 * and the circumstances are how it was reached.
 *
 * A refused solve gets the same block with the reason in place of the numbers.
 * Refusing is a result.
 */
import { useMemo, useState } from 'react';
import type { DetectionRun } from '@/lib/detect/client';
import type { Source } from '@/lib/detect/types';
import type { ObservationState, PipelineStep } from '@/lib/state/store';
import type { SolveRun } from '@/lib/solve/client';
import { boresightEquatorial } from '@/lib/solve/match';
import { compassPoint, formatDec, formatDeg, formatRa } from '@/lib/astro/frames';
import { useOmniEye } from '@/lib/state/store';
import { Confidence, Field, Panel, PanelHeader, Rule, Slider } from './primitives';
import { SourceOverlay } from './SourceOverlay';

export function ObservationPanel({
  observation,
  onImport,
  onClear,
  onRedetect,
}: {
  observation: ObservationState;
  onImport: (file: File) => void;
  onClear: () => void;
  onRedetect: (thresholdSigma: number) => void;
}) {
  const layers = useOmniEye((s) => s.layers);
  const hoveredId = useOmniEye((s) => s.hoveredSourceId);
  const hoverSource = useOmniEye((s) => s.hoverSource);
  const detectionParams = useOmniEye((s) => s.detectionParams);

  const [mediaOpacity, setMediaOpacity] = useState(1);
  const threshold = detectionParams.thresholdSigma ?? 4;

  const hovered = useMemo(
    () => observation.detection?.sources.find((s) => s.id === hoveredId) ?? null,
    [observation.detection, hoveredId],
  );

  const running = observation.steps.some((s) => s.status === 'active');

  return (
    <Panel className="flex max-h-full w-full flex-col overflow-hidden md:w-[340px]">
      <PanelHeader
        title="Observation"
        right={
          <button type="button" onClick={onClear} className="label-caps hover:text-[var(--text)]">
            clear
          </button>
        }
      />

      <div className="scroll-contain min-h-0 flex-1 overflow-y-auto">
        <div className="p-3">
          <SourceOverlay
            imageUrl={observation.imageUrl}
            width={observation.width}
            height={observation.height}
            detection={observation.detection}
            matched={observation.matched}
            showSources={layers.observed}
            showMatched={layers.matched}
            hoveredId={hoveredId}
            onHover={hoverSource}
            mediaOpacity={mediaOpacity}
          />
          <p className="mt-1.5 truncate text-[10px] text-[var(--text-faint)]" title={observation.fileName}>
            {observation.fileName} · {observation.width}×{observation.height}
          </p>
        </div>

        <Slider
          label="Media"
          value={mediaOpacity}
          min={0}
          max={1}
          step={0.02}
          onChange={setMediaOpacity}
          format={(v) => (v === 1 ? 'full' : v === 0 ? 'trace only' : `${Math.round(v * 100)}%`)}
        />

        {observation.solve && (
          <>
            <Rule />
            <Alignment solve={observation.solve} frame={observation.solveFrame} />
          </>
        )}

        <Rule />
        <Pipeline steps={observation.steps} />

        {observation.error && (
          <>
            <Rule />
            <p className="px-3 py-2 text-[11px] leading-relaxed text-[var(--alert)]">{observation.error}</p>
          </>
        )}

        {observation.metadata && (
          <>
            <Rule />
            <MetadataSection observation={observation} />
          </>
        )}

        {observation.detection && (
          <>
            <Rule />
            <DetectionSection
              detection={observation.detection}
              saturatedFraction={observation.saturatedFraction}
              threshold={threshold}
              busy={running}
              onRedetect={onRedetect}
            />
          </>
        )}

        {hovered && (
          <>
            <Rule />
            <SourceInspector source={hovered} psf={observation.detection?.fwhmPixels ?? null} />
          </>
        )}

        <Rule />
        <ImportAnother onImport={onImport} />
      </div>
    </Panel>
  );
}

/**
 * Field alignment.
 *
 * The instrument-style readout the design asks for: a headline number, the counts
 * behind it, and the geometry the solve recovered. Everything here is a
 * measurement of this frame, so a failed solve gets the same panel with the
 * reason in place of the numbers -- refusing is a result, not an absence.
 */
function Alignment({ solve, frame }: { solve: SolveRun; frame: ObservationState['solveFrame'] }) {
  const attitude = solve.attitude;

  if (!solve.ok || !attitude) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="label-caps">Field alignment</span>
          <span className="readout text-[10px] uppercase tracking-[0.12em] text-[var(--warn)]">
            not solved
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--text-dim)]">{solve.message}</p>
        {solve.timedOut && (
          <p className="text-[10px] leading-relaxed text-[var(--warn)]">
            The search ran out of its time budget after {(solve.elapsedMs / 1000).toFixed(0)} s. Supplying a
            rough field of view narrows it enormously.
          </p>
        )}
        <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
          Nothing has been named. A best guess would look exactly like a real identification, which is
          why it is not offered.
        </p>
      </div>
    );
  }

  const equatorial = boresightEquatorial(attitude);

  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="label-caps">Field alignment</span>
        <span className="readout text-[10px] text-[var(--text-faint)]">
          {(solve.elapsedMs / 1000).toFixed(1)} s · pass {solve.pass}
          {solve.ranOnMainThread ? ' · main thread' : ''}
        </span>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="readout text-[26px] leading-none" style={{ color: 'var(--matched)' }}>
          {solve.pairs.length}
        </span>
        <span className="text-[11px] leading-tight text-[var(--text-dim)]">
          of {solve.candidatesInFrame} predicted objects
          <br />
          in frame were matched
        </span>
      </div>

      {/* The honesty number. A match count means nothing without the count chance
          alone would have supplied. */}
      <div className="rounded-sm border border-[var(--panel-edge)] bg-white/[0.02] px-2 py-1.5">
        <p className="text-[10px] leading-relaxed text-[var(--text-dim)]">
          Coincidence alone would have produced about{' '}
          <span className="readout text-[var(--text)]">{solve.expectedByChance.toFixed(1)}</span>. This fit
          stands <span className="readout text-[var(--matched)]">{solve.significance.toFixed(0)}σ</span>{' '}
          above that.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field label="RMS residual" value={`${solve.rmsArcmin?.toFixed(2) ?? '—'}′`} tone="matched" />
        <Field label="Worst residual" value={`${solve.maxArcmin?.toFixed(2) ?? '—'}′`} />
        <Field
          label="Field of view"
          value={`${attitude.fovHorizontalDeg.toFixed(1)}° × ${attitude.fovVerticalDeg.toFixed(1)}°`}
          tone="matched"
        />
        <Field label="Pixel scale" value={`${attitude.pixelScaleArcsec.toFixed(1)}″`} />
        {/* Roll is measured against the zenith, so like altitude and azimuth it
            means nothing unless the vantage was trusted. */}
        <Field
          label="Roll"
          value={frame === 'horizon' ? formatDeg(attitude.roll, 2) : 'needs a vantage'}
          tone={frame === 'horizon' ? 'default' : 'dim'}
          title={
            frame === 'horizon'
              ? 'Rotation of the frame about the boresight, measured from the zenith.'
              : 'Roll is relative to the observer’s zenith, which an all-sky solve does not use.'
          }
        />
        <Field
          label="Distortion"
          value={attitude.k1 === 0 ? 'none fitted' : attitude.k1.toFixed(3)}
          tone={attitude.k1 === 0 ? 'dim' : 'default'}
          title="Radial term, normalised by half the image diagonal. Wide phone lenses land around -0.05 to -0.15."
        />
      </div>

      <Rule />

      {/* Where the camera was pointing. Which of these two readings is meaningful
          depends entirely on whether the vantage was trusted. */}
      {frame === 'horizon' ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Field label="Altitude" value={formatDeg(attitude.altitude, 2)} tone="matched" />
          <Field
            label="Azimuth"
            value={`${formatDeg(attitude.azimuth, 2)}  ${compassPoint(attitude.azimuth)}`}
            tone="matched"
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <Field label="Right ascension" value={formatRa(equatorial.ra)} tone="matched" />
            <Field label="Declination" value={formatDec(equatorial.dec)} tone="matched" />
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
            Solved against the whole sky, with no reliance on the time or place above. These
            coordinates are a property of the photograph. Altitude and azimuth are not shown because
            they would only be as good as a vantage this solve deliberately did not use.
          </p>
        </>
      )}
    </div>
  );
}

/** The reconstruction sequence, narrated. */
function Pipeline({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="px-3 py-2">
      <span className="label-caps">Reconstruction</span>
      <ol className="mt-1.5 flex flex-col gap-1">
        {steps.map((step) => (
          <li key={step.id} className="flex items-baseline gap-2">
            <span className="readout w-3 text-[11px]" style={{ color: stepColour(step.status) }}>
              {stepGlyph(step.status)}
            </span>
            <span
              className="text-[11px] leading-snug"
              style={{
                color:
                  step.status === 'pending'
                    ? 'var(--text-faint)'
                    : step.status === 'active'
                      ? 'var(--text)'
                      : 'var(--text-dim)',
              }}
            >
              {step.label}
              {step.status === 'active' && <span className="animate-pulse-soft"> …</span>}
              {step.detail && <span className="ml-1 text-[var(--text-faint)]">· {step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const stepGlyph = (status: PipelineStep['status']) =>
  ({ pending: '○', active: '◉', done: '●', skipped: '·', failed: '✕' })[status];

const stepColour = (status: PipelineStep['status']) =>
  ({
    pending: 'var(--text-faint)',
    active: 'var(--observed)',
    done: 'var(--matched)',
    skipped: 'var(--text-faint)',
    failed: 'var(--alert)',
  })[status];

function MetadataSection({ observation }: { observation: ObservationState }) {
  const metadata = observation.metadata!;
  const { camera, time, location, fieldOfView } = metadata;

  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <span className="label-caps">Circumstances</span>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field
          label="Camera"
          value={camera.model ? `${camera.make ?? ''} ${camera.model}`.trim() : 'not recorded'}
          tone={camera.model ? 'default' : 'dim'}
        />
        <Field
          label="Exposure"
          value={
            camera.exposureSeconds
              ? `${formatExposure(camera.exposureSeconds)}${camera.iso ? ` · ISO ${camera.iso}` : ''}`
              : 'not recorded'
          }
          tone={camera.exposureSeconds ? 'default' : 'dim'}
        />
      </div>

      {/* Time provenance is given its own block because it is the single most
          dangerous number in the file. */}
      <div className="rounded-sm border border-[var(--panel-edge)] p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="label-caps">Observation time</span>
          {time && <Confidence level={time.confidence}>{time.confidence}</Confidence>}
        </div>
        {time ? (
          <>
            <p className="readout mt-1 text-[12px]">{time.utc.toISOString().replace('T', ' ').slice(0, 19)} UTC</p>
            {time.rawLocal && (
              <p className="readout mt-0.5 text-[10px] text-[var(--text-faint)]">
                file says {time.rawLocal} (local)
              </p>
            )}
            <p
              className="mt-1 text-[10px] leading-relaxed"
              style={{ color: time.confidence === 'exact' ? 'var(--text-faint)' : 'var(--warn)' }}
            >
              {time.note}
            </p>
          </>
        ) : (
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--warn)]">
            No timestamp in the file. The predicted sky is using the time set above — set it by hand before
            trusting any comparison.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field
          label="Position"
          value={
            location
              ? `${location.site.latitude.toFixed(4)}, ${location.site.longitude.toFixed(4)}`
              : 'no GPS in file'
          }
          tone={location ? 'default' : 'dim'}
        />
        <Field
          label="Focal length"
          value={
            camera.focalLength35mm
              ? `${camera.focalLength35mm} mm eq`
              : camera.focalLengthMm
                ? `${camera.focalLengthMm} mm`
                : 'not recorded'
          }
          tone={camera.focalLengthMm ? 'default' : 'dim'}
        />
      </div>

      <Field
        label="Field of view prior"
        value={
          fieldOfView
            ? `${fieldOfView.horizontalDeg.toFixed(1)}° × ${fieldOfView.verticalDeg.toFixed(1)}°`
            : 'none — the solve will have to find it'
        }
        tone={fieldOfView ? 'predicted' : 'dim'}
        title={
          fieldOfView
            ? 'A prior, not a measurement. Phones crop and stabilise, so the recorded focal length routinely disagrees with the delivered frame.'
            : undefined
        }
      />
    </div>
  );
}

function DetectionSection({
  detection,
  saturatedFraction,
  threshold,
  busy,
  onRedetect,
}: {
  detection: DetectionRun;
  saturatedFraction: number;
  threshold: number;
  busy: boolean;
  onRedetect: (thresholdSigma: number) => void;
}) {
  const [pending, setPending] = useState(threshold);
  const counts = useMemo(() => {
    const by = { point: 0, sharp: 0, trailed: 0, diffuse: 0 };
    for (const s of detection.sources) by[s.shape]++;
    return by;
  }, [detection]);

  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="label-caps">Observed sky</span>
        <span className="readout text-[10px] text-[var(--text-faint)]">
          {detection.elapsedMs} ms{detection.ranOnMainThread ? ' · main thread' : ''}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-2.5">
        <Field label="Sources" value={detection.sources.length.toLocaleString()} tone="observed" />
        <Field
          label="Seeing"
          value={detection.fwhmPixels ? `${detection.fwhmPixels.toFixed(2)} px` : '—'}
          title="The image's own point spread function, measured from the round sources it contains."
        />
        <Field
          label="Sky noise"
          value={detection.background.sigma.toExponential(1)}
          title="Median per-pixel noise, estimated from adjacent-pixel differences so a gradient does not inflate it."
        />
      </div>

      {/* Morphology, named for shape and never for cause. */}
      <div className="flex flex-col gap-1">
        <span className="label-caps">Morphology</span>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Morph label="point" count={counts.point} colour="var(--observed)" hint="Consistent with the image's own PSF." />
          <Morph
            label="sharp"
            count={counts.sharp}
            colour="var(--unexplained)"
            hint="Tighter than the optics can produce, so more likely sensor than sky."
          />
          <Morph
            label="trailed"
            count={counts.trailed}
            colour="var(--unexplained)"
            hint="Elongated. Motion, tracking error, or something extended. OmniEye does not guess which."
          />
          <Morph label="diffuse" count={counts.diffuse} colour="#ffd7a0" hint="Much broader than the PSF." />
        </div>
      </div>

      {saturatedFraction > 0.002 && (
        <p className="text-[10px] leading-relaxed text-[var(--warn)]">
          {(saturatedFraction * 100).toFixed(1)}% of the frame is saturated. Flux for those sources is a lower
          bound.
        </p>
      )}

      {detection.background.max / Math.max(detection.background.min, 1e-6) > 1.6 && (
        <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
          Strong background gradient across the frame ({detection.background.min.toFixed(3)} to{' '}
          {detection.background.max.toFixed(3)}). Thresholds follow it locally.
        </p>
      )}

      <Slider
        label="Threshold"
        value={pending}
        min={2}
        max={8}
        step={0.5}
        onChange={setPending}
        format={(v) => `${v.toFixed(1)} σ`}
      />
      <button
        type="button"
        disabled={busy || pending === threshold}
        onClick={() => onRedetect(pending)}
        className="label-caps rounded-sm border border-[var(--panel-edge-strong)] px-2 py-1.5 !text-[var(--observed)] transition-colors hover:bg-white/[0.04] disabled:opacity-35"
      >
        {busy ? 'detecting…' : 're-detect'}
      </button>

      {/* The governing rule, stated where it applies. */}
      <div className="rounded-sm border border-[var(--panel-edge)] bg-white/[0.02] p-2">
        <p className="text-[10px] leading-relaxed text-[var(--text-dim)]">
          These sources are <span className="text-[var(--observed)]">evidence without identity</span>. Detection
          never consults the catalogue, so nothing here is named, and none of it has been aligned to the predicted
          sky yet.
        </p>
      </div>
    </div>
  );
}

function Morph({ label, count, colour, hint }: { label: string; count: number; colour: string; hint: string }) {
  return (
    <span className="flex items-baseline gap-1.5" title={hint}>
      <span className="readout text-[12px]" style={{ color: count > 0 ? colour : 'var(--text-faint)' }}>
        {count}
      </span>
      <span className="text-[10px] tracking-[0.08em] text-[var(--text-faint)]">{label}</span>
    </span>
  );
}

/** Everything measured about one source. No name, because there is not one. */
function SourceInspector({ source, psf }: { source: Source; psf: number | null }) {
  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="label-caps">Source {source.id}</span>
        <span className="readout text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--observed)' }}>
          {source.shape}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field label="Centroid" value={`${source.x.toFixed(2)}, ${source.y.toFixed(2)} px`} tone="observed" />
        <Field label="Signal / noise" value={source.snr.toFixed(1)} tone="observed" />
        <Field
          label="FWHM"
          value={`${source.fwhm.toFixed(2)} px${psf ? ` · ${(source.fwhm / psf).toFixed(2)}× PSF` : ''}`}
        />
        <Field label="Elongation" value={source.elongation.toFixed(2)} />
        <Field label="Flux" value={source.flux.toExponential(2)} />
        <Field label="Area" value={`${source.area} px`} />
      </div>

      {source.saturated && (
        <p className="text-[10px] text-[var(--warn)]">Saturated — the flux above is a lower bound.</p>
      )}

      <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
        No identity. A source becomes a named object only when the matching layer binds it to a prediction.
      </p>
    </div>
  );
}

function ImportAnother({ onImport }: { onImport: (file: File) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-center gap-2 px-3 py-3 transition-colors hover:bg-white/[0.03]">
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onImport(file);
          e.target.value = '';
        }}
      />
      <span className="label-caps !text-[var(--predicted)]">import another observation</span>
    </label>
  );
}

function formatExposure(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  return `1/${Math.round(1 / seconds)} s`;
}
