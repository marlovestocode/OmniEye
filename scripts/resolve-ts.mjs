/**
 * Module resolve hook so the verification scripts can import the app's TypeScript
 * directly under plain `node`, with the same specifiers the bundler uses.
 *
 * Two gaps to close: Node's ESM resolver wants explicit extensions where the
 * bundler infers `.ts`, and it knows nothing about the `@/*` path alias from
 * tsconfig.json. Type stripping itself is built in from Node 22.18.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

function firstExisting(base) {
  if (existsSync(base) && !existsSync(path.join(base, 'package.json'))) {
    // A concrete file, or a directory we should try index files inside.
    if (path.extname(base)) return base;
  }
  for (const ext of CANDIDATE_EXTENSIONS) {
    const withExt = base + ext;
    if (existsSync(withExt)) return withExt;
  }
  for (const ext of CANDIDATE_EXTENSIONS) {
    const index = path.join(base, 'index' + ext);
    if (existsSync(index)) return index;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  // tsconfig's "@/*": ["./*"] alias
  if (specifier.startsWith('@/')) {
    const resolved = firstExisting(path.join(ROOT, specifier.slice(2)));
    if (resolved) return next(pathToFileURL(resolved).href, context);
  }

  // Extensionless relative import
  if (specifier.startsWith('.') && !path.extname(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : ROOT;
    const resolved = firstExisting(path.resolve(path.dirname(parentPath), specifier));
    if (resolved) return next(pathToFileURL(resolved).href, context);
  }

  return next(specifier, context);
}
