#!/usr/bin/env node
/**
 * The transform sanity check the whole project rests on.
 *
 * Every downstream claim -- where a star is drawn, which observed source it gets
 * matched to, where the camera was pointing -- is only as good as the EQJ ->
 * SCENE rotation. So this runs a handful of assertions with answers that are
 * known independently of the code being tested:
 *
 *   - Polaris sits at altitude ~= observer latitude, due north.
 *   - The celestial pole sits at exactly latitude, exactly due north.
 *   - A star on the meridian has hour angle zero.
 *   - Round-tripping alt/az through the scene frame is lossless.
 *   - The scene basis really is east/zenith/south.
 *   - The sky turns 15.041 deg/hr about the pole.
 *
 * Run with:  node scripts/verify-astro.mjs
 */
import { Vector3 } from 'three';
import * as Astronomy from 'astronomy-engine';
import {
  DEG,
  RAD,
  SIDEREAL_RATE_DEG_PER_HOUR,
  altAzToVector,
  angleBetween,
  eqjToSceneMatrix,
  formatDec,
  formatRa,
  localSiderealTime,
  raDecToVector,
  vectorToAltAz,
} from '../lib/astro/frames.ts';

let failures = 0;
function check(label, actual, expected, tolerance, unit = '') {
  const delta = Math.abs(actual - expected);
  const ok = delta <= tolerance;
  if (!ok) failures++;
  const status = ok ? 'ok  ' : 'FAIL';
  console.log(
    `${status} ${label.padEnd(52)} ${actual.toFixed(5)}${unit} vs ${expected.toFixed(5)}${unit}` +
      `  (delta ${delta.toExponential(2)}, tol ${tolerance.toExponential(2)})`,
  );
}

const SITES = [
  { name: 'Greenwich', latitude: 51.4779, longitude: -0.0015, elevation: 47 },
  { name: 'Quito', latitude: -0.1807, longitude: -78.4678, elevation: 2850 },
  { name: 'Sydney', latitude: -33.8688, longitude: 151.2093, elevation: 3 },
  { name: 'Fairbanks', latitude: 64.8378, longitude: -147.7164, elevation: 136 },
];

const WHEN = new Date('2026-08-19T22:30:00Z');

console.log(`\nepoch ${WHEN.toISOString()}\n`);

// -- 1. the pole test ----------------------------------------------------------
// The north celestial pole is due north at an altitude equal to the latitude.
// This is a geometric identity, independent of date, so any sign error or
// timezone bug shows up here immediately.
console.log('-- north celestial pole -------------------------------------------------');
// The pole of date is not the J2000 pole -- 26 years of precession separate them
// by about 0.11 deg, which is exactly the scale of a match tolerance. Carry the
// pole of date back into J2000 first, or this test measures precession instead
// of the rotation it is meant to check.
for (const site of SITES) {
  const m = eqjToSceneMatrix(WHEN, site);
  const rot = Astronomy.Rotation_EQD_EQJ(WHEN);
  const p = Astronomy.RotateVector(rot, new Astronomy.Vector(0, 0, 1, Astronomy.MakeTime(WHEN)));
  const { altitude, azimuth } = vectorToAltAz(new Vector3(p.x, p.y, p.z).applyMatrix3(m));
  check(`${site.name}: pole altitude = latitude`, altitude, site.latitude, 1e-6, ' deg');
  // The pole always sits due north -- below the horizon for southern observers,
  // but still on the northern meridian. Never 180.
  const signedAz = azimuth > 180 ? azimuth - 360 : azimuth;
  check(`${site.name}: pole azimuth is due north`, signedAz, 0, 1e-6, ' deg');
}

// -- 2. Polaris ----------------------------------------------------------------
// The brief's own acceptance test. Polaris is ~0.7 deg off the pole, so it
// circles it: altitude must land within that of the latitude, azimuth within
// that of north.
console.log('\n-- Polaris (HIP 11767) --------------------------------------------------');
const POLARIS = { ra: (2 + 31 / 60 + 49.09 / 3600) * 15 * DEG, dec: (89 + 15 / 60 + 50.8 / 3600) * DEG };
for (const site of SITES.filter((s) => s.latitude > 5)) {
  const m = eqjToSceneMatrix(WHEN, site);
  const v = raDecToVector(POLARIS.ra, POLARIS.dec).applyMatrix3(m);
  const { altitude, azimuth } = vectorToAltAz(v);
  const offNorth = Math.abs(azimuth > 180 ? azimuth - 360 : azimuth);
  const offLat = Math.abs(altitude - site.latitude);
  const ok = offLat < 0.75 && offNorth < 1.5 / Math.cos(site.latitude * DEG);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${site.name.padEnd(12)} alt ${altitude.toFixed(3)} deg ` +
      `(lat ${site.latitude.toFixed(3)}, off by ${offLat.toFixed(3)})   ` +
      `az ${azimuth.toFixed(3)} deg (off north by ${offNorth.toFixed(3)})`,
  );
}

// -- 3. agreement with astronomy-engine's own Horizon() ------------------------
// The matrix path and the per-object path must not disagree. If they do, the
// star field and the readouts are describing different skies.
console.log('\n-- matrix path vs astronomy-engine Horizon() ----------------------------');
const PROBES = [
  { name: 'Sirius', ra: 6.752481, dec: -16.716116 },
  { name: 'Vega', ra: 18.615649, dec: 38.783689 },
  { name: 'Betelgeuse', ra: 5.919529, dec: 7.407064 },
  { name: 'Acrux', ra: 12.443311, dec: -63.099093 },
];
/** J2000 unit vector -> the RA (hours) and Dec (deg) of date that Horizon() wants. */
function eqjToOfDate(vec, when) {
  const t = Astronomy.MakeTime(when);
  const rotated = Astronomy.RotateVector(
    Astronomy.Rotation_EQJ_EQD(when),
    new Astronomy.Vector(vec.x, vec.y, vec.z, t),
  );
  return Astronomy.EquatorFromVector(rotated);
}

/** RA (radians) and Dec (radians) of date -> a J2000 unit vector. */
function ofDateToEqj(raRad, decRad, when) {
  const t = Astronomy.MakeTime(when);
  const v = raDecToVector(raRad, decRad);
  const back = Astronomy.RotateVector(
    Astronomy.Rotation_EQD_EQJ(when),
    new Astronomy.Vector(v.x, v.y, v.z, t),
  );
  return new Vector3(back.x, back.y, back.z);
}

let worst = 0;
let worstIfEpochsMixed = 0;
for (const site of SITES) {
  const m = eqjToSceneMatrix(WHEN, site);
  const observer = new Astronomy.Observer(site.latitude, site.longitude, site.elevation);
  for (const p of PROBES) {
    const eqj = raDecToVector(p.ra * 15 * DEG, p.dec * DEG);
    const mine = vectorToAltAz(eqj.clone().applyMatrix3(m));
    // Horizon() takes coordinates of date, not J2000. Feeding it catalogue
    // coordinates straight is the epoch-mixing bug, measured just below.
    const ofDate = eqjToOfDate(eqj, WHEN);
    const theirs = Astronomy.Horizon(WHEN, observer, ofDate.ra, ofDate.dec, '');
    const naive = Astronomy.Horizon(WHEN, observer, p.ra, p.dec, '');
    const sep = (a, b) => angleBetween(altAzToVector(a), altAzToVector(b)) * RAD;
    worst = Math.max(worst, sep(mine, theirs));
    worstIfEpochsMixed = Math.max(worstIfEpochsMixed, sep(theirs, naive));
  }
}
check('worst separation across sites and probes', worst, 0, 1 / 3600, ' deg');
console.log(
  `     for reference: feeding J2000 coordinates to an of-date routine would ` +
    `move objects by up to ${(worstIfEpochsMixed * 60).toFixed(1)} arcmin today.`,
);

// -- 4. meridian / hour angle --------------------------------------------------
// A star due south (northern site) has hour angle 0, so its RA of date equals the
// local apparent sidereal time. This ties the rotation to the clock.
console.log('\n-- meridian crossing ----------------------------------------------------');
{
  const site = SITES[0];
  const m = eqjToSceneMatrix(WHEN, site);
  const lst = localSiderealTime(WHEN, site.longitude);
  const raOfDate = lst * 15 * DEG;
  const decOfDate = 20 * DEG;
  const eqj = ofDateToEqj(raOfDate, decOfDate, WHEN);
  const { altitude, azimuth } = vectorToAltAz(eqj.applyMatrix3(m));
  check('RA of date = LST puts the object due south', azimuth, 180, 1e-4, ' deg');
  check('and at altitude 90 - lat + dec', altitude, 90 - site.latitude + 20, 1e-4, ' deg');
  console.log(`     LST ${lst.toFixed(4)} h  ->  RA ${formatRa(raOfDate)}  Dec ${formatDec(decOfDate)} (of date)`);
}

// -- 5. scene basis ------------------------------------------------------------
console.log('\n-- scene basis ----------------------------------------------------------');
{
  const north = altAzToVector({ altitude: 0, azimuth: 0 });
  const east = altAzToVector({ altitude: 0, azimuth: 90 });
  const zenith = altAzToVector({ altitude: 90, azimuth: 0 });
  check('north is -Z', north.z, -1, 1e-12);
  check('east is +X', east.x, 1, 1e-12);
  check('zenith is +Y', zenith.y, 1, 1e-12);
  // Facing north, east must be on the right: north x east should point down.
  const cross = new Vector3().crossVectors(north, east);
  check('facing north, east is to the right', cross.y, -1, 1e-12);
  // Round trip
  let maxErr = 0;
  for (let alt = -80; alt <= 80; alt += 17) {
    for (let az = 0; az < 360; az += 13) {
      const back = vectorToAltAz(altAzToVector({ altitude: alt, azimuth: az }));
      maxErr = Math.max(maxErr, Math.abs(back.altitude - alt), Math.abs(((back.azimuth - az + 540) % 360) - 180));
    }
  }
  check('alt/az round trip', maxErr, 0, 1e-9, ' deg');
}

// -- 6. sidereal rate ----------------------------------------------------------
// One hour later, a star must have moved 15.041 deg about the pole -- the fact
// the whole video pipeline leans on.
console.log('\n-- sidereal rate --------------------------------------------------------');
{
  const site = SITES[0];
  const later = new Date(WHEN.getTime() + 3600 * 1000);
  const v0 = raDecToVector(PROBES[1].ra * 15 * DEG, PROBES[1].dec * DEG);
  const a = v0.clone().applyMatrix3(eqjToSceneMatrix(WHEN, site));
  const b = v0.clone().applyMatrix3(eqjToSceneMatrix(later, site));
  // Project both onto the plane perpendicular to the celestial pole and measure
  // the turn about it.
  const pole = new Vector3(0, 0, 1).applyMatrix3(eqjToSceneMatrix(WHEN, site));
  const pa = a.clone().projectOnPlane(pole).normalize();
  const pb = b.clone().projectOnPlane(pole).normalize();
  check('one hour of rotation about the pole', angleBetween(pa, pb) * RAD, SIDEREAL_RATE_DEG_PER_HOUR, 0.002, ' deg');
}

console.log(
  failures === 0
    ? '\nAll transform checks passed. Downstream geometry is trustworthy.\n'
    : `\n${failures} check(s) FAILED. Fix the transforms before building on them.\n`,
);
process.exit(failures === 0 ? 0 : 1);
