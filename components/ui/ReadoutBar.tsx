'use client';

/**
 * The boresight readout: where the view is pointing, in both frames at once.
 *
 * Alt/az is where the observer would look. RA/dec is what is there. Showing both
 * simultaneously is what makes the two coordinate systems feel like one place
 * rather than two separate ideas, and it is how a user learns to read the sky
 * model rather than merely look at it.
 */
import { useMemo } from 'react';
import { Vector3 } from 'three';
import {
  altAzToVector,
  compassPoint,
  formatDec,
  formatDeg,
  formatRa,
  vectorToRaDec,
} from '@/lib/astro/frames';
import { constellationAt } from '@/lib/astro/predicted';
import { useOmniEye } from '@/lib/state/store';
import { Panel } from './primitives';

export function ReadoutBar() {
  const view = useOmniEye((s) => s.view);
  const sky = useOmniEye((s) => s.sky);

  const aim = useMemo(() => {
    const scene = altAzToVector({ altitude: view.altitude, azimuth: view.azimuth });
    if (!sky) return null;
    const eqj = scene.clone().applyMatrix3(sky.rotation.clone().invert());
    const { ra, dec } = vectorToRaDec(eqj);
    return { ra, dec, constellation: constellationAt(sky.rotation, scene) };
  }, [view.altitude, view.azimuth, sky]);

  return (
    <Panel className="pointer-events-auto flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2">
      <Readout label="alt" value={formatDeg(view.altitude, 2)} />
      <Readout
        label="az"
        value={`${formatDeg(view.azimuth, 2)}  ${compassPoint(view.azimuth)}`}
      />
      <span className="h-4 w-px bg-[var(--panel-edge)]" />
      <Readout label="ra" value={aim ? formatRa(aim.ra) : '—'} tone="var(--predicted)" />
      <Readout label="dec" value={aim ? formatDec(aim.dec) : '—'} tone="var(--predicted)" />
      <Readout label="in" value={aim ? aim.constellation.name : '—'} tone="var(--predicted)" />
      <span className="h-4 w-px bg-[var(--panel-edge)]" />
      <Readout label="field" value={formatDeg(view.fovDeg, 1)} tone="var(--text-dim)" />
    </Panel>
  );
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex items-baseline gap-2 whitespace-nowrap">
      <span className="label-caps">{label}</span>
      <span className="readout text-[12.5px]" style={{ color: tone ?? 'var(--text)' }}>
        {value}
      </span>
    </span>
  );
}

/** Where the camera is aimed, as a scene-space unit vector. */
export function aimVector(view: { altitude: number; azimuth: number }): Vector3 {
  return altAzToVector(view);
}
