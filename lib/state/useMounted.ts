'use client';

import { useSyncExternalStore } from 'react';

/**
 * True once the component has mounted in the browser.
 *
 * OmniEye is entirely a client application: the observer's clock, their
 * location, a WebGL canvas and a file on their disk. None of that exists during
 * a prerender, and the current time in particular differs between the server and
 * the browser a moment later -- which React correctly reports as a hydration
 * mismatch.
 *
 * Expressed as an external store rather than a state-in-effect flag: the server
 * snapshot is false, the client snapshot is true, and nothing ever changes after
 * hydration, so there is no subscription and no cascading render.
 */
const noop = () => () => {};

export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
