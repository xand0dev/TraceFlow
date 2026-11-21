// Plain-text views of the state, for the terminal and for agents over MCP.
import type { Graph, State, TrafficEvent } from './types.js';

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

export function describeArchitecture(g: Graph, focus?: string): string {
  const f = focus?.toLowerCase();
  const hit = (...xs: (string | undefined)[]) => !f || xs.some((x) => x?.toLowerCase().includes(f));
  const lines: string[] = [];
  lines.push(`# ${g.project}`);
  lines.push(`Stack: ${g.stack.join(', ') || 'unknown'}`);
  lines.push('');

  const mods = (g.modules ?? []).filter((m) => hit(m.name, m.path, m.desc));
  if (mods.length) {
    lines.push('## Blocks');
    const names = new Map((g.modules ?? []).map((m) => [m.id, m.name]));
    for (const m of mods) {
      const uses = (g.moduleEdges ?? []).filter((e) => e.source === m.id).map((e) => `${names.get(e.target)}${e.kind === 'http' ? ' (http)' : ''}`);
      lines.push(`- ${m.name} [${m.path}] ${m.files.length} files, ${m.lines} lines${m.desc ? ` — ${m.desc}` : ''}${uses.length ? `\n    uses: ${uses.join(', ')}` : ''}`);
    }
    lines.push('');
  }

  const epById = new Map(g.endpoints.map((e) => [e.id, e]));
  for (const s of g.services.filter((x) => x.type === 'frontend')) {
    const pages = g.pages.filter((p) => p.service === s.id && hit(p.path, p.component, ...p.calls.map((c) => c.endpoint)));
    if (!pages.length && f) continue;
    lines.push(`## ${s.subtype === 'mobile' ? 'Mobile app' : 'Web app'}: ${s.name} (${s.root})`);
    for (const p of pages) {
      lines.push(`- ${p.path ?? p.name} → ${p.component}  [${p.file}:${p.line}]`);
      for (const c of p.calls) {
        const ep = epById.get(c.endpoint);
        lines.push(`    calls ${c.method} ${ep?.path ?? c.endpoint.slice(3)}  [${c.file}:${c.line}]`);
      }
    }
    lines.push('');
  }

  const groups = new Map<string, typeof g.endpoints>();
  for (const e of g.endpoints) {
    if (!hit(e.path, e.view, ...e.models)) continue;
    groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  }
  if (groups.size) {
    const backend = g.services.find((s) => s.type === 'backend');
    lines.push(`## API: ${backend?.name ?? 'backend'} (${backend?.root ?? ''})`);
    for (const [group, eps] of groups) {
      lines.push(`### ${group}`);
      for (const e of eps) {
        const loc = e.viewFile ? `${e.viewFile}:${e.viewLine}` : `${e.file}:${e.line}`;
        const models = e.models.length ? ` → ${e.models.join(', ')}` : '';
        lines.push(`- ${e.methods.join('/')} ${e.path}  view ${e.view}${models}  [${loc}]`);
      }
    }
    lines.push('');
  }

  const models = g.models.filter((m) => hit(m.name, ...m.relations.map((r) => r.target)));
  if (models.length) {
    const db = g.services.find((s) => s.type === 'database');
    lines.push(`## Models${db ? ` (${db.name})` : ''}`);
    for (const m of models) {
      const rel = m.relations.length ? `  links: ${m.relations.map((r) => `${r.field}→${r.target}`).join(', ')}` : '';
      lines.push(`- ${m.name} (${m.fields.length} fields)${rel}  [${m.file}:${m.line}]`);
    }
    lines.push('');
  }

  if (g.unmatchedCalls.length && !f) {
    lines.push('## Frontend calls with no matching endpoint');
    for (const c of g.unmatchedCalls.slice(0, 15)) lines.push(`- ${c.method} ${c.path} from ${c.from}  [${c.file}:${c.line}]`);
  }
  return lines.join('\n').trim();
}

export function describeChanges(s: State): string {
  const { diff } = s;
  if (!diff.changes.length) return `No architecture changes since ${new Date(diff.since).toLocaleTimeString()}.`;
  const lines = [`Architecture changes since ${new Date(diff.since).toLocaleTimeString()} (${diff.changes.length}):`];
  const sign = { added: '+', removed: '−', changed: '~' } as const;
  for (const c of diff.changes) {
    const loc = c.file ? `  [${c.file}${c.line ? `:${c.line}` : ''}]` : '';
    lines.push(`${sign[c.kind]} ${c.entity} ${c.label}${loc}  (${ago(c.at)})`);
    for (const d of c.detail.slice(0, 6)) lines.push(`    ${d}`);
  }
  return lines.join('\n');
}

export function describeTraffic(events: TrafficEvent[], opts: { errorsOnly?: boolean; limit?: number } = {}): string {
  let list = events.slice().reverse();
  if (opts.errorsOnly) list = list.filter((e) => e.status >= 400);
  list = list.slice(0, opts.limit ?? 30);
  if (!list.length) {
    return opts.errorsOnly
      ? 'No failed requests recorded.'
      : 'No traffic recorded yet. Add the TraceFlow middleware (Django) or initTraceFlow() (React) and use the app.';
  }
  return list
    .map((e) => `${new Date(e.ts).toLocaleTimeString()}  ${e.status}  ${e.method} ${e.path}${e.durationMs != null ? `  ${Math.round(e.durationMs)}ms` : ''}${e.endpoint ? '' : '  (no matching endpoint in code)'}  from ${e.source}`)
    .join('\n');
}

export function describeEndpoint(s: State, query: string): string {
  const g = s.graph;
  const q = query.trim();
  const ep =
    g.endpoints.find((e) => e.path === q || e.id === q) ??
    g.endpoints.find((e) => e.path.includes(q) || e.view.toLowerCase() === q.toLowerCase());
  if (!ep) return `No endpoint matches "${query}". Known: ${g.endpoints.map((e) => e.path).slice(0, 20).join(', ')}`;
  const callers = g.pages.filter((p) => p.calls.some((c) => c.endpoint === ep.id));
  const svcCallers = g.services.filter((sv) => sv.calls?.some((c) => c.endpoint === ep.id));
  const hits = s.traffic.filter((t) => t.endpoint === ep.id);
  const errors = hits.filter((t) => t.status >= 400);
  const lines = [
    `${ep.methods.join('/')} ${ep.path}`,
    `route: ${ep.file}:${ep.line}`,
    `view: ${ep.view}${ep.viewFile ? `  ${ep.viewFile}:${ep.viewLine}` : ''}`,
    `models: ${ep.models.join(', ') || 'none detected'}`,
    `called by: ${[...callers.map((p) => `${p.path ?? p.name} (${p.file})`), ...svcCallers.map((x) => x.name)].join('; ') || 'no frontend caller found'}`,
    `traffic: ${hits.length} requests, ${errors.length} errors`,
  ];
  if (errors.length) lines.push('recent errors:', describeTraffic(errors, { limit: 5 }));
  return lines.join('\n');
}
