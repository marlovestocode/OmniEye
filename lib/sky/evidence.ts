/**
 * The evidence model.
 *
 * Crossing prediction against detection gives four cells:
 *
 *                        DETECTED IN MEDIA          NOT DETECTED
 *   PREDICTED            MATCHED                    UNCONFIRMED
 *   NOT PREDICTED        UNEXPLAINED                (not representable)
 *
 * Those three representable cells are exactly the three variants below, and the
 * fourth has no type, because a thing that is neither predicted nor observed is
 * not a thing at all.
 *
 * The governing rule -- nothing is presented as confirmed unless it sits in the
 * matched cell -- is enforced structurally rather than by review:
 *
 *   - `PredictedObject` has no `observed` field, so nothing can read evidence off
 *     a prediction, even by accident.
 *   - `confirmedLabel()` accepts only `MatchedObject`. There is no way to obtain a
 *     confirmed name for something that was never detected; the compiler rejects
 *     it at the call site.
 *   - `UnmatchedObservation` has no catalogue entry, so an unexplained source
 *     cannot be given a name at all.
 *
 * Phase 2 fills in the matching that produces `MatchedObject`. Until then the
 * predicted lane produces only `PredictedObject` and the detection lane only
 * `UnmatchedObservation` -- which is the correct, honest state of the app, not a
 * gap in it.
 */
import type { Source } from '@/lib/detect/types';
import type { AltAz } from '@/lib/astro/frames';

// -- what the ephemeris says should be there ----------------------------------

/** Which catalogue an entry came from. */
export type CatalogKind = 'star' | 'deepSky' | 'solarBody';

/** A catalogue entry: an identity the ephemeris can offer, before any evidence. */
export interface CatalogEntry {
  kind: CatalogKind;
  /** Stable identifier: `star:1234`, `dso:M31`, `body:Jupiter`. */
  id: string;
  /** The name this entry would carry *if* it were ever confirmed. */
  name: string | null;
  /** Catalogue designations, most specific first. */
  designations: string[];
  /** J2000 right ascension and declination, radians. */
  ra: number;
  dec: number;
  /** Predicted apparent visual magnitude, where the catalogue has one. */
  magnitude: number | null;
  /** Angular extent in arcminutes; null for anything treated as a point. */
  angularSizeArcmin: number | null;
  constellation: string | null;
}

// -- the three representable cells --------------------------------------------

/**
 * UNCONFIRMED. Predicted here, nothing detected here.
 *
 * The interesting cell: the sky may have been cloudy there, the object may be
 * below the detection floor, or the pointing may be off. Renders as a ghost, and
 * is never labelled as seen.
 */
export interface PredictedObject {
  state: 'predicted';
  catalog: CatalogEntry;
  altAz: AltAz;
  /**
   * Why no counterpart was found, when the pipeline can tell. `null` means the
   * question has not been asked yet -- there is no media, or no solve.
   */
  unconfirmedBecause: UnconfirmedReason | null;
}

/**
 * Reasons a prediction can go unconfirmed, in decreasing order of how much the
 * pipeline actually knows.
 *
 *   outsideField        the solved frame does not cover this direction at all
 *   belowHorizon        not observable from this site at this time
 *   belowDetectionFloor fainter than the faintest source the image did yield
 *   noCounterpart       inside the field, bright enough, and still nothing there
 */
export type UnconfirmedReason =
  | 'outsideField'
  | 'belowHorizon'
  | 'belowDetectionFloor'
  | 'noCounterpart';

/**
 * MATCHED. Predicted here, detected here, and the two were bound together.
 * The only variant permitted to state a name as fact.
 */
export interface MatchedObject {
  state: 'matched';
  catalog: CatalogEntry;
  altAz: AltAz;
  /** The evidence. Present only in this variant, by design. */
  observed: Source;
  /** Angular distance between prediction and observation, arcminutes. */
  residualArcmin: number;
  /** Match confidence, 0..1. See `scoreMatch`. */
  score: number;
}

export type SkyObject = PredictedObject | MatchedObject;

/**
 * UNEXPLAINED. Detected, but nothing in the catalogue accounts for it.
 *
 * A satellite, an aircraft, a hot pixel, a cosmic ray -- or something new. The
 * app does not guess which, and this type deliberately has nowhere to put a name.
 */
export interface UnmatchedObservation {
  state: 'unmatched';
  source: Source;
}

/** The observation side of a match: the same binding, seen from the evidence. */
export interface MatchedObservation {
  state: 'matched';
  source: Source;
  /** `CatalogEntry.id` of the object this source was bound to. */
  objectId: string;
  residualArcmin: number;
}

export type Observation = UnmatchedObservation | MatchedObservation;

// -- narrowing ----------------------------------------------------------------

export const isMatched = (o: SkyObject): o is MatchedObject => o.state === 'matched';
export const isPredictedOnly = (o: SkyObject): o is PredictedObject => o.state === 'predicted';
export const isUnexplained = (o: Observation): o is UnmatchedObservation => o.state === 'unmatched';

// -- labelling ----------------------------------------------------------------

/**
 * The confirmed name of an object, stated as fact.
 *
 * The parameter type is the enforcement. There is no overload taking a
 * `SkyObject`, no default, and no escape hatch: if you have not got a match in
 * hand, this function will not compile.
 */
export function confirmedLabel(object: MatchedObject): string {
  return object.catalog.name ?? object.catalog.designations[0] ?? object.catalog.id;
}

/**
 * What to show for a prediction. Always hedged, and never rendered in the same
 * visual language as a confirmed label.
 */
export function predictedLabel(object: PredictedObject): string {
  const name = object.catalog.name ?? object.catalog.designations[0] ?? object.catalog.id;
  return `${name} — predicted`;
}

/** What to show for a source with no explanation. Never a name. */
export function unexplainedLabel(observation: UnmatchedObservation): string {
  const { shape } = observation.source;
  if (shape === 'trailed') return 'unresolved moving source';
  if (shape === 'sharp') return 'unresolved sharp source';
  return 'unexplained source';
}

/** One-word status for a `SkyObject`, for legends and filters. */
export function evidenceState(object: SkyObject): 'matched' | 'unconfirmed' {
  return object.state === 'matched' ? 'matched' : 'unconfirmed';
}

// -- scoring ------------------------------------------------------------------

export interface MatchScoreInputs {
  /** Angular residual of this pair, arcminutes. */
  residualArcmin: number;
  /** The accepted residual cutoff for the solve, arcminutes. */
  toleranceArcmin: number;
  /** Angular distance to the next-nearest candidate, arcminutes. */
  nextNearestArcmin: number;
  /** RMS residual of the whole solve, arcminutes. */
  solveRmsArcmin: number;
}

/**
 * Confidence in a single pairing, 0..1.
 *
 * Two factors, both of which must hold:
 *
 *   closeness   how far inside the tolerance this pair sits
 *   isolation   how much closer this candidate is than the runner-up
 *
 * Isolation is the one that matters in a dense field. A pair that is 1 arcminute
 * away means very little if the second-best candidate is 1.1 arcminutes away, and
 * a score that ignored that would read as confident precisely where it should not.
 */
export function scoreMatch({
  residualArcmin,
  toleranceArcmin,
  nextNearestArcmin,
  solveRmsArcmin,
}: MatchScoreInputs): number {
  const scale = Math.max(solveRmsArcmin, toleranceArcmin / 3, 1e-6);
  const closeness = Math.exp(-0.5 * (residualArcmin / scale) ** 2);

  const ratio = Number.isFinite(nextNearestArcmin)
    ? nextNearestArcmin / Math.max(residualArcmin, 1e-6)
    : Number.POSITIVE_INFINITY;
  // Ambiguous below 1.5x, effectively decisive by 4x.
  const isolation = ratio <= 1 ? 0 : Math.min(1, Math.log(ratio) / Math.log(4));

  return Math.max(0, Math.min(1, closeness * isolation));
}

// -- aggregate ----------------------------------------------------------------

/** The four-cell tally, which is the app's headline honesty number. */
export interface EvidenceSummary {
  matched: number;
  unconfirmed: number;
  unexplained: number;
  /** Predicted objects fainter than anything this image actually yielded. */
  belowFloor: number;
  /**
   * Fraction of predicted objects the image could plausibly have shown that it
   * did show.
   *
   * Objects fainter than the faintest thing the frame yielded are excluded from
   * the denominator. Counting them would make the number a measurement of the
   * catalogue's depth rather than of the observation: predict down to magnitude
   * eight against a photograph that reached magnitude five and the "confirmed"
   * rate collapses to a tenth, while saying nothing at all about the sky.
   */
  confirmedFraction: number | null;
  /** RMS of matched residuals, arcminutes. Null with nothing matched. */
  rmsResidualArcmin: number | null;
}

export function summarise(objects: SkyObject[], observations: Observation[]): EvidenceSummary {
  let matched = 0;
  let unconfirmed = 0;
  let belowFloor = 0;
  let sumSq = 0;

  for (const o of objects) {
    if (o.state === 'matched') {
      matched++;
      sumSq += o.residualArcmin ** 2;
      continue;
    }
    // Only things the media had a chance of showing count against the rate.
    if (o.unconfirmedBecause === 'outsideField' || o.unconfirmedBecause === 'belowHorizon') continue;
    if (o.unconfirmedBecause === 'belowDetectionFloor') {
      belowFloor++;
      continue;
    }
    unconfirmed++;
  }

  const unexplained = observations.reduce((n, o) => n + (o.state === 'unmatched' ? 1 : 0), 0);
  const inPlay = matched + unconfirmed;

  return {
    matched,
    unconfirmed,
    belowFloor,
    unexplained,
    confirmedFraction: inPlay > 0 ? matched / inPlay : null,
    rmsResidualArcmin: matched > 0 ? Math.sqrt(sumSq / matched) : null,
  };
}
