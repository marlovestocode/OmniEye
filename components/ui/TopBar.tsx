'use client';

/**
 * Where and when, always visible.
 *
 * Every claim the app makes follows from these two values, so they are never
 * hidden behind a settings panel, and each carries its provenance. A time whose
 * timezone was guessed is shown as guessed: an hour of error rotates the sky by
 * 15 degrees, and the result still looks like a plausible sky, which is worse
 * than looking broken.
 */
import { useState } from 'react';
import { formatDeg } from '@/lib/astro/frames';
import { useOmniEye } from '@/lib/state/store';
import { Confidence, Panel, Rule } from './primitives';

const SITE_SOURCE_LABEL: Record<string, { text: string; level: 'exact' | 'estimated' | 'assumed' | 'unknown' }> = {
  default: { text: 'default site', level: 'assumed' },
  geolocation: { text: 'device', level: 'exact' },
  exifGps: { text: 'EXIF GPS', level: 'exact' },
  userSupplied: { text: 'set by hand', level: 'exact' },
};

function formatSite(latitude: number, longitude: number): string {
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(4)}° ${ns}  ${Math.abs(longitude).toFixed(4)}° ${ew}`;
}

export function TopBar({
  onRequestLocation,
  compact = false,
}: {
  onRequestLocation: () => void;
  /** Phone layout: three stacked rows instead of three side-by-side sections. */
  compact?: boolean;
}) {
  const site = useOmniEye((s) => s.site);
  const siteSource = useOmniEye((s) => s.siteSource);
  const time = useOmniEye((s) => s.time);
  const timeMode = useOmniEye((s) => s.timeMode);
  const setTimeMode = useOmniEye((s) => s.setTimeMode);
  const setTime = useOmniEye((s) => s.setTime);
  const timeProvenance = useOmniEye((s) => s.timeProvenance);
  const sky = useOmniEye((s) => s.sky);
  const mode = useOmniEye((s) => s.mode);

  const [editing, setEditing] = useState(false);
  const siteMeta = SITE_SOURCE_LABEL[siteSource] ?? SITE_SOURCE_LABEL.default;

  const timeText = time.toISOString().replace('T', ' ').slice(0, 19);

  if (compact) {
    return (
      <Panel className="pointer-events-auto relative w-full divide-y divide-[var(--panel-edge)]">
        {/* Identity and the two things that qualify the clock. */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <span className="readout text-[13px] font-semibold tracking-[0.28em]">OMNIEYE</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTimeMode(timeMode === 'live' ? 'frozen' : 'live')}
              className="readout rounded-sm px-1.5 py-1 text-[9px] uppercase tracking-[0.14em]"
              style={{
                color: timeMode === 'live' ? 'var(--matched)' : 'var(--warn)',
                background: timeMode === 'live' ? 'rgba(111,240,205,0.10)' : 'rgba(255,207,112,0.10)',
              }}
              aria-label={timeMode === 'live' ? 'Following the clock. Tap to freeze.' : 'Held. Tap to follow the clock.'}
            >
              {timeMode === 'live' ? 'live' : 'held'}
            </button>
            {timeProvenance && (
              <Confidence level={timeProvenance.confidence} title={timeProvenance.note}>
                {timeProvenance.source === 'gps' ? 'gps' : timeProvenance.confidence}
              </Confidence>
            )}
          </div>
        </div>

        {/* When. */}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left"
          aria-label="Set the observation time"
        >
          <span className="readout text-[13px] leading-tight">
            {timeText}
            <span className="ml-1 text-[9px] text-[var(--text-faint)]">UTC</span>
          </span>
          {sky && (
            <span className="readout text-[10px] text-[var(--text-faint)]">
              sun {formatDeg(sky.sunAltitude)} · {sky.twilight}
            </span>
          )}
        </button>

        {/* Where. */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Confidence level={siteMeta.level}>{siteMeta.text}</Confidence>
            <span className="readout truncate text-[11px]">{formatSite(site.latitude, site.longitude)}</span>
          </div>
          <button
            type="button"
            onClick={onRequestLocation}
            className="readout shrink-0 py-1 text-[10px] text-[var(--predicted)]"
          >
            locate
          </button>
        </div>

        {editing && (
          <TimeEditor
            compact
            value={time}
            onCommit={(d) => {
              setTime(d);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </Panel>
    );
  }

  return (
    <Panel className="pointer-events-auto flex items-stretch divide-x divide-[var(--panel-edge)]">
      <div className="flex items-center gap-3 px-4 py-2">
        <span
          className="readout text-[15px] font-semibold tracking-[0.28em]"
          style={{ color: 'var(--text)' }}
        >
          OMNIEYE
        </span>
        <span className="label-caps hidden sm:inline">
          {mode === 'observatory' ? 'observatory' : 'observation'}
        </span>
      </div>

      {/* Time */}
      <div className="flex min-w-[236px] flex-col justify-center gap-0.5 px-4 py-1.5">
        <div className="flex items-center gap-2">
          <span className="label-caps">UTC</span>
          <button
            type="button"
            onClick={() => setTimeMode(timeMode === 'live' ? 'frozen' : 'live')}
            className="readout rounded-sm px-1 text-[9px] uppercase tracking-[0.14em] transition-colors"
            style={{
              color: timeMode === 'live' ? 'var(--matched)' : 'var(--warn)',
              background: timeMode === 'live' ? 'rgba(111,240,205,0.10)' : 'rgba(255,207,112,0.10)',
            }}
            title={timeMode === 'live' ? 'Following the clock. Click to freeze.' : 'Held. Click to follow the clock.'}
          >
            {timeMode === 'live' ? 'live' : 'held'}
          </button>
          {timeProvenance && (
            <Confidence level={timeProvenance.confidence} title={timeProvenance.note}>
              {timeProvenance.source === 'gps' ? 'gps' : timeProvenance.confidence}
            </Confidence>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="readout text-left text-[13px] leading-tight text-[var(--text)] hover:text-white"
          title="Set the observation time"
        >
          {time.toISOString().replace('T', ' ').slice(0, 19)}
        </button>
        {sky && (
          <span className="readout text-[10px] text-[var(--text-faint)]">
            LST {formatSiderealTime(sky.siderealTime)} · sun {formatDeg(sky.sunAltitude)} · {sky.twilight}
          </span>
        )}
      </div>

      {/* Location */}
      <div className="flex min-w-[220px] flex-col justify-center gap-0.5 px-4 py-1.5">
        <div className="flex items-center gap-2">
          <span className="label-caps">Observer</span>
          <Confidence level={siteMeta.level}>{siteMeta.text}</Confidence>
        </div>
        <span className="readout text-[13px] leading-tight">{formatSite(site.latitude, site.longitude)}</span>
        <button
          type="button"
          onClick={onRequestLocation}
          className="readout text-left text-[10px] text-[var(--predicted)] hover:underline"
        >
          use my location
        </button>
      </div>

      {editing && <TimeEditor value={time} onCommit={(d) => { setTime(d); setEditing(false); }} onCancel={() => setEditing(false)} />}
    </Panel>
  );
}

function formatSiderealTime(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  const s = Math.floor(((hours - h) * 60 - m) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Setting the time by hand.
 *
 * Deliberately labelled UTC and nothing else. Offering a local-time field would
 * reintroduce exactly the ambiguity the EXIF layer works to eliminate.
 */
function TimeEditor({
  value,
  onCommit,
  onCancel,
  compact = false,
}: {
  value: Date;
  onCommit: (date: Date) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState(value.toISOString().slice(0, 19));
  const parsed = new Date(`${text}Z`);
  const valid = !Number.isNaN(parsed.getTime());

  return (
    <div className={compact ? 'absolute inset-x-0 top-full mt-1' : 'absolute left-0 top-full mt-1 w-[320px]'}>
      <Panel className="p-3">
        <span className="label-caps">Observation time · UTC</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) onCommit(parsed);
            if (e.key === 'Escape') onCancel();
          }}
          spellCheck={false}
          className="readout mt-2 w-full rounded-sm border border-[var(--panel-edge-strong)] bg-black/40 px-2 py-1.5 text-[16px] outline-none focus:border-[var(--predicted)] md:text-[13px]"
        />
        <Rule className="my-2" />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-faint)]">
            {valid ? 'Enter to apply' : 'Expected YYYY-MM-DDTHH:MM:SS'}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="label-caps hover:text-[var(--text)]">
              cancel
            </button>
            <button
              type="button"
              disabled={!valid}
              onClick={() => onCommit(parsed)}
              className="label-caps !text-[var(--predicted)] disabled:opacity-40"
            >
              apply
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
