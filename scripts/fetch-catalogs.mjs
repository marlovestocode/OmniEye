#!/usr/bin/env node
/**
 * Downloads the raw source catalogs OmniEye builds from.
 *
 * Everything here is public, permissively licensed reference data. It lands in
 * data/raw/ (gitignored) and is consumed by scripts/build-catalogs.mjs, which
 * writes the small derived artefacts in public/catalog/ that ship with the app.
 *
 *   node scripts/fetch-catalogs.mjs
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');

const SOURCES = [
  {
    file: 'hygdata_v41.csv',
    url: 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
    note: 'HYG 4.1 star database (Hipparcos + Yale BSC + Gliese). CC BY-SA 4.0.',
  },
  {
    file: 'dso.csv',
    url: 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/misc/dso.csv',
    note: 'Astronexus deep-sky catalogue (NGC/IC/Messier + PGC). CC BY-SA 4.0.',
  },
  {
    file: 'skyculture_modern_st.json',
    url: 'https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern_st/index.json',
    note: 'Stellarium "modern_st" sky culture: constellation figures as HIP polylines. CC BY-SA 4.0.',
  },
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const force = process.argv.includes('--force');

await mkdir(RAW, { recursive: true });

for (const src of SOURCES) {
  const dest = path.join(RAW, src.file);
  if (!force && (await exists(dest))) {
    console.log(`· ${src.file} already present (use --force to re-download)`);
    continue;
  }
  process.stdout.write(`↓ ${src.file} … `);
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`${src.url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await stat(dest);
  console.log(`${(size / 1e6).toFixed(1)} MB`);
}

console.log('\nSources:');
for (const s of SOURCES) console.log(`  ${s.file.padEnd(28)} ${s.note}`);
console.log('\nNext: node scripts/build-catalogs.mjs');
