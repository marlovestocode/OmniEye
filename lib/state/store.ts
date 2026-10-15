/**
 * Application state.
 *
 * Deliberately shallow and selector-friendly. The 3D scene reads from here every
 * frame, so anything that would cause a React re-render storm lives outside the
 * component tree: catalogues are plain objects held once, the predicted sky is
 * recomputed on a one-second tick rather than per frame, and the star buffer is
 * never in React's hands at all.
 *
 * The three layers are independent booleans, not a mode carousel. Turning
 * Predicted off while leaving Observed on answers "what did I actually capture"
 * in one click, and that question has to be one click away.
 */
import { create } from 'zustand';
import type { Catalogs } from '@/lib/astro/catalog';
import type { ObserverSite } from '@/lib/astro/frames';
import type { PredictedSky } from '@/lib/astro/predicted';
import { buildPredictedSky } from '@/lib/astro/predicted';
import type { DetectionRun } from '@/lib/detect/client';
import type { DetectionParams } from '@/lib/detect/types';
import type { MediaMetadata, ResolvedTime } from '@/lib/media/exif';
import type { SolveRun } from '@/lib/solve/client';
import type { SolveFrame } from '@/lib/solve/candidates';
import type { MatchedSky } from '@/lib/solve/match';
import type { Observation, SkyObject } from '@/lib/sky/evidence';

export type AppMode = 'observatory' | 'observation';

/** Where the observer is, and how much that is worth trusting. */
export type SiteSource = 'default' | 'geolocation' | 'exifGps' | 'userSupplied';

export interface LayerVisibility {
  predicted: boolean;
  observed: boolean;
  matched: boolean;
}

export interface SceneOptions {
  constellations: boolean;
  constellationLabels: boolean;
  horizon: boolean;
  cardinals: boolean;
  altAzGrid: boolean;
  equatorialGrid: boolean;
  deepSky: boolean;
  starLabels: boolean;
  atmosphere: boolean;
  /** Faintest star drawn. The catalogue is sorted, so this is a draw range. */
  magnitudeLimit: number;
}

/** One step of the import sequence, so the UI can narrate the reconstruction. */
export interface PipelineStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface ObservationState {
  id: string;
  fileName: string;
  /** Object URL for display. Revoked when the observation is replaced. */
  imageUrl: string;
  width: number;
  height: number;
  metadata: MediaMetadata | null;
  detection: DetectionRun | null;
  /** Evidence-side records: matched where the solve bound them, unmatched otherwise. */
  observations: Observation[];
  /** The registration attempt, successful or not. Null before it has been run. */
  solve: SolveRun | null;
  /** Which frame the solve ran in -- the observer's horizon, or the whole sky. */
  solveFrame: SolveFrame | null;
  /** The evidence model built from the solve. */
  matched: MatchedSky | null;
  steps: PipelineStep[];
  error: string | null;
  /** Fraction of the frame that came back saturated. */
  saturatedFraction: number;
}

interface State {
  mode: AppMode;

  // -- vantage ---------------------------------------------------------------
  site: ObserverSite;
  siteSource: SiteSource;
  time: Date;
  /** Live follows the clock; frozen holds whatever was set. */
  timeMode: 'live' | 'frozen';
  /** Where the working time came from, when it came from a file. */
  timeProvenance: ResolvedTime | null;

  // -- reference data --------------------------------------------------------
  catalogs: Catalogs | null;
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  catalogError: string | null;

  // -- derived ---------------------------------------------------------------
  sky: PredictedSky | null;

  // -- view ------------------------------------------------------------------
  layers: LayerVisibility;
  scene: SceneOptions;
  /** Camera aim, in the observer's own coordinates. */
  view: { altitude: number; azimuth: number; fovDeg: number };

  // -- evidence --------------------------------------------------------------
  observation: ObservationState | null;
  detectionParams: Partial<DetectionParams>;
  selected: SkyObject | null;
  hoveredSourceId: string | null;

  // -- actions ---------------------------------------------------------------
  setSite: (site: ObserverSite, source: SiteSource) => void;
  setTime: (time: Date, provenance?: ResolvedTime | null) => void;
  setTimeMode: (mode: 'live' | 'frozen') => void;
  tick: () => void;
  setCatalogs: (catalogs: Catalogs) => void;
  setCatalogStatus: (status: State['catalogStatus'], error?: string | null) => void;
  toggleLayer: (layer: keyof LayerVisibility) => void;
  setSceneOption: <K extends keyof SceneOptions>(key: K, value: SceneOptions[K]) => void;
  setView: (view: Partial<State['view']>) => void;
  setMode: (mode: AppMode) => void;
  beginObservation: (
    init: Omit<ObservationState, 'steps' | 'observations' | 'error' | 'solve' | 'solveFrame' | 'matched'>,
  ) => void;
  updateObservation: (patch: Partial<ObservationState>) => void;
  setStep: (id: string, status: PipelineStep['status'], detail?: string) => void;
  clearObservation: () => void;
  setDetectionParams: (params: Partial<DetectionParams>) => void;
  select: (object: SkyObject | null) => void;
  hoverSource: (id: string | null) => void;
}

/**
 * Greenwich, because it is the one place on Earth whose coordinates are a
 * definition rather than a guess. Replaced the moment geolocation or an EXIF tag
 * gives something real, and the UI always shows which is in force.
 */
const DEFAULT_SITE: ObserverSite = { latitude: 51.4779, longitude: -0.0015, elevation: 47 };

/**
 * The import sequence, named the way the design calls for: an instrument
 * reconstructing an observation, not a file upload with a spinner.
 *
 * "Aligning observed field" is present and starts as pending on purpose. It is
 * the next thing to build, and showing it greyed out is more honest than hiding
 * the fact that nothing has been aligned yet.
 */
export const PIPELINE_STEPS: PipelineStep[] = [
  { id: 'read', label: 'Reading metadata', status: 'pending' },
  { id: 'locate', label: 'Locating observation', status: 'pending' },
  { id: 'predict', label: 'Generating predicted sky', status: 'pending' },
  { id: 'decode', label: 'Decoding frame', status: 'pending' },
  { id: 'detect', label: 'Detecting stellar sources', status: 'pending' },
  { id: 'align', label: 'Aligning observed field', status: 'pending' },
];

export const useOmniEye = create<State>((set) => ({
  mode: 'observatory',

  site: DEFAULT_SITE,
  siteSource: 'default',
  time: new Date(),
  timeMode: 'live',
  timeProvenance: null,

  catalogs: null,
  catalogStatus: 'idle',
  catalogError: null,

  sky: null,

  layers: { predicted: true, observed: true, matched: true },
  scene: {
    constellations: true,
    constellationLabels: true,
    horizon: true,
    cardinals: true,
    altAzGrid: false,
    equatorialGrid: false,
    deepSky: true,
    starLabels: true,
    atmosphere: true,
    magnitudeLimit: 6.0,
  },
  view: { altitude: 25, azimuth: 180, fovDeg: 65 },

  observation: null,
  detectionParams: {},
  selected: null,
  hoveredSourceId: null,

  setSite: (site, source) =>
    set((s) => ({ site, siteSource: source, sky: buildPredictedSky({ site, time: s.time }) })),

  setTime: (time, provenance) =>
    set((s) => ({
      time,
      timeMode: 'frozen',
      timeProvenance: provenance ?? s.timeProvenance,
      sky: buildPredictedSky({ site: s.site, time }),
    })),

  setTimeMode: (timeMode) =>
    set((s) => {
      if (timeMode !== 'live') return { timeMode };
      const time = new Date();
      return { timeMode, time, sky: buildPredictedSky({ site: s.site, time }) };
    }),

  // Called on a one-second interval while live. The sky turns 15 arcseconds in
  // that time, which is far below anything the screen can show, so there is no
  // reason to pay for this per frame.
  tick: () =>
    set((s) => {
      if (s.timeMode !== 'live') return {};
      const time = new Date();
      return { time, sky: buildPredictedSky({ site: s.site, time }) };
    }),

  setCatalogs: (catalogs) =>
    set((s) => ({
      catalogs,
      catalogStatus: 'ready',
      catalogError: null,
      sky: s.sky ?? buildPredictedSky({ site: s.site, time: s.time }),
    })),

  setCatalogStatus: (catalogStatus, catalogError = null) => set({ catalogStatus, catalogError }),

  toggleLayer: (layer) => set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),

  setSceneOption: (key, value) => set((s) => ({ scene: { ...s.scene, [key]: value } })),

  setView: (view) => set((s) => ({ view: { ...s.view, ...view } })),

  setMode: (mode) => set({ mode }),

  beginObservation: (init) =>
    set((s) => {
      if (s.observation) URL.revokeObjectURL(s.observation.imageUrl);
      return {
        mode: 'observation',
        selected: null,
        observation: {
          ...init,
          steps: PIPELINE_STEPS.map((step) => ({ ...step })),
          observations: [],
          solve: null,
          solveFrame: null,
          matched: null,
          error: null,
        },
      };
    }),

  updateObservation: (patch) =>
    set((s) => (s.observation ? { observation: { ...s.observation, ...patch } } : {})),

  setStep: (id, status, detail) =>
    set((s) =>
      s.observation
        ? {
            observation: {
              ...s.observation,
              steps: s.observation.steps.map((step) =>
                step.id === id ? { ...step, status, detail: detail ?? step.detail } : step,
              ),
            },
          }
        : {},
    ),

  clearObservation: () =>
    set((s) => {
      if (s.observation) URL.revokeObjectURL(s.observation.imageUrl);
      return { observation: null, mode: 'observatory', hoveredSourceId: null };
    }),

  setDetectionParams: (params) => set((s) => ({ detectionParams: { ...s.detectionParams, ...params } })),

  select: (selected) => set({ selected }),

  hoverSource: (hoveredSourceId) => set({ hoveredSourceId }),
}));

/** Ensures a predicted sky exists without waiting for the first tick. */
export function primeSky(): void {
  const { sky, site, time } = useOmniEye.getState();
  if (!sky) useOmniEye.setState({ sky: buildPredictedSky({ site, time }) });
}
