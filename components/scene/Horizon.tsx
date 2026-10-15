'use client';

/**
 * The observer's own frame: horizon, cardinal points and coordinate grids.
 *
 * These sit outside the rotating sky group. They belong to the ground, not to the
 * celestial sphere, and keeping that distinction structural -- rather than
 * remembering to counter-rotate them -- is what stops the horizon from drifting
 * as the night goes on.
 */
import { useEffect, useMemo } from 'react';
import { Billboard, Text } from '@react-three/drei';
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments } from 'three';
import { DEG, SKY_RADIUS, altAzToScenePoint } from '@/lib/astro/frames';

/** Builds a line-segment object from a list of alt/az polylines. */
function polylineObject(
  polylines: { altitude: number; azimuth: number }[][],
  color: string,
  opacity: number,
  radius = SKY_RADIUS,
): LineSegments {
  let segments = 0;
  for (const line of polylines) segments += Math.max(0, line.length - 1);

  const positions = new Float32Array(segments * 6);
  let p = 0;
  for (const line of polylines) {
    for (let i = 0; i < line.length - 1; i++) {
      for (const point of [line[i], line[i + 1]]) {
        const v = altAzToScenePoint(point, radius);
        positions[p++] = v.x;
        positions[p++] = v.y;
        positions[p++] = v.z;
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.boundingSphere = null;

  const object = new LineSegments(
    geometry,
    new LineBasicMaterial({ color: new Color(color), transparent: true, opacity, depthWrite: false }),
  );
  object.frustumCulled = false;
  return object;
}

function circleAtAltitude(altitude: number, step = 2): { altitude: number; azimuth: number }[] {
  const points = [];
  for (let az = 0; az <= 360; az += step) points.push({ altitude, azimuth: az });
  return points;
}

function meridianAtAzimuth(azimuth: number, step = 2): { altitude: number; azimuth: number }[] {
  const points = [];
  for (let alt = -90; alt <= 90; alt += step) points.push({ altitude: alt, azimuth });
  return points;
}

export interface HorizonProps {
  show: boolean;
  cardinals: boolean;
  altAzGrid: boolean;
  opacity?: number;
}

const CARDINALS: { label: string; azimuth: number; major: boolean }[] = [
  { label: 'N', azimuth: 0, major: true },
  { label: 'NE', azimuth: 45, major: false },
  { label: 'E', azimuth: 90, major: true },
  { label: 'SE', azimuth: 135, major: false },
  { label: 'S', azimuth: 180, major: true },
  { label: 'SW', azimuth: 225, major: false },
  { label: 'W', azimuth: 270, major: true },
  { label: 'NW', azimuth: 315, major: false },
];

export function Horizon({ show, cardinals, altAzGrid, opacity = 1 }: HorizonProps) {
  const horizonLine = useMemo(() => polylineObject([circleAtAltitude(0, 1)], '#3f7f86', 0.85), []);

  // Tick marks every 10 degrees of azimuth, longer on the cardinals. A bare
  // circle tells you where the ground is; ticks let you read a bearing off it.
  const ticks = useMemo(() => {
    const lines: { altitude: number; azimuth: number }[][] = [];
    for (let az = 0; az < 360; az += 10) {
      const major = az % 90 === 0;
      const length = major ? 3.2 : az % 30 === 0 ? 1.8 : 1;
      lines.push([
        { altitude: -length, azimuth: az },
        { altitude: length * 0.35, azimuth: az },
      ]);
    }
    return polylineObject(lines, '#3f7f86', 0.6);
  }, []);

  const grid = useMemo(() => {
    const lines: { altitude: number; azimuth: number }[][] = [];
    for (let alt = -60; alt <= 60; alt += 15) {
      if (alt !== 0) lines.push(circleAtAltitude(alt, 3));
    }
    for (let az = 0; az < 360; az += 15) lines.push(meridianAtAzimuth(az, 3));
    return polylineObject(lines, '#6d86c4', 0.16, SKY_RADIUS * 0.998);
  }, []);

  useEffect(
    () => () => {
      for (const o of [horizonLine, ticks, grid]) {
        o.geometry.dispose();
        (o.material as LineBasicMaterial).dispose();
      }
    },
    [horizonLine, ticks, grid],
  );

  useEffect(() => {
    (horizonLine.material as LineBasicMaterial).opacity = 0.85 * opacity;
    (ticks.material as LineBasicMaterial).opacity = 0.6 * opacity;
    (grid.material as LineBasicMaterial).opacity = 0.16 * opacity;
  }, [horizonLine, ticks, grid, opacity]);

  return (
    <group>
      {altAzGrid && <primitive object={grid} />}
      {show && (
        <>
          <primitive object={horizonLine} />
          <primitive object={ticks} />
        </>
      )}
      {cardinals &&
        CARDINALS.map(({ label, azimuth, major }) => {
          const p = altAzToScenePoint({ altitude: 4.5, azimuth }, SKY_RADIUS * 0.96);
          return (
            <Billboard key={label} position={[p.x, p.y, p.z]}>
              <Text
                fontSize={major ? 3.6 : 2.2}
                color={major ? '#7fd3cf' : '#4d8c92'}
                anchorX="center"
                anchorY="middle"
                fillOpacity={(major ? 0.95 : 0.6) * opacity}
                letterSpacing={0.14}
              >
                {label}
              </Text>
            </Billboard>
          );
        })}
    </group>
  );
}

/**
 * The celestial grid: right ascension and declination, drawn inside the rotating
 * sky group so it turns with the stars.
 */
export function EquatorialGrid({ opacity = 1 }: { opacity?: number }) {
  const object = useMemo(() => {
    const positions: number[] = [];
    const push = (ra: number, dec: number) => {
      const cd = Math.cos(dec);
      positions.push(cd * Math.cos(ra) * SKY_RADIUS, cd * Math.sin(ra) * SKY_RADIUS, Math.sin(dec) * SKY_RADIUS);
    };

    // Parallels of declination every 15 degrees, meridians every hour of RA.
    for (let decDeg = -75; decDeg <= 75; decDeg += 15) {
      const dec = decDeg * DEG;
      for (let raDeg = 0; raDeg < 360; raDeg += 3) {
        push(raDeg * DEG, dec);
        push((raDeg + 3) * DEG, dec);
      }
    }
    for (let hour = 0; hour < 24; hour++) {
      const ra = hour * 15 * DEG;
      for (let decDeg = -87; decDeg < 87; decDeg += 3) {
        push(ra, decDeg * DEG);
        push(ra, (decDeg + 3) * DEG);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.boundingSphere = null;
    const line = new LineSegments(
      geometry,
      new LineBasicMaterial({ color: new Color('#8f6dc4'), transparent: true, opacity: 0.14, depthWrite: false }),
    );
    line.frustumCulled = false;
    return line;
  }, []);

  useEffect(() => {
    (object.material as LineBasicMaterial).opacity = 0.14 * opacity;
  }, [object, opacity]);

  useEffect(
    () => () => {
      object.geometry.dispose();
      (object.material as LineBasicMaterial).dispose();
    },
    [object],
  );

  return <primitive object={object} />;
}
