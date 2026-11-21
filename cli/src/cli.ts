#!/usr/bin/env node
// The traceflow command: opens the live map, runs the MCP server, scans and simulates traffic.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Core } from './core.js';
import { describeArchitecture } from './describe.js';
import { runMcp } from './mcp.js';
import { scanProject } from './scan.js';
import { serve } from './server.js';
import type { State } from './types.js';

const HELP = `traceflow — see what your AI is building

Usage
  traceflow [dir]            Open the live map for a project (default: current folder)
  traceflow mcp [dir]        Run as an MCP server for Claude, Codex or Cursor (also serves the map)
  traceflow scan [dir]       Print the architecture as text (--json for raw data)
  traceflow simulate [url]   Send demo traffic to a running map
  traceflow setup            Print config for Claude Code, Claude Desktop and Codex

Options
  --port <n>         Map port (default 4317)
  --telemetry <n>    WebSocket port for the SDKs (default 8765)
  --host <h>         Bind address (default 127.0.0.1)
  --no-open          Do not open the browser
  --json             With scan: print JSON
`;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--port', '--telemetry', '--host'].includes(args[i - 1] ?? ''));
const COMMANDS = new Set(['mcp', 'scan', 'simulate', 'setup', 'help']);
const command = COMMANDS.has(positional[0]) ? positional[0] : 'open';
const target = (command === 'open' ? positional[0] : positional[1]) ?? process.env.TRACEFLOW_ROOT ?? process.cwd();
const root = resolve(target);
const port = Number(opt('port', '4317'));
const telemetryPort = Number(opt('telemetry', '8765'));
const host = opt('host', '127.0.0.1');

const red = (s: string) => (process.stdout.isTTY ? `\x1b[38;2;255;42;42m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

async function main() {
  if (flag('help') || command === 'help') return void process.stdout.write(HELP);
  if (command === 'setup') return setup();
  if (command === 'simulate') return simulate(positional[1] ?? `http://localhost:${port}`);
  if (!existsSync(root)) throw new Error(`folder not found: ${root}`);
  if (command === 'mcp') return runMcp(root, port, telemetryPort);
  if (command === 'scan') {
    const g = await scanProject(root);
    process.stdout.write(flag('json') ? JSON.stringify(g, null, 2) + '\n' : describeArchitecture(g) + '\n');
    return;
  }

  const core = new Core(root);
  core.on('log', (m) => console.error(dim(`  ${m}`)));
  console.log(`\n  ${red('●')} TraceFlow  ${dim(root)}`);
  await core.start();
  const g = core.graph!;
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  for (let p = port; p < port + 10 && !server; p++) {
    try {
      server = await serve(core, { port: p, host, telemetryPort, log: (m) => console.error(dim(`  ${m}`)) });
    } catch (e: any) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!server) throw new Error(`ports ${port}-${port + 9} are busy`);
  console.log(`  ${g.stack.join(' · ')}`);
  console.log(`  ${g.pages.length} pages · ${g.endpoints.length} endpoints · ${g.models.length} models`);
  console.log(`\n  Map        ${red(server.url)}`);
  console.log(`  Telemetry  ws://localhost:${telemetryPort}  ·  POST ${server.url}/api/ingest`);
  console.log(dim(`\n  Watching for changes. Ctrl+C to stop.\n`));
  core.on('state', (s) => {
    const latest = s.diff.changes[0];
    if (latest && Date.now() - latest.at < 2000) console.log(`  ${red('~')} ${latest.kind} ${latest.entity} ${latest.label}`);
  });
  if (!flag('no-open')) openBrowser(server.url);
  const stop = () => {
    core.close();
    server?.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

function setup() {
  const bin = 'traceflow';
  process.stdout.write(`Claude Code (run inside your project):
  claude mcp add traceflow -- ${bin} mcp

Codex (~/.codex/config.toml):
  [mcp_servers.traceflow]
  command = "${bin}"
  args = ["mcp", "/absolute/path/to/project"]

Claude Desktop (claude_desktop_config.json, "mcpServers"):
  "traceflow": { "command": "${bin}", "args": ["mcp", "/absolute/path/to/project"] }

The map opens at http://localhost:4317 while the MCP server runs.
`);
}

async function simulate(url: string) {
  let calls: { c: { endpoint: string; method: string } }[] = [];
  let eps = new Map<string, { path: string }>();
  let loadedAt = 0;
  const load = async () => {
    const state = (await (await fetch(`${url}/api/state`)).json()) as State;
    calls = [
      ...state.graph.pages.flatMap((p) => p.calls.map((c) => ({ c }))),
      ...state.graph.services.flatMap((s) => (s.calls ?? []).map((c) => ({ c }))),
    ];
    eps = new Map(state.graph.endpoints.map((e) => [e.id, e]));
    loadedAt = Date.now();
  };
  await load();
  if (!calls.length) throw new Error('no frontend calls found to simulate');
  const failing = opt('fail', '');
  console.log(`  sending demo traffic to ${url} — Ctrl+C to stop`);
  for (;;) {
    if (Date.now() - loadedAt > 2000) await load().catch(() => {});
    const { c } = calls[Math.floor(Math.random() * calls.length)];
    const ep = eps.get(c.endpoint);
    if (!ep) continue;
    const path = ep.path.replace(/\{[^}]+\}/g, () => String(1 + Math.floor(Math.random() * 40)));
    const fail = failing ? ep.path.includes(failing) && Math.random() < 0.7 : Math.random() < 0.06;
    const status = fail ? 500 : c.method === 'POST' ? 201 : 200;
    await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'web', target: path, method: c.method, status, duration_ms: 8 + Math.random() * (fail ? 400 : 90) }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 600));
  }
}

main().catch((e) => {
  console.error(`traceflow: ${e?.message ?? e}`);
  process.exit(1);
});
