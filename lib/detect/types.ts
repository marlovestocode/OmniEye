/**
 * The Observed Sky: what OmniEye actually found in the media.
 *
 * Nothing in this file knows a catalogue exists. A source is a bright spot with a
 * position, a brightness and a shape -- no name, no identity, no expectation of
 * where it should have been. That is not modesty, it is the measurement: if the
 * detector were seeded with predicted positions it would find stars there, and
 * the match rate would become a measurement of our own assumptions rather than of
 * the sky.
 *
 * Morphology classes are named after pixel shape, never after what the shape
 * might imply. A one-pixel spike is `sharp`, not "hot pixel". A streak is
 * `trailed`, not "satellite". Naming the cause is the matching layer's job, and
 * only when the astronomy supports it.
 */

/** A point source traced in one frame of media. Evidence, without identity. */
export interface Source {
  /** Stable within one detection run: `<frame>:<ordinal>`. */
  id: string;
  /** Flux-weighted centroid in image pixels, origin at the top-left corner. */
  x: number;
  y: number;
  /** Background-subtracted integrated flux, in the image's own units. */
  flux: number;
  /** Brightest pixel above background. */
  peak: number;
  /** Number of connected pixels above the detection threshold. */
  area: number;
  /** Integrated flux divided by its own noise. The honest brightness confidence. */
  snr: number;
  /** Full width at half maximum in pixels, from the second moments. */
  fwhm: number;
  /** Major-to-minor axis ratio. 1.0 is perfectly round. */
  elongation: number;
  /** Major axis orientation in radians, measured from +x towards +y. */
  theta: number;
  /** True if any pixel reached the saturation level; flux is a lower bound. */
  saturated: boolean;
  /** Local background level under the source. */
  background: number;
  /** Frame index this came from. 0 for a still image. */
  frame: number;
  /** Shape class, from pixel morphology alone. */
  shape: SourceShape;
}

/**
 * What a source looks like, judged only on its own pixels.
 *
 *   point     consistent with the image's own point spread function
 *   sharp     tighter than the PSF, so it is more likely sensor than sky
 *   trailed   clearly elongated: motion, tracking error, or an extended object
 *   diffuse   much broader than the PSF
 */
export type SourceShape = 'point' | 'sharp' | 'trailed' | 'diffuse';

export interface DetectionParams {
  /** Detection threshold in units of the local background noise sigma. */
  thresholdSigma: number;
  /** Minimum connected pixels above threshold for a source to count. */
  minArea: number;
  /** Sources larger than this are discarded as glare, cloud or the Moon. */
  maxArea: number;
  /** Background mesh cell size in pixels. Must be much larger than a star. */
  backgroundCell: number;
  /** Pixel value treated as saturated, on the 0..1 luminance scale. */
  saturationLevel: number;
  /** Keep at most this many sources, brightest first. */
  maxSources: number;
  /**
   * A source narrower than this fraction of the image's own measured PSF is
   * classed `sharp`.
   *
   * Relative rather than absolute, because the rule is physical: optics cannot
   * produce anything tighter than their own point spread function, so a source
   * that is tighter did not come through the lens. An absolute pixel threshold
   * would mean something different on every camera, and would quietly call real
   * stars artefacts on a sharp lens.
   */
  sharpFwhmFraction: number;
  /** Absolute FWHM floor, used only when the PSF could not be measured. */
  sharpFwhmFloor: number;
  /** Sources with a greater elongation than this are classed `trailed`. */
  trailedElongation: number;
  /** Sources broader than this multiple of the PSF are classed `diffuse`. */
  diffuseFwhmFactor: number;
}

export const DEFAULT_DETECTION_PARAMS: DetectionParams = {
  // 4 sigma is the usual compromise: low enough to reach faint stars in a noisy
  // phone frame, high enough that a megapixel of Gaussian noise yields well under
  // one false detection per frame.
  thresholdSigma: 4,
  minArea: 3,
  maxArea: 2000,
  backgroundCell: 64,
  saturationLevel: 0.995,
  maxSources: 500,
  sharpFwhmFraction: 0.65,
  sharpFwhmFloor: 1.1,
  trailedElongation: 2.2,
  diffuseFwhmFactor: 3,
};

/** Per-image statistics, so the UI can say why a detection found what it found. */
export interface BackgroundStats {
  /** Median background level across the mesh, 0..1. */
  median: number;
  /** Median noise sigma across the mesh, 0..1. */
  sigma: number;
  /** Lowest and highest mesh cell background: a gradient reads as a wide spread. */
  min: number;
  max: number;
}

export interface DetectionResult {
  sources: Source[];
  width: number;
  height: number;
  background: BackgroundStats;
  /** Median FWHM of point-like sources: the image's own seeing, in pixels. */
  fwhmPixels: number | null;
  /** How many candidates were rejected, and why. */
  rejected: {
    tooSmall: number;
    tooLarge: number;
    belowSnr: number;
    truncatedByLimit: number;
  };
  params: DetectionParams;
  elapsedMs: number;
}

/** Grey-scale pixel data handed to the detector. Values are 0..1. */
export interface LuminanceImage {
  data: Float32Array;
  width: number;
  height: number;
}
