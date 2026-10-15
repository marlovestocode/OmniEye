/** Entry point for `node --import ./scripts/register-ts.mjs`. */
import { register } from 'node:module';
register('./resolve-ts.mjs', import.meta.url);
