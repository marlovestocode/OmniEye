/**
 * A spatial index on the unit sphere.
 *
 * A blind solve tests hundreds of thousands of attitude hypotheses, and every one
 * asks the same question: what catalogue entries lie near this direction? Scanning
 * a few thousand candidates per query turns a second of work into a minute, so
 * directions get binned once and looked up thereafter.
 *
 * The bands are equal in `z` rather than equal in angle, and each band is divided
 * into as many longitude bins as its own circumference warrants.
 *
 * The obvious alternative -- a plain latitude/longitude grid with a fixed
 * longitude count -- has bins that become vanishingly narrow near the poles. A
 * query there must widen its longitude span by 1/cos(latitude) to cover the same
 * angular distance, which at the pole means every bin on the sphere: a lookup that
 * should touch nine bins touches a thousand. Since the index's poles here fall on
 * the north and south horizon, any frame pointing that way would hit it. Sizing
 * each band separately keeps every lookup the same small cost wherever it lands.
 */
import type { Vector3 } from 'three';

const TWO_PI = Math.PI * 2;

export interface SphereIndex {
  /** Target bin size in radians. */
  cell: number;
  latBins: number;
  /** How many longitude bins each latitude band is divided into. */
  bandLon: Int32Array;
  /** Where each band's bins begin in `bins`. */
  bandStart: Int32Array;
  /** Entry indices, grouped by bin. */
  bins: Int32Array[];
  /** The directions themselves, 3 floats each, in the caller's own order. */
  points: Float32Array;
  count: number;
}

function bandOf(latBins: number, z: number): number {
  const t = (Math.max(-1, Math.min(1, z)) + 1) / 2;
  return Math.min(latBins - 1, Math.max(0, Math.floor(t * latBins)));
}

function lonBinOf(n: number, x: number, y: number): number {
  const lon = Math.atan2(y, x);
  return Math.min(n - 1, Math.floor((((lon % TWO_PI) + TWO_PI) % TWO_PI) / (TWO_PI / n)));
}

/** Builds an index over `count` unit vectors packed 3 floats each. */
export function buildSphereIndex(points: Float32Array, count: number, cellRad: number): SphereIndex {
  const cell = Math.max(cellRad, 1e-3);
  const latBins = Math.max(1, Math.ceil(Math.PI / cell));

  const bandLon = new Int32Array(latBins);
  const bandStart = new Int32Array(latBins + 1);
  let total = 0;
  for (let b = 0; b < latBins; b++) {
    const zMid = ((b + 0.5) / latBins) * 2 - 1;
    const cosLat = Math.sqrt(Math.max(1 - zMid * zMid, 1e-6));
    bandLon[b] = Math.max(1, Math.ceil((TWO_PI * cosLat) / cell));
    bandStart[b] = total;
    total += bandLon[b];
  }
  bandStart[latBins] = total;

  const counts = new Int32Array(total);
  const binOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const band = bandOf(latBins, points[i * 3 + 2]);
    const bin = bandStart[band] + lonBinOf(bandLon[band], points[i * 3], points[i * 3 + 1]);
    binOf[i] = bin;
    counts[bin]++;
  }

  const bins: Int32Array[] = new Array(total);
  for (let b = 0; b < total; b++) bins[b] = new Int32Array(counts[b]);
  const fill = new Int32Array(total);
  for (let i = 0; i < count; i++) {
    const b = binOf[i];
    bins[b][fill[b]++] = i;
  }

  return { cell, latBins, bandLon, bandStart, bins, points, count };
}

/**
 * Visits every bin that could hold a point within `maxAngle` of `query`.
 *
 * Written as a callback rather than returning a list so a lookup allocates
 * nothing: this is the innermost loop of the entire search.
 */
function forEachNearbyBin(
  index: SphereIndex,
  query: Vector3,
  maxAngle: number,
  visit: (bin: Int32Array) => void,
): void {
  const { latBins, bandLon, bandStart, bins } = index;

  // Bands are equal in z, so the band span follows from how far `maxAngle` can
  // move z. One extra band at each end absorbs the curvature near the extremes.
  const zSpan = Math.sin(Math.min(maxAngle, Math.PI / 2)) + 1e-9;
  const bandLo = Math.max(0, bandOf(latBins, query.z - zSpan) - 1);
  const bandHi = Math.min(latBins - 1, bandOf(latBins, query.z + zSpan) + 1);

  const lon = Math.atan2(query.y, query.x);
  const lonNormalised = ((lon % TWO_PI) + TWO_PI) % TWO_PI;

  for (let b = bandLo; b <= bandHi; b++) {
    const n = bandLon[b];
    const start = bandStart[b];

    // How far in longitude `maxAngle` reaches at this band's latitude. Near a
    // pole that is the whole circle -- and such a band has very few bins anyway.
    const zMid = ((b + 0.5) / latBins) * 2 - 1;
    const cosLat = Math.sqrt(Math.max(1 - zMid * zMid, 1e-6));
    const lonReach = maxAngle / cosLat;

    if (lonReach >= Math.PI || n <= 3) {
      for (let k = 0; k < n; k++) visit(bins[start + k]);
      continue;
    }

    const step = TWO_PI / n;
    const centre = Math.floor(lonNormalised / step);
    const span = Math.ceil(lonReach / step) + 1;
    for (let d = -span; d <= span; d++) {
      const k = (((centre + d) % n) + n) % n;
      visit(bins[start + k]);
    }
  }
}

/**
 * The nearest indexed direction to `query`, within `maxAngle` radians.
 * Returns -1 when nothing is close enough.
 */
export function nearest(
  index: SphereIndex,
  query: Vector3,
  maxAngle: number,
): { index: number; angle: number } {
  const { points } = index;
  let best = -1;
  let bestDot = Math.cos(maxAngle);

  forEachNearbyBin(index, query, maxAngle, (bin) => {
    for (let k = 0; k < bin.length; k++) {
      const i = bin[k];
      const dot = query.x * points[i * 3] + query.y * points[i * 3 + 1] + query.z * points[i * 3 + 2];
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    }
  });

  return { index: best, angle: best < 0 ? Infinity : Math.acos(Math.min(1, bestDot)) };
}

/** Every indexed direction within `maxAngle` radians of `query`. */
export function within(index: SphereIndex, query: Vector3, maxAngle: number, out: number[] = []): number[] {
  out.length = 0;
  const { points } = index;
  const cosLimit = Math.cos(maxAngle);

  forEachNearbyBin(index, query, maxAngle, (bin) => {
    for (let k = 0; k < bin.length; k++) {
      const i = bin[k];
      const dot = query.x * points[i * 3] + query.y * points[i * 3 + 1] + query.z * points[i * 3 + 2];
      if (dot >= cosLimit) out.push(i);
    }
  });

  return out;
}

/**
 * Everything in an annulus around `centre`: at least `minAngle` and at most
 * `maxAngle` away.
 *
 * This is the shape a blind solve actually queries. Having fixed one
 * correspondence, the second must lie at a particular angular distance from it,
 * known only to within the range of focal lengths still in play -- which is a
 * ring on the sphere, not a disc.
 */
export function annulus(
  index: SphereIndex,
  centre: Vector3,
  minAngle: number,
  maxAngle: number,
  out: number[] = [],
): number[] {
  within(index, centre, maxAngle, out);
  const cosMin = Math.cos(minAngle);
  let write = 0;
  for (let r = 0; r < out.length; r++) {
    const i = out[r];
    const dot =
      centre.x * index.points[i * 3] +
      centre.y * index.points[i * 3 + 1] +
      centre.z * index.points[i * 3 + 2];
    if (dot <= cosMin) out[write++] = i;
  }
  out.length = write;
  return out;
}
