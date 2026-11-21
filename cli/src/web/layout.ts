import type { Node, Edge as FlowEdge } from 'reactflow';
import type { Endpoint, Graph, Model, Page, State } from '../types.js';

export type Status = 'added' | 'changed' | 'removed' | undefined;

export interface CardData {
  kind: 'page' | 'endpoint' | 'model';
  title: string;
  subtitle?: string;
  methods?: string[];
  status: Status;
  item: Page | Endpoint | Model;
}

export interface GroupData {
  kind: 'web' | 'mobile' | 'api' | 'db';
  title: string;
  subtitle: string;
  count: number;
}

const COL = { web: 0, api: 400, db: 820 };
const W = { page: 300, endpoint: 320, model: 250 };
const H = { page: 58, endpoint: 54, model: 58 };
const GAP = 12;
const PAD_TOP = 58;
const PAD = 18;
const GROUP_GAP = 36;

export function buildLayout(state: State): { nodes: Node[]; edges: FlowEdge[] } {
  const g = state.graph;
  const statusOf = new Map<string, Status>();
  for (const c of state.diff.changes) statusOf.set(c.id, c.kind);

  const pages = [...g.pages, ...state.diff.removed.pages];
  const endpoints = [...g.endpoints, ...state.diff.removed.endpoints];
  const models = [...g.models, ...state.diff.removed.models];

  // Order endpoints by group, then pull pages and models next to what they connect to.
  endpoints.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path));
  const epIndex = new Map(endpoints.map((e, i) => [e.id, i]));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1e9);
  pages.sort((a, b) => avg(a.calls.map((c) => epIndex.get(c.endpoint) ?? 1e9)) - avg(b.calls.map((c) => epIndex.get(c.endpoint) ?? 1e9)));
  const modelScore = (m: Model) => avg(endpoints.filter((e) => e.models.includes(m.name)).map((e) => epIndex.get(e.id)!));
  models.sort((a, b) => modelScore(a) - modelScore(b));

  const nodes: Node[] = [];
  const edges: FlowEdge[] = [];

  // Frontend groups stack in the left column.
  let y = 0;
  const frontends = g.services.filter((s) => s.type === 'frontend');
  for (const s of frontends) {
    const own = pages.filter((p) => p.service === s.id);
    const height = PAD_TOP + own.length * (H.page + GAP) - GAP + PAD;
    nodes.push(group(s.id, s.subtype === 'mobile' ? 'mobile' : 'web', s.name, s.subtype === 'mobile' ? 'Mobile app' : 'Web app', own.length, COL.web, y, W.page + PAD * 2, Math.max(height, 110)));
    own.forEach((p, i) => {
      nodes.push(card(p.id, s.id, PAD, PAD_TOP + i * (H.page + GAP), W.page, H.page, {
        kind: 'page', title: p.path ?? p.name, subtitle: p.component, status: statusOf.get(p.id), item: p,
      }));
    });
    y += Math.max(height, 110) + GROUP_GAP;
  }

  // API column, one container, endpoints grouped by area with a small label gap.
  const backend = g.services.find((s) => s.type === 'backend');
  if (endpoints.length) {
    let ey = PAD_TOP;
    let lastGroup = '';
    const placed: Node[] = [];
    for (const e of endpoints) {
      if (e.group !== lastGroup) {
        if (lastGroup) ey += 14;
        placed.push(label(`label:${e.group}`, 'api', PAD, ey, e.group));
        ey += 24;
        lastGroup = e.group;
      }
      placed.push(card(e.id, 'api', PAD, ey, W.endpoint, H.endpoint, {
        kind: 'endpoint', title: e.path, subtitle: e.view, methods: e.methods, status: statusOf.get(e.id), item: e,
      }));
      ey += H.endpoint + GAP;
    }
    nodes.push(group('api', 'api', backend?.name ?? 'API', 'Backend', endpoints.length, COL.api, 0, W.endpoint + PAD * 2, ey - GAP + PAD));
    nodes.push(...placed);
  }

  if (models.length) {
    const db = g.services.find((s) => s.type === 'database');
    const height = PAD_TOP + models.length * (H.model + GAP) - GAP + PAD;
    nodes.push(group('database', 'db', db?.name ?? 'Database', 'Data', models.length, COL.db, 0, W.model + PAD * 2, height));
    models.forEach((m, i) => {
      nodes.push(card(m.id, 'database', PAD, PAD_TOP + i * (H.model + GAP), W.model, H.model, {
        kind: 'model', title: m.name, subtitle: `${m.fields.length} field${m.fields.length === 1 ? '' : 's'}`, status: statusOf.get(m.id), item: m,
      }));
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  const added = new Set(state.diff.addedEdges);
  const push = (source: string, target: string, kind: string, method?: string) => {
    if (!ids.has(source) || !ids.has(target)) return;
    const id = `${source}->${target}`;
    if (edges.some((e) => e.id === id)) return;
    edges.push({ id, source, target, type: 'flow', zIndex: 1, data: { kind, method, isNew: added.has(id) } });
  };
  for (const p of pages) for (const c of p.calls) push(p.id, c.endpoint, 'calls', c.method);
  for (const s of frontends) for (const c of s.calls ?? []) push(s.id, c.endpoint, 'calls', c.method);
  for (const e of endpoints) for (const m of e.models) push(e.id, `model:${m}`, 'uses');

  return { nodes, edges };
}

function group(id: string, kind: GroupData['kind'], title: string, subtitle: string, count: number, x: number, y: number, w: number, h: number): Node<GroupData> {
  return {
    id, type: 'zone', position: { x, y }, data: { kind, title, subtitle, count },
    style: { width: w, height: h }, draggable: false, selectable: false,
  };
}

function card(id: string, parent: string, x: number, y: number, w: number, h: number, data: CardData): Node<CardData> {
  return { id, type: 'card', parentNode: parent, extent: 'parent', position: { x, y }, data, style: { width: w, height: h }, draggable: false };
}

function label(id: string, parent: string, x: number, y: number, text: string): Node {
  return { id, type: 'label', parentNode: parent, position: { x, y }, data: { text }, draggable: false, selectable: false };
}

export function neighbours(edges: FlowEdge[], id: string): Set<string> {
  const out = new Set([id]);
  // walk both directions so a page lights up its endpoints and their models
  const down = (n: string) => edges.filter((e) => e.source === n).forEach((e) => { if (!out.has(e.target)) { out.add(e.target); down(e.target); } });
  const up = (n: string) => edges.filter((e) => e.target === n).forEach((e) => { if (!out.has(e.source)) { out.add(e.source); up(e.source); } });
  down(id);
  up(id);
  return out;
}

export type { Graph };
