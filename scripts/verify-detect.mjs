#!/usr/bin/env node
/**
 * Proves the detector honestly.
 *
 * A detector is easy to fool into looking good: run it on a clean image, count
 * the blobs, declare victory. So this builds synthetic frames where the truth is
 * known exactly -- planted stars at known sub-pixel positions and known fluxes,
 * on a light-pollution gradient, under Gaussian noise -- and asks the questions
 * that actually matter:
 *
 *   - how accurately does it recover a centroid, in pixels
 *   - what fraction of planted stars does it find, by signal to noise
 *   - how many sources does it invent that were never there
 *   - does the background mesh actually flatten a gradient, or does it just find
 *     everything in the bright corner
 *   - does morphology separate a hot pixel and a trail from a real star
 *
 * Run with:  npm run verify:detect
 */
import { readFile } from 'node:fs/promises';
import { detectSources } from '../lib/detect/detector.ts';

// -- deterministic noise -------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianPair(rand) {
  const u = Math.max(1e-12, rand());
  const v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

// -- synthetic frame -----------------------------------------------------------

const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2));

/**
 * Plants a Gaussian point source. `flux` is total integrated flux above
 * background, so peak brightness follows from the width the way a real star's
 * does.
 */
function plantStar(img, width, height, cx, cy, flux, fwhm) {
  const sigma = fwhm * FWHM_TO_SIGMA;
  const norm = flux / (2 * Math.PI * sigma * sigma);
  const reach = Math.ceil(4 * sigma);
  for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(height - 1, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(width - 1, Math.ceil(cx + reach)); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      img[y * width + x] += norm * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }
}

/** A streak: a point source dragged along a vector. */
function plantTrail(img, width, height, cx, cy, dx, dy, flux, fwhm) {
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1) - 0.5;
    plantStar(img, width, height, cx + dx * t, cy + dy * t, flux / steps, fwhm);
  }
}

const WIDTH = 900;
const HEIGHT = 700;
const SKY = 0.08;
const NOISE = 0.004;
const FWHM = 2.6;

function buildFrame(seed) {
  const rand = mulberry32(seed);
  const data = new Float32Array(WIDTH * HEIGHT);

  // Light-pollution gradient: brightest in one corner, a factor of four across
  // the frame. A detector using one global threshold fails this outright.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const ramp = 1 + 3 * ((x / WIDTH) * 0.7 + (y / HEIGHT) * 0.3);
      data[y * WIDTH + x] = SKY * ramp;
    }
  }

  // Planted stars, spread over three decades of flux so the recall curve has
  // something to show. Kept apart by more than a PSF width: this frame is
  // measuring detection, and blending gets its own test below so that the
  // limitation is visible rather than folded into the completeness number.
  const truth = [];
  const margin = 16;
  const minSeparation = 4 * FWHM;
  for (let attempt = 0; attempt < 4000 && truth.length < 200; attempt++) {
    const cx = margin + rand() * (WIDTH - 2 * margin);
    const cy = margin + rand() * (HEIGHT - 2 * margin);
    if (truth.some((t) => Math.hypot(t.cx - cx, t.cy - cy) < minSeparation)) continue;
    // Flux chosen log-uniformly; the faintest are meant to be missed.
    const flux = 0.02 * Math.pow(10, rand() * 2.2);
    plantStar(data, WIDTH, HEIGHT, cx, cy, flux, FWHM);
    truth.push({ cx, cy, flux });
  }

  // A single dead-sharp pixel, which should not survive the minimum-area rule at
  // all, and a 2x2 spike of the kind demosaicing leaves behind, which should
  // survive and be classed on its width.
  const singlePixel = { x: 120.5, y: 640.5 };
  data[Math.floor(singlePixel.y) * WIDTH + Math.floor(singlePixel.x)] += 0.9;
  const hot = { x: 200.5, y: 620.5 };
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    data[(Math.floor(hot.y) + dy) * WIDTH + Math.floor(hot.x) + dx] += 0.75;
  }

  // A bright, continuous streak -- the shape a satellite or aircraft leaves.
  const trail = { cx: 700, cy: 150 };
  plantTrail(data, WIDTH, HEIGHT, trail.cx, trail.cy, 34, 8, 9.0, FWHM);

  // Two stars a PSF width apart: the deliberate blend case.
  const blend = { cx: 420, cy: 560, separation: 2.0 };
  plantStar(data, WIDTH, HEIGHT, blend.cx - blend.separation / 2, blend.cy, 2.0, FWHM);
  plantStar(data, WIDTH, HEIGHT, blend.cx + blend.separation / 2, blend.cy, 2.0, FWHM);

  // Noise last, so it lands on everything.
  for (let i = 0; i < data.length; i += 2) {
    const [a, b] = gaussianPair(rand);
    data[i] += a * NOISE;
    if (i + 1 < data.length) data[i + 1] += b * NOISE;
  }

  return { image: { data, width: WIDTH, height: HEIGHT }, truth, hot, singlePixel, trail, blend };
}

// -- run -----------------------------------------------------------------------

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)}${detail ?? ''}`);
};

const { image, truth, hot, singlePixel, trail, blend } = buildFrame(20260819);
const result = detectSources(image);

console.log(`\nframe ${WIDTH}x${HEIGHT}, ${truth.length} planted stars + hot pixels + a trail + a blended pair`);
console.log(`sky ${SKY} to ${(SKY * 4).toFixed(3)} across the frame, noise sigma ${NOISE}\n`);

console.log(
  `background mesh  median ${result.background.median.toFixed(4)}  sigma ${result.background.sigma.toFixed(5)}  ` +
    `range ${result.background.min.toFixed(4)} .. ${result.background.max.toFixed(4)}`,
);
console.log(
  `detection        ${result.sources.length} sources in ${result.elapsedMs} ms, ` +
    `measured FWHM ${result.fwhmPixels?.toFixed(2) ?? '-'} px`,
);
console.log(`rejected         ${JSON.stringify(result.rejected)}\n`);

// The mesh must track the gradient rather than average it away.
check(
  'background mesh follows the gradient',
  result.background.max / result.background.min > 3 && result.background.max / result.background.min < 4.5,
  `ratio ${(result.background.max / result.background.min).toFixed(2)} (planted 4.0)`,
);
check(
  'noise estimate is close to the planted sigma',
  Math.abs(result.background.sigma - NOISE) / NOISE < 0.15,
  `${result.background.sigma.toFixed(5)} vs ${NOISE}`,
);
check(
  'measured FWHM matches the planted PSF',
  result.fwhmPixels !== null && Math.abs(result.fwhmPixels - FWHM) < 0.5,
  `${result.fwhmPixels?.toFixed(2)} px vs ${FWHM} px`,
);

// -- association against truth (a test may look at the answers) ----------------

const MATCH_RADIUS = 2.5;
const used = new Set();
const pairs = [];
const spurious = [];

for (const s of result.sources) {
  let best = -1;
  let bestD = MATCH_RADIUS;
  for (let i = 0; i < truth.length; i++) {
    if (used.has(i)) continue;
    const d = Math.hypot(s.x - truth[i].cx, s.y - truth[i].cy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) {
    used.add(best);
    pairs.push({ source: s, truth: truth[best], d: bestD });
  } else {
    spurious.push(s);
  }
}

const errors = pairs.map((p) => p.d);
const rms = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / Math.max(1, errors.length));
const bright = pairs.filter((p) => p.source.snr > 20).map((p) => p.d);
const rmsBright = Math.sqrt(bright.reduce((a, e) => a + e * e, 0) / Math.max(1, bright.length));

console.log('\n-- astrometry -----------------------------------------------------------');
console.log(`     recovered ${pairs.length}/${truth.length} planted stars`);
console.log(`     centroid RMS ${rms.toFixed(3)} px overall, ${rmsBright.toFixed(3)} px for SNR > 20`);

check('centroid RMS under half a pixel', rms < 0.5, `${rms.toFixed(3)} px`);
check('bright centroids good to a tenth of a pixel', rmsBright < 0.1, `${rmsBright.toFixed(3)} px`);

// -- completeness by signal to noise -------------------------------------------

console.log('\n-- completeness ---------------------------------------------------------');
const bands = [
  [0, 0.05],
  [0.05, 0.15],
  [0.15, 0.5],
  [0.5, 1.5],
  [1.5, Infinity],
];
const foundFlux = new Set(pairs.map((p) => p.truth));
for (const [lo, hi] of bands) {
  const inBand = truth.filter((t) => t.flux >= lo && t.flux < hi);
  if (inBand.length === 0) continue;
  const found = inBand.filter((t) => foundFlux.has(t)).length;
  const bar = '#'.repeat(Math.round((found / inBand.length) * 30)).padEnd(30, '.');
  console.log(
    `     flux ${lo.toFixed(2)}-${hi === Infinity ? ' inf' : hi.toFixed(2)}  ${bar}  ${found}/${inBand.length}`,
  );
}

const strong = truth.filter((t) => t.flux > 0.5);
const strongFound = strong.filter((t) => foundFlux.has(t)).length;
check(
  'finds every well-separated bright star',
  strongFound === strong.length,
  `${strongFound}/${strong.length}`,
);

// -- false positives -----------------------------------------------------------

console.log('\n-- spurious sources -----------------------------------------------------');
// The planted artefacts are expected in this list; anything else is noise the
// detector believed.
const near = (list, x, y, r) => list.filter((s) => Math.hypot(s.x - x, s.y - y) < r);
const nearHot = near(spurious, hot.x, hot.y, 4);
const nearTrail = near(spurious, trail.cx, trail.cy, 40);
const nearBlend = near(spurious, blend.cx, blend.cy, 6);
const planted = new Set([...nearHot, ...nearTrail, ...nearBlend]);
const unexplained = spurious.filter((s) => !planted.has(s));
console.log(
  `     ${spurious.length} unassociated: ${nearHot.length} hot pixel, ${nearTrail.length} trail, ` +
    `${nearBlend.length} blend, ${unexplained.length} otherwise`,
);

check(
  'noise alone produces almost no detections',
  unexplained.length <= 3,
  `${unexplained.length} over ${(WIDTH * HEIGHT) / 1e3}k pixels`,
);

// -- morphology ----------------------------------------------------------------

console.log('\n-- morphology -----------------------------------------------------------');
const nearest = (x, y) =>
  [...result.sources].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];

const hotSource = nearest(hot.x, hot.y);
const trailSource = nearest(trail.cx, trail.cy);
const describe = (label, s, tx, ty) =>
  console.log(
    `     ${label.padEnd(12)} -> shape ${s.shape.padEnd(8)} fwhm ${s.fwhm.toFixed(2)} ` +
      `elongation ${s.elongation.toFixed(2)} area ${String(s.area).padStart(4)} ` +
      `offset ${Math.hypot(s.x - tx, s.y - ty).toFixed(2)} px`,
  );

describe('2x2 spike', hotSource, hot.x, hot.y);
describe('trail', trailSource, trail.cx, trail.cy);

check(
  'a single dead pixel never becomes a source',
  !result.sources.some((s) => Math.hypot(s.x - singlePixel.x, s.y - singlePixel.y) < 3),
  'rejected by the minimum-area rule',
);
check(
  'a tight spike is classed sharp',
  Math.hypot(hotSource.x - hot.x, hotSource.y - hot.y) < 3 && hotSource.shape === 'sharp',
  `shape ${hotSource.shape}, fwhm ${hotSource.fwhm.toFixed(2)}`,
);
check(
  'a streak is classed trailed',
  Math.hypot(trailSource.x - trail.cx, trailSource.y - trail.cy) < 20 && trailSource.shape === 'trailed',
  `shape ${trailSource.shape}, elongation ${trailSource.elongation.toFixed(2)}`,
);

// -- blending, stated rather than hidden ---------------------------------------
// There is no deblender. Two stars closer than about a PSF width merge into one
// source. That is a real limitation and the point of this check is that it shows
// up as a measurably wider source rather than as a silent miss.
console.log('\n-- blending (known limitation) ------------------------------------------');
const blendSources = result.sources.filter((s) => Math.hypot(s.x - blend.cx, s.y - blend.cy) < 6);
const widest = blendSources.sort((a, b) => b.fwhm - a.fwhm)[0];
console.log(
  `     two stars ${blend.separation} px apart produced ${blendSources.length} source(s); ` +
    `widest fwhm ${widest ? widest.fwhm.toFixed(2) : '-'} px against a ${result.fwhmPixels?.toFixed(2)} px PSF`,
);
// A pair separated along one axis widens that axis only, so elongation is the
// signature that actually shows, not overall width.
check(
  'a blend merges into a single, measurably non-PSF-like source',
  blendSources.length === 1 && widest.elongation > 1.15,
  `${blendSources.length} source(s), elongation ${widest?.elongation.toFixed(2)}, ` +
    `fwhm ratio ${(widest.fwhm / result.fwhmPixels).toFixed(2)}`,
);

const starShapes = pairs.filter((p) => p.source.snr > 15).map((p) => p.source.shape);
const pointFraction = starShapes.filter((s) => s === 'point').length / Math.max(1, starShapes.length);
check(
  'real stars are classed point',
  pointFraction > 0.95,
  `${(pointFraction * 100).toFixed(1)}% of SNR>15 recoveries`,
);

// -- flux ordering -------------------------------------------------------------

console.log('\n-- photometry -----------------------------------------------------------');
// Measured flux should track planted flux closely; a systematic offset would
// mean the background is being over- or under-subtracted.
const photometric = pairs.filter((p) => p.source.snr > 20 && !p.source.saturated);
const ratios = photometric.map((p) => p.source.flux / p.truth.flux).sort((a, b) => a - b);
const medianRatio = ratios[ratios.length >> 1];
console.log(
  `     measured/planted flux: median ${medianRatio.toFixed(3)} over ${photometric.length} sources ` +
    `(p10 ${ratios[Math.floor(ratios.length * 0.1)].toFixed(3)}, p90 ${ratios[Math.floor(ratios.length * 0.9)].toFixed(3)})`,
);
check('photometry is unbiased to within 10%', Math.abs(medianRatio - 1) < 0.1, `${medianRatio.toFixed(3)}`);

// -- catalogue blindness -------------------------------------------------------
// Structural rather than statistical. The guarantee that matters is that the
// detector cannot consult the sky model even if someone later wanted it to, so
// this reads its own source and checks what it is allowed to import.
console.log('\n-- catalogue blindness --------------------------------------------------');
{
  const source = await readFile(new URL('../lib/detect/detector.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  const forbidden = imports.filter((i) => /astro|catalog|sky|predicted/i.test(i));
  console.log(`     detector.ts imports: ${imports.join(', ') || '(none)'}`);
  check('the detector imports nothing from the prediction lane', forbidden.length === 0, forbidden.join(', '));

  // And it is deterministic: the same pixels always give the same answer, so a
  // disagreement between two runs is always a real change, never sampling.
  const again = detectSources(image);
  const same =
    again.sources.length === result.sources.length &&
    again.sources.every((s, i) => s.x === result.sources[i].x && s.y === result.sources[i].y);
  check('detection is deterministic', same);
}

console.log(failures === 0 ? '\nDetector checks out.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
