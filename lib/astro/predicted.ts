/**
 * The Predicted Sky.
 *
 * Layer 1: what the ephemeris says should be overhead, given a place and an
 * instant. It is complete and precise, it needs no media, and it is a hypothesis
 * -- so everything this module produces comes out as `PredictedObject`, which by
 * construction cannot claim to have been seen.
 *
 * Stars are deliberately *not* materialised as objects. Fifteen thousand of them
 * live in one Float32Array bound straight to the GPU, and the snapshot carries
 * only the rotation that orients them. An individual star becomes a
 * `PredictedObject` when something actually asks about it -- a hover, a match, an
 * inspector -- via `predictedStar`.
 */
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import * as Astronomy from 'astronomy-engine';
import {
  RAD,
  eqjToSceneMatrix,
  localSiderealTime,
  raDecToVector,
  vectorToAltAz,
  type AltAz,
  type ObserverSite,
} from './frames';
import type { Catalogs, DeepSkyObject, StarCatalog } from './catalog';
import { starLabel } from './catalog';
import { solarSystemStates, sunAltitude, twilightBand, type SolarBodyState, type TwilightBand } from './solar';
import type { CatalogEntry, PredictedObject } from '@/lib/sky/evidence';

/** A place and an instant. Everything predicted follows from these two. */
export interface Vantage {
  site: ObserverSite;
  time: Date;
}

export interface PredictedSky {
  vantage: Vantage;
  /** EQJ -> SCENE. Apply to any catalogue direction to place it in the scene. */
  rotation: Matrix3;
  /** The same rotation, for orienting the star field object. */
  orientation: Quaternion;
  /** Local apparent sidereal time, hours. */
  siderealTime: number;
  /** Sun altitude in degrees, and the twilight band it implies. */
  sunAltitude: number;
  twilight: TwilightBand;
  /** Solar system bodies, recomputed for this instant. */
  solarBodies: SolarBodyState[];
}

/** Builds the snapshot. Cheap enough to run on every clock tick. */
export function buildPredictedSky({ site, time }: Vantage): PredictedSky {
  const rotation = eqjToSceneMatrix(time, site);
  const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().setFromMatrix3(rotation));
  const alt = sunAltitude(time, site);
  return {
    vantage: { site, time },
    rotation,
    orientation,
    siderealTime: localSiderealTime(time, site.longitude),
    sunAltitude: alt,
    twilight: twilightBand(alt),
    solarBodies: solarSystemStates(time, site),
  };
}

// -- catalogue entries ---------------------------------------------------------

const _v = new Vector3();

/** Where a catalogue direction lands on the observer's horizon dome. */
export function altAzOf(directionEqj: Vector3, rotation: Matrix3): AltAz {
  return vectorToAltAz(_v.copy(directionEqj).applyMatrix3(rotation));
}

/** The identity a star would carry if it were ever confirmed. */
export function starEntry(catalog: StarCatalog, index: number): CatalogEntry {
  const d = catalog.designations.get(index);
  const ux = catalog.positions[index * 3];
  const uy = catalog.positions[index * 3 + 1];
  const uz = catalog.positions[index * 3 + 2];
  const ra = Math.atan2(uy, ux);

  const designations: string[] = [];
  if (d?.bayer && d.constellation) designations.push(`${d.bayer} ${d.constellation}`);
  if (d?.flamsteed && d.constellation) designations.push(`${d.flamsteed} ${d.constellation}`);
  if (d?.hip != null) designations.push(`HIP ${d.hip}`);

  return {
    kind: 'star',
    id: `star:${index}`,
    name: starLabel(d),
    designations,
    ra: ra < 0 ? ra + 2 * Math.PI : ra,
    dec: Math.asin(Math.max(-1, Math.min(1, uz))),
    magnitude: catalog.magnitudes[index],
    angularSizeArcmin: null,
    constellation: d?.constellation ?? null,
  };
}

export function deepSkyEntry(object: DeepSkyObject): CatalogEntry {
  return {
    kind: 'deepSky',
    id: `dso:${object.id}`,
    name: object.name ?? object.id,
    designations: object.designations,
    ra: object.ra,
    dec: object.dec,
    magnitude: object.magnitude,
    angularSizeArcmin: object.majorArcmin,
    constellation: object.constellation,
  };
}

export function solarBodyEntry(state: SolarBodyState): CatalogEntry {
  return {
    kind: 'solarBody',
    id: `body:${state.name}`,
    name: state.name,
    designations: [state.name],
    ra: state.ra,
    dec: state.dec,
    magnitude: state.magnitude,
    angularSizeArcmin: state.angularDiameterArcmin,
    constellation: state.constellation,
  };
}

// -- predicted objects ---------------------------------------------------------

/**
 * Materialises one star as a prediction.
 *
 * `unconfirmedBecause` stays null until something has actually looked: with no
 * media there is no question to answer, and inventing a reason would be its own
 * kind of overclaiming. The only reason available without media is that the star
 * is below the horizon, which is a fact about the sky rather than about the
 * observation.
 */
export function predictedStar(sky: PredictedSky, catalog: StarCatalog, index: number): PredictedObject {
  const altAz = altAzOf(
    _v.set(catalog.positions[index * 3], catalog.positions[index * 3 + 1], catalog.positions[index * 3 + 2]),
    sky.rotation,
  );
  return {
    state: 'predicted',
    catalog: starEntry(catalog, index),
    altAz: { ...altAz },
    unconfirmedBecause: altAz.altitude < 0 ? 'belowHorizon' : null,
  };
}

export function predictedDeepSky(sky: PredictedSky, object: DeepSkyObject): PredictedObject {
  const altAz = altAzOf(raDecToVector(object.ra, object.dec, _v), sky.rotation);
  return {
    state: 'predicted',
    catalog: deepSkyEntry(object),
    altAz: { ...altAz },
    unconfirmedBecause: altAz.altitude < 0 ? 'belowHorizon' : null,
  };
}

export function predictedSolarBody(state: SolarBodyState): PredictedObject {
  return {
    state: 'predicted',
    catalog: solarBodyEntry(state),
    altAz: { ...state.altAz },
    unconfirmedBecause: state.altAz.altitude < 0 ? 'belowHorizon' : null,
  };
}

/**
 * Every deep-sky object currently above the horizon, as predictions.
 *
 * Galaxies and nebulae are faint and extended and usually sit under a phone's
 * detection floor, so this list is where the unconfirmed cell earns its keep:
 * these get drawn, placed correctly, and left explicitly unconfirmed.
 */
export function predictedDeepSkyAboveHorizon(
  sky: PredictedSky,
  catalog: Catalogs['deepSky'],
  magnitudeLimit = 10,
): PredictedObject[] {
  const out: PredictedObject[] = [];
  for (const object of catalog.objects) {
    if (object.magnitude !== null && object.magnitude > magnitudeLimit) continue;
    const altAz = altAzOf(raDecToVector(object.ra, object.dec, _v), sky.rotation);
    if (altAz.altitude < 0) continue;
    out.push({
      state: 'predicted',
      catalog: deepSkyEntry(object),
      altAz: { ...altAz },
      unconfirmedBecause: null,
    });
  }
  return out;
}

// -- lookup --------------------------------------------------------------------

/**
 * The catalogue star nearest a scene-space direction, within `maxAngleDeg`.
 * Used for hover and click, and it is a plain nearest neighbour on purpose --
 * a UI pick is not a match, and nothing downstream treats it as one.
 */
export function nearestStar(
  catalog: StarCatalog,
  rotation: Matrix3,
  sceneDirection: Vector3,
  maxAngleDeg = 1.5,
  magnitudeLimit = 6.5,
): { index: number; separationDeg: number } | null {
  // Compare in catalogue space: rotating one probe beats rotating every star.
  const inverse = rotation.clone().invert();
  const probe = sceneDirection.clone().normalize().applyMatrix3(inverse);

  const count = catalog.countBrighterThan(magnitudeLimit);
  const cosLimit = Math.cos(maxAngleDeg / RAD);
  let best = -1;
  let bestDot = cosLimit;

  for (let i = 0; i < count; i++) {
    const dot =
      probe.x * catalog.positions[i * 3] +
      probe.y * catalog.positions[i * 3 + 1] +
      probe.z * catalog.positions[i * 3 + 2];
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }

  if (best < 0) return null;
  return { index: best, separationDeg: Math.acos(Math.min(1, bestDot)) * RAD };
}

/** The constellation a scene-space direction falls in, by IAU boundary. */
export function constellationAt(rotation: Matrix3, sceneDirection: Vector3): Astronomy.ConstellationInfo {
  const inverse = rotation.clone().invert();
  const eqj = sceneDirection.clone().normalize().applyMatrix3(inverse);
  const ra = Math.atan2(eqj.y, eqj.x);
  const dec = Math.asin(Math.max(-1, Math.min(1, eqj.z)));
  return Astronomy.Constellation(((ra < 0 ? ra + 2 * Math.PI : ra) * RAD) / 15, dec * RAD);
}
