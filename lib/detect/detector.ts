/**
 * Source detection.
 *
 * A small, deliberate implementation of the classical sequence: estimate the
 * background on a coarse mesh, threshold against the local noise, group the
 * survivors into connected components, and reduce each to a flux-weighted
 * centroid with second moments.
 *
 * Nothing here consults a catalogue, and nothing may. This is Layer 2, and its
 * value is precisely that it does not know what it is supposed to find. Seeding
 * detection with predicted positions would make the match rate a measurement of
 * our own expectations instead of the sky, so the detector is kept structurally
 * incapable of it: it takes pixels and returns positions.
 *
 * Roughly two hundred lines and no dependencies, which is the point -- it has to
 * run per frame in a worker, and several megabytes of WASM would buy nothing that
 * a background estimate, a threshold and a union of neighbours does not.
 */
import {
  DEFAULT_DETECTION_PARAMS,
  type BackgroundStats,
  type DetectionParams,
  type DetectionResult,
  type LuminanceImage,
  type Source,
  type SourceShape,
} from './types';

/** Background level and noise on a coarse mesh over the image. */
interface BackgroundMesh {
  /** Cells across and down. */
  cols: number;
  rows: number;
  cell: number;
  /** cols*rows background levels. */
  level: Float32Array;
  /** cols*rows noise sigmas. */
  sigma: Float32Array;
  stats: BackgroundStats;
}

/**
 * Sigma-clipped mean of one mesh cell: the background *level*.
 *
 * Three clipping passes is enough. Stars occupy a tiny fraction of any cell, so
 * the first pass is already close and the rest just removes their tails. The
 * alternative -- a true median -- would mean sorting every cell for an answer
 * that differs in the third decimal.
 */
function clippedLevel(
  data: Float32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  seedSigma: number,
): number {
  let mean = 0;
  let sigma = seedSigma;

  for (let pass = 0; pass < 3; pass++) {
    const lo = pass === 0 ? -Infinity : mean - 3 * sigma;
    const hi = pass === 0 ? Infinity : mean + 3 * sigma;

    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = x0; x < x1; x++) {
        const v = data[row + x];
        if (v < lo || v > hi) continue;
        n++;
        sum += v;
        sumSq += v * v;
      }
    }
    if (n < 8) break;
    mean = sum / n;
    if (pass === 0) sigma = Math.sqrt(Math.max(sumSq / n - mean * mean, 0));
  }

  return mean;
}

/**
 * Noise sigma of one mesh cell, from adjacent-pixel differences.
 *
 * The obvious estimator -- the spread of pixel values about the cell mean --
 * is wrong here, because a light-pollution gradient across a 64-pixel cell
 * contributes to that spread as much as the noise does. On a frame with a strong
 * gradient it inflates sigma by 40% or more, and every threshold in the brighter
 * half of the image silently rises with it.
 *
 * Differencing neighbours removes any smooth gradient: a linear ramp adds the
 * same constant to every difference, which the median absolute deviation about
 * the median then discards. The sqrt(2) undoes the variance doubling from
 * subtracting two noisy pixels. Stars survive as outliers in the tails, where the
 * MAD ignores them.
 */
function noiseFromDifferences(
  data: Float32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const stride = 2; // every other row and column: plenty of samples, half the sort
  const rows = Math.max(0, Math.ceil((y1 - y0) / stride));
  const cols = Math.max(0, Math.ceil((x1 - 1 - x0) / stride));
  if (rows * cols < 16) return 0;

  const diffs = new Float32Array(rows * cols);
  let n = 0;
  for (let y = y0; y < y1; y += stride) {
    const row = y * width;
    for (let x = x0; x < x1 - 1; x += stride) {
      diffs[n++] = data[row + x + 1] - data[row + x];
    }
  }

  const sample = diffs.subarray(0, n);
  sample.sort();
  const med = sample[n >> 1];

  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(sample[i] - med);
  dev.sort();

  return (1.4826 * dev[n >> 1]) / Math.SQRT2;
}

/** Builds the background mesh. Cells must be far larger than any star. */
function estimateBackground(image: LuminanceImage, cell: number): BackgroundMesh {
  const { data, width, height } = image;
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const level = new Float32Array(cols * rows);
  const sigma = new Float32Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * cell;
    const y1 = Math.min(height, y0 + cell);
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cell;
      const x1 = Math.min(width, x0 + cell);
      // Noise first, so the level's clipping has a sensible width to clip at.
      const s = noiseFromDifferences(data, width, x0, y0, x1, y1);
      sigma[cy * cols + cx] = s;
      level[cy * cols + cx] = clippedLevel(data, width, x0, y0, x1, y1, s);
    }
  }

  const sortedLevels = Float32Array.from(level).sort();
  const sortedSigmas = Float32Array.from(sigma).sort();
  const mid = sortedLevels.length >> 1;

  return {
    cols,
    rows,
    cell,
    level,
    sigma,
    stats: {
      median: sortedLevels[mid],
      sigma: sortedSigmas[mid],
      min: sortedLevels[0],
      max: sortedLevels[sortedLevels.length - 1],
    },
  };
}

/**
 * Bilinear sample of the mesh at a pixel, so a light-pollution gradient is
 * subtracted smoothly instead of in visible 64-pixel steps.
 */
function sampleMesh(mesh: BackgroundMesh, values: Float32Array, x: number, y: number): number {
  const { cols, rows, cell } = mesh;
  // Mesh values sit at cell centres.
  const fx = Math.min(cols - 1, Math.max(0, (x - cell / 2) / cell));
  const fy = Math.min(rows - 1, Math.max(0, (y - cell / 2) / cell));
  const ix = Math.min(cols - 2, Math.floor(fx));
  const iy = Math.min(rows - 2, Math.floor(fy));
  const tx = cols > 1 ? fx - ix : 0;
  const ty = rows > 1 ? fy - iy : 0;
  const ix1 = Math.min(cols - 1, ix + 1);
  const iy1 = Math.min(rows - 1, iy + 1);

  const v00 = values[iy * cols + ix];
  const v10 = values[iy * cols + ix1];
  const v01 = values[iy1 * cols + ix];
  const v11 = values[iy1 * cols + ix1];
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/** A connected group of above-threshold pixels, before it becomes a Source. */
interface Blob {
  pixels: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Eight-connected flood fill from `start`, consuming the mask as it goes.
 *
 * Returns null once a region exceeds `limit` pixels -- glare around a streetlight
 * or the Moon can be a million-pixel blob, and there is no reason to build an
 * array for it before rejecting it.
 */
function floodFill(mask: Uint8Array, width: number, height: number, start: number, limit: number): Blob | null {
  const pixels: number[] = [];
  const stack: number[] = [start];
  mask[start] = 2;

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let overflowed = false;

  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;

    if (!overflowed) {
      pixels.push(p);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (pixels.length > limit) overflowed = true;
    }

    const x0 = x > 0 ? x - 1 : 0;
    const x1 = x < width - 1 ? x + 1 : width - 1;
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;

    for (let ny = y0; ny <= y1; ny++) {
      const row = ny * width;
      for (let nx = x0; nx <= x1; nx++) {
        const q = row + nx;
        if (mask[q] === 1) {
          mask[q] = 2;
          stack.push(q);
        }
      }
    }
  }

  return overflowed ? null : { pixels, minX, minY, maxX, maxY };
}
/** What a blob turns out to be, once its pixels are actually weighed. */
interface Measurement {
  x: number;
  y: number;
  flux: number;
  peak: number;
  fwhm: number;
  elongation: number;
  theta: number;
  background: number;
  saturationPeak: number;
}

/**
 * Reduces a blob to a position, a brightness and a shape.
 *
 * Two decisions here carry most of the astrometric accuracy:
 *
 * Background is subtracted per pixel rather than once for the window. Across a
 * light-pollution gradient a single value tilts the weights and drags the
 * centroid downhill.
 *
 * The centroid is then refined under a Gaussian weight rather than taken from the
 * sum of positive residuals. Summing only what is above background rectifies the
 * noise, and the resulting error does not shrink with brightness -- measured at a
 * flat 0.15 px for every source regardless of signal to noise, which would have
 * been the dominant term in any plate solve built on it. Weighting suppresses
 * distant pixels smoothly instead of by a hard cut, so nothing needs clipping and
 * the estimator approaches the precision the photons allow.
 */
function measure(image: LuminanceImage, mesh: BackgroundMesh, blob: Blob): Measurement {
  const { data, width, height } = image;

  // Moments taken only over above-threshold pixels are truncated, which biases
  // the width low. Widening by two pixels recovers most of the wings without
  // pulling in a neighbour.
  const pad = 2;
  const x0 = Math.max(0, blob.minX - pad);
  const x1 = Math.min(width - 1, blob.maxX + pad);
  const y0 = Math.max(0, blob.minY - pad);
  const y1 = Math.min(height - 1, blob.maxY + pad);
  const windowW = x1 - x0 + 1;

  // Background-subtracted window, cached once: the refinement reads it four times.
  const local = new Float32Array(windowW * (y1 - y0 + 1));
  const bgCentre = sampleMesh(mesh, mesh.level, (x0 + x1) / 2, (y0 + y1) / 2);

  let flux = 0;
  let sx = 0;
  let sy = 0;
  let peak = 0;
  let rawPeak = 0;

  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    const out = (y - y0) * windowW;
    for (let x = x0; x <= x1; x++) {
      const raw = data[row + x];
      if (raw > rawPeak) rawPeak = raw;
      const w = raw - sampleMesh(mesh, mesh.level, x + 0.5, y + 0.5);
      local[out + (x - x0)] = w;
      if (w <= 0) continue;
      flux += w;
      sx += w * (x + 0.5);
      sy += w * (y + 0.5);
      if (w > peak) peak = w;
    }
  }

  const fallback: Measurement = {
    x: (blob.minX + blob.maxX) / 2 + 0.5,
    y: (blob.minY + blob.maxY) / 2 + 0.5,
    flux: 0,
    peak: 0,
    fwhm: 0,
    elongation: 1,
    theta: 0,
    background: bgCentre,
    saturationPeak: rawPeak,
  };
  if (flux <= 0) return fallback;

  const isoX = sx / flux;
  const isoY = sy / flux;

  // -- second moments about the isophotal centre ------------------------------
  const shape = secondMoments(local, windowW, x0, y0, x1, y1, isoX, isoY, flux);

  // -- Gaussian-weighted re-centring ------------------------------------------
  // The weight width tracks the source: too narrow throws away signal, too wide
  // lets noise back in. The source's own sigma is the natural choice.
  const sigma = Math.max(0.7, Math.min(6, Math.sqrt(Math.sqrt(shape.majorVar * shape.minorVar))));
  const denom = 2 * sigma * sigma;

  let cx = isoX;
  let cy = isoY;
  for (let iter = 0; iter < 4; iter++) {
    let wSum = 0;
    let wx = 0;
    let wy = 0;
    for (let y = y0; y <= y1; y++) {
      const out = (y - y0) * windowW;
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        // Unclipped: negative noise pixels are kept, so positive ones cannot bias
        // the result.
        const w = local[out + (x - x0)] * Math.exp(-(dx * dx + dy * dy) / denom);
        wSum += w;
        wx += w * (x + 0.5);
        wy += w * (y + 0.5);
      }
    }
    if (!(wSum > 0)) break;
    const nx = wx / wSum;
    const ny = wy / wSum;
    const moved = Math.hypot(nx - cx, ny - cy);
    cx = nx;
    cy = ny;
    if (moved < 1e-4) break;
  }

  // If the refinement wandered off the blob it was not a real source; keep the
  // robust answer rather than the precise-looking one.
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || Math.hypot(cx - isoX, cy - isoY) > 2) {
    cx = isoX;
    cy = isoY;
  }

  const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
  return {
    x: cx,
    y: cy,
    flux,
    peak,
    // FWHM of a Gaussian with the same geometric-mean width as the ellipse.
    fwhm: FWHM_PER_SIGMA * Math.sqrt(Math.sqrt(shape.majorVar * shape.minorVar)),
    elongation: Math.sqrt(shape.majorVar / shape.minorVar),
    theta: shape.theta,
    background: bgCentre,
    saturationPeak: rawPeak,
  };
}

/** Principal axes of the flux-weighted second-moment ellipse. */
function secondMoments(
  local: Float32Array,
  windowW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  flux: number,
): { majorVar: number; minorVar: number; theta: number } {
  let mxx = 0;
  let myy = 0;
  let mxy = 0;
  for (let y = y0; y <= y1; y++) {
    const out = (y - y0) * windowW;
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const w = local[out + (x - x0)];
      if (w <= 0) continue;
      const dx = x + 0.5 - cx;
      mxx += w * dx * dx;
      myy += w * dy * dy;
      mxy += w * dx * dy;
    }
  }
  mxx /= flux;
  myy /= flux;
  mxy /= flux;

  const half = (mxx + myy) / 2;
  const disc = Math.sqrt(Math.max(0, ((mxx - myy) / 2) ** 2 + mxy * mxy));
  return {
    majorVar: Math.max(half + disc, 1e-9),
    minorVar: Math.max(half - disc, 1e-9),
    theta: 0.5 * Math.atan2(2 * mxy, mxx - myy),
  };
}

/** Median of an array, without mutating it. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Finds point sources in a luminance image.
 *
 * `frame` is stamped onto every source so that a video pass can keep frames
 * distinguishable once they are pooled.
 */
export function detectSources(
  image: LuminanceImage,
  overrides: Partial<DetectionParams> = {},
  frame = 0,
): DetectionResult {
  const params: DetectionParams = { ...DEFAULT_DETECTION_PARAMS, ...overrides };
  const started = Date.now();
  const { data, width, height } = image;

  const mesh = estimateBackground(image, params.backgroundCell);

  // Threshold against the local background and its local noise. Doing this per
  // pixel rather than per image is what lets a shot from a lit street still
  // yield the four stars it does contain.
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const bg = sampleMesh(mesh, mesh.level, x, y);
      const noise = sampleMesh(mesh, mesh.sigma, x, y);
      if (data[row + x] > bg + params.thresholdSigma * noise) mask[row + x] = 1;
    }
  }

  const rejected = { tooSmall: 0, tooLarge: 0, belowSnr: 0, truncatedByLimit: 0 };
  const raw: (Source & { _pointlike: boolean })[] = [];
  const overflowLimit = Math.max(params.maxArea * 4, 4096);

  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== 1) continue;
    const blob = floodFill(mask, width, height, p, overflowLimit);
    if (!blob) {
      rejected.tooLarge++;
      continue;
    }
    const area = blob.pixels.length;
    if (area < params.minArea) {
      rejected.tooSmall++;
      continue;
    }
    if (area > params.maxArea) {
      rejected.tooLarge++;
      continue;
    }

    const m = measure(image, mesh, blob);
    const noise = sampleMesh(mesh, mesh.sigma, m.x, m.y);
    // Background-limited signal to noise. Without knowing the sensor gain the
    // photon term is not available, so this is a lower bound -- which is the
    // right direction for a number the UI presents as confidence.
    const snr = noise > 0 ? m.flux / (noise * Math.sqrt(area)) : 0;
    if (snr < params.thresholdSigma) {
      rejected.belowSnr++;
      continue;
    }

    raw.push({
      id: `${frame}:${raw.length}`,
      x: m.x,
      y: m.y,
      flux: m.flux,
      peak: m.peak,
      area,
      snr,
      fwhm: m.fwhm,
      elongation: m.elongation,
      theta: m.theta,
      saturated: m.saturationPeak >= params.saturationLevel,
      background: m.background,
      frame,
      shape: 'point',
      // Seed set for the PSF estimate: round sources, not obviously sensor
      // artefacts. Deliberately generous -- this only has to be good enough to
      // take a median of, and the classification that follows uses the result.
      _pointlike: m.elongation < params.trailedElongation && m.fwhm >= params.sharpFwhmFloor,
    });
  }

  // The image's own point spread function, measured from the round sources it
  // actually contains. Everything else is judged relative to it, so a soft lens
  // and a sharp one are held to their own standards rather than a fixed number.
  const fwhmPixels = median(raw.filter((s) => s._pointlike).map((s) => s.fwhm));

  for (const s of raw) {
    s.shape = classifyShape(s, fwhmPixels, params);
  }

  raw.sort((a, b) => b.flux - a.flux);
  if (raw.length > params.maxSources) {
    rejected.truncatedByLimit = raw.length - params.maxSources;
    raw.length = params.maxSources;
  }

  // `_pointlike` was only ever a seed for the PSF estimate; it does not belong
  // in the public record of a source.
  const sources: Source[] = raw.map((s, i) => {
    const rest = { ...s } as Source & { _pointlike?: boolean };
    delete rest._pointlike;
    return { ...(rest as Source), id: `${frame}:${i}` };
  });

  return {
    sources,
    width,
    height,
    background: mesh.stats,
    fwhmPixels,
    rejected,
    params,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Shape class from pixel morphology alone -- never from what it might be.
 *
 * The `sharp` test is the one that carries physical weight: nothing that came
 * through the lens can be narrower than the lens's own point spread function, so
 * anything that is came from the sensor. Judging it against the PSF measured in
 * this very image means the rule holds for a soft phone camera and a sharp prime
 * alike, instead of encoding one camera's pixel scale as a constant.
 */
function classifyShape(
  s: { fwhm: number; elongation: number },
  imageFwhm: number | null,
  params: DetectionParams,
): SourceShape {
  const sharpLimit =
    imageFwhm !== null
      ? Math.max(params.sharpFwhmFloor, imageFwhm * params.sharpFwhmFraction)
      : params.sharpFwhmFloor;
  if (s.fwhm < sharpLimit) return 'sharp';
  if (s.elongation > params.trailedElongation) return 'trailed';
  if (imageFwhm !== null && s.fwhm > params.diffuseFwhmFactor * imageFwhm) return 'diffuse';
  return 'point';
}
