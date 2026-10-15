/**
 * Coordinate frames.
 *
 * Everything in OmniEye that has a direction lives in one of four frames, and
 * every bug in a sky app is a frame confusion, so they are named explicitly here
 * and converted only through this module.
 *
 *   EQJ    Mean equator and equinox of J2000. Right-handed unit vectors with
 *          +x toward the vernal equinox and +z toward the north celestial pole.
 *          This is what the star catalogue stores and what stays fixed forever.
 *
 *   EQD    Equator of date. EQJ carried forward by precession and nutation.
 *          We never hold vectors here; astronomy-engine passes through it.
 *
 *   HOR    astronomy-engine's horizontal frame: +x north, +y west, +z zenith.
 *          Right-handed, and the frame its rotation matrices target.
 *
 *   SCENE  The three.js frame the renderer draws in. Observer at the origin,
 *          looking out at the inside of the celestial sphere:
 *
 *              +X  east
 *              +Y  zenith
 *              +Z  south      (so north is -Z, which a default three.js camera
 *                              faces, and east falls on the viewer's right)
 *
 * The single conversion that matters is EQJ -> SCENE at a given time and place.
 * It is a pure rotation, which is why the entire star field can be one static
 * GPU buffer with one quaternion on the parent object: the sky turns, the
 * vertices never move.
 *
 * Refraction is deliberately absent from that rotation. Bending is a function of
 * altitude, so it is not a rotation at all; applying it would mean moving every
 * vertex. The rotation is therefore geometric (airless), and refraction is
 * applied per object where it is actually read as a number -- see
 * `apparentAltitude` and the rise/set helpers in solar.ts.
 */
import * as Astronomy from 'astronomy-engine';
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

/** Radius of the celestial sphere in scene units. Purely a drawing convention. */
export const SKY_RADIUS = 100;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const ARCMIN = DEG / 60;
export const ARCSEC = DEG / 3600;

/** Sidereal rate: how fast the sky turns, in degrees per hour. */
export const SIDEREAL_RATE_DEG_PER_HOUR = 15.041067;

/** A direction in the observer's horizontal frame, in degrees. */
export interface AltAz {
  /** Degrees above the horizon. Negative is below. */
  altitude: number;
  /** Degrees clockwise from true north: N 0, E 90, S 180, W 270. */
  azimuth: number;
}

/** A direction on the celestial sphere, J2000 unless stated otherwise. */
export interface Equatorial {
  /** Right ascension in radians, [0, 2pi). */
  ra: number;
  /** Declination in radians, [-pi/2, pi/2]. */
  dec: number;
}

/** Where and when the observer is. Elevation in metres above mean sea level. */
export interface ObserverSite {
  latitude: number;
  longitude: number;
  elevation: number;
}

// -- basis change --------------------------------------------------------------

/**
 * HOR -> SCENE. A permutation with two sign flips:
 *   scene.x =  east  = -hor.y   (hor.y is west)
 *   scene.y =  up    =  hor.z
 *   scene.z =  south = -hor.x   (hor.x is north)
 * Determinant +1, so it is a proper rotation and composes cleanly.
 */
const HOR_TO_SCENE = new Matrix3().set(
  0, -1, 0,
  0, 0, 1,
  -1, 0, 0,
);

/**
 * astronomy-engine stores rotation matrices transposed relative to the usual
 * row-major convention: its `RotateVector` reads `rot[j][i]` for output row `i`.
 * This adapter transposes back so the result multiplies vectors the normal way.
 */
function toMatrix3(rot: Astronomy.RotationMatrix): Matrix3 {
  const r = rot.rot;
  return new Matrix3().set(
    r[0][0], r[1][0], r[2][0],
    r[0][1], r[1][1], r[2][1],
    r[0][2], r[1][2], r[2][2],
  );
}

const _m4 = new Matrix4();

/**
 * The rotation that carries a J2000 catalogue vector into scene space for this
 * observer at this instant. Includes precession and nutation via
 * astronomy-engine; excludes refraction and aberration.
 */
export function eqjToSceneMatrix(date: Date, site: ObserverSite): Matrix3 {
  const observer = new Astronomy.Observer(site.latitude, site.longitude, site.elevation);
  const eqjToHor = toMatrix3(Astronomy.Rotation_EQJ_HOR(date, observer));
  return new Matrix3().multiplyMatrices(HOR_TO_SCENE, eqjToHor);
}

/** The same rotation as a quaternion, for interpolating the sky between frames. */
export function eqjToSceneQuaternion(date: Date, site: ObserverSite, out = new Quaternion()): Quaternion {
  const m = eqjToSceneMatrix(date, site);
  _m4.setFromMatrix3(m);
  return out.setFromRotationMatrix(_m4);
}

// -- spherical <-> cartesian ---------------------------------------------------

/** EQJ right ascension and declination (radians) to an EQJ unit vector. */
export function raDecToVector(ra: number, dec: number, out = new Vector3()): Vector3 {
  const cd = Math.cos(dec);
  return out.set(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec));
}

/** EQJ unit vector back to right ascension and declination, in radians. */
export function vectorToRaDec(v: Vector3): Equatorial {
  const ra = Math.atan2(v.y, v.x);
  return {
    ra: ra < 0 ? ra + 2 * Math.PI : ra,
    dec: Math.asin(Math.max(-1, Math.min(1, v.z / v.length()))),
  };
}

/** Horizontal direction (degrees) to a scene-space unit vector. */
export function altAzToVector(altAz: AltAz, out = new Vector3()): Vector3 {
  const alt = altAz.altitude * DEG;
  const az = altAz.azimuth * DEG;
  const ca = Math.cos(alt);
  // az 0 -> -Z (north), az 90 -> +X (east).
  return out.set(ca * Math.sin(az), Math.sin(alt), -ca * Math.cos(az));
}

/** Scene-space direction back to altitude and azimuth, in degrees. */
export function vectorToAltAz(v: Vector3): AltAz {
  const len = v.length() || 1;
  const altitude = Math.asin(Math.max(-1, Math.min(1, v.y / len))) * RAD;
  let azimuth = Math.atan2(v.x, -v.z) * RAD;
  if (azimuth < 0) azimuth += 360;
  return { altitude, azimuth };
}

/** Convenience: a point on the sphere at drawing radius, from alt/az degrees. */
export function altAzToScenePoint(altAz: AltAz, radius = SKY_RADIUS, out = new Vector3()): Vector3 {
  return altAzToVector(altAz, out).multiplyScalar(radius);
}

// -- proper motion -------------------------------------------------------------

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const MS_PER_JULIAN_YEAR = 365.25 * 86400 * 1000;

/** Julian years elapsed since the J2000.0 epoch. Negative before 2000. */
export function yearsSinceJ2000(date: Date): number {
  return (date.getTime() - J2000_MS) / MS_PER_JULIAN_YEAR;
}

/**
 * Carries a catalogue vector forward by its proper motion.
 *
 * `omega` is the star's angular velocity as a vector in the same frame, radians
 * per year, built at catalogue-build time so the renderer never has to know
 * whether the source table's RA proper motion carried a cos(dec) factor.
 *
 * Writes into `out` as a normalised vector.
 */
export function applyProperMotion(
  ux: number, uy: number, uz: number,
  ox: number, oy: number, oz: number,
  years: number,
  out: Vector3,
): Vector3 {
  return out.set(ux + ox * years, uy + oy * years, uz + oz * years).normalize();
}

// -- angles --------------------------------------------------------------------

/** Angle between two directions, in radians. Robust for very small angles. */
export function angleBetween(a: Vector3, b: Vector3): number {
  const an = _tmpA.copy(a).normalize();
  const bn = _tmpB.copy(b).normalize();
  // 2*asin(|a-b|/2) stays accurate where acos(a.b) loses all its digits.
  const chord = an.distanceTo(bn);
  return 2 * Math.asin(Math.min(1, chord / 2));
}
const _tmpA = new Vector3();
const _tmpB = new Vector3();

/** Angular separation of two horizontal directions, in degrees. */
export function altAzSeparation(a: AltAz, b: AltAz): number {
  return angleBetween(altAzToVector(a, _tmpC), altAzToVector(b, _tmpD)) * RAD;
}
const _tmpC = new Vector3();
const _tmpD = new Vector3();

// -- refraction ----------------------------------------------------------------

/**
 * Airless altitude to the altitude an observer actually sees, in degrees.
 * Uses astronomy-engine's "normal" model (Bennett, capped near the horizon).
 */
export function apparentAltitude(trueAltitudeDeg: number): number {
  return trueAltitudeDeg + Astronomy.Refraction('normal', trueAltitudeDeg);
}

// -- sidereal time -------------------------------------------------------------

/** Greenwich apparent sidereal time in hours, [0, 24). */
export function greenwichSiderealTime(date: Date): number {
  return Astronomy.SiderealTime(date);
}

/** Local apparent sidereal time in hours, [0, 24), for a longitude in degrees. */
export function localSiderealTime(date: Date, longitude: number): number {
  const lst = Astronomy.SiderealTime(date) + longitude / 15;
  return ((lst % 24) + 24) % 24;
}

// -- formatting ----------------------------------------------------------------

/** Right ascension in radians to `05h 35m 17.3s`. */
export function formatRa(raRad: number): string {
  let hours = ((raRad * RAD) / 15 + 24) % 24;
  const h = Math.floor(hours);
  hours = (hours - h) * 60;
  const m = Math.floor(hours);
  const s = (hours - m) * 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`;
}

/** Declination in radians to `-05° 23' 28"`. */
export function formatDec(decRad: number): string {
  const deg = decRad * RAD;
  const sign = deg < 0 ? '-' : '+';
  let a = Math.abs(deg);
  const d = Math.floor(a);
  a = (a - d) * 60;
  const m = Math.floor(a);
  const s = Math.round((a - m) * 60);
  return `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}' ${String(s).padStart(2, '0')}"`;
}

/** Degrees to a fixed-width `137.2°`. */
export function formatDeg(deg: number, digits = 1): string {
  return `${deg.toFixed(digits)}°`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Azimuth in degrees to a 16-point compass label. */
export function compassPoint(azimuth: number): string {
  const i = Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[i];
}

/**
 * An angular size in radians, rendered in whichever unit keeps it readable.
 * Residuals are quoted in arcminutes throughout the app; this is for anything
 * that can span many orders of magnitude.
 */
export function formatAngle(rad: number): string {
  const deg = rad * RAD;
  if (Math.abs(deg) >= 1) return `${deg.toFixed(2)}°`;
  const arcmin = deg * 60;
  if (Math.abs(arcmin) >= 1) return `${arcmin.toFixed(2)}'`;
  return `${(arcmin * 60).toFixed(1)}"`;
}
