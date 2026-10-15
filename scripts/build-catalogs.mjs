#!/usr/bin/env node
/**
 * Turns the bulky raw catalogues in data/raw/ into the small, GPU-ready
 * artefacts the app fetches at runtime:
 *
 *   public/catalog/stars.bin           Float32Array, `stride` floats per star, no parse step
 *   public/catalog/stars.meta.json     counts, magnitude tiers, provenance
 *   public/catalog/star-names.json     designations for the stars worth labelling
 *   public/catalog/constellations.json figures, resolved to stars.bin indices
 *   public/catalog/dso.json            Messier + bright NGC/IC, with angular sizes
 *
 * Star record layout (all Float32, J2000 mean equator):
 *   0..2  unit vector towards the star (x -> vernal equinox, z -> north celestial pole)
 *   3     visual magnitude
 *   4     B-V colour index (NaN when unknown)
 *   5..7  proper motion as an angular velocity vector, radians/year
 *
 * Storing proper motion as a vector means applying it at load time is
 * `normalise(u + dt * omega)` -- no trigonometry per star, and no chance of the
 * classic mu_alpha vs mu_alpha*cos(dec) mix-up leaking into the renderer.
 *
 *   node scripts/build-catalogs.mjs [--mag 7.0]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'public', 'catalog');

const STRIDE = 8;
const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

const argMag = process.argv.indexOf('--mag');
const MAG_LIMIT = argMag > -1 ? Number(process.argv[argMag + 1]) : 7.0;
/** Stars this bright get a name entry even without a proper name. */
const NAME_MAG_LIMIT = 6.5;
/** Magnitude tiers the renderer can slice to without re-fetching. */
const TIERS = [2.0, 3.0, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0];

// -- CSV ----------------------------------------------------------------------

/** Splits one CSV line, honouring double-quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function readCsv(file) {
  const text = await readFile(path.join(RAW, file), 'utf8');
  const lines = text.split('\n');
  const header = splitCsv(lines[0]).map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  return { lines, col };
}

const num = (s) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

// -- constellation figures ----------------------------------------------------

/** IAU three-letter abbreviation from a Stellarium constellation id. */
function abbrevFromId(id) {
  return id.replace(/^CON\s+\S+\s+/, '');
}

async function readSkyCulture() {
  const raw = JSON.parse(await readFile(path.join(RAW, 'skyculture_modern_st.json'), 'utf8'));
  const needed = new Set();
  const figures = raw.constellations.map((c) => {
    for (const line of c.lines) for (const hip of line) needed.add(hip);
    return {
      abbrev: abbrevFromId(c.id),
      name: c.common_name?.native ?? c.common_name?.english ?? abbrevFromId(c.id),
      english: c.common_name?.english ?? null,
      lines: c.lines,
    };
  });
  return { figures, needed };
}

// -- stars --------------------------------------------------------------------

async function buildStars(neededHip) {
  const { lines, col } = await readCsv('hygdata_v41.csv');
  const stars = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsv(line);

    // Row 0 is the Sun, which has no meaningful RA/Dec in this catalogue.
    if (c[col.id] === '0') continue;

    const mag = num(c[col.mag]);
    if (mag === null) continue;

    const hip = num(c[col.hip]);
    const keep = mag <= MAG_LIMIT || (hip !== null && neededHip.has(hip));
    if (!keep) continue;

    const ra = num(c[col.rarad]);
    const dec = num(c[col.decrad]);
    if (ra === null || dec === null) continue;

    const cosDec = Math.cos(dec);
    const sinDec = Math.sin(dec);
    const cosRa = Math.cos(ra);
    const sinRa = Math.sin(ra);

    // HYG's pmra is mu_alpha* -- it already carries the cos(dec) factor. Verified
    // against HYG's own vx/vy/vz Cartesian velocities, which agree in direction to
    // six decimals and in magnitude only under that reading.
    const muA = (num(c[col.pmra]) ?? 0) * MAS_TO_RAD;
    const muD = (num(c[col.pmdec]) ?? 0) * MAS_TO_RAD;

    // Local tangent basis at (ra, dec): omega = muA * e_ra + muD * e_dec.
    const omega = [
      muA * -sinRa + muD * -sinDec * cosRa,
      muA * cosRa + muD * -sinDec * sinRa,
      muD * cosDec,
    ];

    stars.push({
      u: [cosDec * cosRa, cosDec * sinRa, sinDec],
      mag,
      ci: num(c[col.ci]),
      omega,
      hip,
      proper: c[col.proper] || null,
      bayer: c[col.bayer] || null,
      flam: c[col.flam] || null,
      con: c[col.con] || null,
      spect: c[col.spect] || null,
      dist: num(c[col.dist]),
    });
  }

  // Brightest first: the renderer can then draw a magnitude-limited prefix of the
  // buffer without touching the index, and the matcher walks the same order.
  stars.sort((a, b) => a.mag - b.mag);
  return stars;
}

// -- deep sky -----------------------------------------------------------------

/** Human-readable labels for the catalogue's terse type codes. */
const DSO_TYPE_LABEL = {
  Gxy: 'galaxy',
  GC: 'globular cluster',
  OC: 'open cluster',
  'OC+Neb': 'open cluster with nebulosity',
  PN: 'planetary nebula',
  Neb: 'nebula',
  SNR: 'supernova remnant',
  HIIRgn: 'H II region',
  GxyCld: 'galaxy cloud',
  DN: 'dark nebula',
  Ast: 'asterism',
  '*': 'star',
  '**': 'double star',
  '***': 'triple star',
};

/**
 * The source catalogue carries proper names for only ~100 rows and misses most
 * of the Messier list. These are the common names an observer would actually
 * recognise, which the object inspector needs.
 */
const MESSIER_NAMES = {
  M1: 'Crab Nebula',
  M8: 'Lagoon Nebula',
  M11: 'Wild Duck Cluster',
  M13: 'Great Globular Cluster in Hercules',
  M16: 'Eagle Nebula',
  M17: 'Omega Nebula',
  M20: 'Trifid Nebula',
  M24: 'Sagittarius Star Cloud',
  M27: 'Dumbbell Nebula',
  M31: 'Andromeda Galaxy',
  M33: 'Triangulum Galaxy',
  M42: 'Orion Nebula',
  M43: "De Mairan's Nebula",
  M44: 'Beehive Cluster',
  M45: 'Pleiades',
  M51: 'Whirlpool Galaxy',
  M57: 'Ring Nebula',
  M63: 'Sunflower Galaxy',
  M64: 'Black Eye Galaxy',
  M76: 'Little Dumbbell Nebula',
  M81: "Bode's Galaxy",
  M82: 'Cigar Galaxy',
  M87: 'Virgo A',
  M97: 'Owl Nebula',
  M101: 'Pinwheel Galaxy',
  M104: 'Sombrero Galaxy',
};

async function buildDso() {
  const { lines, col } = await readCsv('dso.csv');
  const objects = [];
  const seen = new Set();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsv(line);

    const cats = [
      [c[col.cat1], c[col.id1]],
      [c[col.cat2], c[col.id2]],
    ].filter(([cat, id]) => cat && id);

    const messier = cats.find(([cat]) => cat === 'M');
    const name = (c[col.name] || '').trim() || null;
    const mag = num(c[col.mag]);
    const primary = cats[0];

    const interesting =
      messier ||
      name ||
      (mag !== null && mag <= 10 && primary && ['NGC', 'IC', 'C', 'Col'].includes(primary[0]));
    if (!interesting) continue;

    const ra = num(c[col.rarad]);
    const dec = num(c[col.decrad]);
    if (ra === null || dec === null) continue;

    const id = messier ? 'M' + messier[1] : primary[0] + ' ' + primary[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const type = c[col.type] || null;
    objects.push({
      id,
      name: name ?? MESSIER_NAMES[id] ?? null,
      designations: cats.map(([cat, cid]) => (cat === 'M' ? 'M' + cid : cat + ' ' + cid)),
      type,
      typeLabel: type ? (DSO_TYPE_LABEL[type] ?? type) : null,
      con: c[col.const] || null,
      // Radians, J2000 -- same convention as the star buffer.
      ra,
      dec,
      mag,
      // Angular extent in arcminutes; r2/angle absent for round objects.
      r1: num(c[col.r1]),
      r2: num(c[col.r2]),
      angle: num(c[col.angle]),
    });
  }

  const messierCount = objects.filter((o) => /^M\d+$/.test(o.id)).length;
  objects.sort((a, b) => (a.mag ?? 99) - (b.mag ?? 99));
  return { objects, messierCount };
}

// -- build --------------------------------------------------------------------

await mkdir(OUT, { recursive: true });

const { figures, needed } = await readSkyCulture();
console.log('figures      ' + figures.length + ' constellations, ' + needed.size + ' distinct HIP stars referenced');

const stars = await buildStars(needed);
console.log('stars        ' + stars.length + ' kept (mag <= ' + MAG_LIMIT + ', plus figure stars)');

const buf = new Float32Array(stars.length * STRIDE);
for (let i = 0; i < stars.length; i++) {
  const s = stars[i];
  const o = i * STRIDE;
  buf[o] = s.u[0];
  buf[o + 1] = s.u[1];
  buf[o + 2] = s.u[2];
  buf[o + 3] = s.mag;
  buf[o + 4] = s.ci ?? Number.NaN;
  buf[o + 5] = s.omega[0];
  buf[o + 6] = s.omega[1];
  buf[o + 7] = s.omega[2];
}
await writeFile(path.join(OUT, 'stars.bin'), Buffer.from(buf.buffer));

// How many leading records fall within each magnitude limit.
const tiers = TIERS.filter((m) => m <= Math.max(MAG_LIMIT, TIERS[0])).map((m) => {
  const first = stars.findIndex((s) => s.mag > m);
  return { mag: m, count: first === -1 ? stars.length : first };
});

await writeFile(
  path.join(OUT, 'stars.meta.json'),
  JSON.stringify(
    {
      source: 'HYG 4.1 (Astronexus)',
      license: 'CC BY-SA 4.0',
      epoch: 'J2000.0',
      frame: 'EQJ - mean equator and equinox of J2000',
      count: stars.length,
      stride: STRIDE,
      magLimit: MAG_LIMIT,
      fields: ['ux', 'uy', 'uz', 'mag', 'ci', 'pmx', 'pmy', 'pmz'],
      pmUnits: 'radians per year, angular velocity vector',
      tiers,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

// star-names.json -- sparse, keyed by index into stars.bin
const hipToIndex = new Map();
const names = {};
for (let i = 0; i < stars.length; i++) {
  const s = stars[i];
  if (s.hip !== null && !hipToIndex.has(s.hip)) hipToIndex.set(s.hip, i);

  const isFigureStar = s.hip !== null && needed.has(s.hip);
  if (!s.proper && !isFigureStar && s.mag > NAME_MAG_LIMIT) continue;
  if (!s.proper && !s.bayer && !s.flam && !isFigureStar) continue;

  const entry = {};
  if (s.proper) entry.p = s.proper;
  if (s.bayer) entry.b = s.bayer;
  if (s.flam) entry.f = s.flam;
  if (s.con) entry.c = s.con;
  if (s.hip !== null) entry.h = s.hip;
  if (s.spect) entry.s = s.spect;
  if (s.dist !== null && s.dist > 0 && s.dist < 100000) entry.d = Math.round(s.dist * 100) / 100;
  names[i] = entry;
}
await writeFile(path.join(OUT, 'star-names.json'), JSON.stringify({ names }));
console.log('names        ' + Object.keys(names).length + ' designations');

// constellations.json -- HIP polylines resolved to stars.bin indices
let dropped = 0;
const constellations = figures.map((f) => {
  const lines = [];
  for (const poly of f.lines) {
    let run = [];
    for (const hip of poly) {
      const idx = hipToIndex.get(hip);
      if (idx === undefined) {
        dropped++;
        // Break the polyline rather than inventing a segment across the gap.
        if (run.length > 1) lines.push(run);
        run = [];
        continue;
      }
      run.push(idx);
    }
    if (run.length > 1) lines.push(run);
  }
  return { abbrev: f.abbrev, name: f.name, english: f.english, lines };
});
await writeFile(
  path.join(OUT, 'constellations.json'),
  JSON.stringify({
    source: 'Stellarium sky culture "modern_st" (Sky & Telescope figures)',
    license: 'CC BY-SA 4.0',
    constellations,
  }),
);
const segCount = constellations.reduce((n, c) => n + c.lines.reduce((m, l) => m + l.length - 1, 0), 0);
console.log('figures      ' + segCount + ' segments resolved, ' + dropped + ' vertices unresolved');

const { objects, messierCount } = await buildDso();
await writeFile(
  path.join(OUT, 'dso.json'),
  JSON.stringify({
    source: 'Astronexus deep-sky catalogue (NGC/IC/Messier)',
    license: 'CC BY-SA 4.0',
    epoch: 'J2000.0',
    count: objects.length,
    objects,
  }),
);
console.log('deep sky     ' + objects.length + ' objects (' + messierCount + ' Messier)');

console.log('\nwrote public/catalog/{stars.bin,stars.meta.json,star-names.json,constellations.json,dso.json}');
