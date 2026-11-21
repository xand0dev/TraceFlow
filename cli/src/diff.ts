import type { Change, Diff, Endpoint, Graph, Model, Module, Page } from './types.js';
import { edgeKey } from './types.js';

const pageSig = (p: Page) => JSON.stringify([p.path, p.component, p.calls.map((c) => c.method + c.endpoint).sort()]);
const endpointSig = (e: Endpoint) => JSON.stringify([e.methods.slice().sort(), e.models.slice().sort(), e.view]);
const modelSig = (m: Model) => JSON.stringify([m.fields.slice().sort()]);
const moduleSig = (m: Module) => JSON.stringify(m.files.map((f) => `${f.path}:${f.lines}`).sort());

const pageLabel = (p: Page) => (p.path ? `${p.path} · ${p.component}` : p.name);
const endpointLabel = (e: Endpoint) => `${e.methods.join(' ')} ${e.path}`;

function setDiff(a: string[], b: string[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  return { added: b.filter((x) => !sa.has(x)), removed: a.filter((x) => !sb.has(x)) };
}

/**
 * Compare the current scan with the baseline taken when the session started.
 * `firstSeen` keeps the time each change first appeared, so "2 min ago" stays stable across rescans.
 */
export function computeDiff(base: Graph, cur: Graph, since: number, firstSeen: Map<string, number>): Diff {
  const changes: Change[] = [];
  const now = Date.now();
  const stamp = (key: string) => {
    if (!firstSeen.has(key)) firstSeen.set(key, now);
    return firstSeen.get(key)!;
  };

  const compare = <T extends { id: string }>(
    entity: Change['entity'],
    before: T[],
    after: T[],
    sig: (x: T) => string,
    label: (x: T) => string,
    detail: (b: T | undefined, a: T | undefined) => string[],
    loc: (x: T) => { file?: string; line?: number },
  ): T[] => {
    const bm = new Map(before.map((x) => [x.id, x]));
    const am = new Map(after.map((x) => [x.id, x]));
    const gone: T[] = [];
    for (const [id, a] of am) {
      const b = bm.get(id);
      if (!b) {
        changes.push({ id, kind: 'added', entity, label: label(a), detail: detail(undefined, a), ...loc(a), at: stamp(`added:${id}`) });
      } else if (sig(a) !== sig(b)) {
        const key = `changed:${id}:${sig(a)}`;
        changes.push({ id, kind: 'changed', entity, label: label(a), detail: detail(b, a), ...loc(a), at: stamp(key) });
      }
    }
    for (const [id, b] of bm) {
      if (!am.has(id)) {
        gone.push(b);
        changes.push({ id, kind: 'removed', entity, label: label(b), detail: [], ...loc(b), at: stamp(`removed:${id}`) });
      }
    }
    return gone;
  };

  const removedPages = compare('page', base.pages, cur.pages, pageSig, pageLabel,
    (b, a) => {
      if (!a) return [];
      const pathOf = (id: string) => cur.endpoints.find((e) => e.id === id)?.path ?? base.endpoints.find((e) => e.id === id)?.path ?? id.slice(3);
      const sig = (p?: Page) => p?.calls.map((c) => `${c.method} ${pathOf(c.endpoint)}`) ?? [];
      const { added, removed } = setDiff(sig(b), sig(a));
      return [...added.map((x) => `+ calls ${x}`), ...removed.map((x) => `− no longer calls ${x}`)];
    },
    (p) => ({ file: p.file, line: p.line }));

  const removedEndpoints = compare('endpoint', base.endpoints, cur.endpoints, endpointSig, endpointLabel,
    (b, a) => {
      if (!a) return [];
      if (!b) return [`view ${a.view}`, ...a.models.map((x) => `uses ${x}`)];
      const out: string[] = [];
      const m = setDiff(b.methods, a.methods);
      out.push(...m.added.map((x) => `+ ${x}`), ...m.removed.map((x) => `− ${x}`));
      const md = setDiff(b.models, a.models);
      out.push(...md.added.map((x) => `+ uses ${x}`), ...md.removed.map((x) => `− stopped using ${x}`));
      return out;
    },
    (e) => ({ file: e.viewFile ?? e.file, line: e.viewLine ?? e.line }));

  const removedModels = compare('model', base.models, cur.models, modelSig, (m) => m.name,
    (b, a) => {
      if (!a) return [];
      if (!b) return a.fields.slice(0, 8);
      const { added, removed } = setDiff(b.fields, a.fields);
      return [...added.map((x) => `+ ${x}`), ...removed.map((x) => `− ${x}`)];
    },
    (m) => ({ file: m.file, line: m.line }));

  const removedModules = compare('module', base.modules ?? [], cur.modules ?? [], moduleSig, (m) => m.name,
    (b, a) => {
      if (!a) return [];
      if (!b) return [`${a.files.length} file${a.files.length === 1 ? '' : 's'} · ${a.lines} lines`, ...(a.desc ? [a.desc] : [])];
      const before = new Map(b.files.map((f) => [f.path, f.lines]));
      const after = new Map(a.files.map((f) => [f.path, f.lines]));
      const out: string[] = [];
      for (const [path, lines] of after) {
        if (!before.has(path)) out.push(`+ ${path}`);
        else if (before.get(path) !== lines) {
          const d = lines - before.get(path)!;
          out.push(`~ ${path} ${d > 0 ? '+' : ''}${d} lines`);
        }
      }
      for (const path of before.keys()) if (!after.has(path)) out.push(`− ${path}`);
      return out;
    },
    (m) => ({ file: m.files[0]?.path, line: 1 }));

  const baseEdges = new Set(base.edges.map(edgeKey));
  const baseModEdges = new Set((base.moduleEdges ?? []).map((e) => `${e.source}->${e.target}`));
  const addedEdges = [...cur.edges.map(edgeKey).filter((k) => !baseEdges.has(k)), ...(cur.moduleEdges ?? []).map((e) => `${e.source}->${e.target}`).filter((k) => !baseModEdges.has(k))];

  changes.sort((a, b) => b.at - a.at);
  return {
    since,
    changes,
    removed: { pages: removedPages, endpoints: removedEndpoints, models: removedModels, modules: removedModules },
    addedEdges,
  };
}

export function emptyDiff(since: number): Diff {
  return { since, changes: [], removed: { pages: [], endpoints: [], models: [], modules: [] }, addedEdges: [] };
}
