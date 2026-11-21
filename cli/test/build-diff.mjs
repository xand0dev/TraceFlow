// Bundles src/diff.ts for the tests so they run against the real source.
import { build } from 'esbuild';
await build({ entryPoints: ['src/diff.ts'], outfile: 'test/diff-under-test.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'warning' });
