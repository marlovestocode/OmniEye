/**
 * Choosing what a solve is allowed to match against, and in which frame.
 *
 * Two modes, and the difference between them is the whole answer to "can this
 * work without knowing where I was standing?"
 *
 *   horizon   Candidates are the stars actually above the observer's horizon,
 *             expressed in the scene frame. Half the sky is excluded before the
 *             search begins, which makes it fast and makes the answer directly
 *             meaningful -- altitude, azimuth, a footprint on the dome.
 *
 *   allSky    Candidates are the whole catalogue in J2000 equatorial coordinates,
 *             with no horizon and no clock involved at all. The solve returns
 *             right ascension and declination, which is what a plate solve
 *             fundamentally measures: a direction on the celestial sphere is a
 *             property of the photograph, not of the photographer.
 *
 * The second mode is slower -- twice the candidates and no easy rejections -- but
 * it needs nothing but pixels. It is what makes an image with no GPS, no
 * timestamp, no compass and no focal length still identifiable.
 */
import { Vector3 } from 'three';
import type { Catalogs, StarCatalog } from '@/lib/astro/catalog';
import type { PredictedSky } from '@/lib/astro/predicted';
import type { SolveCandidate } from './types';

export type SolveFrame = 'horizon' | 'allSky';

export interface CandidateOptions {
  /** Faintest catalogue entry the solve may match against. */
  magnitudeLimit?: number;
  /**
   * How far below the horizon still counts as reachable, in degrees.
   * Refraction and a slightly wrong vantage both put real stars a little below a
   * naive horizon, and excluding them would cost matches at the frame edge.
   */
  horizonMarginDeg?: number;
}

const _v = new Vector3();

/**
 * Stars, and the planets, that a solve may match against.
 *
 * Planets are included deliberately. They are among the brightest points in any
 * night sky, they are not in a star catalogue, and leaving them out would make
 * the brightest source in a great many photographs permanently unexplainable --
 * and, worse, would tempt the search to anchor on it and fail.
 */
export function buildCandidates(
  catalogs: Catalogs,
  sky: PredictedSky,
  frame: SolveFrame,
  options: CandidateOptions = {},
): SolveCandidate[] {
  const { magnitudeLimit = 6.5, horizonMarginDeg = -3 } = options;
  const stars: StarCatalog = catalogs.stars;
  const limit = stars.countBrighterThan(magnitudeLimit);
  const out: SolveCandidate[] = [];

  const minY = Math.sin((horizonMarginDeg * Math.PI) / 180);

  for (let i = 0; i < limit; i++) {
    const x = stars.positions[i * 3];
    const y = stars.positions[i * 3 + 1];
    const z = stars.positions[i * 3 + 2];

    if (frame === 'allSky') {
      out.push({ id: `star:${i}`, x, y, z, magnitude: stars.magnitudes[i] });
      continue;
    }

    _v.set(x, y, z).applyMatrix3(sky.rotation);
    if (_v.y < minY) continue;
    out.push({ id: `star:${i}`, x: _v.x, y: _v.y, z: _v.z, magnitude: stars.magnitudes[i] });
  }

  for (const body of sky.solarBodies) {
    // The Sun and Moon are extended and enormously bright; a detector sees them
    // as a saturated blob, not a point, and matching a point source to them would
    // be meaningless.
    if (body.kind !== 'planet') continue;
    if (body.magnitude > magnitudeLimit) continue;

    if (frame === 'allSky') {
      out.push({
        id: `body:${body.name}`,
        x: body.direction.x,
        y: body.direction.y,
        z: body.direction.z,
        magnitude: body.magnitude,
      });
      continue;
    }

    _v.copy(body.direction).applyMatrix3(sky.rotation);
    if (_v.y < minY) continue;
    out.push({ id: `body:${body.name}`, x: _v.x, y: _v.y, z: _v.z, magnitude: body.magnitude });
  }

  return out;
}

/**
 * Which frame to solve in, given how much the stated vantage is worth.
 *
 * An exact time and place make the horizon a real constraint worth exploiting.
 * Anything less and the horizon is a guess -- and a guessed horizon does not
 * merely slow the solve down, it can exclude the very stars that are in the
 * frame, so the search fails for a reason that has nothing to do with the
 * photograph.
 */
export function chooseFrame(timeIsExact: boolean, locationIsExact: boolean): SolveFrame {
  return timeIsExact && locationIsExact ? 'horizon' : 'allSky';
}
