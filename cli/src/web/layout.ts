// Places blocks in layers: whatever uses something sits above it, so entry points are on top.
import type { Module, ModuleEdge } from '../types';

export interface Placed {
  m: Module;
  x: number;
  y: number;
  hub: boolean;
}

export const NODE_W = 250;
export const NODE_H = 162;
const COL_W = 300;
const ROW_H = 250;
const PER_ROW = 4;

export function placeModules(mods: Module[], edges: ModuleEdge[]): Placed[] {
  if (!mods.length) return [];
  const ids = new Set(mods.map((m) => m.id));
  const valid = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const indegree = new Map<string, number>(mods.map((m) => [m.id, 0]));
  const degree = new Map<string, number>(mods.map((m) => [m.id, 0]));
  for (const e of valid) {
    indegree.set(e.target, indegree.get(e.target)! + 1);
    degree.set(e.source, degree.get(e.source)! + 1);
    degree.set(e.target, degree.get(e.target)! + 1);
  }

  // Split into groups that are connected to each other; lay out each group, then put the groups side by side.
  const parent = new Map(mods.map((m) => [m.id, m.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const e of valid) parent.set(find(e.source), find(e.target));
  const groups = new Map<string, Module[]>();
  for (const m of mods) {
    const r = degree.get(m.id) ? find(m.id) : '__alone__';
    groups.set(r, [...(groups.get(r) ?? []), m]);
  }
  const alone = groups.get('__alone__') ?? [];
  groups.delete('__alone__');
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);

  const placed: Placed[] = [];
  let offsetX = 0;
  for (const group of ordered) {
    const local = layoutGroup(group, valid);
    const minX = Math.min(...local.map((p) => p.x));
    const maxX = Math.max(...local.map((p) => p.x));
    for (const p of local) placed.push({ ...p, x: p.x - minX + offsetX });
    offsetX += maxX - minX + COL_W;
  }
  if (alone.length) {
    // Unlinked blocks: a small grid next to the rest, sorted by size.
    const cols = Math.max(1, Math.min(PER_ROW, Math.ceil(Math.sqrt(alone.length))));
    const sorted = [...alone].sort((a, b) => b.lines - a.lines);
    sorted.forEach((m, i) => {
      placed.push({ m, x: offsetX + (i % cols) * COL_W, y: Math.floor(i / cols) * ROW_H, hub: false });
    });
  }

  // The block most others depend on is drawn larger.
  const maxIn = Math.max(...indegree.values());
  if (maxIn >= 2) {
    const hub = [...indegree.entries()].filter(([, d]) => d === maxIn).sort((a, b) => degree.get(b[0])! - degree.get(a[0])!)[0][0];
    placed.forEach((p) => (p.hub = p.m.id === hub));
  }
  // Center the whole map on x = 0.
  const minX = Math.min(...placed.map((p) => p.x));
  const maxX = Math.max(...placed.map((p) => p.x));
  return placed.map((p) => ({ ...p, x: p.x - (minX + maxX) / 2 - NODE_W / 2 }));
}

function layoutGroup(mods: Module[], allEdges: ModuleEdge[]): Placed[] {
  const ids = new Set(mods.map((m) => m.id));
  const edges = allEdges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const out = new Map<string, string[]>(mods.map((m) => [m.id, []]));
  for (const e of edges) out.get(e.source)!.push(e.target);

  // Drop the edges that close a cycle, then layer by longest path from the top.
  const state = new Map<string, number>();
  const acyclic = new Map<string, string[]>(mods.map((m) => [m.id, []]));
  const visit = (n: string) => {
    state.set(n, 1);
    for (const t of out.get(n)!) {
      if (state.get(t) === 1) continue;
      acyclic.get(n)!.push(t);
      if (!state.get(t)) visit(t);
    }
    state.set(n, 2);
  };
  const byName = [...mods].sort((a, b) => a.name.localeCompare(b.name));
  const indeg = new Map<string, number>(mods.map((m) => [m.id, 0]));
  for (const e of edges) indeg.set(e.target, indeg.get(e.target)! + 1);
  for (const m of [...byName].sort((a, b) => indeg.get(a.id)! - indeg.get(b.id)!)) if (!state.get(m.id)) visit(m.id);

  const inAcyclic = new Map<string, number>(mods.map((m) => [m.id, 0]));
  for (const ts of acyclic.values()) for (const t of ts) inAcyclic.set(t, inAcyclic.get(t)! + 1);
  const layer = new Map<string, number>();
  const queue = byName.filter((m) => inAcyclic.get(m.id) === 0).map((m) => m.id);
  queue.forEach((id) => layer.set(id, 0));
  const remaining = new Map(inAcyclic);
  while (queue.length) {
    const n = queue.shift()!;
    for (const t of acyclic.get(n)!) {
      layer.set(t, Math.max(layer.get(t) ?? 0, layer.get(n)! + 1));
      remaining.set(t, remaining.get(t)! - 1);
      if (remaining.get(t) === 0) queue.push(t);
    }
  }
  // Pull blocks up next to their lowest user, so long chains don't stretch the map.
  for (const m of byName) {
    const users = [...acyclic.entries()].filter(([, ts]) => ts.includes(m.id)).map(([s]) => layer.get(s) ?? 0);
    const deps = acyclic.get(m.id)!.map((t) => layer.get(t) ?? 0);
    if (users.length) {
      const lowest = Math.max(...users) + 1;
      const ceiling = deps.length ? Math.min(...deps) - 1 : Infinity;
      layer.set(m.id, Math.min(Math.max(lowest, 0), ceiling === Infinity ? lowest : Math.max(lowest, Math.min(layer.get(m.id)!, ceiling))));
    }
  }

  const layers = new Map<number, string[]>();
  for (const m of byName) {
    const l = layer.get(m.id) ?? 0;
    layers.set(l, [...(layers.get(l) ?? []), m.id]);
  }
  const rows: string[][] = [];
  const order = new Map<string, number>();
  for (const l of [...layers.keys()].sort((a, b) => a - b)) {
    let row = layers.get(l)!;
    const score = (id: string) => {
      const p = [...acyclic.entries()].filter(([, ts]) => ts.includes(id)).map(([s]) => order.get(s) ?? 0);
      return p.length ? p.reduce((a, b) => a + b, 0) / p.length : 0;
    };
    row = [...row].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    for (let i = 0; i < row.length; i += PER_ROW) {
      const chunk = row.slice(i, i + PER_ROW);
      chunk.forEach((id, k) => order.set(id, k - (chunk.length - 1) / 2));
      rows.push(chunk);
    }
  }
  const byId = new Map(mods.map((m) => [m.id, m]));
  const placed: Placed[] = [];
  rows.forEach((row, r) => row.forEach((id) => placed.push({ m: byId.get(id)!, x: order.get(id)! * COL_W, y: r * ROW_H, hub: false })));
  return placed;
}

export function bounds(nodes: { x: number; y: number }[]) {
  if (!nodes.length) return { x: -500, y: -300, w: 1000, h: 600 };
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const x = Math.min(...xs) - 90;
  const y = Math.min(...ys) - 70;
  return { x, y, w: Math.max(...xs) + NODE_W + 90 - x, h: Math.max(...ys) + NODE_H + 60 - y };
}

/** Up to two lines of description, cut at a word. */
export function wrap(text: string, width = 36, lines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  let used = 0;
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width && cur) {
      out.push(cur.trim());
      cur = w;
      if (out.length === lines) break;
    } else cur = (cur + ' ' + w).trim();
    used++;
  }
  if (out.length < lines && cur) out.push(cur);
  if (used < words.length && out.length) out[out.length - 1] = out[out.length - 1].replace(/[,.;:]?$/, '…');
  return out.slice(0, lines);
}
