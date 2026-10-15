'use client';

/**
 * Names for the brightest stars.
 *
 * Text is the expensive thing in this scene -- every label is a mesh -- so the
 * set is kept deliberately small and re-derived only when the magnitude cut or
 * the catalogue changes, never per frame.
 *
 * The wording matters as much as the count. These are predicted positions, so
 * the name is a catalogue designation for a place in the sky, not a claim that
 * the star was observed. Confirmed names look different, and only appear once
 * something has actually been matched.
 */
import { useMemo } from 'react';
import { Billboard, Text } from '@react-three/drei';
import { Vector3 } from 'three';
import type { StarCatalog } from '@/lib/astro/catalog';
import { SKY_RADIUS } from '@/lib/astro/frames';

export interface StarLabelsProps {
  catalog: StarCatalog;
  /** Only stars brighter than this are named. */
  magnitudeLimit: number;
  opacity?: number;
  max?: number;
}

export function StarLabels({ catalog, magnitudeLimit, opacity = 1, max = 60 }: StarLabelsProps) {
  const labels = useMemo(() => {
    const limit = Math.min(catalog.countBrighterThan(magnitudeLimit), catalog.count);
    const out: { index: number; name: string; position: Vector3; magnitude: number }[] = [];

    for (let i = 0; i < limit && out.length < max; i++) {
      const designation = catalog.designations.get(i);
      // Proper names only. A sky covered in Bayer letters is a chart, not a view.
      if (!designation?.proper) continue;
      out.push({
        index: i,
        name: designation.proper,
        magnitude: catalog.magnitudes[i],
        position: new Vector3(
          catalog.positions[i * 3],
          catalog.positions[i * 3 + 1],
          catalog.positions[i * 3 + 2],
        ).multiplyScalar(SKY_RADIUS * 0.995),
      });
    }
    return out;
  }, [catalog, magnitudeLimit, max]);

  return (
    <group>
      {labels.map((label) => (
        <Billboard key={label.index} position={[label.position.x, label.position.y, label.position.z]}>
          <Text
            position={[1.6, 1.0, 0]}
            fontSize={1.55}
            color="#b9c8ee"
            anchorX="left"
            anchorY="middle"
            fillOpacity={(label.magnitude < 1.5 ? 0.8 : 0.55) * opacity}
            letterSpacing={0.05}
            outlineWidth={0.05}
            outlineColor="#04060c"
          >
            {label.name}
          </Text>
        </Billboard>
      ))}
    </group>
  );
}
