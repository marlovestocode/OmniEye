'use client';

/**
 * The traced photograph.
 *
 * Detected sources drawn directly over the image they came from, in the observed
 * layer's warm palette. Scientific annotation, not a computer-vision debug view:
 * marker size follows the source's own measured width, so the overlay describes
 * what was found rather than stamping identical circles on everything.
 *
 * Colour carries the claim. Warm rings are evidence without identity: a bright
 * spot the detector found and nothing has explained. Aqua rings are evidence
 * bound to a prediction, and they are the only markers that ever carry a name --
 * built through `confirmedLabel`, which will not accept anything unmatched.
 *
 * Matched markers also carry their residual as a short exaggerated line, the
 * standard astrometric residual plot: random short lines mean a sound fit, a
 * coherent swirl means the camera model is wrong.
 *
 * Drawn on a canvas rather than as DOM nodes: five hundred sources would be five
 * hundred elements to lay out, and the frame budget belongs to the sky.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DetectionRun } from '@/lib/detect/client';
import type { Source, SourceShape } from '@/lib/detect/types';
import type { MatchedSky } from '@/lib/solve/match';
import { confirmedLabel, isMatched } from '@/lib/sky/evidence';

const SHAPE_COLOUR: Record<SourceShape, string> = {
  point: '#ffb765',
  sharp: '#ff8fb0',
  trailed: '#ff8fb0',
  diffuse: '#ffd7a0',
};

export interface SourceOverlayProps {
  imageUrl: string;
  /** Pixel dimensions the detection ran at. */
  width: number;
  height: number;
  detection: DetectionRun | null;
  /** The solve's output, when there is one. Null leaves every source unnamed. */
  matched: MatchedSky | null;
  showSources: boolean;
  showMatched: boolean;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  /** 0 shows the model only, 1 shows the media only. */
  mediaOpacity: number;
}

export function SourceOverlay({
  imageUrl,
  width,
  height,
  detection,
  matched,
  showSources,
  showMatched,
  hoveredId,
  onHover,
  mediaOpacity,
}: SourceOverlayProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // Track the rendered size so the overlay stays registered with the image
  // through any layout change.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Names, keyed by the source that earned them. Built only from matched
  // objects: `confirmedLabel` will not accept anything else, so an unmatched
  // source cannot acquire a name here even by mistake.
  const names = useMemo(() => {
    const map = new Map<string, { label: string; score: number }>();
    if (!matched) return map;
    for (const object of matched.objects) {
      if (!isMatched(object)) continue;
      map.set(object.observed.id, { label: confirmedLabel(object), score: object.score });
    }
    return map;
  }, [matched]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || box.width === 0 || !detection) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.round(box.width * dpr);
    el.height = Math.round(box.height * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    if (!showSources) return;

    const scale = box.width / width;
    const psf = detection.fwhmPixels ?? 3;

    for (const source of detection.sources) {
      const name = showMatched ? names.get(source.id) : undefined;
      const predicted = showMatched ? matched?.predictedPixels.get(source.id) : undefined;
      drawSource(ctx, source, scale, psf, source.id === hoveredId, name, predicted);
    }
  }, [box, detection, showSources, showMatched, hoveredId, width, names, matched]);

  return (
    <div
      ref={wrapper}
      className="relative w-full overflow-hidden rounded-sm bg-black"
      style={{ aspectRatio: `${width} / ${height}` }}
      onPointerMove={(event) => {
        if (!detection || box.width === 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const scale = width / rect.width;
        const x = (event.clientX - rect.left) * scale;
        const y = (event.clientY - rect.top) * scale;
        onHover(nearestSource(detection.sources, x, y, 18 * scale));
      }}
      onPointerLeave={() => onHover(null)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="Imported observation"
        className="absolute inset-0 h-full w-full object-cover"
        style={{ opacity: mediaOpacity }}
        draggable={false}
      />
      <canvas
        ref={canvas}
        className="absolute inset-0 h-full w-full"
        style={{ width: box.width, height: box.height }}
      />
    </div>
  );
}

/**
 * One source marker.
 *
 * The circle is sized from the source's own FWHM, floored so a faint star is
 * still visible and clickable. Shape class changes the stroke, not the position:
 * a trailed source gets a dashed ring because the app is flagging its morphology,
 * not asserting what caused it.
 */
function drawSource(
  ctx: CanvasRenderingContext2D,
  source: Source,
  scale: number,
  psf: number,
  hovered: boolean,
  name?: { label: string; score: number },
  predicted?: { x: number; y: number },
): void {
  const x = source.x * scale;
  const y = source.y * scale;
  const radius = Math.max(4, source.fwhm * scale * 1.6);

  // A matched source changes colour family entirely. That is the whole visual
  // grammar: warm means evidence without identity, aqua means evidence bound to a
  // prediction, and nothing carries a name until it crosses that line.
  if (name) {
    drawMatched(ctx, x, y, radius, name, predicted, scale, hovered);
    return;
  }

  const colour = SHAPE_COLOUR[source.shape];

  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = hovered ? 1.6 : 1;
  ctx.globalAlpha = hovered ? 1 : 0.75;

  if (source.shape === 'trailed') {
    // Trace the ellipse the second moments actually measured, at its measured
    // orientation, so a streak reads as a streak.
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.ellipse(x, y, radius * source.elongation, radius, source.theta, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    if (source.shape === 'sharp') ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (hovered) {
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    // Crosshair through the sub-pixel centroid: the number that matters.
    const reach = radius + 8;
    ctx.beginPath();
    ctx.moveTo(x - reach, y);
    ctx.lineTo(x - radius - 2, y);
    ctx.moveTo(x + radius + 2, y);
    ctx.lineTo(x + reach, y);
    ctx.moveTo(x, y - reach);
    ctx.lineTo(x, y - radius - 2);
    ctx.moveTo(x, y + radius + 2);
    ctx.lineTo(x, y + reach);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * A confirmed identification.
 *
 * The double ring is the matched glyph. The residual is drawn as a short line
 * from where the catalogue said the object would be to where it actually was,
 * exaggerated so an arcminute is visible -- the standard astrometric residual
 * plot, and the quickest way to see that a fit is sound: random short lines mean
 * a good solve, a coherent swirl means the camera model is wrong.
 */
function drawMatched(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  name: { label: string; score: number },
  predicted: { x: number; y: number } | undefined,
  scale: number,
  hovered: boolean,
): void {
  const confident = name.score > 0.35;
  const colour = '#6ff0cd';

  ctx.save();
  ctx.strokeStyle = colour;
  ctx.globalAlpha = hovered ? 1 : 0.45 + 0.45 * name.score;
  ctx.lineWidth = hovered ? 1.6 : 1.1;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.75, 0, Math.PI * 2);
  ctx.globalAlpha *= 0.5;
  ctx.stroke();

  if (predicted) {
    const EXAGGERATION = 12;
    const dx = (x - predicted.x * scale) * EXAGGERATION;
    const dy = (y - predicted.y * scale) * EXAGGERATION;
    if (Math.hypot(dx, dy) > 1.5) {
      ctx.globalAlpha = hovered ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x - dx, y - dy);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  // Only a confident match is labelled at rest. A name is the strongest claim
  // the interface makes, so a weak one waits to be asked for.
  if (confident || hovered) {
    ctx.globalAlpha = hovered ? 1 : 0.85;
    ctx.fillStyle = colour;
    ctx.font = '500 11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const label = hovered ? `${name.label}  ${(name.score * 100).toFixed(0)}%` : name.label;
    ctx.fillText(label, x + radius * 1.9 + 3, y);
  }
  ctx.restore();
}

function nearestSource(sources: Source[], x: number, y: number, radius: number): string | null {
  let best: string | null = null;
  let bestDistance = radius;
  for (const source of sources) {
    const d = Math.hypot(source.x - x, source.y - y);
    if (d < bestDistance) {
      bestDistance = d;
      best = source.id;
    }
  }
  return best;
}
