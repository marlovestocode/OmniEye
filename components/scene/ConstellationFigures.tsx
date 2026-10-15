'use client';

/**
 * Constellation figures.
 *
 * The Stellarium sky culture stores figures as polylines of HIP numbers, which
 * the catalogue build resolves to indices into the same star buffer the field is
 * drawn from. The lines therefore land exactly on the stars they connect -- not
 * near them -- because they are literally reading the same positions.
 *
 * Drawn thin and cool: these are part of the predicted layer, a naming convention
 * laid over the sky rather than anything detected in it.
 */
import { useEffect, useMemo } from 'react';
import { AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three';
import type { ConstellationSet, StarCatalog } from '@/lib/astro/catalog';
import { SKY_RADIUS } from '@/lib/astro/frames';

export interface ConstellationFiguresProps {
  catalog: StarCatalog;
  constellations: ConstellationSet;
  opacity?: number;
  /** When set, only this constellation is drawn at full strength. */
  highlight?: string | null;
}

export function ConstellationFigures({
  catalog,
  constellations,
  opacity = 1,
  highlight = null,
}: ConstellationFiguresProps) {
  const { geometry, material } = useMemo(() => {
    // Each polyline of n vertices becomes n-1 segments, flattened into one
    // buffer so all 88 figures cost a single draw call.
    let segments = 0;
    for (const figure of constellations.figures) {
      for (const line of figure.lines) segments += Math.max(0, line.length - 1);
    }

    const positions = new Float32Array(segments * 6);
    const alphas = new Float32Array(segments * 2);
    let p = 0;
    let a = 0;

    for (const figure of constellations.figures) {
      const strength = highlight === null || figure.abbrev === highlight ? 1 : 0.22;
      for (const line of figure.lines) {
        for (let i = 0; i < line.length - 1; i++) {
          for (const index of [line[i], line[i + 1]]) {
            positions[p++] = catalog.positions[index * 3] * SKY_RADIUS;
            positions[p++] = catalog.positions[index * 3 + 1] * SKY_RADIUS;
            positions[p++] = catalog.positions[index * 3 + 2] * SKY_RADIUS;
            alphas[a++] = strength;
          }
        }
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('aStrength', new BufferAttribute(alphas, 1));
    g.boundingSphere = null;

    const m = new LineBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      color: 0x8aa2ff,
    });

    // Fade the figures below the horizon the same way the stars fade, so a
    // figure does not hang in the ground.
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uOpacity = { value: opacity };
      m.userData.shader = shader;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aStrength;
           varying float vFade;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec4 wp = modelMatrix * vec4(position, 1.0);
           float sinAlt = normalize(wp.xyz).y;
           vFade = aStrength * smoothstep(-0.02, 0.06, sinAlt);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uOpacity;
           varying float vFade;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
           gl_FragColor.a *= vFade * uOpacity * 0.5;`,
        );
    };

    return { geometry: g, material: m };
  }, [catalog, constellations, highlight, opacity]);

  useEffect(() => {
    const shader = material.userData.shader;
    if (shader) shader.uniforms.uOpacity.value = opacity;
  }, [material, opacity]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const object = useMemo(() => new LineSegments(geometry, material), [geometry, material]);
  object.frustumCulled = false;
  object.renderOrder = 0;

  return <primitive object={object} />;
}
