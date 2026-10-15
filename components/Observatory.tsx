'use client';

/**
 * The application shell.
 *
 * The sky is the app. It fills the viewport and everything else floats over it as
 * hairline glass, because the design's central claim is that a photograph becomes
 * a window into a 3D celestial sphere -- and that only lands if the sphere is the
 * thing you are looking at, not a widget in a dashboard.
 *
 * Two lanes run through here and they are kept apart on purpose:
 *
 *   the predicted lane   catalogues -> rotation -> scene. Runs with no media at
 *                        all, which is why the sky is on screen before anything
 *                        is imported and works offline afterwards.
 *   the evidence lane    file -> pixels -> worker -> sources. Never touches the
 *                        catalogue.
 *
 * They meet at registration, which is Phase 2. Until then this component draws
 * both and joins neither, and says so where a user would otherwise assume.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCatalogsOnce } from '@/lib/astro/catalog';
import { detect } from '@/lib/detect/client';
import { loadImage } from '@/lib/media/image';
import { readMediaMetadata } from '@/lib/media/exif';
import { summarise, type Observation } from '@/lib/sky/evidence';
import { buildCandidates, chooseFrame } from '@/lib/solve/candidates';
import { solve } from '@/lib/solve/client';
import { buildMatchedSky } from '@/lib/solve/match';
import { primeSky, useOmniEye } from '@/lib/state/store';
import { useMounted } from '@/lib/state/useMounted';
import { SkyCanvas } from './scene/SkyCanvas';
import { EvidenceGrid } from './ui/EvidenceGrid';
import { LayerPanel, Legend } from './ui/LayerPanel';
import { ObservationPanel } from './ui/ObservationPanel';
import { ReadoutBar } from './ui/ReadoutBar';
import { TopBar } from './ui/TopBar';
import { Panel } from './ui/primitives';

export function Observatory() {
  const catalogs = useOmniEye((s) => s.catalogs);
  const catalogStatus = useOmniEye((s) => s.catalogStatus);
  const catalogError = useOmniEye((s) => s.catalogError);
  const sky = useOmniEye((s) => s.sky);
  const layers = useOmniEye((s) => s.layers);
  const observation = useOmniEye((s) => s.observation);
  const [dragging, setDragging] = useState(false);
  const mounted = useMounted();

  // -- reference data ---------------------------------------------------------
  useEffect(() => {
    primeSky();
    let live = true;
    useOmniEye.getState().setCatalogStatus('loading');
    loadCatalogsOnce()
      .then((loaded) => {
        if (live) useOmniEye.getState().setCatalogs(loaded);
      })
      .catch((error: unknown) => {
        if (!live) return;
        useOmniEye.getState().setCatalogStatus('error', error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, []);

  // -- the clock --------------------------------------------------------------
  // One second. The sky turns 15 arcseconds in that time, far below anything the
  // screen can resolve, so there is no reason to recompute per frame.
  useEffect(() => {
    const id = window.setInterval(() => useOmniEye.getState().tick(), 1000);
    return () => window.clearInterval(id);
  }, []);

  const requestLocation = useCallback(() => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        useOmniEye.getState().setSite(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            elevation: position.coords.altitude ?? 0,
          },
          'geolocation',
        );
      },
      () => {
        /* Denied or unavailable. The default site stays, and the badge keeps
           saying it is a default -- no need for an error dialog. */
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }, []);

  const importMedia = useImportMedia();

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file?.type.startsWith('image/')) void importMedia(file);
    },
    [importMedia],
  );

  const summary = summarise(observation?.matched?.objects ?? [], observation?.observations ?? []);
  const predictedOpacity = layers.predicted ? 1 : 0;

  // Nothing here is meaningful on the server: the clock, the location, the WebGL
  // context and the media all belong to the browser. Rendering the loading shell
  // until mount keeps the prerendered HTML deterministic instead of asking React
  // to reconcile a timestamp that moved between the two.
  if (!mounted) return <LoadingSky status="loading" error={null} />;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {/* The sky, filling everything. */}
      <div className="absolute inset-0">
        {catalogs && sky ? (
          <SkyCanvas catalogs={catalogs} sky={sky} predictedOpacity={predictedOpacity} />
        ) : (
          <LoadingSky status={catalogStatus} error={catalogError} />
        )}
      </div>

      {/* Chrome floats over it. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
        <div className="relative flex items-start justify-between gap-3">
          <TopBar onRequestLocation={requestLocation} />
        </div>

        <div className="mt-3 flex min-h-0 flex-1 items-start justify-between gap-3">
          <div className="pointer-events-auto flex max-h-full flex-col gap-3 overflow-y-auto">
            <LayerPanel hasObservation={observation !== null} />
            <Legend hasObservation={observation !== null} hasMatches={summary.matched > 0} />
          </div>

          <div className="pointer-events-auto flex max-h-full min-h-0 flex-col items-end gap-3">
            {/* shrink-0: in a max-height flex column the grid would otherwise be
                compressed and spill its cells past the panel edge. */}
            <div className="shrink-0">
              <EvidenceGrid
                summary={summary}
                hasObservation={observation !== null}
                hasSolve={observation?.solve?.ok === true}
              />
            </div>
            {observation ? (
              <ObservationPanel
                observation={observation}
                onImport={importMedia}
                onClear={() => useOmniEye.getState().clearObservation()}
                onRedetect={(thresholdSigma) => {
                  useOmniEye.getState().setDetectionParams({ thresholdSigma });
                  void importMedia(null, { thresholdSigma });
                }}
              />
            ) : (
              <ImportPrompt onImport={importMedia} />
            )}
          </div>
        </div>

        <div className="mt-3 flex justify-center">
          <ReadoutBar />
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--ink)]/70 backdrop-blur-sm">
          <div className="rounded-md border border-dashed border-[var(--observed)] px-10 py-8 text-center">
            <p className="label-caps !text-[var(--observed)]">drop to begin reconstruction</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Runs an import through the reconstruction sequence, narrating each step.
 *
 * Passing `null` re-runs detection on the file already loaded, which is what the
 * threshold slider needs.
 */
function useImportMedia() {
  const lastFile = useRef<File | null>(null);

  return useCallback(async (file: File | null, overrides?: { thresholdSigma?: number }) => {
    const source = file ?? lastFile.current;
    if (!source) return;
    lastFile.current = source;

    const store = useOmniEye.getState();
    store.beginObservation({
      id: `${Date.now()}`,
      fileName: source.name,
      imageUrl: URL.createObjectURL(source),
      width: 1,
      height: 1,
      metadata: null,
      detection: null,
      saturatedFraction: 0,
    });

    const { setStep, updateObservation } = useOmniEye.getState();

    try {
      // 1. Metadata
      setStep('read', 'active');
      const metadata = await readMediaMetadata(source);
      updateObservation({ metadata });
      setStep(
        'read',
        'done',
        metadata.camera.model ?? (Object.keys(metadata.raw).length ? 'no camera model' : 'no EXIF'),
      );

      // 2. Location, then time. Both adopt the file's values when it has better
      //    ones than the current vantage -- and the badge in the top bar changes
      //    to say where they came from.
      setStep('locate', 'active');
      if (metadata.location) {
        useOmniEye.getState().setSite(metadata.location.site, 'exifGps');
      }
      if (metadata.time) {
        useOmniEye.getState().setTime(metadata.time.utc, metadata.time);
      }
      setStep(
        'locate',
        metadata.location || metadata.time ? 'done' : 'skipped',
        metadata.location
          ? 'from EXIF GPS'
          : metadata.time
            ? 'time only'
            : 'nothing in the file — using the vantage above',
      );

      // 3. The predicted sky already exists; setting the vantage rebuilt it.
      setStep('predict', 'active');
      const predicted = useOmniEye.getState().sky;
      setStep(
        'predict',
        'done',
        predicted ? `sun ${predicted.sunAltitude.toFixed(1)}°, ${predicted.twilight}` : undefined,
      );

      // 4. Pixels
      setStep('decode', 'active');
      const image = await loadImage(source);
      updateObservation({
        width: image.luminance.width,
        height: image.luminance.height,
        saturatedFraction: image.saturatedFraction,
      });
      setStep('decode', 'done', `${image.luminance.width}×${image.luminance.height}`);

      // 5. Detection, off the main thread. The luminance buffer is transferred,
      //    so it is gone from this side once the call is made.
      setStep('detect', 'active');
      const params = { ...useOmniEye.getState().detectionParams, ...overrides };
      const detection = await detect(image.luminance, params);

      // Every source starts unmatched. There is no code path that produces a
      // matched observation yet, and the type system is what guarantees that.
      const observations: Observation[] = detection.sources.map((s) => ({ state: 'unmatched', source: s }));

      updateObservation({ detection, observations });
      setStep('detect', 'done', `${detection.sources.length} sources`);

      // 6. Registration. The two lanes finally meet.
      setStep('align', 'active');
      const state = useOmniEye.getState();
      const catalogs = state.catalogs;
      const sky = state.sky;

      if (!catalogs || !sky) {
        setStep('align', 'skipped', 'catalogues not loaded');
        return;
      }

      // Which frame to solve in depends entirely on how much the vantage is
      // worth. An exact GPS fix and a GPS timestamp make the horizon a real
      // constraint worth exploiting; anything less and the horizon is a guess
      // that could exclude the very stars in the frame. See `chooseFrame`.
      const timeIsExact = metadata.time?.confidence === 'exact';
      const locationIsExact = metadata.location !== null;
      let frame = chooseFrame(timeIsExact, locationIsExact);

      const solveSources = detection.sources.map((s) => ({ id: s.id, x: s.x, y: s.y, flux: s.flux }));
      const fovPriorDeg = metadata.fieldOfView?.diagonalDeg ?? null;

      let result = await solve({
        sources: solveSources,
        width: image.luminance.width,
        height: image.luminance.height,
        fovPriorDeg,
        candidates: buildCandidates(catalogs, sky, frame, { magnitudeLimit: 6.0 }),
      });

      // A horizon solve that fails may be failing because the horizon was wrong,
      // not because the photograph was unidentifiable. Falling back to the whole
      // sky costs a second and answers a different, better question: what is in
      // this frame, regardless of where the camera was standing.
      if (!result.ok && frame === 'horizon') {
        frame = 'allSky';
        const retry = await solve({
          sources: solveSources,
          width: image.luminance.width,
          height: image.luminance.height,
          fovPriorDeg,
          // Shallower on the retry: the whole sky is twice the candidates with
          // no horizon to reject half of them, and the stars that identify a
          // frame are the bright ones either way.
          candidates: buildCandidates(catalogs, sky, frame, { magnitudeLimit: 5.8 }),
        });
        if (retry.ok || retry.significance > result.significance) result = retry;
      }

      const matched = buildMatchedSky(
        result,
        detection.sources,
        catalogs,
        sky,
        frame,
        image.luminance.width,
        image.luminance.height,
      );

      updateObservation({
        solve: result,
        solveFrame: frame,
        matched,
        observations: matched.observations,
      });

      if (result.ok && result.attitude) {
        // Swing the view to what the camera was actually looking at. Only when
        // the solve is trustworthy, and only in horizon mode -- an all-sky solve
        // has no opinion about altitude and azimuth.
        if (frame === 'horizon') {
          useOmniEye.getState().setView({
            altitude: result.attitude.altitude,
            azimuth: result.attitude.azimuth,
            fovDeg: Math.min(120, Math.max(8, result.attitude.fovDiagonalDeg * 1.6)),
          });
        }
        setStep(
          'align',
          'done',
          `${result.pairs.length} matched, RMS ${result.rmsArcmin?.toFixed(2) ?? '—'}′`,
        );
      } else {
        setStep('align', 'skipped', result.failure ?? 'no solve');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateObservation({ error: message });
      const active = useOmniEye.getState().observation?.steps.find((s) => s.status === 'active');
      if (active) setStep(active.id, 'failed', message);
    }
  }, []);
}

function ImportPrompt({ onImport }: { onImport: (file: File) => void }) {
  return (
    <Panel className="w-[248px] p-4">
      <span className="label-caps">Observation</span>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-dim)]">
        Import a photograph of the night sky. OmniEye will trace the point sources actually present in it,
        alongside the sky it predicts was overhead.
      </p>
      <label className="mt-3 flex cursor-pointer items-center justify-center rounded-sm border border-dashed border-[var(--panel-edge-strong)] px-3 py-4 transition-colors hover:border-[var(--observed)] hover:bg-white/[0.03]">
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
        <span className="label-caps !text-[var(--observed)]">choose a file, or drop one</span>
      </label>
    </Panel>
  );
}

function LoadingSky({ status, error }: { status: string; error: string | null }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--ink)]">
      <div className="w-[320px] text-center">
        <p className="readout text-[13px] tracking-[0.28em] text-[var(--text-dim)]">OMNIEYE</p>
        {status === 'error' ? (
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--alert)]">
            Could not load the catalogues. {error}
            <br />
            <span className="text-[var(--text-faint)]">
              Run <span className="readout">npm run catalog:fetch &amp;&amp; npm run catalog:build</span>.
            </span>
          </p>
        ) : (
          <>
            <p className="mt-3 text-[11px] text-[var(--text-faint)]">Loading catalogues…</p>
            <div className="mt-3 h-px w-full overflow-hidden bg-[var(--panel-edge)]">
              <div className="animate-sweep h-full w-1/3 bg-[var(--predicted)]" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
