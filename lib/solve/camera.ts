/**
 * The camera model.
 *
 * A pinhole with one optional radial term. Turning a detected centroid into a
 * direction is the step that lets an image be compared with a sky at all, so the
 * conventions are pinned down here and nowhere else.
 *
 *   image frame    pixels, origin at the top-left corner, x right, y *down*
 *   camera frame   x right, y up, z out of the back of the lens
 *
 * The camera looks down its own -z. The y flip between the two frames is the
 * single most common sign error in this kind of code, so it happens in exactly
 * one function.
 *
 * Focal length is carried in pixels rather than millimetres. Millimetres are only
 * meaningful alongside a sensor size, which phones rarely report honestly, while
 * pixels are what the geometry actually needs.
 */
import { Vector3 } from 'three';
import { DEG, RAD } from '@/lib/astro/frames';

export interface CameraModel {
  width: number;
  height: number;
  /** Focal length in pixels. */
  focal: number;
  /** Principal point in pixels. Defaults to the image centre. */
  cx: number;
  cy: number;
  /**
   * Brown radial distortion coefficient, with radius normalised by half the
   * image diagonal so the value is dimensionless and comparable across sizes.
   * Zero for a perfect pinhole; wide phone lenses land around -0.05 to -0.15.
   */
  k1: number;
}

export function makeCamera(width: number, height: number, focal: number, k1 = 0): CameraModel {
  return { width, height, focal, cx: width / 2, cy: height / 2, k1 };
}

/** Half the image diagonal, the normalising radius for the distortion term. */
export const normRadius = (camera: CameraModel): number =>
  Math.hypot(camera.width, camera.height) / 2;

/** Focal length in pixels from a diagonal field of view in degrees. */
export function focalFromDiagonalFov(width: number, height: number, fovDeg: number): number {
  return Math.hypot(width, height) / 2 / Math.tan((fovDeg * DEG) / 2);
}

/** Diagonal field of view in degrees for a focal length in pixels. */
export function diagonalFovFromFocal(width: number, height: number, focal: number): number {
  return 2 * Math.atan(Math.hypot(width, height) / 2 / focal) * RAD;
}

/** Horizontal and vertical field of view in degrees. */
export function fieldOfView(camera: CameraModel): { horizontal: number; vertical: number; diagonal: number } {
  const f = camera.focal;
  return {
    horizontal: 2 * Math.atan(camera.width / 2 / f) * RAD,
    vertical: 2 * Math.atan(camera.height / 2 / f) * RAD,
    diagonal: 2 * Math.atan(Math.hypot(camera.width, camera.height) / 2 / f) * RAD,
  };
}

/** Angular size of one pixel at the image centre, in arcseconds. */
export function pixelScaleArcsec(camera: CameraModel): number {
  return (1 / camera.focal) * RAD * 3600;
}

/**
 * Removes radial distortion from a measured offset.
 *
 * The distortion model maps ideal to measured, so undoing it means inverting
 * `r_measured = r_ideal * (1 + k1 * r_ideal^2)`. Three Newton steps converge to
 * far better than a thousandth of a pixel across any sane coefficient.
 */
function undistort(dx: number, dy: number, k1: number, norm: number): { dx: number; dy: number } {
  if (k1 === 0) return { dx, dy };
  const rMeasured = Math.hypot(dx, dy) / norm;
  if (rMeasured < 1e-9) return { dx, dy };

  let r = rMeasured;
  for (let i = 0; i < 3; i++) {
    const f = r * (1 + k1 * r * r) - rMeasured;
    const df = 1 + 3 * k1 * r * r;
    if (Math.abs(df) < 1e-12) break;
    r -= f / df;
  }
  const scale = r / rMeasured;
  return { dx: dx * scale, dy: dy * scale };
}

/** Applies radial distortion: ideal offset to where it actually lands. */
function distort(dx: number, dy: number, k1: number, norm: number): { dx: number; dy: number } {
  if (k1 === 0) return { dx, dy };
  const r = Math.hypot(dx, dy) / norm;
  const scale = 1 + k1 * r * r;
  return { dx: dx * scale, dy: dy * scale };
}

/**
 * A detected pixel to a unit vector in the camera frame.
 *
 * This is the "lift to unit vectors" step: once every source and every catalogue
 * entry is a unit vector, the registration problem is rotation-only.
 */
export function pixelToRay(camera: CameraModel, x: number, y: number, out = new Vector3()): Vector3 {
  const { dx, dy } = undistort(x - camera.cx, y - camera.cy, camera.k1, normRadius(camera));
  // The y flip: image rows increase downwards, camera y points up.
  return out.set(dx, -dy, -camera.focal).normalize();
}

/**
 * A camera-frame direction back to a pixel.
 *
 * Returns null for anything at or behind the lens plane, which would otherwise
 * project to a plausible-looking point in front of the camera.
 */
export function rayToPixel(
  camera: CameraModel,
  ray: Vector3,
): { x: number; y: number } | null {
  if (ray.z >= -1e-9) return null;
  const scale = -camera.focal / ray.z;
  const ideal = { dx: ray.x * scale, dy: -ray.y * scale };
  const { dx, dy } = distort(ideal.dx, ideal.dy, camera.k1, normRadius(camera));
  return { x: camera.cx + dx, y: camera.cy + dy };
}

/** True when a pixel lies inside the frame, with an optional margin. */
export function insideFrame(camera: CameraModel, x: number, y: number, margin = 0): boolean {
  return x >= -margin && y >= -margin && x <= camera.width + margin && y <= camera.height + margin;
}

/**
 * The focal lengths at which two image points subtend a given angle.
 *
 * This is what makes a blind solve tractable without searching field of view on a
 * grid: one hypothesised correspondence between an image pair and a catalogue
 * pair pins the scale outright.
 *
 * And it is a closed form, not a search. Writing the cosine of the angle between
 * two pinhole rays and clearing the square root leaves a quadratic in f²:
 *
 *   cos t = (A + f²) / sqrt((a² + f²)(b² + f²))
 *
 * with a², b² the squared pixel offsets from the principal point and A their dot
 * product. Rearranged,
 *
 *   (1 - cos²t) u² + (2A - cos²t (a² + b²)) u + (A² - cos²t a² b²) = 0,  u = f²
 *
 * Squaring introduces the mirror solution where the angle comes out as its
 * supplement, so each root is checked against the original unsquared equation
 * before being returned. This runs once per hypothesis -- hundreds of thousands
 * of times per solve -- and replacing a forty-step bisection with a quadratic is
 * the difference between a solve that takes a second and one that takes a minute.
 *
 * Assumes no radial distortion, which holds during hypothesis generation: the
 * distortion term is fitted afterwards, once there is a fit to improve.
 */
export function focalsForAngle(
  camera: CameraModel,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  angleRad: number,
  minFocal: number,
  maxFocal: number,
  out: number[] = [],
): number[] {
  out.length = 0;

  const dx1 = ax - camera.cx;
  const dy1 = ay - camera.cy;
  const dx2 = bx - camera.cx;
  const dy2 = by - camera.cy;

  const a2 = dx1 * dx1 + dy1 * dy1;
  const b2 = dx2 * dx2 + dy2 * dy2;
  const A = dx1 * dx2 + dy1 * dy2;

  const c = Math.cos(angleRad);
  const c2 = c * c;
  const s = 1 - c2;

  // Nearly parallel or nearly opposite rays pin nothing down.
  if (s < 1e-12) return out;

  const p = 2 * A - c2 * (a2 + b2);
  const q = A * A - c2 * a2 * b2;
  const disc = p * p - 4 * s * q;
  if (disc < 0) return out;

  const root = Math.sqrt(disc);
  for (const u of [(-p + root) / (2 * s), (-p - root) / (2 * s)]) {
    if (!(u > 0)) continue;
    const f = Math.sqrt(u);
    if (f < minFocal || f > maxFocal) continue;
    // Reject the supplement introduced by squaring.
    const check = (A + u) / Math.sqrt((a2 + u) * (b2 + u));
    if (Math.abs(check - c) > 1e-6) continue;
    out.push(f);
  }
  return out;
}
