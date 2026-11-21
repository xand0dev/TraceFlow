import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Graph } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

function parserPath(): string {
  const candidates = [join(here, 'parser.py'), join(here, '..', '..', 'src', 'parser.py')];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('parser.py not found next to the TraceFlow CLI');
  return found;
}

let cachedPython: string | null = null;

/** GUI apps start servers with a short PATH, so look in the usual places too. */
const PYTHONS = [
  process.env.TRACEFLOW_PYTHON,
  'python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
  'python',
  'py',
].filter(Boolean) as string[];

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

export async function scanProject(root: string): Promise<Graph> {
  const script = parserPath();
  const tries = cachedPython ? [cachedPython] : PYTHONS;
  let lastError = '';
  for (const py of tries) {
    try {
      const { code, out, err } = await run(py, [script, root]);
      if (code !== 0) {
        lastError = err || out;
        if (/not found|not recognized|No such file/i.test(lastError)) continue;
        throw new Error(`parser failed: ${lastError.trim().slice(0, 500)}`);
      }
      cachedPython = py;
      const graph = JSON.parse(out) as Graph & { error?: string };
      if (graph.error) throw new Error(graph.error);
      return graph;
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
  }
  throw new Error(`Python 3.9+ not found. Set TRACEFLOW_PYTHON. ${lastError}`.trim());
}

/** Same matching rules as parser.py: params are wildcards, trailing slash ignored. */
export function pathKey(path: string): string {
  const clean = path.split('?')[0].split('#')[0];
  const segs = clean.split('/').filter(Boolean);
  return '/' + segs.map((s) => (s.startsWith('{') || s.startsWith('<') || s.startsWith(':') || /^\d+$/.test(s) || /^[0-9a-f-]{32,36}$/i.test(s) ? '*' : s)).join('/');
}

export function matchEndpoint(graph: Graph, path: string): string | undefined {
  const key = pathKey(path);
  const segs = key.split('/').filter(Boolean);
  let fallback: string | undefined;
  for (const ep of graph.endpoints) {
    const ekey = pathKey(ep.path);
    if (ekey === key) return ep.id;
    const esegs = ekey.split('/').filter(Boolean);
    if (!fallback && esegs.length === segs.length && esegs.every((s, i) => s === '*' || segs[i] === '*' || s === segs[i])) {
      fallback = ep.id;
    }
  }
  return fallback;
}
