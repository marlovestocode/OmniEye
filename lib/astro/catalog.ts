/**
 * Catalogue loading.
 *
 * The star catalogue arrives as a raw Float32Array with no parse step, is carried
 * forward from J2000 to the working epoch once, and is then handed to the GPU as
 * a static buffer. It never moves again: the sky turns by rotating the object it
 * is attached to, not by rewriting vertices.
 *
 * Everything here is fetched from /catalog and is pure reference data. Nothing in
 * this module knows anything about media, detection, or matching -- the predicted
 * lane must be able to run with no observation at all.
 */
import { Vector3 } from 'three';
import { applyProperMotion, yearsSinceJ2000 } from './frames';
import { rgbFromColorIndex, spectralClassFromColorIndex } from './color';

const CATALOG_BASE = '/catalog';

export interface StarCatalogMeta {
  source: string;
  license: string;
  epoch: string;
  frame: string;
  count: number;
  stride: number;
  magLimit: number;
  fields: string[];
  pmUnits: string;
  tiers: { mag: number; count: number }[];
  builtAt: string;
}

/** Designations for a star, as stored in star-names.json (keys kept terse). */
interface RawStarName {
  p?: string; // proper name
  b?: string; // Bayer letter
  f?: string; // Flamsteed number
  c?: string; // constellation abbreviation
  h?: number; // HIP number
  s?: string; // spectral type
  d?: number; // distance, parsecs
}

export interface StarDesignation {
  proper: string | null;
  bayer: string | null;
  flamsteed: string | null;
  constellation: string | null;
  hip: number | null;
  spectralType: string | null;
  distanceParsecs: number | null;
}

export interface StarCatalog {
  meta: StarCatalogMeta;
  /** Epoch the positions were carried forward to. */
  epoch: Date;
  count: number;
  /** 3 floats per star: EQJ unit vector at `epoch`. */
  positions: Float32Array;
  /** Visual magnitude per star, brightest first. */
  magnitudes: Float32Array;
  /** 3 floats per star: linear-ish sRGB in [0,1]. */
  colors: Float32Array;
  /** B-V colour index per star, NaN when the catalogue had none. */
  colorIndices: Float32Array;
  /** Sparse designations, keyed by star index. */
  designations: Map<number, StarDesignation>;
  /** Index into `positions` for a HIP number, where known. */
  byHip: Map<number, number>;
  /**
   * How many leading stars fall within a magnitude limit. The buffer is sorted
   * brightest-first, so a limit is a draw range rather than a filter.
   */
  countBrighterThan(magnitude: number): number;
}

export interface ConstellationFigure {
  abbrev: string;
  name: string;
  english: string | null;
  /** Polylines of star indices into the star catalogue. */
  lines: number[][];
}

export interface ConstellationSet {
  source: string;
  license: string;
  figures: ConstellationFigure[];
  byAbbrev: Map<string, ConstellationFigure>;
}

export interface DeepSkyObject {
  id: string;
  name: string | null;
  designations: string[];
  type: string | null;
  typeLabel: string | null;
  constellation: string | null;
  /** J2000, radians. */
  ra: number;
  dec: number;
  magnitude: number | null;
  /** Semi-major and semi-minor angular extent in arcminutes, and position angle. */
  majorArcmin: number | null;
  minorArcmin: number | null;
  positionAngle: number | null;
}

export interface DeepSkyCatalog {
  source: string;
  license: string;
  objects: DeepSkyObject[];
  byId: Map<string, DeepSkyObject>;
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${CATALOG_BASE}/${path}`, { signal });
  if (!res.ok) throw new Error(`catalog: ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Loads the star catalogue and carries every position forward from J2000 to
 * `epoch` by its own proper motion.
 *
 * Doing this once at load rather than never is the difference between a fit that
 * is good to arcseconds and one that is systematically off for the handful of
 * high-proper-motion stars bright enough to appear in a photograph. Doing it once
 * rather than continuously is fine: over a decade the residual change is well
 * under an arcsecond for everything in this magnitude range.
 */
export async function loadStarCatalog(epoch: Date = new Date(), signal?: AbortSignal): Promise<StarCatalog> {
  const [meta, binRes, nameJson] = await Promise.all([
    fetchJson<StarCatalogMeta>('stars.meta.json', signal),
    fetch(`${CATALOG_BASE}/stars.bin`, { signal }),
    fetchJson<{ names: Record<string, RawStarName> }>('star-names.json', signal),
  ]);
  if (!binRes.ok) throw new Error(`catalog: stars.bin -> HTTP ${binRes.status}`);

  const raw = new Float32Array(await binRes.arrayBuffer());
  const { count, stride } = meta;
  if (raw.length < count * stride) {
    throw new Error(`catalog: stars.bin holds ${raw.length} floats, expected ${count * stride}`);
  }

  const positions = new Float32Array(count * 3);
  const magnitudes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const colorIndices = new Float32Array(count);

  const years = yearsSinceJ2000(epoch);
  const v = new Vector3();

  for (let i = 0; i < count; i++) {
    const o = i * stride;
    applyProperMotion(raw[o], raw[o + 1], raw[o + 2], raw[o + 5], raw[o + 6], raw[o + 7], years, v);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;

    magnitudes[i] = raw[o + 3];
    const ci = raw[o + 4];
    colorIndices[i] = ci;
    const [r, g, b] = rgbFromColorIndex(ci);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  const designations = new Map<number, StarDesignation>();
  const byHip = new Map<number, number>();
  for (const [key, entry] of Object.entries(nameJson.names)) {
    const index = Number(key);
    designations.set(index, {
      proper: entry.p ?? null,
      bayer: entry.b ?? null,
      flamsteed: entry.f ?? null,
      constellation: entry.c ?? null,
      hip: entry.h ?? null,
      spectralType: entry.s ?? spectralClassFromColorIndex(colorIndices[index]),
      distanceParsecs: entry.d ?? null,
    });
    if (entry.h !== undefined) byHip.set(entry.h, index);
  }

  const tiers = meta.tiers;
  return {
    meta,
    epoch,
    count,
    positions,
    magnitudes,
    colors,
    colorIndices,
    designations,
    byHip,
    countBrighterThan(magnitude: number) {
      // Exact when the limit lands on a published tier; otherwise binary search
      // the sorted magnitude array.
      const tier = tiers.find((t) => t.mag === magnitude);
      if (tier) return tier.count;
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (magnitudes[mid] <= magnitude) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}

/** A readable label for a star: proper name, else Bayer/Flamsteed, else HIP. */
export function starLabel(d: StarDesignation | undefined): string | null {
  if (!d) return null;
  if (d.proper) return d.proper;
  if (d.bayer && d.constellation) return `${d.bayer} ${d.constellation}`;
  if (d.flamsteed && d.constellation) return `${d.flamsteed} ${d.constellation}`;
  if (d.hip !== null) return `HIP ${d.hip}`;
  return null;
}

export async function loadConstellations(signal?: AbortSignal): Promise<ConstellationSet> {
  const json = await fetchJson<{
    source: string;
    license: string;
    constellations: ConstellationFigure[];
  }>('constellations.json', signal);
  const byAbbrev = new Map(json.constellations.map((c) => [c.abbrev, c]));
  return { source: json.source, license: json.license, figures: json.constellations, byAbbrev };
}

export async function loadDeepSky(signal?: AbortSignal): Promise<DeepSkyCatalog> {
  const json = await fetchJson<{
    source: string;
    license: string;
    objects: {
      id: string;
      name: string | null;
      designations: string[];
      type: string | null;
      typeLabel: string | null;
      con: string | null;
      ra: number;
      dec: number;
      mag: number | null;
      r1: number | null;
      r2: number | null;
      angle: number | null;
    }[];
  }>('dso.json', signal);

  const objects: DeepSkyObject[] = json.objects.map((o) => ({
    id: o.id,
    name: o.name,
    designations: o.designations,
    type: o.type,
    typeLabel: o.typeLabel,
    constellation: o.con,
    ra: o.ra,
    dec: o.dec,
    magnitude: o.mag,
    majorArcmin: o.r1,
    minorArcmin: o.r2,
    positionAngle: o.angle,
  }));

  return {
    source: json.source,
    license: json.license,
    objects,
    byId: new Map(objects.map((o) => [o.id, o])),
  };
}

export interface Catalogs {
  stars: StarCatalog;
  constellations: ConstellationSet;
  deepSky: DeepSkyCatalog;
}

/** Loads everything the predicted lane needs, in parallel. */
export async function loadCatalogs(epoch: Date = new Date(), signal?: AbortSignal): Promise<Catalogs> {
  const [stars, constellations, deepSky] = await Promise.all([
    loadStarCatalog(epoch, signal),
    loadConstellations(signal),
    loadDeepSky(signal),
  ]);
  return { stars, constellations, deepSky };
}

let pending: Promise<Catalogs> | null = null;

/**
 * Loads the catalogues once per page, memoised.
 *
 * The catalogues are immutable reference data with no per-component identity, so
 * a module-scoped promise is a truer model than an effect that owns a fetch.
 * It also sidesteps a trap: under StrictMode, React mounts effects twice, and an
 * effect that aborts its fetch on cleanup will cancel the first attempt while the
 * second finds a "loading" flag already set and declines to start. The result is
 * a page that waits forever for a request nobody is making.
 *
 * Deliberately not abortable. Half a megabyte of star positions that the app will
 * need again in a moment is not worth cancelling.
 */
export function loadCatalogsOnce(epoch: Date = new Date()): Promise<Catalogs> {
  if (!pending) {
    pending = loadCatalogs(epoch).catch((error) => {
      // Let a later attempt retry rather than caching the failure forever.
      pending = null;
      throw error;
    });
  }
  return pending;
}
