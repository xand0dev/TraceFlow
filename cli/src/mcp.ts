import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Core } from './core.js';
import { describeArchitecture, describeChanges, describeEndpoint, describeTraffic } from './describe.js';
import { serve } from './server.js';
import type { State } from './types.js';

const log = (msg: string) => process.stderr.write(`[traceflow] ${msg}\n`);

interface Source {
  state(): Promise<State>;
  resetBaseline(): Promise<void>;
  url: string | null;
}

async function health(url: string): Promise<{ root: string } | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(600) });
    const body = (await res.json()) as any;
    return body?.app === 'traceflow' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Reuse a map that is already running for this project (it has the live traffic),
 * otherwise run our own engine and open the map on the first free port.
 */
async function connect(root: string, port: number, telemetryPort: number): Promise<Source> {
  for (let p = port; p < port + 10; p++) {
    const url = `http://localhost:${p}`;
    const h = await health(url);
    if (h && h.root === root) {
      log(`using the running map at ${url}`);
      return {
        url,
        state: async () => (await fetch(`${url}/api/state`)).json() as Promise<State>,
        resetBaseline: async () => {
          await fetch(`${url}/api/baseline`, { method: 'POST' });
        },
      };
    }
  }
  const core = new Core(root);
  core.on('log', log);
  await core.start();
  let url: string | null = null;
  for (let p = port; p < port + 10 && !url; p++) {
    try {
      url = (await serve(core, { port: p, host: '127.0.0.1', telemetryPort, log })).url;
    } catch {}
  }
  log(url ? `map at ${url}` : 'map server not started (no free port)');
  return { url, state: async () => core.state(), resetBaseline: async () => core.resetBaseline() };
}

export async function runMcp(root: string, port: number, telemetryPort: number): Promise<void> {
  let source: Promise<Source> | null = null;
  const get = () => (source ??= connect(root, port, telemetryPort));
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  const server = new McpServer(
    { name: 'traceflow', version: '0.2.0' },
    {
      instructions:
        'TraceFlow knows this project\'s architecture: frontend pages, the API endpoints they call, the models those endpoints use, and live HTTP traffic. ' +
        'Use `architecture` before exploring an unfamiliar codebase, `trace` to find where an endpoint lives and who calls it, ' +
        '`changes` after editing to summarize what moved in the architecture, and `traffic` when debugging failed requests. ' +
        'Tell the user they can watch the live map with `open_map`.',
    },
  );

  server.registerTool(
    'architecture',
    {
      title: 'Project architecture',
      description:
        'Pages and screens, the API endpoints each one calls, the models each endpoint uses, and how models link, with file:line for everything. Optional focus filters by a word such as "orders" or "auth".',
      inputSchema: { focus: z.string().optional().describe('Only show parts mentioning this word') },
      annotations: { readOnlyHint: true },
    },
    async ({ focus }) => text(describeArchitecture((await (await get()).state()).graph, focus)),
  );

  server.registerTool(
    'changes',
    {
      title: 'Architecture changes',
      description: 'What was added, removed or changed in the architecture (pages, endpoints, models) since this session started.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const src = await get();
      const s = await src.state();
      return text(describeChanges(s) + (src.url ? `\n\nLive map: ${src.url}` : ''));
    },
  );

  server.registerTool(
    'traffic',
    {
      title: 'Live traffic',
      description: 'Recent HTTP requests reported by the running app (status, method, path, time). Use errors_only when debugging.',
      inputSchema: {
        errors_only: z.boolean().optional().describe('Only 4xx and 5xx responses'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ errors_only, limit }) =>
      text(describeTraffic((await (await get()).state()).traffic, { errorsOnly: errors_only, limit })),
  );

  server.registerTool(
    'trace',
    {
      title: 'Trace an endpoint',
      description: 'Where an API endpoint is routed and implemented, which models it uses, which pages call it, and its recent errors.',
      inputSchema: { endpoint: z.string().describe('A path like /api/orders/ or a view name') },
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint }) => text(describeEndpoint(await (await get()).state(), endpoint)),
  );

  server.registerTool(
    'open_map',
    {
      title: 'Live map link',
      description: 'The local URL of the live architecture map, to show the user.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const src = await get();
      return text(src.url ? `Live map: ${src.url}` : 'The map server could not start: ports are busy. Run `traceflow` in the project to open it.');
    },
  );

  server.registerTool(
    'reset_changes',
    {
      title: 'Reset change tracking',
      description: 'Start tracking architecture changes from now on, for example before a new task.',
    },
    async () => {
      await (await get()).resetBaseline();
      return text('Change tracking starts from now.');
    },
  );

  await server.connect(new StdioServerTransport());
  // Start scanning right away so the first tool call is fast and the map is up.
  void get().catch((e) => log(`startup failed: ${e.message}`));
}
