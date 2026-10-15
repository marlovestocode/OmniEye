/**
 * Main-thread handle on the detection worker.
 *
 * One worker, created lazily and kept alive: spinning one up costs more than most
 * single detections, and a video pass wants it warm anyway.
 *
 * Falls back to running in-thread when workers are unavailable (server render,
 * or a browser that refuses one). The fallback is correct but will stutter, so it
 * says so in the returned result rather than hiding it.
 */
import * as Comlink from 'comlink';
import { detectSources } from './detector';
import type { DetectorApi } from './detector.worker';
import type { DetectionParams, DetectionResult, LuminanceImage } from './types';

let worker: Worker | null = null;
let remote: Comlink.Remote<DetectorApi> | null = null;

function ensureWorker(): Comlink.Remote<DetectorApi> | null {
  if (remote) return remote;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
    remote = Comlink.wrap<DetectorApi>(worker);
    return remote;
  } catch {
    worker = null;
    remote = null;
    return null;
  }
}

export interface DetectionRun extends DetectionResult {
  /** True when the worker was unavailable and this ran on the main thread. */
  ranOnMainThread: boolean;
}

/**
 * Runs detection on a luminance plane.
 *
 * The buffer is transferred to the worker, so `image.data` is detached when this
 * returns. Callers that still need the pixels should pass a copy -- being
 * explicit about it beats copying every megabyte defensively.
 */
export async function detect(
  image: LuminanceImage,
  params: Partial<DetectionParams> = {},
  frame = 0,
): Promise<DetectionRun> {
  const api = ensureWorker();

  if (!api) {
    return { ...detectSources(image, params, frame), ranOnMainThread: true };
  }

  const buffer = image.data.buffer as ArrayBuffer;
  const result = await api.detect(
    Comlink.transfer({ buffer, width: image.width, height: image.height, params, frame }, [buffer]),
  );
  return { ...result, ranOnMainThread: false };
}

/** Releases the worker. Worth calling when leaving observation mode for good. */
export function disposeDetector(): void {
  worker?.terminate();
  worker = null;
  remote = null;
}
