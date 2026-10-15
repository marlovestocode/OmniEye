/**
 * Turning a solve into evidence.
 *
 * The solver deals in ids and residuals. This turns those into the app's actual
 * currency: `MatchedObject`s that may state a name as fact, `PredictedObject`s
 * that may not, and `Observation`s for the sources nothing accounts for.
 *
 * The four cells of the evidence grid are filled here, and this is the only place
 * in the codebase where a `MatchedObject` is constructed -- so the governing rule
 * has exactly one enforcement point rather than being spread across the renderer.
 */
import { Matrix3, Vector3 } from 'three';
import { ARCMIN, vectorToAltAz, type AltAz } from '@/lib/astro/frames';
import type { Catalogs } from '@/lib/astro/catalog';
import { deepSkyEntry, solarBodyEntry, starEntry, type PredictedSky } from '@/lib/astro/predicted';
import type { Source } from '@/lib/detect/types';
import {
  scoreMatch,
  type CatalogEntry,
  type MatchedObject,
  type Observation,
  type PredictedObject,
  type SkyObject,
  type UnconfirmedReason,
} from '@/lib/sky/evidence';
import { insideFrame, makeCamera, rayToPixel } from './camera';
import type { SolveFrame } from './candidates';
import type { SolveResult } from './types';

export interface MatchedSky {
  /** Everything the solve bound to evidence, plus everything it did not. */
  objects: SkyObject[];
  /** The evidence side: matched and unexplained sources. */
  observations: Observation[];
  /** Confidence per matched pair, keyed by source id. */
  confidence: Map<string, number>;
  /** Where each matched catalogue entry projects to in the frame, in pixels. */
  predictedPixels: Map<string, { x: number; y: number }>;
}

/** The catalogue entry behind a solver id, whichever catalogue it came from. */
function entryFor(id: string, catalogs: Catalogs, sky: PredictedSky): CatalogEntry | null {
  const [kind, key] = id.split(':');
  if (kind === 'star') {
    const index = Number(key);
    if (!Number.isFinite(index) || index >= catalogs.stars.count) return null;
    return starEntry(catalogs.stars, index);
  }
  if (kind === 'body') {
    const body = sky.solarBodies.find((b) => b.name === key);
    return body ? solarBodyEntry(body) : null;
  }
  if (kind === 'dso') {
    const object = catalogs.deepSky.byId.get(key);
    return object ? deepSkyEntry(object) : null;
  }
  return null;
}

/** Direction of a catalogue entry in the frame the solve was run in. */
function directionOf(id: string, catalogs: Catalogs, sky: PredictedSky, frame: SolveFrame): Vector3 | null {
  const [kind, key] = id.split(':');
  const v = new Vector3();

  if (kind === 'star') {
    const i = Number(key);
    if (!Number.isFinite(i) || i >= catalogs.stars.count) return null;
    v.set(catalogs.stars.positions[i * 3], catalogs.stars.positions[i * 3 + 1], catalogs.stars.positions[i * 3 + 2]);
  } else if (kind === 'body') {
    const body = sky.solarBodies.find((b) => b.name === key);
    if (!body) return null;
    v.copy(body.direction);
  } else {
    return null;
  }

  return frame === 'allSky' ? v : v.applyMatrix3(sky.rotation);
}

/**
 * Builds the evidence model from a completed solve.
 *
 * `sources` is every source the detector found, not only those the solver was
 * given, so that a source left unexplained is genuinely unexplained rather than
 * merely unexamined.
 */
export function buildMatchedSky(
  result: SolveResult,
  sources: Source[],
  catalogs: Catalogs,
  sky: PredictedSky,
  frame: SolveFrame,
  width: number,
  height: number,
): MatchedSky {
  const objects: SkyObject[] = [];
  const observations: Observation[] = [];
  const confidence = new Map<string, number>();
  const predictedPixels = new Map<string, { x: number; y: number }>();

  if (!result.ok || !result.attitude) {
    // No solve, no matches. Every source stays unexplained, and no catalogue
    // entry is granted a reason for going unconfirmed -- the question was asked
    // and not answered, which is not the same as answered in the negative.
    for (const source of sources) observations.push({ state: 'unmatched', source });
    return { objects, observations, confidence, predictedPixels };
  }

  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const matchedSourceIds = new Set<string>();
  const matchedCandidateIds = new Set<string>();
  const rmsArcmin = result.rmsArcmin ?? result.params.toleranceArcmin;

  for (const pair of result.pairs) {
    const source = sourceById.get(pair.sourceId);
    const catalog = entryFor(pair.candidateId, catalogs, sky);
    if (!source || !catalog) continue;

    const direction = directionOf(pair.candidateId, catalogs, sky, frame);
    const altAz: AltAz =
      direction && frame === 'horizon'
        ? vectorToAltAz(direction)
        : direction
          ? vectorToAltAz(direction.clone().applyMatrix3(sky.rotation))
          : { altitude: 0, azimuth: 0 };

    const score = scoreMatch({
      residualArcmin: pair.residualArcmin,
      toleranceArcmin: result.params.toleranceArcmin,
      nextNearestArcmin: pair.nextNearestArcmin,
      solveRmsArcmin: rmsArcmin,
    });

    const matched: MatchedObject = {
      state: 'matched',
      catalog,
      altAz,
      observed: source,
      residualArcmin: pair.residualArcmin,
      score,
    };
    objects.push(matched);
    observations.push({
      state: 'matched',
      source,
      objectId: catalog.id,
      residualArcmin: pair.residualArcmin,
    });

    confidence.set(source.id, score);
    predictedPixels.set(source.id, { x: pair.predictedX, y: pair.predictedY });
    matchedSourceIds.add(source.id);
    matchedCandidateIds.add(pair.candidateId);
  }

  for (const source of sources) {
    if (!matchedSourceIds.has(source.id)) observations.push({ state: 'unmatched', source });
  }

  // The unconfirmed cell: predicted objects that fall inside the solved frame and
  // were not found. This is the half of the grid most apps discard, and it is the
  // half that says something -- cloud, a detection floor, or a bad frame edge.
  objects.push(
    ...unconfirmedInFrame(result, catalogs, sky, frame, matchedCandidateIds, width, height),
  );

  return { objects, observations, confidence, predictedPixels };
}

/**
 * Catalogue entries that the solved frame covers but the image did not show.
 *
 * Each carries a reason, and the reasons are ranked by how much the pipeline
 * actually knows. `belowDetectionFloor` is asserted only when the object is
 * fainter than the faintest thing the detector did find -- which is a measurement
 * of this image, not a general claim about the equipment.
 */
function unconfirmedInFrame(
  result: SolveResult,
  catalogs: Catalogs,
  sky: PredictedSky,
  frame: SolveFrame,
  matchedCandidateIds: Set<string>,
  width: number,
  height: number,
): PredictedObject[] {
  const attitude = result.attitude;
  if (!attitude) return [];

  const r = attitude.rotation;
  const rotation = new Matrix3().set(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]);
  const inverse = rotation.clone().invert();
  // The real frame, not one reconstructed from the field of view. Deriving the
  // dimensions back out of the solved angles would be circular, and would put the
  // frame edge in a slightly different place than the image's own.
  const camera = makeCamera(width, height, attitude.focal, attitude.k1);

  const faintestMatchedMagnitude = limitingMagnitude(result, catalogs);

  const out: PredictedObject[] = [];
  const v = new Vector3();
  const limit = catalogs.stars.countBrighterThan(8);

  for (let i = 0; i < limit; i++) {
    const id = `star:${i}`;
    if (matchedCandidateIds.has(id)) continue;

    v.set(
      catalogs.stars.positions[i * 3],
      catalogs.stars.positions[i * 3 + 1],
      catalogs.stars.positions[i * 3 + 2],
    );
    if (frame !== 'allSky') v.applyMatrix3(sky.rotation);

    const cameraRay = v.clone().applyMatrix3(inverse);
    const pixel = rayToPixel(camera, cameraRay);
    if (!pixel || !insideFrame(camera, pixel.x, pixel.y, -4)) continue;

    const magnitude = catalogs.stars.magnitudes[i];
    let reason: UnconfirmedReason = 'noCounterpart';
    if (faintestMatchedMagnitude !== null && magnitude > faintestMatchedMagnitude) {
      reason = 'belowDetectionFloor';
    }

    out.push({
      state: 'predicted',
      catalog: starEntry(catalogs.stars, i),
      altAz: vectorToAltAz(frame === 'allSky' ? v.clone().applyMatrix3(sky.rotation) : v),
      unconfirmedBecause: reason,
    });
  }

  return out;
}

/**
 * The faintest magnitude this image demonstrably reached.
 *
 * Taken from the faintest star that actually matched, not from an exposure
 * calculation. It is a statement about this photograph and nothing else.
 */
function limitingMagnitude(result: SolveResult, catalogs: Catalogs): number | null {
  let faintest: number | null = null;
  for (const pair of result.pairs) {
    const [kind, key] = pair.candidateId.split(':');
    if (kind !== 'star') continue;
    const i = Number(key);
    if (!Number.isFinite(i) || i >= catalogs.stars.count) continue;
    const m = catalogs.stars.magnitudes[i];
    if (faintest === null || m > faintest) faintest = m;
  }
  return faintest;
}

/** Boresight right ascension and declination, for an all-sky solve. */
export function boresightEquatorial(attitude: { boresight: [number, number, number] }): {
  ra: number;
  dec: number;
} {
  const [x, y, z] = attitude.boresight;
  const ra = Math.atan2(y, x);
  return { ra: ra < 0 ? ra + 2 * Math.PI : ra, dec: Math.asin(Math.max(-1, Math.min(1, z))) };
}

/** A compact human summary of a solve, for the alignment readout. */
export function describeSolve(result: SolveResult): {
  matched: number;
  rms: string;
  field: string;
  scale: string;
  significance: string;
} {
  return {
    matched: result.pairs.length,
    rms: result.rmsArcmin === null ? '—' : `${result.rmsArcmin.toFixed(2)}′`,
    field: result.attitude ? `${result.attitude.fovDiagonalDeg.toFixed(1)}°` : '—',
    scale: result.attitude ? `${result.attitude.pixelScaleArcsec.toFixed(1)}″/px` : '—',
    significance: `${result.significance.toFixed(0)}σ`,
  };
}

/** Angular separation helper, arcminutes, for callers outside the solver. */
export function separationArcmin(a: Vector3, b: Vector3): number {
  return (2 * Math.asin(Math.min(1, a.distanceTo(b) / 2))) / ARCMIN;
}
