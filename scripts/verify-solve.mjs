#!/usr/bin/env node
/**
 * Proves the plate solve, and proves that it refuses.
 *
 * A solver is easy to make look good: point it at a frame you already know the
 * answer to and admire the answer. The hard requirements are the other two:
 *
 *   it must recover a *known* attitude and focal length from pixels alone, with
 *   no prior, to a stated accuracy; and
 *
 *   it must refuse when it should. A confident wrong answer is far worse than no
 *   answer, so most of what follows feeds it frames that contain no solve --
 *   pure noise, a rotated sky, too few stars -- and checks that it says so.
 *
 * Truth here is synthetic: a real attitude and focal length are chosen, real
 * catalogue stars are projected through them, noise and false sources are added,
 * and the solver sees only the resulting pixel coordinates.
 *
 * Run with:  npm run verify:solve
 */
import { readFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { DEG, ARCMIN, altAzToVector, eqjToSceneMatrix } from '../lib/astro/frames.ts';
import { focalFromDiagonalFov, makeCamera, rayToPixel, insideFrame } from '../lib/solve/camera.ts';
import { solvePlate } from '../lib/solve/solve.ts';
import { triadRotation } from '../lib/solve/wahba.ts';

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)}${detail ?? ''}`);
};

// -- load the real catalogue ---------------------------------------------------

const meta = JSON.parse(await readFile(new URL('../public/catalog/stars.meta.json', import.meta.url), 'utf8'));
const binBuf = await readFile(new URL('../public/catalog/stars.bin', import.meta.url));
const raw = new Float32Array(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength / 4);
const names = JSON.parse(await readFile(new URL('../public/catalog/star-names.json', import.meta.url), 'utf8')).names;

const SITE = { latitude: 51.4779, longitude: -0.0015, elevation: 47 };
const WHEN = new Date('2026-01-15T22:00:00Z');
const skyRotation = eqjToSceneMatrix(WHEN, SITE);

/** Every catalogue star above the horizon, in scene space, brightest first. */
function visibleCandidates(magLimit) {
  const out = [];
  const v = new Vector3();
  for (let i = 0; i < meta.count; i++) {
    const mag = raw[i * meta.stride + 3];
    if (mag > magLimit) break; // sorted brightest-first
    v.set(raw[i * meta.stride], raw[i * meta.stride + 1], raw[i * meta.stride + 2]).applyMatrix3(skyRotation);
    if (v.y <= 0.02) continue;
    out.push({ id: `star:${i}`, x: v.x, y: v.y, z: v.z, magnitude: mag });
  }
  return out;
}

/** A rotation from camera frame to scene frame for a given aim and roll. */
function attitudeFor(altitude, azimuth, rollDeg) {
  const boresight = altAzToVector({ altitude, azimuth });
  // Image "up" starts at the zenith projected into the frame, then rolls.
  const zenith = new Vector3(0, 1, 0).addScaledVector(boresight, -boresight.y).normalize();
  const right = new Vector3().crossVectors(zenith, boresight).normalize();
  const roll = rollDeg * DEG;
  const up = zenith.clone().multiplyScalar(Math.cos(roll)).addScaledVector(right, Math.sin(roll));
  // Camera looks down -z, so -z maps to the boresight and +y to image up.
  return triadRotation(new Vector3(0, 0, -1), new Vector3(0, 1, 0), boresight, up);
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Renders a synthetic observation: catalogue stars projected through a known
 * attitude and lens, jittered, with a share of false sources mixed in.
 */
function synthesise({
  altitude,
  azimuth,
  roll,
  fovDeg,
  width = 1600,
  height = 1200,
  magLimit = 5.5,
  centroidNoisePx = 0.35,
  falseSources = 0,
  k1 = 0,
  seed = 7,
}) {
  const rand = mulberry32(seed);
  const rotation = attitudeFor(altitude, azimuth, roll);
  const inverse = rotation.clone().invert();
  const focal = focalFromDiagonalFov(width, height, fovDeg);
  const camera = makeCamera(width, height, focal, k1);

  const candidates = visibleCandidates(Math.max(magLimit + 1.5, 6.5));
  const sources = [];
  const truth = new Map();
  const v = new Vector3();

  for (const c of candidates) {
    if (c.magnitude > magLimit) continue;
    v.set(c.x, c.y, c.z).applyMatrix3(inverse);
    const px = rayToPixel(camera, v);
    if (!px || !insideFrame(camera, px.x, px.y, -8)) continue;

    const gauss = () => {
      const u = Math.max(1e-9, rand());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const id = `src:${sources.length}`;
    sources.push({
      id,
      x: px.x + gauss() * centroidNoisePx,
      y: px.y + gauss() * centroidNoisePx,
      // Flux from magnitude, which is what a detector would actually measure.
      flux: Math.pow(10, -0.4 * c.magnitude),
    });
    truth.set(id, c.id);
  }

  for (let i = 0; i < falseSources; i++) {
    sources.push({
      id: `false:${i}`,
      x: rand() * width,
      y: rand() * height,
      // Deliberately bright: a satellite or an aircraft outshines most stars, and
      // the anchor search has to survive that.
      flux: Math.pow(10, -0.4 * (rand() * 3)),
    });
  }

  return { sources, truth, camera, rotation, candidates, width, height, focal };
}

/**
 * Pairs whose assigned catalogue entry is genuinely the wrong object.
 *
 * Not simply "a different id from the one that generated the source". HYG lists
 * the components of close doubles separately, so two catalogue entries can sit a
 * few arcseconds apart and describe what any camera records as a single point.
 * Pairing with the companion instead of the primary is the catalogue being finer
 * than the evidence, not the solver being wrong -- so a mismatch only counts when
 * the two entries are far enough apart to be distinguishable in the frame.
 */
function misidentified(result, scene, thresholdArcmin = 2) {
  const byId = new Map(scene.candidates.map((c) => [c.id, c]));
  let wrong = 0;
  for (const pair of result.pairs) {
    const truthId = scene.truth.get(pair.sourceId);
    if (truthId === pair.candidateId) continue;
    const a = byId.get(truthId);
    const b = byId.get(pair.candidateId);
    if (!a || !b) {
      wrong++;
      continue;
    }
    const separation =
      (2 *
        Math.asin(
          Math.min(1, new Vector3(a.x, a.y, a.z).distanceTo(new Vector3(b.x, b.y, b.z)) / 2),
        )) /
      ARCMIN;
    if (separation > thresholdArcmin) wrong++;
  }
  return wrong;
}

/**
 * Misidentifications the app would have presented confidently.
 *
 * A pair whose runner-up candidate sits almost as close is ambiguous evidence,
 * and `scoreMatch` scores it near zero for exactly that reason -- the interface
 * shows it as uncertain. Counting those as failures would hold the solver to a
 * standard the product does not claim.
 */
function confidentMisidentifications(result, scene, isolationRatio = 2.5) {
  const byId = new Map(scene.candidates.map((c) => [c.id, c]));
  let wrong = 0;
  for (const pair of result.pairs) {
    const truthId = scene.truth.get(pair.sourceId);
    if (truthId === pair.candidateId) continue;
    const a = byId.get(truthId);
    const b = byId.get(pair.candidateId);
    if (a && b) {
      const separation =
        (2 * Math.asin(Math.min(1, new Vector3(a.x, a.y, a.z).distanceTo(new Vector3(b.x, b.y, b.z)) / 2))) /
        ARCMIN;
      if (separation <= 2) continue; // the catalogue splitting one point in two
    }
    const isolation = pair.nextNearestArcmin / Math.max(pair.residualArcmin, 1e-6);
    if (isolation >= isolationRatio) wrong++;
  }
  return wrong;
}

/** How far the solved boresight is from the truth, in arcminutes. */
function pointingErrorArcmin(attitude, truthRotation) {
  const truthBoresight = new Vector3(0, 0, -1).applyMatrix3(truthRotation).normalize();
  const solved = altAzToVector({ altitude: attitude.altitude, azimuth: attitude.azimuth });
  return (2 * Math.asin(Math.min(1, solved.distanceTo(truthBoresight) / 2))) / ARCMIN;
}

// -- 1. blind solve, no prior at all -------------------------------------------

console.log('\n-- blind solve, no field-of-view prior -----------------------------------');
{
  const cases = [
    { altitude: 55, azimuth: 120, roll: 0, fovDeg: 45, magLimit: 5.0, label: 'moderate field, no roll' },
    { altitude: 38, azimuth: 250, roll: 137, fovDeg: 68, magLimit: 5.5, label: 'wide field, heavy roll' },
    { altitude: 20, azimuth: 195, roll: 41, fovDeg: 90, magLimit: 5.2, label: 'very wide, low altitude' },
  ];

  for (const c of cases) {
    const scene = synthesise({ ...c, seed: 1000 + c.fovDeg });
    if (scene.sources.length < 8) {
      check(c.label, false, `only ${scene.sources.length} stars in frame — bad test case`);
      continue;
    }
    const result = solvePlate({
      sources: scene.sources,
      width: scene.width,
      height: scene.height,
      fovPriorDeg: null,
      candidates: scene.candidates,
    });

    if (!result.ok) {
      check(
        c.label,
        false,
        `refused: ${result.failure} — ${result.message} [${scene.sources.length} sources, ` +
          `${scene.candidates.length} candidates, ${result.hypothesesTested} hypotheses]`,
      );
      continue;
    }

    const pointing = pointingErrorArcmin(result.attitude, scene.rotation);
    const fovError = Math.abs(result.attitude.fovDiagonalDeg - c.fovDeg) / c.fovDeg;
    const rollError = Math.abs(((result.attitude.roll - c.roll + 540) % 360) - 180);

    // Correctness of the *identifications*, which is what the app shows.
    const wrong = misidentified(result, scene);
    // A wrong pair only matters if the app would have presented it confidently.
    // Isolation -- how much closer the chosen candidate is than the runner-up --
    // is what `scoreMatch` uses to decide that, so a misidentification among
    // crowded, poorly isolated candidates is reported rather than asserted away.
    const confidentlyWrong = confidentMisidentifications(result, scene);

    const ok = pointing < 12 && fovError < 0.02 && rollError < 0.5 && confidentlyWrong === 0;
    check(
      c.label,
      ok,
      `${result.pairs.length} matched, pointing ${pointing.toFixed(2)}′, ` +
        `fov ${result.attitude.fovDiagonalDeg.toFixed(2)}° (truth ${c.fovDeg}°), ` +
        `roll err ${rollError.toFixed(2)}°, rms ${result.rmsArcmin.toFixed(2)}′, ` +
        `${wrong} misidentified (${confidentlyWrong} of them confident), ` +
        `pass ${result.pass}, ${result.elapsedMs} ms`,
    );
  }
}

// -- 1b. the narrow-field limit ------------------------------------------------
//
// A stated boundary rather than a hidden one.
//
// The blind search fixes scale from one hypothesised pair, which means the
// catalogue partner can lie anywhere in a ring whose width is the entire range of
// focal lengths still in play. Across 6 to 130 degrees that ring holds a fifth of
// the sky. A wide frame escapes this because its brightest stars are bright
// enough to sit near the top of the catalogue, so the correct anchor is found
// early; a narrow frame pointed at an unremarkable patch has no bright star at
// all, and reaching an anchor thousands of entries down while sweeping a ring
// that large runs to a hundred million hypotheses.
//
// What matters is that it fails safely -- refusing rather than inventing -- and
// that the ordinary remedy works: any rough idea of the field collapses the ring
// and the same frame solves at once.
console.log(`
-- narrow field without a scale hint --------------------------------------`);
{
  const narrow = { altitude: 72, azimuth: 30, roll: -84, fovDeg: 22, magLimit: 6.2 };
  const scene = synthesise({ ...narrow, seed: 1022 });
  const common = { sources: scene.sources, width: scene.width, height: scene.height, candidates: scene.candidates };

  const blind = solvePlate(common);
  check(
    'refuses rather than inventing an answer',
    !blind.ok,
    blind.ok ? 'ACCEPTED — a fabricated identification' : `${blind.failure}: ${blind.message.slice(0, 62)}`,
  );

  // A hint deliberately 30% away from the truth: the sort of thing a focal
  // length tag, or a user picking "telephoto", would supply.
  const hinted = solvePlate({ ...common, fovPriorDeg: narrow.fovDeg * 1.3 });
  const pointing = hinted.ok ? pointingErrorArcmin(hinted.attitude, scene.rotation) : Infinity;
  check(
    'and solves as soon as it has a rough field of view',
    hinted.ok && pointing < 12 && confidentMisidentifications(hinted, scene) === 0,
    hinted.ok
      ? `${hinted.pairs.length} matched, pointing ${pointing.toFixed(2)}′, ` +
        `fov ${hinted.attitude.fovDiagonalDeg.toFixed(2)}° (truth ${narrow.fovDeg}°), ` +
        `rms ${hinted.rmsArcmin.toFixed(2)}′, pass ${hinted.pass}, ${hinted.elapsedMs} ms`
      : hinted.message,
  );
}

// -- 2. survives contamination -------------------------------------------------

console.log('\n-- contaminated frames ---------------------------------------------------');
{
  const scene = synthesise({
    altitude: 48,
    azimuth: 140,
    roll: 62,
    fovDeg: 60,
    magLimit: 5.4,
    falseSources: 25,
    centroidNoisePx: 0.6,
    seed: 4242,
  });
  const result = solvePlate({
    sources: scene.sources,
    width: scene.width,
    height: scene.height,
    candidates: scene.candidates,
  });
  const wrong = result.ok ? confidentMisidentifications(result, scene) : -1;
  // One confident error in a hundred-odd identifications, on a frame carrying
  // twenty-five fabricated bright sources, is the honest standard here -- not
  // zero. The interface reports per-match confidence for exactly this reason.
  check(
    '25 bright false sources do not derail the solve',
    result.ok && wrong <= Math.ceil(result.pairs.length * 0.02),
    result.ok
      ? `${result.pairs.length} matched, ${wrong} confidently misidentified, rms ${result.rmsArcmin.toFixed(2)}′, pass ${result.pass}`
      : `refused (pass ${result.pass}): ${result.message} [${scene.sources.length} sources incl. 25 false; ` +
        `solve pointed ${(pointingErrorArcmin(result.attitude, scene.rotation) / 60).toFixed(1)}° off, ` +
        `fov ${result.attitude?.fovDiagonalDeg.toFixed(1)}° vs truth 60°]`,
  );
}

// -- 3. radial distortion ------------------------------------------------------

console.log('\n-- lens distortion -------------------------------------------------------');
{
  const k1 = -0.11;
  const scene = synthesise({ altitude: 44, azimuth: 200, roll: 15, fovDeg: 78, magLimit: 5.6, k1, seed: 909 });
  const result = solvePlate({
    sources: scene.sources,
    width: scene.width,
    height: scene.height,
    candidates: scene.candidates,
  });
  check(
    'a distorted wide lens still solves',
    result.ok,
    result.ok
      ? `rms ${result.rmsArcmin.toFixed(2)}′, fitted k1 ${result.attitude.k1.toFixed(3)} (truth ${k1})`
      : result.message,
  );
  if (result.ok) {
    // The fit does not have to recover k1 exactly -- focal length and distortion
    // trade against each other -- but it must land close enough that edge stars
    // are not systematically off.
    check(
      'the fitted distortion has the right sign and rough size',
      result.attitude.k1 < -0.03 && result.attitude.k1 > -0.25,
      `k1 ${result.attitude.k1.toFixed(3)}`,
    );
  }
}

// -- 4. refusal ----------------------------------------------------------------
// The most important section. Each of these frames contains no correct answer,
// and the only acceptable behaviour is to say so.

console.log('\n-- refusal ---------------------------------------------------------------');
{
  const rand = mulberry32(99);
  const candidates = visibleCandidates(6.5);

  // Pure noise: sources scattered at random.
  const noise = [];
  for (let i = 0; i < 60; i++) {
    noise.push({ id: `n:${i}`, x: rand() * 1600, y: rand() * 1200, flux: rand() });
  }
  const noiseResult = solvePlate({ sources: noise, width: 1600, height: 1200, candidates });
  check(
    'random sources are refused',
    !noiseResult.ok,
    noiseResult.ok
      ? `ACCEPTED ${noiseResult.pairs.length} matches — this is the dangerous failure`
      : `${noiseResult.failure}: ${noiseResult.message.slice(0, 78)}`,
  );

  // Too few sources to be worth trusting: a real frame, cut down to four stars.
  const scant = synthesise({ altitude: 55, azimuth: 130, roll: 0, fovDeg: 50, magLimit: 5.5, seed: 5 });
  const scantResult = solvePlate({
    sources: scant.sources.slice(0, 4),
    width: scant.width,
    height: scant.height,
    candidates: scant.candidates,
  });
  check(
    'four sources are refused rather than fitted',
    !scantResult.ok,
    `${scantResult.failure}: ${scantResult.message.slice(0, 70)}`,
  );

  // A real star field, but from a sky that was never above this horizon: the
  // frame is internally consistent and simply does not belong to this observer.
  const wrongSky = synthesise({ altitude: 50, azimuth: 100, roll: 0, fovDeg: 40, magLimit: 5.2, seed: 31 });
  const decoys = visibleCandidates(6.5).filter((_, i) => i % 3 === 0);
  const shuffled = wrongSky.sources.map((s, i) => ({
    ...s,
    // Reflect the frame. Every internal angle is preserved, so a solver that
    // only checks distances would be delighted; a proper rotation cannot fit it.
    x: wrongSky.width - s.x,
    y: s.y,
    id: `m:${i}`,
  }));
  const mirrored = solvePlate({
    sources: shuffled,
    width: wrongSky.width,
    height: wrongSky.height,
    candidates: decoys,
  });
  check(
    'a mirrored frame is refused',
    !mirrored.ok,
    mirrored.ok
      ? `ACCEPTED ${mirrored.pairs.length} matches from a mirror image`
      : `${mirrored.failure}: ${mirrored.message.slice(0, 70)}`,
  );
}

// -- 5. the prior helps, and does not constrain the answer ---------------------

console.log('\n-- field-of-view prior ---------------------------------------------------');
{
  const truthFov = 63;
  const scene = synthesise({ altitude: 52, azimuth: 165, roll: 22, fovDeg: truthFov, magLimit: 5.5, seed: 77 });
  // A generous budget for both, so the comparison measures the prior's effect
  // rather than where each run hit the same ceiling.
  const common = {
    sources: scene.sources,
    width: scene.width,
    height: scene.height,
    candidates: scene.candidates,
    params: { maxHypotheses: 5_000_000 },
  };

  const blind = solvePlate(common);
  // A prior that is wrong by 20%, the way a phone's recorded focal length is.
  const hinted = solvePlate({ ...common, fovPriorDeg: truthFov * 1.2 });

  check('solves with a deliberately wrong prior', hinted.ok, hinted.ok ? '' : hinted.message);
  if (blind.ok && hinted.ok) {
    check(
      'the prior does not drag the answer towards itself',
      Math.abs(hinted.attitude.fovDiagonalDeg - truthFov) < 0.02 * truthFov,
      `${hinted.attitude.fovDiagonalDeg.toFixed(2)}° against a ${(truthFov * 1.2).toFixed(1)}° hint, ` +
        `truth ${truthFov}°`,
    );
    check(
      'and it makes the search cheaper',
      hinted.hypothesesTested < blind.hypothesesTested,
      `${hinted.hypothesesTested} hypotheses against ${blind.hypothesesTested} blind ` +
        `(${hinted.elapsedMs} ms vs ${blind.elapsedMs} ms)`,
    );
  }
}

// -- 6. named identifications --------------------------------------------------

console.log('\n-- what the user actually sees -------------------------------------------');
{
  // Aim at Orion, which is up from London on a January evening.
  const orion = { altitude: 30, azimuth: 180, roll: 8, fovDeg: 40, magLimit: 5.0 };
  const scene = synthesise({ ...orion, seed: 2024 });
  const result = solvePlate({
    sources: scene.sources,
    width: scene.width,
    height: scene.height,
    candidates: scene.candidates,
  });

  if (!result.ok) {
    check('the demonstration frame solves', false, result.message);
  } else {
    const named = result.pairs
      .map((p) => {
        const idx = Number(p.candidateId.split(':')[1]);
        return { name: names[idx]?.p, residual: p.residualArcmin };
      })
      .filter((n) => n.name)
      .sort((a, b) => a.residual - b.residual);

    console.log(`     ${result.message}`);
    console.log(`     named: ${named.map((n) => `${n.name} (${n.residual.toFixed(1)}′)`).join(', ') || 'none'}`);
    check('the solve names recognisable stars', named.length > 0, `${named.length} carry proper names`);
    const wrong = misidentified(result, scene);
    check(
      'every accepted pair is a true identification',
      wrong === 0,
      `${result.pairs.length} pairs, ${wrong} genuinely wrong`,
    );
  }
}

// -- 7. residual structure -----------------------------------------------------

console.log('\n-- residuals -------------------------------------------------------------');
{
  const scene = synthesise({ altitude: 46, azimuth: 210, roll: 33, fovDeg: 55, magLimit: 5.6, centroidNoisePx: 0.4, seed: 313 });
  const result = solvePlate({
    sources: scene.sources,
    width: scene.width,
    height: scene.height,
    candidates: scene.candidates,
  });
  if (!result.ok) {
    check('control frame solves', false, result.message);
  } else {
    // With a correct model the residuals should be noise: no net drift, and a
    // spread consistent with the centroid error that was planted.
    const dx = result.pairs.map((p) => p.observedX - p.predictedX);
    const dy = result.pairs.map((p) => p.observedY - p.predictedY);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const meanX = mean(dx);
    const meanY = mean(dy);
    const spread = Math.sqrt(mean(dx.map((v) => v * v)) + mean(dy.map((v) => v * v)));
    console.log(
      `     mean residual (${meanX.toFixed(3)}, ${meanY.toFixed(3)}) px, spread ${spread.toFixed(3)} px, ` +
        `planted centroid noise 0.40 px`,
    );
    check('residuals have no systematic drift', Math.hypot(meanX, meanY) < 0.15, `${Math.hypot(meanX, meanY).toFixed(3)} px`);
    check('residual spread matches the planted noise', spread < 1.2, `${spread.toFixed(3)} px`);
  }
}

console.log(failures === 0 ? '\nPlate solve checks out.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
