/**
 * Reading an observation's circumstances out of the file.
 *
 * The hazard this module exists to handle: `DateTimeOriginal` is local wall-clock
 * with no offset attached. Treating it as UTC rotates the sky by 15 degrees per
 * hour of error, and -- worse than breaking -- the result still looks like a
 * plausible sky. So the time is never returned as a bare Date. It always comes
 * back with a stated provenance and confidence, and the UI is expected to show it.
 *
 * The preference order is:
 *
 *   1. GPSDateStamp + GPSTimeStamp   true UTC, straight from the satellites
 *   2. OffsetTimeOriginal            an explicit offset the camera recorded
 *   3. DateTimeOriginal + longitude  a solar-time estimate, good to about an hour
 *   4. DateTimeOriginal alone        assumed to be this device's timezone
 *
 * Only the first two are trustworthy enough to solve against without asking.
 */
import type { ObserverSite } from '@/lib/astro/frames';

/**
 * exifr is loaded on demand rather than at module scope.
 *
 * It probes for Node's `fs` and `zlib` when it is evaluated, which is noise
 * during a static prerender, and it is a few hundred kilobytes that only matter
 * once a file is actually imported. The observatory has to be on screen before
 * any of that.
 */
async function loadExifr() {
  return (await import('exifr')).default;
}

export type TimeSource =
  | 'gps'
  | 'exifOffset'
  | 'exifLocalWithLongitude'
  | 'exifLocalAssumedDeviceZone'
  | 'fileModified'
  | 'userSupplied';

export type Confidence = 'exact' | 'estimated' | 'assumed' | 'unknown';

export interface ResolvedTime {
  utc: Date;
  source: TimeSource;
  confidence: Confidence;
  /** Offset applied to reach UTC, in minutes east of Greenwich. */
  offsetMinutes: number | null;
  /** The wall-clock string as written in the file, for display. */
  rawLocal: string | null;
  /** Plain-language note the UI shows next to the timestamp. */
  note: string;
}

export interface ResolvedLocation {
  site: ObserverSite;
  source: 'exifGps' | 'geolocation' | 'userSupplied' | 'default';
  confidence: Confidence;
  /** Horizontal accuracy in metres, where the source reports one. */
  accuracyMetres: number | null;
}

export interface CameraMetadata {
  make: string | null;
  model: string | null;
  lensModel: string | null;
  /** Actual focal length in millimetres. */
  focalLengthMm: number | null;
  /** Focal length expressed for a 35 mm frame, when the camera reports it. */
  focalLength35mm: number | null;
  exposureSeconds: number | null;
  iso: number | null;
  fNumber: number | null;
  /** Pixel dimensions as recorded in the file. */
  pixelWidth: number | null;
  pixelHeight: number | null;
  orientation: number | null;
}

export interface FieldOfViewPrior {
  /** Horizontal field of view in degrees. */
  horizontalDeg: number;
  /** Vertical field of view in degrees. */
  verticalDeg: number;
  /** Diagonal field of view in degrees. */
  diagonalDeg: number;
  /** How this was arrived at. */
  basis: 'focalLength35mm' | 'focalLengthAndSensor' | 'none';
  confidence: Confidence;
}

export interface MediaMetadata {
  fileName: string;
  fileSize: number;
  mimeType: string;
  camera: CameraMetadata;
  time: ResolvedTime | null;
  location: ResolvedLocation | null;
  fieldOfView: FieldOfViewPrior | null;
  /** Everything else exifr found, for the technical panel. */
  raw: Record<string, unknown>;
}

// -- time ----------------------------------------------------------------------

/** `2026:08:19 22:30:00` -> its component numbers. Returns null if unparseable. */
function parseExifDateTime(value: unknown): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  if (value instanceof Date) {
    // exifr revived it by treating the string as this device's local time, so the
    // local components are exactly what the file said.
    return {
      y: value.getFullYear(),
      mo: value.getMonth() + 1,
      d: value.getDate(),
      h: value.getHours(),
      mi: value.getMinutes(),
      s: value.getSeconds(),
    };
  }
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}

function formatLocal(p: { y: number; mo: number; d: number; h: number; mi: number; s: number }): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** `+01:00` / `-0730` -> minutes east of Greenwich. */
function parseOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Works out the UTC instant a frame was taken, and how much to trust the answer.
 *
 * `raw` is exifr's merged output; `longitude` is used only for the solar-time
 * fallback, and only when nothing better exists.
 */
export function resolveTime(raw: Record<string, unknown>, longitude: number | null): ResolvedTime | null {
  // 1. GPS time is true UTC.
  const gpsDate = raw.GPSDateStamp;
  const gpsTime = raw.GPSTimeStamp;
  if (typeof gpsDate === 'string' && typeof gpsTime === 'string') {
    const d = gpsDate.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
    const t = gpsTime.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
    if (d && t) {
      const utc = new Date(
        Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], Math.floor(Number(t[3])), Math.round((Number(t[3]) % 1) * 1000)),
      );
      if (!Number.isNaN(utc.getTime())) {
        return {
          utc,
          source: 'gps',
          confidence: 'exact',
          offsetMinutes: 0,
          rawLocal: null,
          note: 'GPS timestamp — true UTC, straight from the satellites.',
        };
      }
    }
  }

  const original = parseExifDateTime(raw.DateTimeOriginal ?? raw.CreateDate ?? raw.DateTime);
  if (!original) return null;
  const rawLocal = formatLocal(original);
  const asUtcMs = Date.UTC(original.y, original.mo - 1, original.d, original.h, original.mi, original.s);

  // 2. An explicit offset the camera wrote alongside the wall clock.
  const offset = parseOffset(raw.OffsetTimeOriginal ?? raw.OffsetTime ?? raw.OffsetTimeDigitized);
  if (offset !== null) {
    return {
      utc: new Date(asUtcMs - offset * 60_000),
      source: 'exifOffset',
      confidence: 'exact',
      offsetMinutes: offset,
      rawLocal,
      note: `Local time with an explicit UTC offset of ${formatOffset(offset)}.`,
    };
  }

  // 3. No offset, but we know where on Earth this was: estimate from longitude.
  //    Political timezone boundaries and daylight saving mean this can be an hour
  //    or more out, which is 15 degrees of sky, so it is flagged as estimated.
  if (longitude !== null) {
    const solarOffset = Math.round((longitude / 15) * 60);
    return {
      utc: new Date(asUtcMs - solarOffset * 60_000),
      source: 'exifLocalWithLongitude',
      confidence: 'estimated',
      offsetMinutes: solarOffset,
      rawLocal,
      note:
        `No timezone in the file. Offset estimated as ${formatOffset(solarOffset)} from the GPS longitude. ` +
        'Daylight saving or a wide timezone can put this an hour out — which is 15° of sky.',
    };
  }

  // 4. Nothing to go on. Assume the file was written in this device's timezone.
  const assumed = new Date(original.y, original.mo - 1, original.d, original.h, original.mi, original.s);
  return {
    utc: assumed,
    source: 'exifLocalAssumedDeviceZone',
    confidence: 'assumed',
    offsetMinutes: -assumed.getTimezoneOffset(),
    rawLocal,
    note:
      'No timezone and no GPS in the file. Assumed to be this device’s timezone. ' +
      'Check it before trusting any match — an hour of error rotates the sky by 15°.',
  };
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// -- field of view -------------------------------------------------------------

/** Standard 35 mm frame, in millimetres. */
const FRAME_35MM = { width: 36, height: 24 };

/**
 * Angular field of view from focal length.
 *
 * A prior, not a measurement: it narrows the plate solve's search, and the solve
 * is what establishes the real value. Phone cameras crop and stabilise, so the
 * recorded focal length routinely disagrees with the delivered frame by a few
 * per cent.
 */
export function fieldOfViewPrior(camera: CameraMetadata): FieldOfViewPrior | null {
  const width = camera.pixelWidth;
  const height = camera.pixelHeight;
  const aspect = width && height ? width / height : FRAME_35MM.width / FRAME_35MM.height;

  const fov = (sensorDim: number, focal: number) => 2 * Math.atan(sensorDim / (2 * focal)) * (180 / Math.PI);

  if (camera.focalLength35mm) {
    // The 35 mm equivalent already folds in the crop factor. Reshape the standard
    // frame to the image's aspect ratio so a portrait frame is not given a
    // landscape field.
    const longSide = FRAME_35MM.width;
    const shortSide = longSide / Math.max(aspect, 1 / aspect);
    const [w, h] = aspect >= 1 ? [longSide, shortSide] : [shortSide, longSide];
    return {
      horizontalDeg: fov(w, camera.focalLength35mm),
      verticalDeg: fov(h, camera.focalLength35mm),
      diagonalDeg: fov(Math.hypot(w, h), camera.focalLength35mm),
      basis: 'focalLength35mm',
      confidence: 'estimated',
    };
  }

  // Without a 35 mm equivalent the sensor size is unknown, and guessing it would
  // be inventing data. Better to have no prior and let the solve work it out.
  return null;
}

// -- top level -----------------------------------------------------------------

/** Everything OmniEye can learn about a file before looking at a single pixel. */
export async function readMediaMetadata(file: File): Promise<MediaMetadata> {
  const exifr = await loadExifr();

  let raw: Record<string, unknown> = {};
  try {
    raw =
      ((await exifr.parse(file, {
        tiff: true,
        exif: true,
        gps: true,
        // Keep the timestamps as written. exifr's default revival interprets them
        // in the device's timezone, which is precisely the assumption this module
        // exists to make explicit rather than silent.
        reviveValues: false,
        mergeOutput: true,
      })) as Record<string, unknown> | undefined) ?? {};
  } catch {
    raw = {};
  }

  // exifr's dedicated GPS pass returns decimal degrees, which the raw tags do not.
  let gps: { latitude: number; longitude: number } | null = null;
  try {
    gps = (await exifr.gps(file)) ?? null;
  } catch {
    gps = null;
  }

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const camera: CameraMetadata = {
    make: str(raw.Make),
    model: str(raw.Model),
    lensModel: str(raw.LensModel),
    focalLengthMm: num(raw.FocalLength),
    focalLength35mm: num(raw.FocalLengthIn35mmFormat),
    exposureSeconds: num(raw.ExposureTime),
    iso: num(raw.ISO),
    fNumber: num(raw.FNumber),
    pixelWidth: num(raw.ExifImageWidth) ?? num(raw.ImageWidth),
    pixelHeight: num(raw.ExifImageHeight) ?? num(raw.ImageHeight),
    orientation: num(raw.Orientation),
  };

  const location: ResolvedLocation | null = gps
    ? {
        site: { latitude: gps.latitude, longitude: gps.longitude, elevation: num(raw.GPSAltitude) ?? 0 },
        source: 'exifGps',
        confidence: 'exact',
        accuracyMetres: null,
      }
    : null;

  return {
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    camera,
    time: resolveTime(raw, gps?.longitude ?? null),
    location,
    fieldOfView: fieldOfViewPrior(camera),
    raw,
  };
}

/** A time the user typed or picked, which outranks anything read from the file. */
export function userSuppliedTime(utc: Date): ResolvedTime {
  return {
    utc,
    source: 'userSupplied',
    confidence: 'exact',
    offsetMinutes: null,
    rawLocal: null,
    note: 'Set by hand.',
  };
}
