/**
 * Star colour from catalogue photometry.
 *
 * The catalogue gives a B-V colour index, not a colour. Turning one into the
 * other is a real physical chain, and doing it properly costs about thirty lines:
 *
 *   B-V  ->  effective temperature   (Ballesteros 2012)
 *   T    ->  chromaticity on the Planckian locus  (Kim et al. cubic fit)
 *   xy   ->  CIE XYZ  ->  linear sRGB  ->  gamma-encoded sRGB
 *
 * The result is normalised to constant peak channel, because brightness is
 * carried separately by magnitude. A star's colour says what it is; its size and
 * intensity say how bright it looked.
 */

/** Effective temperature in kelvin from a B-V colour index. */
export function temperatureFromColorIndex(bv: number): number {
  // Ballesteros' formula, valid across the range HYG actually contains.
  const c = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
}

/** CIE 1931 chromaticity of a blackbody at temperature T, following the Planckian locus. */
function planckianChromaticity(kelvin: number): [number, number] {
  const T = Math.max(1667, Math.min(25000, kelvin));
  const t2 = T * T;
  const t3 = t2 * T;

  const x =
    T < 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / T + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / T + 0.24039;

  const x2 = x * x;
  const x3 = x2 * x;

  let y: number;
  if (T < 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (T < 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;

  return [x, y];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear light to gamma-encoded sRGB. */
function encodeSrgb(v: number): number {
  const c = clamp01(v);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * sRGB triple for a blackbody, normalised so the strongest channel is 1.
 * Components are in [0, 1].
 */
export function rgbFromTemperature(kelvin: number): [number, number, number] {
  const [x, y] = planckianChromaticity(kelvin);
  if (y <= 0) return [1, 1, 1];

  // xyY with Y = 1 -> XYZ
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;

  // XYZ -> linear sRGB (sRGB primaries, D65)
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;

  // Clip negatives towards the achromatic axis rather than truncating, which
  // would skew hue for the extreme temperatures at both ends of the locus.
  const lowest = Math.min(r, g, b);
  if (lowest < 0) {
    r -= lowest;
    g -= lowest;
    b -= lowest;
  }

  const peak = Math.max(r, g, b, 1e-9);
  return [encodeSrgb(r / peak), encodeSrgb(g / peak), encodeSrgb(b / peak)];
}

/** sRGB triple for a star of the given B-V colour index. */
export function rgbFromColorIndex(bv: number): [number, number, number] {
  if (!Number.isFinite(bv)) return [1, 1, 1]; // unknown colour reads as white, not invented
  return rgbFromTemperature(temperatureFromColorIndex(bv));
}

/**
 * Rough spectral class letter for a colour index, for the object inspector when
 * the catalogue has no spectral type of its own.
 */
export function spectralClassFromColorIndex(bv: number): string | null {
  if (!Number.isFinite(bv)) return null;
  if (bv < -0.25) return 'O';
  if (bv < 0.0) return 'B';
  if (bv < 0.3) return 'A';
  if (bv < 0.58) return 'F';
  if (bv < 0.81) return 'G';
  if (bv < 1.4) return 'K';
  return 'M';
}
