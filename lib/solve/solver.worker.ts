/**
 * Plate-solve worker.
 *
 * A blind solve tests hundreds of thousands of hypotheses and can run for
 * seconds. On the main thread that would freeze the sky mid-rotation, which is
 * exactly the wrong impression to give while the app is deciding whether it can
 * identify anything.
 *
 * Both sides speak plain data -- packed numbers and string ids -- so nothing
 * three.js-shaped has to survive the structured clone.
 */
import * as Comlink from 'comlink';
import { solvePlate, type SolveRequest } from './solve';
import type { SolveResult } from './types';

const api = {
  solve(request: SolveRequest): SolveResult {
    return solvePlate(request);
  },
};

export type SolverApi = typeof api;

Comlink.expose(api);
