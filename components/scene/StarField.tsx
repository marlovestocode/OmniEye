'use client';

/**
 * The star field.
 *
 * One draw call for fifteen thousand stars. The positions are J2000 unit vectors
 * uploaded once and never touched again; the sky turns because the parent group's
 * quaternion turns. Rewriting vertices every frame to make the sky rotate would
 * be doing on the CPU what the vertex stage does for free.
 *
 * Magnitude reaches the GPU as an attribute so the shader can do three jobs the
 * CPU would otherwise have to redo on every change: size a star by its
 * brightness, fade it out smoothly as it approaches the magnitude limit rather
 * than letting it pop, and dim it towards the horizon by the airmass it is seen
 * through.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import type { StarCatalog } from '@/lib/astro/catalog';
import { SKY_RADIUS } from '@/lib/astro/frames';

const vertexShader = /* glsl */ `
  attribute float aMagnitude;
  attribute vec3 aColor;

  uniform float uMagnitudeLimit;
  uniform float uPointScale;
  uniform float uPixelRatio;
  uniform float uExtinction;   // magnitudes of extinction at one airmass
  uniform float uHorizonFade;  // 0 draws below the horizon, 1 hides it

  varying vec3 vColor;
  varying float vIntensity;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 viewPos = viewMatrix * world;
    gl_Position = projectionMatrix * viewPos;

    // Altitude follows straight from the scene frame: +Y is the zenith.
    float sinAlt = normalize(world.xyz).y;

    // Airmass by the plane-parallel approximation, capped where it stops being
    // meaningful. Below the horizon this is irrelevant -- the fade has already
    // taken over.
    float airmass = 1.0 / max(sinAlt, 0.05);
    float extinguished = aMagnitude + uExtinction * (min(airmass, 8.0) - 1.0);

    // Flux relative to the faintest star drawn: 1.0 at the limit, 100x at five
    // magnitudes brighter.
    float flux = pow(10.0, -0.4 * (extinguished - uMagnitudeLimit));

    // Radius grows far more slowly than flux, the way a real star image does.
    // Without that compression Sirius would be a dinner plate.
    float radius = uPointScale * pow(max(flux, 0.0001), 0.22);
    gl_PointSize = clamp(radius, 1.0, 26.0) * uPixelRatio;

    // Fade across the last magnitude so the limit slider glides instead of
    // snapping whole populations in and out.
    float limitFade = smoothstep(0.0, 1.0, uMagnitudeLimit - extinguished + 1.0);

    // Below the horizon the ground is in the way. Kept as a soft edge so the
    // horizon reads as atmosphere rather than as a clipping plane.
    float horizon = mix(1.0, smoothstep(-0.015, 0.035, sinAlt), uHorizonFade);

    vIntensity = clamp(pow(max(flux, 0.0), 0.32) * 0.85, 0.0, 1.0) * limitFade * horizon;
    vColor = aColor;
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;

  uniform float uOpacity;

  varying vec3 vColor;
  varying float vIntensity;

  void main() {
    // Round sprite with a soft core, generated rather than textured: no image to
    // load, and it stays crisp at any device pixel ratio.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;

    float core = pow(1.0 - r, 2.2);
    float halo = pow(1.0 - r, 6.0) * 0.5;
    float alpha = clamp((core + halo) * vIntensity, 0.0, 1.0) * uOpacity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(vColor, alpha);
  }
`;

export interface StarFieldProps {
  catalog: StarCatalog;
  magnitudeLimit: number;
  /** Dim stars towards the horizon by atmospheric extinction. */
  atmosphere: boolean;
  /** Overall brightness, for the media-versus-model opacity slider. */
  opacity?: number;
}

export function StarField({ catalog, magnitudeLimit, atmosphere, opacity = 1 }: StarFieldProps) {
  const points = useRef<Points>(null);
  const { size, viewport } = useThree();

  const geometry = useMemo(() => {
    const g = new BufferGeometry();

    // Positions are the catalogue's unit vectors pushed out to the drawing
    // radius. Built once; the sky moves by rotating the parent.
    const positions = new Float32Array(catalog.count * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = catalog.positions[i] * SKY_RADIUS;

    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('aMagnitude', new BufferAttribute(catalog.magnitudes, 1));
    g.setAttribute('aColor', new BufferAttribute(catalog.colors, 3));
    // Frustum culling on a sphere centred on the camera only ever gets it wrong.
    g.boundingSphere = null;
    return g;
  }, [catalog]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        // Stars add light; they never occlude each other.
        blending: AdditiveBlending,
        uniforms: {
          uMagnitudeLimit: { value: magnitudeLimit },
          uPointScale: { value: 2.4 },
          uPixelRatio: { value: 1 },
          uExtinction: { value: atmosphere ? 0.22 : 0 },
          uHorizonFade: { value: 1 },
          uOpacity: { value: opacity },
        },
      }),
    // Uniforms are updated in place below; rebuilding the material per change
    // would recompile the shader for a slider drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => material.dispose(), [material]);

  // Draw range rather than a filter: the catalogue is sorted brightest-first, so
  // a magnitude limit is simply "how many of the leading records to draw".
  const drawCount = useMemo(
    () => catalog.countBrighterThan(magnitudeLimit + 1),
    [catalog, magnitudeLimit],
  );

  useFrame(() => {
    material.uniforms.uMagnitudeLimit.value = magnitudeLimit;
    material.uniforms.uOpacity.value = opacity;
    material.uniforms.uExtinction.value = atmosphere ? 0.22 : 0;
    material.uniforms.uPixelRatio.value = Math.min(viewport.dpr ?? 1, 2);
    // A narrower field magnifies everything, including stars.
    material.uniforms.uPointScale.value = 2.4 * Math.min(2.5, Math.max(0.7, 900 / Math.max(size.height, 1)) + 0.4);
    if (points.current) points.current.geometry.setDrawRange(0, drawCount);
  });

  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}

/** Kept for callers that want the same size curve outside the shader. */
export function apparentStarRadius(magnitude: number, limit: number, scale = 2.4): number {
  const flux = Math.pow(10, -0.4 * (magnitude - limit));
  return Math.min(26, Math.max(1, scale * Math.pow(Math.max(flux, 1e-4), 0.22)));
}
