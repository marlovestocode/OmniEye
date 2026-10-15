'use client';

/**
 * Deep-sky objects.
 *
 * These are where the unconfirmed cell of the evidence grid earns its keep.
 * Galaxies and nebulae are extended, faint, and almost always below a phone's
 * detection floor -- so they get predicted, placed correctly at their true
 * angular size, and marked as prediction only. Never a rendered thumbnail, and
 * never anything that could be read as "this was captured".
 *
 * The marker is a hollow ellipse sized by the object's real angular extent, with
 * a floor so a small planetary nebula is still clickable. Hollow is the point: a
 * filled shape reads as an image, an outline reads as an annotation.
 */
import { useEffect, useMemo } from 'react';
import { Billboard, Text } from '@react-three/drei';
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments, Vector3 } from 'three';
import type { DeepSkyCatalog, DeepSkyObject } from '@/lib/astro/catalog';
import { DEG, SKY_RADIUS, raDecToVector } from '@/lib/astro/frames';

const ARCMIN_TO_SCENE = (arcmin: number) => SKY_RADIUS * Math.tan((arcmin / 60) * DEG);

/** Local tangent basis at a direction: north and east on the sky. */
function tangentBasis(direction: Vector3): { north: Vector3; east: Vector3 } {
  const north = new Vector3(0, 0, 1).addScaledVector(direction, -direction.z);
  if (north.lengthSq() < 1e-9) north.set(1, 0, 0);
  north.normalize();
  const east = new Vector3().crossVectors(north, direction).normalize();
  return { north, east };
}

export interface DeepSkyProps {
  catalog: DeepSkyCatalog;
  magnitudeLimit: number;
  labels: boolean;
  opacity?: number;
  /** Objects with a label drawn. Kept small: text is the expensive part. */
  labelLimit?: number;
}

export function DeepSky({ catalog, magnitudeLimit, labels, opacity = 1, labelLimit = 24 }: DeepSkyProps) {
  const visible = useMemo(
    () =>
      catalog.objects.filter(
        (o) => o.magnitude !== null && o.magnitude <= magnitudeLimit && (o.majorArcmin ?? 0) > 0,
      ),
    [catalog, magnitudeLimit],
  );

  const outlines = useMemo(() => {
    const positions: number[] = [];
    const direction = new Vector3();

    for (const object of visible) {
      raDecToVector(object.ra, object.dec, direction).normalize();
      const { north, east } = tangentBasis(direction);

      // Minimum size so a compact object is still a target, not a dot.
      const major = Math.max(ARCMIN_TO_SCENE((object.majorArcmin ?? 2) / 2), SKY_RADIUS * 0.0035);
      const minor = Math.max(
        ARCMIN_TO_SCENE(((object.minorArcmin ?? object.majorArcmin ?? 2) / 2)),
        SKY_RADIUS * 0.0035,
      );
      // Position angle is measured from north through east.
      const pa = (object.positionAngle ?? 0) * DEG;

      const steps = 28;
      let prev: Vector3 | null = null;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const a = Math.cos(t) * major;
        const b = Math.sin(t) * minor;
        // Rotate the ellipse into position angle, then lift to the sphere.
        const alongNorth = a * Math.cos(pa) - b * Math.sin(pa);
        const alongEast = a * Math.sin(pa) + b * Math.cos(pa);
        const point = direction
          .clone()
          .multiplyScalar(SKY_RADIUS)
          .addScaledVector(north, alongNorth)
          .addScaledVector(east, alongEast);
        if (prev) positions.push(prev.x, prev.y, prev.z, point.x, point.y, point.z);
        prev = point;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.boundingSphere = null;

    const object = new LineSegments(
      geometry,
      new LineBasicMaterial({ color: new Color('#8aa2ff'), transparent: true, opacity: 0.4, depthWrite: false }),
    );
    object.frustumCulled = false;
    object.renderOrder = 2;
    return object;
  }, [visible]);

  useEffect(() => {
    (outlines.material as LineBasicMaterial).opacity = 0.4 * opacity;
  }, [outlines, opacity]);

  useEffect(
    () => () => {
      outlines.geometry.dispose();
      (outlines.material as LineBasicMaterial).dispose();
    },
    [outlines],
  );

  // Label only the objects a viewer would actually be looking for.
  const labelled = useMemo(
    () =>
      visible
        .filter((o) => o.name !== null || /^M\d+$/.test(o.id))
        .sort((a, b) => (a.magnitude ?? 99) - (b.magnitude ?? 99))
        .slice(0, labelLimit),
    [visible, labelLimit],
  );

  return (
    <group>
      <primitive object={outlines} />
      {labels &&
        labelled.map((object) => <DeepSkyLabel key={object.id} object={object} opacity={opacity} />)}
    </group>
  );
}

function DeepSkyLabel({ object, opacity }: { object: DeepSkyObject; opacity: number }) {
  const position = useMemo(
    () => raDecToVector(object.ra, object.dec).normalize().multiplyScalar(SKY_RADIUS * 0.997),
    [object.ra, object.dec],
  );
  const offset = Math.max(ARCMIN_TO_SCENE((object.majorArcmin ?? 4) / 2), SKY_RADIUS * 0.004) + 1.2;

  return (
    <Billboard position={[position.x, position.y, position.z]}>
      <Text
        position={[0, -offset, 0]}
        fontSize={1.45}
        color="#8aa2ff"
        anchorX="center"
        anchorY="top"
        fillOpacity={0.62 * opacity}
        letterSpacing={0.06}
        outlineWidth={0.05}
        outlineColor="#04060c"
      >
        {object.id}
      </Text>
    </Billboard>
  );
}
