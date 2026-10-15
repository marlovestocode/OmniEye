'use client';

/**
 * Sun, Moon and planets.
 *
 * Nine objects, so they can be React components with real geometry -- unlike the
 * stars, which have to be one buffer. They live inside the rotating sky group in
 * the same EQJ frame as the catalogue, which is what keeps them locked to the
 * star field rather than swimming against it.
 *
 * Everything here is predicted. A planet is drawn at its computed position and
 * labelled with a hedge, because until the matching layer binds it to a detected
 * source the app has no evidence it was visible at all -- it may have been behind
 * a cloud, or below the detection floor, or the frame may not cover it.
 */
import { useMemo } from 'react';
import { Billboard, Text } from '@react-three/drei';
import { AdditiveBlending, DoubleSide, Vector3 } from 'three';
import { DEG, SKY_RADIUS } from '@/lib/astro/frames';
import type { SolarBodyState } from '@/lib/astro/solar';

/** Rough colours, chosen to be recognisable rather than photometric. */
const BODY_TINT: Record<string, string> = {
  Sun: '#ffe9a8',
  Moon: '#e8ecf5',
  Mercury: '#c9c2b4',
  Venus: '#fff2d0',
  Mars: '#ff9b76',
  Jupiter: '#ffd9a8',
  Saturn: '#f2dda6',
  Uranus: '#aee6ee',
  Neptune: '#9fb8ff',
};

/**
 * How large to draw a body.
 *
 * Honest angular size would make every planet a sub-pixel dot: Jupiter is half an
 * arcminute across, which at a 60 degree field is under a pixel. So planets are
 * drawn at a legible minimum and their true angular diameter is reported as a
 * number in the inspector instead of being faked as a size. The Sun and Moon are
 * the exception -- both are about half a degree, genuinely visible, and drawn at
 * their real size.
 */
function drawRadius(body: SolarBodyState, fovDeg: number): number {
  const trueRadius = SKY_RADIUS * Math.tan((body.angularDiameterArcmin / 120) * DEG);
  if (body.kind === 'sun' || body.kind === 'moon') return trueRadius;
  // Scale the floor with the field so a zoomed-in view does not turn Jupiter
  // into a balloon.
  const floor = SKY_RADIUS * Math.tan(((fovDeg / 90) * 0.16) * DEG);
  return Math.max(trueRadius, floor);
}

export interface SolarSystemProps {
  bodies: SolarBodyState[];
  fovDeg: number;
  labels: boolean;
  opacity?: number;
}

export function SolarSystem({ bodies, fovDeg, labels, opacity = 1 }: SolarSystemProps) {
  return (
    <group>
      {bodies.map((body) => (
        <Body key={body.name} body={body} fovDeg={fovDeg} labels={labels} opacity={opacity} />
      ))}
    </group>
  );
}

function Body({
  body,
  fovDeg,
  labels,
  opacity,
}: {
  body: SolarBodyState;
  fovDeg: number;
  labels: boolean;
  opacity: number;
}) {
  const position = useMemo(
    () => new Vector3().copy(body.direction).multiplyScalar(SKY_RADIUS * 0.999),
    [body.direction],
  );
  const radius = drawRadius(body, fovDeg);
  const tint = BODY_TINT[body.name] ?? '#ffffff';

  // Below the horizon a body is behind the ground. It stays in the scene at
  // reduced strength rather than vanishing, so scrubbing time reads as motion
  // instead of as objects blinking out.
  const belowHorizon = body.altAz.altitude < 0;
  const strength = (belowHorizon ? 0.18 : 1) * opacity;

  return (
    <group position={position}>
      <Billboard>
        {/* Disc */}
        <mesh renderOrder={2}>
          <circleGeometry args={[radius, 48]} />
          <meshBasicMaterial color={tint} transparent opacity={0.92 * strength} side={DoubleSide} depthWrite={false} />
        </mesh>

        {/* The unlit portion of a phase, drawn as a shadow cap offset towards the
            dark limb. Approximate -- a real terminator is an ellipse -- but it
            gets the orientation right, which is the part a viewer checks. */}
        {body.kind !== 'sun' && body.illuminatedFraction < 0.97 && (
          <mesh
            renderOrder={3}
            position={shadowOffset(body, radius)}
          >
            <circleGeometry args={[radius * 1.02, 48]} />
            <meshBasicMaterial color="#04060c" transparent opacity={0.88 * strength} depthWrite={false} />
          </mesh>
        )}

        {/* Glow, so a bright planet still reads at a wide field where its disc is
            only a few pixels. */}
        <mesh renderOrder={1}>
          <circleGeometry args={[radius * 4.5, 32]} />
          <meshBasicMaterial
            color={tint}
            transparent
            opacity={0.1 * strength}
            blending={AdditiveBlending}
            depthWrite={false}
          />
        </mesh>

        {labels && (
          <Text
            position={[0, -radius - 2.4, 0]}
            fontSize={2.0}
            color={tint}
            anchorX="center"
            anchorY="top"
            fillOpacity={0.75 * strength}
            letterSpacing={0.08}
            outlineWidth={0.06}
            outlineColor="#04060c"
          >
            {body.name.toUpperCase()}
          </Text>
        )}
      </Billboard>
    </group>
  );
}

/**
 * Where to put the shadow cap for a given phase.
 *
 * `brightLimbAngle` is measured east of north on the sky. In the billboard's
 * local frame, up is roughly celestial north, so the dark side lies opposite the
 * bright limb.
 */
function shadowOffset(body: SolarBodyState, radius: number): [number, number, number] {
  const dark = (body.brightLimbAngle + 180) * DEG;
  // Offset grows as the lit fraction shrinks: at half phase the cap sits on the
  // limb, at new it covers the disc entirely.
  const distance = radius * (2 * body.illuminatedFraction) * 0.98;
  return [Math.sin(dark) * distance, Math.cos(dark) * distance, 0.01];
}
