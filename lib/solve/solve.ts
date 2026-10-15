/**
 * Plate solving: the step where the two lanes finally meet.
 *
 * Up to here nothing has been claimed. The predicted lane knows where everything
 * should be; the evidence lane knows where bright things actually are. This
 * module proposes correspondences between them, and -- crucially -- refuses most
 * of what it proposes.
 *
 * The shape of the search:
 *
 *   1. Anchor.     Assume one bright source is one bright catalogue entry.
 *   2. Scale.      A second source at a known angular distance from the anchor
 *                  fixes the focal length outright, in closed form. No field of
 *                  view grid, no assumption about the lens.
 *   3. Attitude.   Two correspondences determine a rotation completely (TRIAD).
 *   4. Verify.     Project the other sources and count how many land on something.
 *   5. Refine.     Kabsch on the inliers, then focal length, then distortion,
 *                  re-associating and tightening the tolerance each round.
 *   6. Gate.       Mutual nearest neighbour, a hard angular cutoff, a minimum
 *                  inlier count, and a margin over the runner-up hypothesis.
 *
 * Step 6 is the one that matters. Plain nearest-neighbour matching in a dense
 * field will confidently pair the wrong stars and produce a beautiful-looking
 * wrong answer, so a pair is accepted only when each is the other's nearest --
 * being closest one way is not a match -- and a solve is accepted only when it is
 * decisively better than the second-best reading of the same frame.
 */
import { Matrix3, Vector3 } from 'three';
import { ARCMIN, RAD, vectorToAltAz } from '@/lib/astro/frames';
import {
  diagonalFovFromFocal,
  fieldOfView,
  focalsForAngle,
  focalFromDiagonalFov,
  insideFrame,
  makeCamera,
  pixelScaleArcsec,
  pixelToRay,
  rayToPixel,
  type CameraModel,
} from './camera';
import { annulus, buildSphereIndex, nearest, type SphereIndex } from './sphereIndex';
import { solveRotation, triadRotation, type VectorPair } from './wahba';
import {
  DEFAULT_SOLVE_PARAMS,
  type SolveCandidate,
  type SolveParams,
  type SolveResult,
  type SolveSource,
  type SolvedAttitude,
  type SolvedPair,
} from './types';

export interface SolveRequest {
  sources: SolveSource[];
  width: number;
  height: number;
  /**
   * Diagonal field of view from EXIF, degrees. A hint that narrows the search,
   * never a constraint on the answer -- phones crop and stabilise, so the
   * recorded focal length routinely disagrees with the delivered frame.
   */
  fovPriorDeg?: number | null;
  candidates: SolveCandidate[];
  params?: Partial<SolveParams>;
}

/** Working copy of a candidate set, packed for the index. */
interface CandidateSet {
  /** Everything visible. Used for scoring and for the final association. */
  index: SphereIndex;
  /**
   * The brightest slice only, indexed separately for hypothesis generation.
   *
   * A hypothesis pairs the *brightest* sources in the frame, and their
   * counterparts are necessarily bright stars -- so searching the full visible
   * catalogue for a ring partner spends almost all its time on stars that could
   * never have produced the source being matched. Restricting the ring query to
   * the bright prefix cuts the search by nearly an order of magnitude without
   * changing which solves are reachable. Indices are shared with `index` because
   * the array is sorted brightest-first and this is a prefix of it.
   */
  bright: SphereIndex;
  brightCount: number;
  ids: string[];
  magnitudes: Float32Array;
  points: Float32Array;
  count: number;
}

function packCandidates(candidates: SolveCandidate[], brightCount: number): CandidateSet {
  // Brightest first, so "the anchor candidates" is a prefix.
  const sorted = [...candidates].sort((a, b) => a.magnitude - b.magnitude);
  const points = new Float32Array(sorted.length * 3);
  const magnitudes = new Float32Array(sorted.length);
  const ids: string[] = new Array(sorted.length);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const len = Math.hypot(c.x, c.y, c.z) || 1;
    points[i * 3] = c.x / len;
    points[i * 3 + 1] = c.y / len;
    points[i * 3 + 2] = c.z / len;
    magnitudes[i] = c.magnitude;
    ids[i] = c.id;
  }

  // Two degree bins: comfortably larger than any tolerance, small enough that a
  // lookup touches a handful of entries.
  const bright = Math.min(brightCount, sorted.length);
  return {
    index: buildSphereIndex(points, sorted.length, 2 / RAD),
    bright: buildSphereIndex(points, bright, 3 / RAD),
    brightCount: bright,
    ids,
    magnitudes,
    points,
    count: sorted.length,
  };
}

const vecAt = (points: Float32Array, i: number, out: Vector3) =>
  out.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);

/** Angle between two unit vectors, accurate all the way down to arcseconds. */
const angleBetweenUnit = (a: Vector3, b: Vector3) => 2 * Math.asin(Math.min(1, a.distanceTo(b) / 2));

interface Hypothesis {
  rotation: Matrix3;
  focal: number;
  inliers: number;
  score: number;
  /** Where this hypothesis says the camera was pointing. */
  boresight: Vector3;
}

/**
 * The best few *distinct* hypotheses.
 *
 * The ambiguity gate asks whether some other reading of the frame fits nearly as
 * well. Answering it needs genuinely different attitudes, and a naive "keep the
 * previous best" runner-up does not give them: as the search closes in on the
 * truth it produces hundreds of near-identical hypotheses, and the runner-up ends
 * up being the same solve found again. Every real frame then looks ambiguous.
 *
 * So hypotheses pointing within `MERGE_ANGLE` of one already held are treated as
 * the same solution and merged, keeping the better. What survives are readings
 * that actually disagree about where the camera was.
 */
const MERGE_ANGLE = 4 / RAD;

class HypothesisSet {
  readonly items: Hypothesis[] = [];
  private readonly limit: number;

  constructor(limit = 4) {
    this.limit = limit;
  }

  offer(candidate: Hypothesis): void {
    for (let i = 0; i < this.items.length; i++) {
      if (angleBetweenUnit(this.items[i].boresight, candidate.boresight) < MERGE_ANGLE) {
        if (candidate.score > this.items[i].score) {
          this.items[i] = candidate;
          this.items.sort((a, b) => b.score - a.score);
        }
        return;
      }
    }
    this.items.push(candidate);
    this.items.sort((a, b) => b.score - a.score);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }

  get best(): Hypothesis | null {
    return this.items[0] ?? null;
  }

  /** The best hypothesis that disagrees with the winner about where to look. */
  get alternative(): Hypothesis | null {
    return this.items[1] ?? null;
  }
}

/**
 * Scores one attitude by projecting sources into the sky and counting how many
 * land on a catalogue entry.
 *
 * Deliberately one-way and approximate. This runs hundreds of thousands of times,
 * so it exists only to rank hypotheses; the mutual-nearest-neighbour test that
 * actually decides what is a match happens once, later, on the winner.
 *
 * The raw count is not comparable between hypotheses, and using it directly is a
 * trap. A hypothesis that proposes a very wide field gets a correspondingly wide
 * angular tolerance, sweeps up far more sky per source, and collects inliers by
 * chance alone -- on a dense catalogue a nonsense wide-field fit can match every
 * source it is given. So the expected number of chance hits is computed from the
 * catalogue's own density and subtracted. What remains is agreement the sky did
 * not have to provide, which is comparable across every scale.
 */
function scoreHypothesis(
  sources: SolveSource[],
  camera: CameraModel,
  rotation: Matrix3,
  set: CandidateSet,
  tolerance: number,
  limit: number,
  needed: number,
  /** The two sources the hypothesis was built from. They match by construction. */
  skipA: number,
  skipB: number,
  /**
   * Abandon a hypothesis that has produced nothing after this many independent
   * sources. Zero disables it.
   */
  quickRejectAfter: number,
): { inliers: number; score: number } {
  const ray = new Vector3();
  let inliers = 0;
  let raw = 0;
  let examined = 0;
  const n = Math.min(limit, sources.length);

  for (let i = 0; i < n; i++) {
    // The pair that generated this attitude agrees with it by construction, so
    // counting them would give every hypothesis two free matches and tell us
    // nothing about whether the rest of the frame agrees.
    if (i === skipA || i === skipB) continue;

    // Bail as soon as even a perfect run on what remains could not reach the bar.
    if (inliers + (n - i) < needed) break;

    pixelToRay(camera, sources[i].x, sources[i].y, ray).applyMatrix3(rotation);
    const hit = nearest(set.index, ray, tolerance);
    examined++;
    if (hit.index >= 0) {
      inliers++;
      // A tight match counts for more than a loose one, so a fit that merely
      // scatters sources near catalogue entries cannot tie with one that lands
      // on them.
      raw += 1 - hit.angle / tolerance;
    } else if (quickRejectAfter > 0 && inliers === 0 && examined >= quickRejectAfter) {
      // Nothing at all after several independent sources. The overwhelming
      // majority of hypotheses are wrong, and dismissing them after a handful of
      // lookups instead of projecting the whole frame is most of the search's
      // speed. It is switched off on the deeper passes, where a correct
      // hypothesis really can miss its first few sources because those sources
      // are satellites.
      break;
    }
  }

  // Expected chance hits: sources x catalogue density x the solid angle each
  // search disc covers. The 1/3 is the mean of (1 - r/tol) over a uniform disc,
  // which is what a chance hit contributes on average.
  const expected = (examined * set.count * tolerance * tolerance) / 4;
  return { inliers, score: raw - expected / 3 };
}

/** Mutual nearest neighbour association between sources and candidates. */
function associate(
  sources: SolveSource[],
  camera: CameraModel,
  rotation: Matrix3,
  set: CandidateSet,
  tolerance: number,
): SolvedPair[] {
  const ray = new Vector3();
  const inverse = rotation.clone().invert();

  // Forward: each source's nearest candidate.
  const forward = new Map<number, { source: number; angle: number; next: number }>();
  const sourceBest: (number | null)[] = new Array(sources.length).fill(null);

  const scratch: number[] = [];
  for (let s = 0; s < sources.length; s++) {
    pixelToRay(camera, sources[s].x, sources[s].y, ray).applyMatrix3(rotation);
    const hit = nearest(set.index, ray, tolerance);
    if (hit.index < 0) continue;

    // The distance to the runner-up is what makes a match trustworthy in a dense
    // field, so it is measured here and carried into the score.
    let next = Infinity;
    annulus(set.index, ray, 0, tolerance * 4, scratch);
    const probe = new Vector3();
    for (const c of scratch) {
      if (c === hit.index) continue;
      vecAt(set.points, c, probe);
      next = Math.min(next, angleBetweenUnit(ray, probe));
    }

    sourceBest[s] = hit.index;
    const existing = forward.get(hit.index);
    if (!existing || hit.angle < existing.angle) {
      forward.set(hit.index, { source: s, angle: hit.angle, next });
    }
  }

  const pairs: SolvedPair[] = [];
  const camRay = new Vector3();
  const candidate = new Vector3();

  for (const [candidateIndex, best] of forward) {
    // Mutual: the candidate's nearest source must be the same source that chose
    // it. A pair that is merely closest one way is not a match.
    if (sourceBest[best.source] !== candidateIndex) continue;

    vecAt(set.points, candidateIndex, candidate);
    camRay.copy(candidate).applyMatrix3(inverse);
    const predicted = rayToPixel(camera, camRay);
    if (!predicted) continue;

    const source = sources[best.source];
    pairs.push({
      sourceId: source.id,
      candidateId: set.ids[candidateIndex],
      predictedX: predicted.x,
      predictedY: predicted.y,
      observedX: source.x,
      observedY: source.y,
      residualArcmin: best.angle / ARCMIN,
      nextNearestArcmin: best.next === Infinity ? Number.POSITIVE_INFINITY : best.next / ARCMIN,
    });
  }

  return pairs;
}

/** Root-mean-square residual of a set of pairs, in radians. */
const rmsOf = (pairs: SolvedPair[]): number =>
  pairs.length === 0
    ? Infinity
    : Math.sqrt(pairs.reduce((a, p) => a + (p.residualArcmin * ARCMIN) ** 2, 0) / pairs.length);

/**
 * Refines an attitude, then a focal length, then a distortion term, tightening
 * the association tolerance as the fit improves.
 *
 * Order matters. Attitude is solved in closed form and dominates the residual, so
 * it goes first; focal length is a one-dimensional search around a value already
 * close; distortion is fitted last and only when there is enough signal to
 * support it, because a radial term will happily absorb a bad attitude and leave
 * a fit that looks excellent and points somewhere else.
 */
function refine(
  sources: SolveSource[],
  set: CandidateSet,
  start: { rotation: Matrix3; focal: number },
  width: number,
  height: number,
  params: SolveParams,
): { camera: CameraModel; rotation: Matrix3; pairs: SolvedPair[]; tolerance: number } {
  let camera = makeCamera(width, height, start.focal, 0);
  let rotation = start.rotation.clone();

  // Built once: the refinement loop looks these up on every pair of every round.
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const candidateById = new Map(set.ids.map((id, i) => [id, i]));

  const coarse = (params.coarseTolerancePixels / start.focal) * 1.5;
  const fine = params.toleranceArcmin * ARCMIN;
  let pairs = associate(sources, camera, rotation, set, coarse);

  for (let round = 0; round < 6; round++) {
    // Ease the tolerance down rather than dropping to the final value at once: an
    // early tight cut can throw away the very pairs that would have corrected the
    // attitude.
    //
    // The schedule ends at the *declared* tolerance and never at something
    // derived from the fit's own residual. Letting a fit widen its own acceptance
    // window is self-fulfilling -- a badly wrong attitude produces large
    // residuals, grants itself a large tolerance, and then matches almost every
    // source in the frame. Two attitudes sixty degrees apart both scoring over a
    // hundred matches is what that looks like from the outside.
    const t = round / 5;
    const tolerance = coarse * (1 - t) + fine * t;
    pairs = associate(sources, camera, rotation, set, tolerance);
    if (pairs.length < 2) break;

    // Attitude.
    const vectorPairs: VectorPair[] = [];
    for (const pair of pairs) {
      const source = sourceById.get(pair.sourceId);
      const ci = candidateById.get(pair.candidateId);
      if (!source || ci === undefined) continue;
      vectorPairs.push({
        from: pixelToRay(camera, source.x, source.y, new Vector3()),
        to: vecAt(set.points, ci, new Vector3()),
        // Down-weight wide residuals rather than cutting them: a hard cut at this
        // stage makes the fit oscillate between two sets of inliers.
        weight: 1 / (1 + (pair.residualArcmin / Math.max(params.toleranceArcmin, 1e-6)) ** 2),
      });
    }
    const improved = solveRotation(vectorPairs);
    if (improved) rotation = improved;

    // Focal length: a golden-section search on the one number that trades a
    // uniform radial stretch against everything else.
    camera = { ...camera, focal: optimiseFocal(sources, set, rotation, camera, tolerance) };

    // Distortion, only once the fit is already good and there is enough of it.
    if (params.fitDistortion && round >= 3 && pairs.length >= 12) {
      camera = { ...camera, k1: optimiseK1(sources, set, rotation, camera, tolerance) };
    }
  }

  // The declared tolerance is a ceiling. A fit that is clearly better than it may
  // tighten below it; nothing may loosen past it.
  const rms = rmsOf(pairs);
  const finalTolerance = Number.isFinite(rms) ? Math.min(fine, Math.max(rms * 4, fine * 0.15)) : fine;
  pairs = associate(sources, camera, rotation, set, finalTolerance);
  // The acceptance radius travels with the result: the significance test needs
  // the radius actually used, not the declared ceiling.
  return { camera, rotation, pairs, tolerance: finalTolerance };
}

/** Sum of squared residuals for a camera, in radians squared. */
function cost(
  sources: SolveSource[],
  set: CandidateSet,
  rotation: Matrix3,
  camera: CameraModel,
  tolerance: number,
): number {
  const pairs = associate(sources, camera, rotation, set, tolerance);
  if (pairs.length < 2) return Number.POSITIVE_INFINITY;
  // Divided by the count so a fit is not rewarded merely for finding fewer,
  // tighter pairs.
  const sum = pairs.reduce((a, p) => a + (p.residualArcmin * ARCMIN) ** 2, 0);
  return sum / pairs.length ** 1.5;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

function optimiseFocal(
  sources: SolveSource[],
  set: CandidateSet,
  rotation: Matrix3,
  camera: CameraModel,
  tolerance: number,
): number {
  let lo = camera.focal * 0.85;
  let hi = camera.focal * 1.18;
  let c = hi - GOLDEN * (hi - lo);
  let d = lo + GOLDEN * (hi - lo);
  let fc = cost(sources, set, rotation, { ...camera, focal: c }, tolerance);
  let fd = cost(sources, set, rotation, { ...camera, focal: d }, tolerance);

  for (let i = 0; i < 14; i++) {
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - GOLDEN * (hi - lo);
      fc = cost(sources, set, rotation, { ...camera, focal: c }, tolerance);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + GOLDEN * (hi - lo);
      fd = cost(sources, set, rotation, { ...camera, focal: d }, tolerance);
    }
  }
  const best = (lo + hi) / 2;
  return Number.isFinite(cost(sources, set, rotation, { ...camera, focal: best }, tolerance))
    ? best
    : camera.focal;
}

function optimiseK1(
  sources: SolveSource[],
  set: CandidateSet,
  rotation: Matrix3,
  camera: CameraModel,
  tolerance: number,
): number {
  // One term only. Reaching for a full polynomial before the residual plot asks
  // for it is how a fit starts describing the fitter rather than the lens.
  let best = camera.k1;
  let bestCost = cost(sources, set, rotation, camera, tolerance);
  for (let k = -0.28; k <= 0.121; k += 0.02) {
    const c = cost(sources, set, rotation, { ...camera, k1: k }, tolerance);
    if (c < bestCost) {
      bestCost = c;
      best = k;
    }
  }
  return best;
}

/**
 * Roll of the frame about the boresight, in degrees.
 *
 * Measured as the angle between the image's "up" direction, carried into the
 * scene, and the direction towards the zenith projected into the image plane.
 */
function rollAngle(rotation: Matrix3): number {
  const boresight = new Vector3(0, 0, -1).applyMatrix3(rotation).normalize();
  const imageUp = new Vector3(0, 1, 0).applyMatrix3(rotation).normalize();

  // Zenith with the boresight component removed: "up" as the observer means it.
  const zenith = new Vector3(0, 1, 0).addScaledVector(boresight, -boresight.y);
  if (zenith.lengthSq() < 1e-9) return 0; // pointing straight up; roll is arbitrary
  zenith.normalize();

  const right = new Vector3().crossVectors(zenith, boresight).normalize();
  return Math.atan2(imageUp.dot(right), imageUp.dot(zenith)) * RAD;
}

function describeAttitude(rotation: Matrix3, camera: CameraModel): SolvedAttitude {
  const boresight = new Vector3(0, 0, -1).applyMatrix3(rotation).normalize();
  const { altitude, azimuth } = vectorToAltAz(boresight);
  const fov = fieldOfView(camera);
  const e = rotation.elements; // column-major

  return {
    // Row-major, so the far side does not have to know three.js's storage order.
    rotation: [e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8]],
    boresight: [boresight.x, boresight.y, boresight.z],
    altitude,
    azimuth,
    roll: rollAngle(rotation),
    focal: camera.focal,
    k1: camera.k1,
    fovHorizontalDeg: fov.horizontal,
    fovVerticalDeg: fov.vertical,
    fovDiagonalDeg: fov.diagonal,
    pixelScaleArcsec: pixelScaleArcsec(camera),
  };
}

/** One pass of the blind search, at a fixed search breadth. */
function solvePass(request: SolveRequest, pass: number, deadline: number): SolveResult {
  const started = Date.now();
  let timedOut = false;
  const params: SolveParams = { ...DEFAULT_SOLVE_PARAMS, ...request.params };
  const { width, height } = request;

  const fail = (failure: SolveResult['failure'], message: string): SolveResult => ({
    ok: false,
    pass,
    timedOut,
    failure,
    message,
    attitude: null,
    pairs: [],
    rmsArcmin: null,
    maxArcmin: null,
    expectedByChance: 0,
    significance: 0,
    candidatesInFrame: 0,
    runnerUpInliers: 0,
    hypothesesTested: 0,
    elapsedMs: Date.now() - started,
    params,
  });

  // Brightest first: rank is the only prior the solver has about which source is
  // most likely to be a catalogued star.
  const sources = [...request.sources].sort((a, b) => b.flux - a.flux);
  if (sources.length < params.minInliers) {
    return fail(
      'tooFewSources',
      `Only ${sources.length} source${sources.length === 1 ? '' : 's'} were traced. ` +
        `A solve needs at least ${params.minInliers} to be worth trusting.`,
    );
  }
  if (request.candidates.length < params.minInliers) {
    return fail('tooFewSources', 'Not enough catalogue entries are above the horizon to solve against.');
  }

  const set = packCandidates(request.candidates, params.hypothesisCandidates);

  // Focal length bracket. A recorded field of view narrows it hard, which is
  // worth a lot of time -- but it is only ever a bracket, never the answer.
  let minFocal = focalFromDiagonalFov(width, height, params.maxFovDeg);
  let maxFocal = focalFromDiagonalFov(width, height, params.minFovDeg);
  if (request.fovPriorDeg && request.fovPriorDeg > 0) {
    const prior = focalFromDiagonalFov(width, height, request.fovPriorDeg);
    minFocal = Math.max(minFocal, prior / 1.45);
    maxFocal = Math.min(maxFocal, prior * 1.45);
    if (minFocal >= maxFocal) {
      minFocal = prior / 1.45;
      maxFocal = prior * 1.45;
    }
  }

  const probe = makeCamera(width, height, (minFocal + maxFocal) / 2, 0);

  // How many sources a hypothesis is scored against.
  //
  // A fixed handful of the brightest is wrong for a contaminated frame. Twenty
  // five satellite trails and lens flares will occupy most of the top of a flux
  // ranking, and a hypothesis scored only on those cannot see that it is correct
  // -- the true attitude matches none of them and loses to noise. Scoring against
  // a share of the whole set dilutes the contamination without paying to project
  // every source in a crowded frame.
  const verifySources = Math.min(
    sources.length,
    // Capped: a frame with five hundred traced sources does not need five hundred
    // projections to rank a hypothesis, and paying for them would make the search
    // scale with the detector's threshold rather than with the sky.
    40,
    Math.max(params.verifySources, Math.round(sources.length * 0.3)),
  );

  const anchorSources = Math.min(params.anchorSources, sources.length);
  const hypothesisSources = Math.min(params.hypothesisSources, sources.length);
  const anchorCandidates = Math.min(params.anchorCandidates, set.count);

  const hypotheses = new HypothesisSet();
  let tested = 0;

  const anchorVec = new Vector3();
  const partnerVec = new Vector3();
  const anchorRay = new Vector3();
  const partnerRay = new Vector3();
  const ring: number[] = [];
  const focals: number[] = [];
  const scratchCamera = makeCamera(width, height, minFocal, 0);
  const scratchRotation = new Matrix3();

  // The angular range each image pair could subtend, given the focal lengths
  // still in play. Computed once: it depends only on the pixels, not on which
  // catalogue entry is being tried.
  interface SourcePair {
    anchor: SolveSource;
    partner: SolveSource;
    anchorIndex: number;
    partnerIndex: number;
    narrowest: number;
    widest: number;
  }
  const sourcePairs: SourcePair[] = [];
  for (let a = 0; a < anchorSources; a++) {
    for (let p = 0; p < hypothesisSources; p++) {
      if (p === a) continue;
      const anchor = sources[a];
      const partner = sources[p];

      probe.focal = minFocal;
      const widest = angleBetweenUnit(
        pixelToRay(probe, anchor.x, anchor.y, anchorRay),
        pixelToRay(probe, partner.x, partner.y, partnerRay),
      );
      probe.focal = maxFocal;
      const narrowest = angleBetweenUnit(
        pixelToRay(probe, anchor.x, anchor.y, anchorRay),
        pixelToRay(probe, partner.x, partner.y, partnerRay),
      );
      if (widest > narrowest)
        sourcePairs.push({ anchor, partner, anchorIndex: a, partnerIndex: p, narrowest, widest });
    }
  }

  // Catalogue anchor in the outer loop, source pair inside.
  //
  // The order matters more than it looks. Running it the other way spends the
  // whole hypothesis budget on the first source before the second is ever tried,
  // and the first source in a contaminated frame is routinely a satellite or a
  // lens flare -- so the search exhausts itself on a source that has no
  // counterpart at all. Sweeping catalogue anchors outermost gives every source
  // pair a turn against the brightest stars before any of them gets a second one.
  outer: for (let c = 0; c < anchorCandidates; c++) {
    vecAt(set.points, c, anchorVec);

    for (const { anchor, partner, anchorIndex, partnerIndex: partnerIndex_, narrowest, widest } of sourcePairs) {
      // Where the partner's counterpart must lie: a ring around the anchor whose
      // width is the whole remaining uncertainty in the lens.
      annulus(set.bright, anchorVec, narrowest, widest, ring);

      for (const partnerIndex of ring) {
        vecAt(set.points, partnerIndex, partnerVec);
        const angle = angleBetweenUnit(anchorVec, partnerVec);

        // One correspondence pair fixes the scale outright. Two roots are
        // possible -- a short lens and a long one can subtend the same angle
        // between the same two pixels -- and both deserve a hearing.
        focalsForAngle(probe, anchor.x, anchor.y, partner.x, partner.y, angle, minFocal, maxFocal, focals);

        for (const focal of focals) {
          // A single mutable camera and rotation, reused across the sweep.
          // Anything allocated here is allocated hundreds of thousands of times.
          scratchCamera.focal = focal;
          const rotation = triadRotation(
            pixelToRay(scratchCamera, anchor.x, anchor.y, anchorRay),
            pixelToRay(scratchCamera, partner.x, partner.y, partnerRay),
            anchorVec,
            partnerVec,
            scratchRotation,
          );
          if (!rotation) continue;

          tested++;
          const tolerance = (params.coarseTolerancePixels / focal) * 1.5;
          // Most hypotheses are hopeless. Telling the scorer the bar the current
          // leader set lets it abandon them after a few sources instead of
          // projecting every one, which is the difference between a search that
          // takes seconds and one that takes minutes.
          const leader = hypotheses.best;
          const { inliers, score } = scoreHypothesis(
            sources,
            scratchCamera,
            rotation,
            set,
            tolerance,
            verifySources,
            leader ? Math.max(2, Math.floor(leader.inliers * 0.7)) : 2,
            anchorIndex,
            partnerIndex_,
            params.quickRejectAfter,
          );
          if (inliers < 2) continue;

          // Only a hypothesis worth keeping gets its own copies.
          hypotheses.offer({
            rotation: rotation.clone(),
            focal,
            inliers,
            score,
            boresight: new Vector3(0, 0, -1).applyMatrix3(rotation).normalize(),
          });
        }

        if (tested >= params.maxHypotheses) break outer;
        // Checked on the ring boundary rather than per hypothesis: Date.now() is
        // not free, and a ring is a few hundred hypotheses at most.
        if (Date.now() > deadline) {
          timedOut = true;
          break outer;
        }
      }
    }
  }

  if (!hypotheses.best) {
    return {
      ...fail('noHypothesis', 'No arrangement of the traced sources matched the catalogue at any scale.'),
      hypothesesTested: tested,
    };
  }

  // Refine the top few *distinct* readings, not just the leading one.
  //
  // A coarse score is built from a two-point attitude and a fixed tolerance, and
  // it is far too noisy to decide whether a frame is ambiguous: a nonsense fit can
  // score within a few per cent of the truth. What separates them is what survives
  // refinement. The true attitude converges and picks up every star in the frame;
  // a wrong one collapses to a handful of coincidences.
  //
  // Then the comparison has to be made on where each one *ended up*, not where it
  // started. Refinement begins with a generous tolerance precisely so it can climb
  // out of a mediocre starting point, and it routinely does: two coarse
  // hypotheses pointing sixty degrees apart often converge on the same answer.
  // Judging them by their starting boresights would call every frame ambiguous.
  const refinements = hypotheses.items
    .slice(0, 3)
    .map((h) => {
      const r = refine(sources, set, h, width, height, params);
      return {
        hypothesis: h,
        ...r,
        boresight: new Vector3(0, 0, -1).applyMatrix3(r.rotation).normalize(),
      };
    })
    .sort((a, b) => b.pairs.length - a.pairs.length || rmsOf(a.pairs) - rmsOf(b.pairs));

  // Fold together the ones that converged on the same solution.
  const distinct: typeof refinements = [];
  for (const candidate of refinements) {
    if (distinct.some((d) => angleBetweenUnit(d.boresight, candidate.boresight) < MERGE_ANGLE)) continue;
    distinct.push(candidate);
  }

  const refined = distinct[0];
  const runnerUp = distinct[1] ?? null;
  const pairs = refined.pairs;

  // How much of the sky the solved frame actually covers, which is what makes an
  // unconfirmed prediction meaningful later.
  let candidatesInFrame = 0;
  {
    const inverse = refined.rotation.clone().invert();
    const v = new Vector3();
    for (let i = 0; i < set.count; i++) {
      vecAt(set.points, i, v).applyMatrix3(inverse);
      const px = rayToPixel(refined.camera, v);
      if (px && insideFrame(refined.camera, px.x, px.y)) candidatesInFrame++;
    }
  }

  // What this many sources would have matched by coincidence.
  //
  // The relevant density is not the whole sky's but the solved frame's: how many
  // catalogue entries the frame contains, spread over the solid angle it covers.
  // Each source searches a disc of the acceptance radius, so the expected number
  // of chance matches is sources x entries x disc / frame.
  const fovDeg = fieldOfView(refined.camera);
  const frameSolidAngleDeg2 = Math.max(fovDeg.horizontal * fovDeg.vertical, 1e-6);
  const acceptanceDeg = refined.tolerance * RAD;
  const discDeg2 = Math.PI * acceptanceDeg * acceptanceDeg;
  const expectedByChance = (sources.length * candidatesInFrame * discDeg2) / frameSolidAngleDeg2;
  const significance = (pairs.length - expectedByChance) / Math.sqrt(Math.max(expectedByChance, 1));

  const base = {
    pass,
    timedOut,
    attitude: describeAttitude(refined.rotation, refined.camera),
    pairs,
    rmsArcmin: pairs.length ? rmsOf(pairs) / ARCMIN : null,
    maxArcmin: pairs.length ? Math.max(...pairs.map((p) => p.residualArcmin)) : null,
    expectedByChance,
    significance,
    candidatesInFrame,
    runnerUpInliers: runnerUp?.pairs.length ?? 0,
    hypothesesTested: tested,
    elapsedMs: Date.now() - started,
    params,
  };

  if (pairs.length < params.minInliers) {
    return {
      ...base,
      ok: false,
      failure: 'tooFewInliers',
      message:
        `Best fit held only ${pairs.length} mutual match${pairs.length === 1 ? '' : 'es'}, below the ` +
        `${params.minInliers} required. Nothing has been confirmed.`,
    };
  }

  if (significance < params.minSignificance) {
    return {
      ...base,
      ok: false,
      failure: 'notSignificant',
      message:
        `Found ${pairs.length} match${pairs.length === 1 ? '' : 'es'}, but a frame this size would ` +
        `throw up about ${expectedByChance.toFixed(1)} by coincidence. That is not enough of an ` +
        `excess to call anything identified.`,
    };
  }

  if (runnerUp && pairs.length < runnerUp.pairs.length * params.ambiguityMargin) {
    const separation = angleBetweenUnit(refined.boresight, runnerUp.boresight) * RAD;
    return {
      ...base,
      ok: false,
      failure: 'ambiguous',
      message:
        `Two readings of this frame survive refinement almost equally well, pointing ` +
        `${separation.toFixed(0)}° apart (${pairs.length} matches against ${runnerUp.pairs.length}). ` +
        `A best guess is not a solve, so none has been accepted.`,
    };
  }

  const rms = base.rmsArcmin ?? Infinity;
  if (rms > params.toleranceArcmin) {
    return {
      ...base,
      ok: false,
      failure: 'residualTooLarge',
      message:
        `Matched ${pairs.length} sources but the residual is ${rms.toFixed(1)}′, wider than the ` +
        `${params.toleranceArcmin}′ tolerance. The fit is not good enough to name anything.`,
    };
  }

  const fov = diagonalFovFromFocal(width, height, refined.camera.focal);
  return {
    ...base,
    ok: true,
    failure: null,
    message:
      `Solved: ${pairs.length} of ${candidatesInFrame} predicted objects in frame matched, ` +
      `RMS ${rms.toFixed(2)}′, field ${fov.toFixed(1)}°. Chance alone would have given about ` +
      `${expectedByChance.toFixed(1)}.`,
  };
}


/**
 * Runs a blind plate solve, widening the search only when it has to.
 *
 * The cheap first pass assumes what is usually true: the brightest things in a
 * night-sky photograph are among the brightest things in the sky, so pairing them
 * against a few hundred bright catalogue entries finds the answer quickly.
 *
 * That assumption fails in two specific ways, and both are ordinary. A narrow
 * field pointed at an unremarkable patch contains no globally bright star at all
 * -- every source in it may be fainter than the two hundredth brightest object
 * overhead. And a frame carrying satellites, aircraft or lens flare can have its
 * brightest few sources be things that are not in any catalogue, so no hypothesis
 * anchored on them can ever be right.
 *
 * Rather than paying for the deep search every time, each pass reaches further:
 * more sources allowed to anchor, more catalogue entries allowed to pair. A frame
 * that solves easily costs one pass, and one that does not is still reachable.
 */
export function solvePlate(request: SolveRequest): SolveResult {
  const started = Date.now();

  const escalation: Partial<SolveParams>[] = [
    {},
    {
      anchorSources: 8,
      hypothesisSources: 18,
      anchorCandidates: 160,
      hypothesisCandidates: 900,
      maxHypotheses: 1_200_000,
      quickRejectAfter: 8,
    },
    {
      // Depth. A narrow field pointed at an unremarkable patch can contain no
      // bright star at all -- every source in it may be fainter than the four
      // hundredth brightest object overhead -- so the anchor has to be allowed to
      // be an ordinary star. Narrow fields also produce small pair separations,
      // which makes each ring query cheap, so reaching this far down the
      // catalogue costs less than it looks.
      // Few source pairs, many catalogue anchors. Reaching an anchor two
      // thousand entries down means sweeping two thousand anchors, and every
      // extra source pair multiplies that sweep -- so this pass spends its budget
      // on depth rather than on breadth. Contamination is pass two's problem.
      anchorSources: 3,
      hypothesisSources: 8,
      anchorCandidates: 3000,
      hypothesisCandidates: 8000,
      maxHypotheses: 3_000_000,
      quickRejectAfter: 6,
    },
  ];

  const params = { ...DEFAULT_SOLVE_PARAMS, ...request.params };
  const deadline = started + params.deadlineMs;

  let best: SolveResult | null = null;
  for (let pass = 0; pass < escalation.length; pass++) {
    const result = solvePass(
      { ...request, params: { ...escalation[pass], ...request.params } },
      pass + 1,
      deadline,
    );
    if (result.ok) return { ...result, elapsedMs: Date.now() - started };

    // Keep the most convincing refusal, not the most recent one. A wider search
    // is not automatically a better one: it can wander onto a worse fit, and
    // reporting that instead of what the earlier pass found would misdescribe how
    // close the frame came.
    if (!best || result.significance > best.significance) best = result;

    // Nothing in the frame to work with: looking harder cannot change that.
    if (result.failure === 'tooFewSources') break;
    // Out of time. Escalating would only produce a worse answer more slowly.
    if (Date.now() > deadline) break;
  }

  return { ...(best as SolveResult), elapsedMs: Date.now() - started };
}
