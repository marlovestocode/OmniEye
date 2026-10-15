/**
 * Solar system bodies.
 *
 * Stars can be a static buffer because they do not move. Planets and the Moon
 * do, so they are recomputed whenever the observation time changes -- but they
 * are computed into the *same* EQJ frame as the star catalogue, so they can sit
 * inside the same rotating group and stay locked to the star field.
 *
 * Positions here are topocentric: geocentric vector minus the observer's own
 * position on the rotating Earth. For everything beyond the Moon that is a
 * rounding error, but lunar parallax reaches nearly a degree, which is far larger
 * than any match tolerance the app will ever use.
 */
import * as Astronomy from 'astronomy-engine';
import { Vector3 } from 'three';
import { RAD, type AltAz, type ObserverSite } from './frames';

const AU_KM = 149597870.7;

/** Mean radii in kilometres, for angular diameter. */
const BODY_RADIUS_KM: Partial<Record<Astronomy.Body, number>> = {
  [Astronomy.Body.Sun]: 695700,
  [Astronomy.Body.Moon]: 1737.4,
  [Astronomy.Body.Mercury]: 2439.7,
  [Astronomy.Body.Venus]: 6051.8,
  [Astronomy.Body.Mars]: 3389.5,
  [Astronomy.Body.Jupiter]: 69911,
  [Astronomy.Body.Saturn]: 58232,
  [Astronomy.Body.Uranus]: 25362,
  [Astronomy.Body.Neptune]: 24622,
  [Astronomy.Body.Pluto]: 1188.3,
};

/** The bodies OmniEye predicts, in the order they are drawn. */
export const SOLAR_BODIES: Astronomy.Body[] = [
  Astronomy.Body.Sun,
  Astronomy.Body.Moon,
  Astronomy.Body.Mercury,
  Astronomy.Body.Venus,
  Astronomy.Body.Mars,
  Astronomy.Body.Jupiter,
  Astronomy.Body.Saturn,
  Astronomy.Body.Uranus,
  Astronomy.Body.Neptune,
];

export type SolarBodyKind = 'sun' | 'moon' | 'planet';

export interface SolarBodyState {
  body: Astronomy.Body;
  name: string;
  kind: SolarBodyKind;
  /** Topocentric EQJ unit vector -- same frame as the star catalogue. */
  direction: Vector3;
  /** J2000 right ascension and declination in radians. */
  ra: number;
  dec: number;
  /** Geometric (airless) horizontal position. */
  altAz: AltAz;
  /** Apparent altitude in degrees, including refraction. */
  apparentAltitude: number;
  /** Distance from the observer in AU. */
  distanceAu: number;
  /** Apparent visual magnitude. */
  magnitude: number;
  /** Angular diameter in arcminutes. */
  angularDiameterArcmin: number;
  /** Fraction of the disc lit, 0..1. Meaningless for the Sun. */
  illuminatedFraction: number;
  /**
   * Position angle of the bright limb, degrees east of north. Only meaningful
   * for the Moon and inner planets; this is what orients a drawn crescent.
   */
  brightLimbAngle: number;
  /** Constellation the body currently sits in. */
  constellation: string;
}

function toVector3(v: Astronomy.Vector): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

/**
 * Topocentric EQJ position of a body, in AU.
 * Aberration is on: it is a real ~20 arcsecond effect and cheap to include.
 */
function topocentricEqj(body: Astronomy.Body, date: Date, observer: Astronomy.Observer): Vector3 {
  const geo = toVector3(Astronomy.GeoVector(body, date, true));
  const obs = toVector3(Astronomy.ObserverVector(date, observer, false));
  return geo.sub(obs);
}

/** Angle from north through east, at `at`, towards `towards`. Degrees. */
function positionAngle(at: Vector3, towards: Vector3): number {
  const dir = at.clone().normalize();
  // Local north: the celestial pole, with the radial component removed.
  const north = new Vector3(0, 0, 1).addScaledVector(dir, -dir.z);
  if (north.lengthSq() < 1e-12) return 0; // at the pole, position angle is undefined
  north.normalize();
  const east = new Vector3().crossVectors(north, dir).normalize();
  const t = towards.clone().normalize();
  const angle = Math.atan2(t.dot(east), t.dot(north)) * RAD;
  return (angle + 360) % 360;
}

/** Everything the UI needs about one solar system body at one instant. */
export function solarBodyState(body: Astronomy.Body, date: Date, site: ObserverSite): SolarBodyState {
  const observer = new Astronomy.Observer(site.latitude, site.longitude, site.elevation);

  const topo = topocentricEqj(body, date, observer);
  const distanceAu = topo.length();
  const direction = topo.clone().divideScalar(distanceAu || 1);

  const eq = Astronomy.EquatorFromVector(
    new Astronomy.Vector(topo.x, topo.y, topo.z, Astronomy.MakeTime(date)),
  );
  // Horizon() wants coordinates of date, so carry the topocentric vector across
  // the epoch boundary rather than handing it J2000 numbers.
  const ofDate = Astronomy.EquatorFromVector(
    Astronomy.RotateVector(
      Astronomy.Rotation_EQJ_EQD(date),
      new Astronomy.Vector(topo.x, topo.y, topo.z, Astronomy.MakeTime(date)),
    ),
  );
  const geometric = Astronomy.Horizon(date, observer, ofDate.ra, ofDate.dec, '');
  const refracted = Astronomy.Horizon(date, observer, ofDate.ra, ofDate.dec, 'normal');

  const illum = Astronomy.Illumination(body, date);
  const radiusKm = BODY_RADIUS_KM[body] ?? 0;
  const angularDiameterArcmin = radiusKm
    ? 2 * Math.atan(radiusKm / (distanceAu * AU_KM)) * RAD * 60
    : 0;

  const sunTopo = body === Astronomy.Body.Sun ? topo : topocentricEqj(Astronomy.Body.Sun, date, observer);

  const kind: SolarBodyKind =
    body === Astronomy.Body.Sun ? 'sun' : body === Astronomy.Body.Moon ? 'moon' : 'planet';

  return {
    body,
    name: body as string,
    kind,
    direction,
    ra: (eq.ra / 12) * Math.PI,
    dec: eq.dec / RAD,
    altAz: { altitude: geometric.altitude, azimuth: geometric.azimuth },
    apparentAltitude: refracted.altitude,
    distanceAu,
    magnitude: illum.mag,
    angularDiameterArcmin,
    illuminatedFraction: illum.phase_fraction,
    brightLimbAngle: kind === 'sun' ? 0 : positionAngle(topo, sunTopo.clone().sub(topo)),
    constellation: Astronomy.Constellation(eq.ra, eq.dec).symbol,
  };
}

/** All predicted solar system bodies at one instant. */
export function solarSystemStates(date: Date, site: ObserverSite): SolarBodyState[] {
  return SOLAR_BODIES.map((body) => solarBodyState(body, date, site));
}

export interface RiseSetInfo {
  rise: Date | null;
  set: Date | null;
  transit: Date | null;
  /** Altitude at transit, degrees. Negative means it never clears the horizon. */
  transitAltitude: number | null;
  /** True when the body is above the horizon for the whole search window. */
  circumpolar: boolean;
  /** True when the body never rises during the search window. */
  neverRises: boolean;
}

/**
 * Rise, set and upper transit for a body, searched forward from `date`.
 * Refraction and the body's own radius are handled by astronomy-engine.
 */
export function riseSetFor(body: Astronomy.Body, date: Date, site: ObserverSite, limitDays = 1): RiseSetInfo {
  const observer = new Astronomy.Observer(site.latitude, site.longitude, site.elevation);
  const rise = Astronomy.SearchRiseSet(body, observer, +1, date, limitDays);
  const set = Astronomy.SearchRiseSet(body, observer, -1, date, limitDays);
  let transit: Astronomy.HourAngleEvent | null = null;
  try {
    transit = Astronomy.SearchHourAngle(body, observer, 0, date, +1);
  } catch {
    transit = null;
  }

  // Distinguishing circumpolar from never-rising needs to know which side of the
  // horizon the body is on right now.
  const now = Astronomy.Equator(body, date, observer, true, true);
  const currentAltitude = Astronomy.Horizon(date, observer, now.ra, now.dec, 'normal').altitude;

  return {
    rise: rise ? rise.date : null,
    set: set ? set.date : null,
    transit: transit ? transit.time.date : null,
    transitAltitude: transit ? transit.hor.altitude : null,
    circumpolar: !rise && !set && currentAltitude > 0,
    neverRises: !rise && !set && currentAltitude <= 0,
  };
}

/**
 * Rise, set and transit for a fixed catalogue position. astronomy-engine works
 * in terms of bodies, so the target is registered as a user-defined star first.
 * J2000 coordinates in radians.
 */
export function riseSetForFixed(
  raJ2000: number,
  decJ2000: number,
  date: Date,
  site: ObserverSite,
  limitDays = 1,
): RiseSetInfo {
  // Body.Star1..Star8 are scratch slots the library reserves for exactly this.
  Astronomy.DefineStar(Astronomy.Body.Star1, (raJ2000 * RAD) / 15, decJ2000 * RAD, 1000);
  return riseSetFor(Astronomy.Body.Star1, date, site, limitDays);
}

/**
 * Moon phase as a name, from the Sun-Moon ecliptic longitude difference in
 * degrees (0 new, 90 first quarter, 180 full, 270 last quarter).
 */
export function moonPhaseName(phaseDegrees: number): string {
  const p = ((phaseDegrees % 360) + 360) % 360;
  if (p < 11.25 || p >= 348.75) return 'new';
  if (p < 78.75) return 'waxing crescent';
  if (p < 101.25) return 'first quarter';
  if (p < 168.75) return 'waxing gibbous';
  if (p < 191.25) return 'full';
  if (p < 258.75) return 'waning gibbous';
  if (p < 281.25) return 'last quarter';
  return 'waning crescent';
}

/** Sun altitude in degrees -- the number that decides how dark the sky is. */
export function sunAltitude(date: Date, site: ObserverSite): number {
  const observer = new Astronomy.Observer(site.latitude, site.longitude, site.elevation);
  const eq = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true);
  return Astronomy.Horizon(date, observer, eq.ra, eq.dec, 'normal').altitude;
}

export type TwilightBand = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night';

/** Which twilight band a Sun altitude falls in. */
export function twilightBand(sunAltitudeDeg: number): TwilightBand {
  if (sunAltitudeDeg > -0.833) return 'day';
  if (sunAltitudeDeg > -6) return 'civil';
  if (sunAltitudeDeg > -12) return 'nautical';
  if (sunAltitudeDeg > -18) return 'astronomical';
  return 'night';
}
