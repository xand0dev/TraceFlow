import { build } from 'esbuild';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/web', { recursive: true });

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
await chmod('dist/cli.js', 0o755);
await copyFile('../src/parser.py', 'dist/parser.py');

await build({
  entryPoints: ['src/web/main.tsx'],
  outdir: 'dist/web',
  entryNames: 'app',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

await writeFile('dist/web/index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TraceFlow</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23050506'/%3E%3Ccircle cx='8' cy='8' r='3' fill='%23ff2a2a'/%3E%3C/svg%3E" />
<link rel="stylesheet" href="/app.css" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`);
console.log('built dist/');
