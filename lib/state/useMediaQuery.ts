'use client';

import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query.
 *
 * Used to choose between two genuinely different layouts rather than to restyle
 * one: the desktop shell floats panels over the sky in columns, the compact shell
 * stacks them behind a bottom sheet. Rendering both and hiding one with CSS would
 * mount every panel twice -- including the canvas-backed source overlay -- so the
 * branch is made in JS and each panel exists exactly once.
 *
 * The server snapshot is `false`. That is safe here because the shell does not
 * render anything layout-dependent until it has mounted in the browser.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below Tailwind's `md` breakpoint: a phone, or a narrow window. */
export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 767.98px)');
}
