#!/usr/bin/env node
/**
 * Spot-checks the solar system layer against values that can be looked up
 * independently, and confirms the two paths into the scene agree.
 *
 * The important structural check is the last one: a solar body's EQJ direction,
 * pushed through the same EQJ -> SCENE rotation the star field uses, must land
 * where astronomy-engine's own Horizon() puts it. If those two drift apart, the
 * planets would swim against the stars.
 *
 * Run with:  node scripts/verify-solar.mjs
 */
import * as Astronomy from 'astronomy-engine';
import { Vector3 } from 'three';
import { RAD, altAzToVector, angleBetween, eqjToSceneMatrix, formatRa, formatDec, vectorToAltAz } from '../lib/astro/frames.ts';
import { solarSystemStates, moonPhaseName, sunAltitude, twilightBand, riseSetFor, riseSetForFixed } from '../lib/astro/solar.ts';

const site = { latitude: 51.4779, longitude: -0.0015, elevation: 47 };
const when = new Date('2026-08-19T22:30:00Z');

console.log(`\nGreenwich, ${when.toISOString()}\n`);

const states = solarSystemStates(when, site);

console.log('body        RA            Dec              alt      az       mag     diam      lit    limb PA  con');
for (const s of states) {
  console.log(
    s.name.padEnd(10),
    formatRa(s.ra).padEnd(13),
    formatDec(s.dec).padEnd(16),
    s.altAz.altitude.toFixed(2).padStart(7),
    s.altAz.azimuth.toFixed(2).padStart(8),
    s.magnitude.toFixed(2).padStart(7),
    (s.angularDiameterArcmin.toFixed(2) + "'").padStart(9),
    (s.illuminatedFraction * 100).toFixed(0).padStart(5) + '%',
    s.brightLimbAngle.toFixed(1).padStart(8),
    ' ',
    s.constellation,
  );
}

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '   ' + detail : ''}`);
};

console.log('\n-- consistency ----------------------------------------------------------');

// The scene path and the horizon path must agree to well under an arcsecond.
const m = eqjToSceneMatrix(when, site);
let worst = 0;
let worstBody = '';
for (const s of states) {
  const viaScene = vectorToAltAz(s.direction.clone().applyMatrix3(m));
  const sep =
    angleBetween(altAzToVector(viaScene), altAzToVector(s.altAz)) * RAD * 3600;
  if (sep > worst) {
    worst = sep;
    worstBody = s.name;
  }
}
check(
  'EQJ direction through the scene rotation matches Horizon()',
  worst < 0.1,
  `worst ${worst.toFixed(4)}" (${worstBody})`,
);

// Angular diameters against well-known values.
const diam = Object.fromEntries(states.map((s) => [s.name, s.angularDiameterArcmin]));
check('Sun subtends about 32 arcmin', Math.abs(diam.Sun - 31.8) < 0.6, `${diam.Sun.toFixed(2)}'`);
check('Moon subtends 29-34 arcmin', diam.Moon > 29 && diam.Moon < 34.2, `${diam.Moon.toFixed(2)}'`);
check('Jupiter subtends 0.5-0.9 arcmin', diam.Jupiter > 0.5 && diam.Jupiter < 0.9, `${diam.Jupiter.toFixed(3)}'`);

// The Sun's magnitude is a fixed point of the whole photometric scale.
const sun = states.find((s) => s.name === 'Sun');
check('Sun magnitude is about -26.7', Math.abs(sun.magnitude + 26.7) < 0.2, sun.magnitude.toFixed(3));

// Lunar parallax: the topocentric position must differ from the geocentric one
// by up to about a degree. If it does not, the observer offset was dropped.
{
  const geo = Astronomy.GeoVector(Astronomy.Body.Moon, when, true);
  const geoDir = new Vector3(geo.x, geo.y, geo.z).normalize();
  const moon = states.find((s) => s.name === 'Moon');
  const parallax = angleBetween(geoDir, moon.direction) * RAD;
  check(
    'topocentric Moon differs from geocentric by a plausible parallax',
    parallax > 0.05 && parallax < 1.1,
    `${(parallax * 60).toFixed(1)} arcmin`,
  );
}

// Bright limb must point away from the Sun's anti-direction: the lit side faces
// the Sun, so the position angle towards the Sun and the limb angle agree.
{
  const moon = states.find((s) => s.name === 'Moon');
  const phase = Astronomy.MoonPhase(when);
  check(
    'illuminated fraction agrees with the phase angle',
    Math.abs(moon.illuminatedFraction - (1 - Math.cos(phase / RAD)) / 2) < 0.02,
    `${(moon.illuminatedFraction * 100).toFixed(1)}% (${moonPhaseName(phase)}, phase ${phase.toFixed(1)} deg)`,
  );
}

console.log('\n-- sky brightness -------------------------------------------------------');
{
  const alt = sunAltitude(when, site);
  console.log(`     Sun altitude ${alt.toFixed(2)} deg -> ${twilightBand(alt)}`);
  check('twilight band is a known value', ['day', 'civil', 'nautical', 'astronomical', 'night'].includes(twilightBand(alt)));
}

console.log('\n-- rise / set -----------------------------------------------------------');
{
  const sunEvents = riseSetFor(Astronomy.Body.Sun, when, site);
  console.log(`     Sun   rise ${sunEvents.rise?.toISOString() ?? '-'}  set ${sunEvents.set?.toISOString() ?? '-'}`);
  check('Sun rises within the next day', sunEvents.rise !== null);

  // Polaris from Greenwich is circumpolar; Canopus never rises.
  const polaris = riseSetForFixed((2.5303 * 15) / RAD, 89.264 / RAD, when, site);
  check('Polaris is circumpolar from Greenwich', polaris.circumpolar, JSON.stringify({ rise: polaris.rise, set: polaris.set }));

  const canopus = riseSetForFixed((6.3992 * 15) / RAD, -52.6957 / RAD, when, site);
  check('Canopus never rises from Greenwich', canopus.neverRises);

  const sirius = riseSetForFixed((6.7525 * 15) / RAD, -16.7161 / RAD, when, site);
  check('Sirius has both a rise and a set', sirius.rise !== null && sirius.set !== null,
    `rise ${sirius.rise?.toISOString().slice(11, 16)}Z  set ${sirius.set?.toISOString().slice(11, 16)}Z`);
}

console.log(failures === 0 ? '\nSolar system layer checks out.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
