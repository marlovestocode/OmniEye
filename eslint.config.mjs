import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    /**
     * react-three-fiber components legitimately mutate the objects they own.
     *
     * `useFrame` runs on the render loop, not during React's render, so setting a
     * shader uniform or a draw range there is exactly the right thing to do --
     * the alternative would be recompiling a material on every slider drag. The
     * React Compiler lint rules cannot see that distinction and flag every one of
     * those writes as mutation of a memoised value.
     *
     * Scoped as tightly as possible: only the scene directory, only the two rules
     * that misread the frame loop. Everything else, including the hook rules that
     * do apply, stays on.
     */
    files: ['components/scene/**/*.tsx'],
    rules: {
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
    },
  },

  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Generated reference data, and the raw catalogues it is built from.
    'public/catalog/**',
    'data/**',
  ]),
]);

export default eslintConfig;
