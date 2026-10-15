/**
 * Main-thread handle on the plate-solve worker.
 *
 * Same shape as the detection client: one worker, created lazily, kept warm, with
 * an in-thread fallback that says so rather than pretending.
 */
import * as Comlink from 'comlink';
import { solvePlate, type SolveRequest } from './solve';
import type { SolverApi } from './solver.worker';
import type { SolveResult } from './types';

let worker: Worker | null = null;
let remote: Comlink.Remote<SolverApi> | null = null;

function ensureWorker(): Comlink.Remote<SolverApi> | null {
  if (remote) return remote;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
    remote = Comlink.wrap<SolverApi>(worker);
    return remote;
  } catch {
    worker = null;
    remote = null;
    return null;
  }
}

export interface SolveRun extends SolveResult {
  ranOnMainThread: boolean;
}

export async function solve(request: SolveRequest): Promise<SolveRun> {
  const api = ensureWorker();
  if (!api) return { ...solvePlate(request), ranOnMainThread: true };
  const result = await api.solve(request);
  return { ...result, ranOnMainThread: false };
}

/** Cancels an in-flight solve by discarding the worker running it. */
export function abortSolve(): void {
  worker?.terminate();
  worker = null;
  remote = null;
}
