/**
 * Getting pixels out of a file and into the detector.
 *
 * Two things happen here that affect what the detector can find, so both are
 * deliberate and both are reported:
 *
 * Luminance is the plain mean of the colour channels, not a perceptual luma.
 * Rec.709 weights green nine times heavier than blue, which would quietly make
 * the detector less sensitive to blue stars than to red ones -- a colour-dependent
 * detection floor is not something a sky app should have. The mean is unbiased
 * across colour and, for equal per-channel noise, loses nothing measurable
 * against the weighted version.
 *
 * Downscaling is offered but off by default. Resampling moves centroids, and
 * centroid accuracy is the input to every angle the app later reports.
 */
import type { LuminanceImage } from '@/lib/detect/types';

export interface LoadedImage {
  /** The decoded frame, kept for display and for the sphere texture later. */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Grey-scale copy at detection resolution. */
  luminance: LuminanceImage;
  /** Scale from luminance pixels back to full-resolution pixels. 1 when untouched. */
  scale: number;
  /** Fraction of pixels at or above the saturation level. */
  saturatedFraction: number;
}

export interface LoadOptions {
  /**
   * Cap on the longest edge for the detection copy. Null keeps full resolution,
   * which is the default: a 12 megapixel frame costs about 100 MB of working
   * memory in the worker but preserves sub-pixel accuracy.
   */
  maxEdge?: number | null;
  saturationLevel?: number;
}

/** Decodes a file to an ImageBitmap, honouring EXIF orientation. */
export async function decodeImageFile(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Pulls RGBA pixels out of a bitmap at the given size. */
export function readPixels(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): ImageData {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('image: no 2D context available');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * RGBA to a 0..1 grey-scale plane.
 *
 * Also counts saturated pixels, because a frame that is 30% blown out explains a
 * poor detection far better than any parameter tuning will.
 */
export function toLuminance(
  image: ImageData,
  saturationLevel = 0.995,
): { luminance: LuminanceImage; saturatedFraction: number } {
  const { data, width, height } = image;
  const out = new Float32Array(width * height);
  const threshold = saturationLevel * 255 * 3;
  let saturated = 0;

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const sum = data[p] + data[p + 1] + data[p + 2];
    out[i] = sum / 765; // 3 * 255
    if (sum >= threshold) saturated++;
  }

  return {
    luminance: { data: out, width, height },
    saturatedFraction: saturated / out.length,
  };
}

/** Decodes a file and prepares everything the detector and the UI need. */
export async function loadImage(file: File, options: LoadOptions = {}): Promise<LoadedImage> {
  const { maxEdge = null, saturationLevel = 0.995 } = options;
  const bitmap = await decodeImageFile(file);

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = maxEdge && longest > maxEdge ? maxEdge / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const pixels = readPixels(bitmap, width, height);
  const { luminance, saturatedFraction } = toLuminance(pixels, saturationLevel);

  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    luminance,
    // Multiply a detection-space coordinate by this to reach full resolution.
    scale: scale === 1 ? 1 : 1 / scale,
    saturatedFraction,
  };
}
