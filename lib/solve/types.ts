/**
 * What a plate solve takes and what it hands back.
 *
 * Kept as plain data so the whole thing can cross a worker boundary: the solver
 * receives packed arrays and returns packed arrays, and the main thread turns the
 * result into `MatchedObject`s afterwards. Nothing here references three.js or
 * the catalogue objects.
 */

/** One candidate the solve is allowed to match against. */
export interface SolveCandidate {
  /** `star:1234`, `body:Jupiter`. Matches `CatalogEntry.id`. */
  id: string;
  /** Unit vector in scene space -- the observer's own alt/az frame. */
  x: number;
  y: number;
  z: number;
  /** Apparent visual magnitude; brighter sorts first. */
  magnitude: number;
}

/** A detected source reduced to what the solver needs. */
export interface SolveSource {
  id: string;
  x: number;
  y: number;
  flux: number;
}

export interface SolveParams {
  /** Widest diagonal field of view to consider, degrees. */
  maxFovDeg: number;
  /** Narrowest diagonal field of view to consider, degrees. */
  minFovDeg: number;
  /**
   * How many of the brightest sources may anchor a hypothesis.
   *
   * More than one because the brightest thing in a frame is not reliably a
   * catalogued star -- it can be a satellite, an aircraft, a streetlight or a
   * lens flare, and a search anchored only on it would fail outright.
   */
  anchorSources: number;
  /** How many of the brightest catalogue entries may anchor a hypothesis. */
  anchorCandidates: number;
  /** How many sources take part in hypothesis generation. */
  hypothesisSources: number;
  /** How many sources take part in scoring a hypothesis. */
  verifySources: number;
  /**
   * How many of the brightest catalogue entries a hypothesis may pair against.
   *
   * A hypothesis pairs the brightest sources in the frame, whose counterparts are
   * necessarily bright stars. Searching the whole visible catalogue for a ring
   * partner spends nearly all its time on stars that could not have produced the
   * source being matched.
   */
  hypothesisCandidates: number;
  /**
   * Hard ceiling on hypotheses tested, so a pathological frame fails in bounded
   * time rather than hanging. Reaching it is reported, not hidden.
   */
  maxHypotheses: number;
  /**
   * Abandon a hypothesis that has matched nothing after this many independent
   * sources. Zero checks every source.
   *
   * Aggressive on the first pass, where the assumption that a correct hypothesis
   * agrees with the frame almost immediately is nearly always right; relaxed on
   * later passes, where a correct hypothesis genuinely can miss its first few
   * sources because those sources are satellites rather than stars.
   */
  quickRejectAfter: number;
  /**
   * Wall-clock budget for the whole solve, milliseconds.
   *
   * An interactive app cannot offer an unbounded search. The escalation stops
   * when this is spent and reports the most convincing thing it found, which is
   * usually a refusal -- and a refusal after a bounded wait is a far better
   * product than a correct answer that arrives whenever it arrives.
   */
  deadlineMs: number;
  /** Accepted residual for a pair, in pixels, before refinement. */
  coarseTolerancePixels: number;
  /** Accepted residual after refinement, in arcminutes. */
  toleranceArcmin: number;
  /** A solve with fewer inliers than this is refused, whatever its significance. */
  minInliers: number;
  /**
   * How many standard deviations the match count must stand above what chance
   * alone would supply.
   *
   * A fixed inlier count cannot work here. Against a catalogue of several
   * thousand entries and a tolerance of a few arcminutes, six coincidental
   * matches are not rare -- they are expected. What matters is the excess over
   * chance, computed from the density of catalogue entries inside the solved
   * frame, and that scales correctly whether the frame holds eight stars or eight
   * hundred.
   */
  minSignificance: number;
  /**
   * The winning hypothesis must beat the best *disagreeing* hypothesis by this
   * factor in score. A solve that is merely the best of several similar readings
   * of the sky is not a solve.
   */
  ambiguityMargin: number;
  /** Fit a radial distortion term once the attitude has converged. */
  fitDistortion: boolean;
}

export const DEFAULT_SOLVE_PARAMS: SolveParams = {
  minFovDeg: 6,
  maxFovDeg: 130,
  anchorSources: 4,
  anchorCandidates: 70,
  hypothesisSources: 10,
  verifySources: 16,
  hypothesisCandidates: 250,
  maxHypotheses: 700_000,
  quickRejectAfter: 4,
  deadlineMs: 20_000,
  coarseTolerancePixels: 8,
  toleranceArcmin: 12,
  minInliers: 6,
  minSignificance: 6,
  ambiguityMargin: 1.35,
  fitDistortion: true,
};

/** One accepted correspondence. */
export interface SolvedPair {
  sourceId: string;
  candidateId: string;
  /** Where the catalogue entry projects to, in pixels. */
  predictedX: number;
  predictedY: number;
  /** Where the source actually is, in pixels. */
  observedX: number;
  observedY: number;
  /** Separation on the sky, arcminutes. */
  residualArcmin: number;
  /** Distance to the next-nearest candidate, arcminutes. */
  nextNearestArcmin: number;
}

export interface SolvedAttitude {
  /** Rotation from the camera frame into whichever frame the candidates were in. */
  rotation: number[];
  /** Boresight as a unit vector in that same frame. */
  boresight: [number, number, number];
  /**
   * Boresight altitude and azimuth. Meaningful only for a solve run against the
   * observer's horizon; for an all-sky solve these are computed from the stated
   * vantage, which is precisely what such a solve does not trust.
   */
  altitude: number;
  azimuth: number;
  /**
   * Rotation of the frame about the boresight, degrees. Zero puts image "up"
   * towards the zenith; positive turns the frame clockwise as seen by the viewer.
   */
  roll: number;
  focal: number;
  k1: number;
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
  fovDiagonalDeg: number;
  pixelScaleArcsec: number;
}

export type SolveFailure =
  | 'tooFewSources'
  | 'noHypothesis'
  | 'tooFewInliers'
  | 'notSignificant'
  | 'ambiguous'
  | 'residualTooLarge';

export interface SolveResult {
  ok: boolean;
  /** Which escalation pass produced this result, counting from one. */
  pass: number;
  /** True when the search stopped because its time budget ran out. */
  timedOut: boolean;
  failure: SolveFailure | null;
  /** Plain-language account of what happened, shown in the UI verbatim. */
  message: string;
  attitude: SolvedAttitude | null;
  pairs: SolvedPair[];
  /** RMS of accepted residuals, arcminutes. */
  rmsArcmin: number | null;
  /** How many matches this many sources would find by coincidence alone. */
  expectedByChance: number;
  /** Excess of the match count over chance, in standard deviations. */
  significance: number;
  /** Largest accepted residual, arcminutes. */
  maxArcmin: number | null;
  /** How many candidates fell inside the solved frame at all. */
  candidatesInFrame: number;
  /** Inlier count of the runner-up hypothesis, for the ambiguity test. */
  runnerUpInliers: number;
  hypothesesTested: number;
  elapsedMs: number;
  params: SolveParams;
}
