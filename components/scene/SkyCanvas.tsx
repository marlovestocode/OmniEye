'use client';

/**
 * The 3D scene.
 *
 * The observer sits at the origin and looks out at the inside of the celestial
 * sphere. Everything with a celestial position lives inside `SkyRig`, a single
 * group whose quaternion carries the EQJ -> SCENE rotation; everything belonging
 * to the ground -- horizon, cardinals, the alt/az grid -- sits outside it. That
 * split is why the horizon stays put while the sky turns, without anything having
 * to remember to counter-rotate.
 *
 * Camera control is written by hand rather than taken from OrbitControls, because
 * orbiting is the wrong verb. Standing under the sky you change where you are
 * looking, and the horizon never tilts. So drag maps to altitude and azimuth,
 * roll is structurally impossible, and the wheel changes field of view rather
 * than distance.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Group, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { SKY_RADIUS, altAzToVector, vectorToAltAz, type AltAz } from '@/lib/astro/frames';
import type { Catalogs } from '@/lib/astro/catalog';
import type { PredictedSky } from '@/lib/astro/predicted';
import { useOmniEye } from '@/lib/state/store';
import { StarField } from './StarField';
import { ConstellationFigures } from './ConstellationFigures';
import { DeepSky } from './DeepSky';
import { EquatorialGrid, Horizon } from './Horizon';
import { SolarSystem } from './SolarSystem';
import { StarLabels } from './StarLabels';

/** Clamps a view so the camera can never flip over the zenith. */
const clampAltitude = (a: number) => Math.max(-88, Math.min(88, a));
const wrapAzimuth = (a: number) => ((a % 360) + 360) % 360;

/**
 * Points the camera at an altitude and azimuth with no roll.
 *
 * Interpolated rather than snapped, so that navigating to a target reads as the
 * instrument swinging round to it -- the design asks for camera motion to mean
 * something, and a jump means nothing.
 */
function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const view = useOmniEye((s) => s.view);
  const setView = useOmniEye((s) => s.setView);

  const target = useRef<AltAz & { fovDeg: number }>({
    altitude: view.altitude,
    azimuth: view.azimuth,
    fovDeg: view.fovDeg,
  });
  // Built from the same props rather than by reading `target.current`, which
  // would be a ref access during render.
  const current = useRef({ altitude: view.altitude, azimuth: view.azimuth, fovDeg: view.fovDeg });
  const dragging = useRef<{ x: number; y: number } | null>(null);

  // Store is the source of truth for where the camera is aimed; this keeps the
  // smoothing target in step when something else moves it (a navigation, a
  // preset, a restored observation).
  useEffect(() => {
    target.current = { altitude: view.altitude, azimuth: view.azimuth, fovDeg: view.fovDeg };
  }, [view.altitude, view.azimuth, view.fovDeg]);

  // Every finger currently down, so a second one can turn the drag into a pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; fovDeg: number } | null>(null);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = useCallback((event: PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    (event.target as Element).setPointerCapture?.(event.pointerId);

    if (pointers.current.size === 2) {
      // Second finger: stop panning and start measuring the gap between them.
      dragging.current = null;
      pinch.current = { distance: Math.max(spread(), 1), fovDeg: target.current.fovDeg };
    } else if (pointers.current.size === 1) {
      dragging.current = { x: event.clientX, y: event.clientY };
    }
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pinch.current && pointers.current.size >= 2) {
        // Fingers apart narrows the field (zoom in); together widens it. The
        // ratio is taken against the gap when the pinch began, so it is stable
        // however far apart the fingers happened to land.
        const next = pinch.current.fovDeg * (pinch.current.distance / Math.max(spread(), 1));
        target.current.fovDeg = Math.max(4, Math.min(120, next));
        setView({ fovDeg: target.current.fovDeg });
        return;
      }

      const start = dragging.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      dragging.current = { x: event.clientX, y: event.clientY };

      // Scale with field of view so a drag moves the same amount of *sky*
      // regardless of zoom. Without this, a narrow field feels glued and a wide
      // one feels frictionless.
      const perPixel = target.current.fovDeg / Math.max(gl.domElement.clientHeight, 1);
      target.current.azimuth = wrapAzimuth(target.current.azimuth - dx * perPixel);
      target.current.altitude = clampAltitude(target.current.altitude + dy * perPixel);
    },
    [gl, setView],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent) => {
      if (!pointers.current.delete(event.pointerId)) return;
      (event.target as Element).releasePointerCapture?.(event.pointerId);

      if (pointers.current.size === 1) {
        // One finger lifted mid-pinch: carry on panning with the other, from
        // where it is now, so the view does not jump.
        const [rest] = [...pointers.current.values()];
        pinch.current = null;
        dragging.current = { x: rest.x, y: rest.y };
      } else if (pointers.current.size === 0) {
        pinch.current = null;
        dragging.current = null;
      }

      setView({
        altitude: target.current.altitude,
        azimuth: target.current.azimuth,
        fovDeg: target.current.fovDeg,
      });
    },
    [setView],
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      const next = target.current.fovDeg * Math.exp(event.deltaY * 0.0012);
      target.current.fovDeg = Math.max(4, Math.min(120, next));
      setView({ fovDeg: target.current.fovDeg });
    },
    [setView],
  );

  useEffect(() => {
    const el = gl.domElement;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl, onPointerDown, onPointerMove, onPointerUp, onWheel]);

  const lookAt = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const smoothing = 1 - Math.pow(0.0015, delta);
    const t = target.current;
    const c = current.current;

    // Azimuth wraps, so interpolate along the shorter arc rather than the long
    // way round through zero.
    const dAz = ((t.azimuth - c.azimuth + 540) % 360) - 180;
    c.azimuth = wrapAzimuth(c.azimuth + dAz * smoothing);
    c.altitude += (t.altitude - c.altitude) * smoothing;
    c.fovDeg += (t.fovDeg - c.fovDeg) * smoothing;

    altAzToVector({ altitude: c.altitude, azimuth: c.azimuth }, lookAt).multiplyScalar(SKY_RADIUS);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, 0);
    camera.lookAt(lookAt);
    if (Math.abs(camera.fov - c.fovDeg) > 1e-4) {
      camera.fov = c.fovDeg;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

/** The rotating celestial sphere: everything with a catalogue position. */
function SkyRig({ sky, children }: { sky: PredictedSky; children: React.ReactNode }) {
  const group = useRef<Group>(null);
  const target = useMemo(() => new Quaternion(), []);

  useFrame((_, delta) => {
    if (!group.current) return;
    target.copy(sky.orientation);
    // Slerp rather than assign, so scrubbing time reads as the sky turning
    // instead of teleporting.
    group.current.quaternion.slerp(target, 1 - Math.pow(0.0001, delta));
  });

  useEffect(() => {
    group.current?.quaternion.copy(sky.orientation);
    // Only on mount: after this the frame loop eases towards each new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <group ref={group}>{children}</group>;
}

export interface SkyCanvasProps {
  catalogs: Catalogs;
  sky: PredictedSky;
  /** Layer 1 opacity. Drops to zero when Predicted is switched off. */
  predictedOpacity: number;
}

export function SkyCanvas({ catalogs, sky, predictedOpacity }: SkyCanvasProps) {
  const scene = useOmniEye((s) => s.scene);
  const fovDeg = useOmniEye((s) => s.view.fovDeg);

  return (
    <Canvas
      // The camera lives at the origin inside a radius-100 sphere, so the near
      // plane has to be tiny and the far plane just past the shell.
      camera={{ fov: fovDeg, near: 0.1, far: SKY_RADIUS * 2, position: [0, 0, 0] }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      style={{ background: 'var(--ink)', touchAction: 'none', cursor: 'grab' }}
      frameloop="always"
    >
      <CameraRig />

      <SkyRig sky={sky}>
        {scene.equatorialGrid && <EquatorialGrid opacity={predictedOpacity} />}
        {scene.constellations && (
          <ConstellationFigures
            catalog={catalogs.stars}
            constellations={catalogs.constellations}
            opacity={predictedOpacity}
          />
        )}
        <StarField
          catalog={catalogs.stars}
          magnitudeLimit={scene.magnitudeLimit}
          atmosphere={scene.atmosphere}
          opacity={predictedOpacity}
        />
        {scene.deepSky && (
          <DeepSky
            catalog={catalogs.deepSky}
            magnitudeLimit={Math.min(9, scene.magnitudeLimit + 2)}
            labels={scene.starLabels}
            opacity={predictedOpacity}
          />
        )}
        {scene.starLabels && (
          <StarLabels
            catalog={catalogs.stars}
            magnitudeLimit={Math.min(2.6, scene.magnitudeLimit)}
            opacity={predictedOpacity}
          />
        )}
        <SolarSystem
          bodies={sky.solarBodies}
          fovDeg={fovDeg}
          labels={scene.starLabels}
          opacity={predictedOpacity}
        />
      </SkyRig>

      {/* Outside the rig: the observer's own frame, which does not turn. */}
      <Horizon
        show={scene.horizon}
        cardinals={scene.cardinals}
        altAzGrid={scene.altAzGrid}
        opacity={1}
      />
    </Canvas>
  );
}

/** Where the camera is currently pointing, for the readout bar. */
export function viewDirection(view: { altitude: number; azimuth: number }): AltAz {
  return vectorToAltAz(altAzToVector(view));
}
