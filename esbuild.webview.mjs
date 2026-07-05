// esbuild.webview.mjs
// Bundles the React + ReactFlow webview into a single JS file for VS Code Webview.

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

build({
  entryPoints: [resolve(__dirname, 'src/webview/App.tsx')],
  bundle: true,
  outfile: resolve(__dirname, 'out/webview/bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
    '.css': 'css',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  minify: false,   // keep readable for debugging during PoC
  sourcemap: true,
}).then(() => {
  console.log('✅ Webview bundle built: out/webview/bundle.js');
}).catch((err) => {
  console.error('❌ Webview build failed:', err);
  process.exit(1);
});
