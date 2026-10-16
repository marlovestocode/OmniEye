'use client';

/**
 * The three layers, and the legend that explains them.
 *
 * Three independent switches, not a mode carousel. The design is explicit about
 * this and the reason is a use case: turning Predicted off while leaving Observed
 * on answers "what did I actually capture?" in one click, and that question is
 * the point of the app.
 *
 * The legend appears only when a layer that needs explaining is on.
 */
import { Panel, PanelHeader, Rule, Slider, Toggle } from './primitives';
import { useOmniEye } from '@/lib/state/store';

export function LayerPanel({ hasObservation }: { hasObservation: boolean }) {
  const layers = useOmniEye((s) => s.layers);
  const toggleLayer = useOmniEye((s) => s.toggleLayer);
  const scene = useOmniEye((s) => s.scene);
  const setSceneOption = useOmniEye((s) => s.setSceneOption);
  const catalogs = useOmniEye((s) => s.catalogs);

  const starCount = catalogs ? catalogs.stars.countBrighterThan(scene.magnitudeLimit) : 0;

  return (
    <Panel className="w-full overflow-hidden md:w-[228px]">
      <PanelHeader title="Layers" />

      <div className="p-1">
        <Toggle
          label="Predicted"
          glyph="○"
          checked={layers.predicted}
          accent="var(--predicted)"
          onChange={() => toggleLayer('predicted')}
          hint="What the ephemeris says should be there. A hypothesis, never a sighting."
        />
        <Toggle
          label="Observed"
          glyph="●"
          checked={layers.observed}
          accent="var(--observed)"
          onChange={() => toggleLayer('observed')}
          hint="Point sources actually traced in the media. No identity attached."
        />
        <Toggle
          label="Matched"
          glyph="◎"
          checked={layers.matched}
          accent="var(--matched)"
          onChange={() => toggleLayer('matched')}
          hint="Prediction bound to evidence. The only layer permitted to state a name as fact."
        />
      </div>

      {!hasObservation && (
        <>
          <Rule />
          <p className="px-3 py-2 text-[10px] leading-relaxed text-[var(--text-faint)]">
            Observed and Matched are empty until media is imported. Nothing has been seen yet.
          </p>
        </>
      )}

      <Rule />
      <PanelHeader title="Predicted sky" />
      <div className="p-1">
        <Toggle
          label="Constellation figures"
          checked={scene.constellations}
          accent="var(--predicted)"
          onChange={(v) => setSceneOption('constellations', v)}
        />
        <Toggle
          label="Deep sky objects"
          checked={scene.deepSky}
          accent="var(--predicted)"
          onChange={(v) => setSceneOption('deepSky', v)}
          hint="Extended, faint, and usually below a phone's detection floor. Predicted only."
        />
        <Toggle
          label="Names"
          checked={scene.starLabels}
          accent="var(--predicted)"
          onChange={(v) => setSceneOption('starLabels', v)}
        />
        <Toggle
          label="Atmosphere"
          checked={scene.atmosphere}
          accent="var(--predicted)"
          onChange={(v) => setSceneOption('atmosphere', v)}
          hint="Dim stars near the horizon by the airmass they are seen through."
        />
        <Slider
          label="Limiting magnitude"
          value={scene.magnitudeLimit}
          min={1}
          max={7}
          step={0.25}
          onChange={(v) => setSceneOption('magnitudeLimit', v)}
          format={(v) => `${v.toFixed(2)}  ·  ${starCount.toLocaleString()} stars`}
        />
      </div>

      <Rule />
      <PanelHeader title="Observer frame" />
      <div className="p-1">
        <Toggle
          label="Horizon"
          checked={scene.horizon}
          accent="var(--horizon)"
          onChange={(v) => setSceneOption('horizon', v)}
        />
        <Toggle
          label="Cardinals"
          checked={scene.cardinals}
          accent="var(--cardinal)"
          onChange={(v) => setSceneOption('cardinals', v)}
        />
        <Toggle
          label="Alt / az grid"
          checked={scene.altAzGrid}
          accent="var(--horizon)"
          onChange={(v) => setSceneOption('altAzGrid', v)}
        />
        <Toggle
          label="RA / dec grid"
          checked={scene.equatorialGrid}
          accent="#a78bda"
          onChange={(v) => setSceneOption('equatorialGrid', v)}
        />
      </div>
    </Panel>
  );
}

/**
 * The contextual legend. Shows only the symbols currently in play -- a legend for
 * things that are not on screen is noise.
 */
export function Legend({ hasObservation, hasMatches }: { hasObservation: boolean; hasMatches: boolean }) {
  const layers = useOmniEye((s) => s.layers);
  const scene = useOmniEye((s) => s.scene);

  const entries: { glyph: string; label: string; colour: string; note?: string }[] = [];
  if (layers.predicted) {
    entries.push({ glyph: '○', label: 'Predicted', colour: 'var(--predicted)', note: 'not observed' });
    if (scene.deepSky) entries.push({ glyph: '◇', label: 'Predicted deep sky', colour: 'var(--predicted)' });
    if (scene.constellations) entries.push({ glyph: '—', label: 'Constellation', colour: 'var(--predicted)' });
  }
  if (layers.observed && hasObservation) {
    entries.push({ glyph: '●', label: 'Observed source', colour: 'var(--observed)', note: 'unnamed' });
    entries.push({ glyph: '◌', label: 'Unexplained', colour: 'var(--unexplained)' });
  }
  if (layers.matched && hasMatches) {
    entries.push({ glyph: '◎', label: 'Matched', colour: 'var(--matched)', note: 'confirmed' });
  }

  if (entries.length === 0) return null;

  return (
    <Panel className="px-3 py-2">
      <div className="flex flex-col gap-1">
        {entries.map((e) => (
          <div key={e.label} className="flex items-baseline gap-2">
            <span className="readout w-3 text-[12px] leading-none" style={{ color: e.colour }}>
              {e.glyph}
            </span>
            <span className="text-[10px] tracking-[0.08em] text-[var(--text-dim)]">{e.label}</span>
            {e.note && <span className="text-[10px] text-[var(--text-faint)]">· {e.note}</span>}
          </div>
        ))}
      </div>
    </Panel>
  );
}
