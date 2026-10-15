/**
 * Detection worker.
 *
 * Detection touches every pixel several times and takes hundreds of milliseconds
 * on a full-resolution frame. Running it on the main thread would stall the 3D
 * scene, and the whole point of the interface is that the sky keeps turning while
 * the observation is being read.
 *
 * The luminance buffer is transferred rather than copied, so the caller loses its
 * reference -- see `client.ts`, which owns that contract.
 */
import * as Comlink from 'comlink';
import { detectSources } from './detector';
import type { DetectionParams, DetectionResult, LuminanceImage } from './types';

export interface DetectRequest {
  /** Raw luminance plane. Transferred, not copied. */
  buffer: ArrayBuffer;
  width: number;
  height: number;
  params?: Partial<DetectionParams>;
  frame?: number;
}

const api = {
  detect({ buffer, width, height, params, frame = 0 }: DetectRequest): DetectionResult {
    const image: LuminanceImage = { data: new Float32Array(buffer), width, height };
    return detectSources(image, params ?? {}, frame);
  },

  /**
   * Detects across a sequence of frames in one call, so a video pass does not pay
   * a round trip per frame.
   */
  detectBatch(requests: DetectRequest[]): DetectionResult[] {
    return requests.map((r) => api.detect(r));
  },
};

export type DetectorApi = typeof api;

Comlink.expose(api);
