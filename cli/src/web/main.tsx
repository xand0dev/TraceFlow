import { createRoot } from 'react-dom/client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './styles.css';
import { buildLayout, neighbours, type CardData, type GroupData } from './layout';
import type { Change, State, TrafficEvent } from '../types';

// ── live state shared with nodes and edges without re-laying out the graph ──

interface Pulse { id: number; edge: string; error: boolean }
interface Hit { status: number; ts: number; count: number }

const live = {
  pulses: [] as Pulse[],
  hits: new Map<string, Hit>(),
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((l) => l()); },
};

function useLive() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((x) => x + 1);
    live.listeners.add(l);
    return () => { live.listeners.delete(l); };
  }, []);
}

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── nodes ──

const TAG: Record<string, string> = { added: 'NEW', changed: 'CHANGED', removed: 'REMOVED' };

const CardNode = memo(({ id, data, selected }: NodeProps<CardData>) => {
  useLive();
  const hit = live.hits.get(id);
  const fresh = hit && Date.now() - hit.ts < 1400;
  const failing = hit && hit.status >= 500 && Date.now() - hit.ts < 12000;
  const cls = ['card', `card-${data.kind}`, data.status && `is-${data.status}`, fresh && 'is-hit', failing && 'is-failing', selected && 'is-selected']
    .filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="card-top">
        {data.methods && <span className="methods">{data.methods.map((m) => <i key={m} className={`m-${m.toLowerCase()}`}>{m}</i>)}</span>}
        <span className="card-title">{data.title}</span>
        {data.status && <span className={`tag tag-${data.status}`}>{TAG[data.status]}</span>}
      </div>
      <div className="card-sub">
        <span>{data.subtitle}</span>
        {hit && <span className={`hit ${hit.status >= 400 ? 'bad' : ''}`}>{hit.status} · {hit.count}×</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const GroupNode = memo(({ data }: NodeProps<GroupData>) => (
  <div className={`group group-${data.kind}`}>
    <Handle type="source" position={Position.Right} isConnectable={false} style={{ top: 28 }} />
    <div className="group-head">
      <span className="group-kind">{data.subtitle}</span>
      <span className="group-title">{data.title}</span>
      <span className="group-count">{data.count}</span>
    </div>
  </div>
));

const LabelNode = memo(({ data }: NodeProps<{ text: string }>) => <div className="area-label">{data.text}</div>);

// ── edges ──

const FlowEdge = memo(({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style }: EdgeProps) => {
  useLive();
  const [d] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const pulses = live.pulses.filter((p) => p.edge === id);
  const cls = ['flow', data?.isNew && 'is-new', pulses.length && 'is-active'].filter(Boolean).join(' ');
  return (
    <g className={cls} style={style}>
      <path d={d} className="flow-line" fill="none" />
      {pulses.map((p) => (
        <circle key={p.id} r={3.5} className={p.error ? 'dot dot-err' : 'dot'} style={{ offsetPath: `path('${d}')` }} />
      ))}
    </g>
  );
});

const nodeTypes = { card: CardNode, zone: GroupNode, label: LabelNode };
const edgeTypes = { flow: FlowEdge };

// ── app ──

type Tab = 'changes' | 'live' | 'details';

function App() {
  const [state, setState] = useState<State | null>(null);
  const [traffic, setTraffic] = useState<TrafficEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<Tab>('changes');
  const [selected, setSelected] = useState<string | null>(null);
  const flow = useReactFlow();
  const layout = useMemo(() => (state ? buildLayout(state) : { nodes: [], edges: [] }), [state]);
  const edgesRef = useRef(layout.edges);
  edgesRef.current = layout.edges;
  const fitted = useRef(false);

  const onTraffic = useCallback((t: TrafficEvent) => {
    setTraffic((xs) => [...xs.slice(-399), t]);
    if (!t.endpoint) return;
    const prev = live.hits.get(t.endpoint);
    live.hits.set(t.endpoint, { status: t.status, ts: Date.now(), count: (prev?.count ?? 0) + 1 });
    const err = t.status >= 500;
    const hits = edgesRef.current.filter((e) => e.target === t.endpoint && (!e.data?.method || e.data.method === t.method));
    const incoming = hits.length ? hits : edgesRef.current.filter((e) => e.target === t.endpoint);
    const outgoing = edgesRef.current.filter((e) => e.source === t.endpoint);
    const born: Pulse[] = [];
    incoming.forEach((e) => born.push({ id: Math.random(), edge: e.id, error: err }));
    live.pulses.push(...born);
    live.emit();
    setTimeout(() => {
      const next: Pulse[] = err ? [] : outgoing.map((e) => ({ id: Math.random(), edge: e.id, error: false }));
      live.pulses = live.pulses.filter((p) => !born.includes(p)).concat(next);
      live.emit();
      setTimeout(() => { live.pulses = live.pulses.filter((p) => !next.includes(p)); live.emit(); }, 900);
    }, 900);
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => setOnline(true));
    es.addEventListener('error', () => setOnline(false));
    es.addEventListener('state', (m) => {
      const s = JSON.parse((m as MessageEvent).data) as State;
      setState(s);
      setTraffic((xs) => (xs.length ? xs : s.traffic));
    });
    es.addEventListener('traffic', (m) => onTraffic(JSON.parse((m as MessageEvent).data)));
    const t = setInterval(() => live.emit(), 1000);
    return () => { es.close(); clearInterval(t); };
  }, [onTraffic]);

  const userMoved = useRef(false);
  useEffect(() => {
    // Keep the whole map in view as it grows, until the user pans or zooms themselves.
    if (!layout.nodes.length || (fitted.current && userMoved.current)) return;
    fitted.current = true;
    const t = setTimeout(() => flow.fitView({ padding: 0.08, duration: 400 }), 80);
    return () => clearTimeout(t);
  }, [layout.nodes.length, flow]);

  const focusSet = useMemo(() => (selected ? neighbours(layout.edges, selected) : null), [selected, layout.edges]);
  const nodes = useMemo(() => layout.nodes.map((n) => ({
    ...n,
    selected: n.id === selected,
    className: focusSet && n.type === 'card' && !focusSet.has(n.id) ? 'is-dim' : undefined,
  })), [layout.nodes, focusSet, selected]);
  const edges = useMemo(() => layout.edges.map((e) => ({
    ...e,
    style: focusSet && !(focusSet.has(e.source) && focusSet.has(e.target)) ? { opacity: 0.12 } : undefined,
  })), [layout.edges, focusSet]);

  const focus = (id: string) => {
    setSelected(id);
    setTab('details');
    const n = flow.getNode(id);
    if (n?.positionAbsolute) {
      userMoved.current = true;
      flow.setCenter(n.positionAbsolute.x + (n.width ?? 300) / 2, n.positionAbsolute.y + (n.height ?? 56) / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 500 });
    }
  };

  if (!state) return <div className="boot"><span className="pulse-dot" /> Scanning project…</div>;
  const g = state.graph;
  const empty = !g.pages.length && !g.endpoints.length && !g.models.length;
  const changes = state.diff.changes;
  const errors = traffic.filter((t) => t.status >= 500 && Date.now() - t.ts < 60000).length;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="pulse-dot" /> TRACEFLOW</div>
        <div className="project">
          <b>{g.project}</b>
          <span className="stack">{g.stack.map((s) => <i key={s}>{s}</i>)}</span>
        </div>
        <div className={`status ${online ? '' : 'off'}`}>{online ? `live · scanned ${ago(state.scannedAt)} · ${state.scanMs} ms` : 'reconnecting…'}</div>
      </header>

      <main className="body">
        <section className="map">
          {empty ? (
            <div className="empty">
              <h2>Nothing to draw yet</h2>
              <p>No Django backend or React app found in <code>{g.root}</code>. Point TraceFlow at a project folder.</p>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={(_, n) => n.type === 'card' && focus(n.id)}
              onPaneClick={() => setSelected(null)}
              onMoveStart={(e) => { if (e) userMoved.current = true; }}
              minZoom={0.15}
              maxZoom={2}
              nodesConnectable={false}
              nodesDraggable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Lines} gap={48} color="#101114" />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
          )}
          <div className="legend">
            <span><i className="lg lg-new" /> new</span>
            <span><i className="lg lg-changed" /> changed</span>
            <span><i className="lg lg-removed" /> removed</span>
            <span><i className="lg lg-live" /> request</span>
          </div>
        </section>

        <aside className="side">
          <nav className="tabs">
            <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changes <b className={changes.length ? 'red' : ''}>{changes.length}</b></button>
            <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>Live <b className={errors ? 'red' : ''}>{traffic.length}</b></button>
            <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>Details</button>
          </nav>
          <div className="panel">
            {tab === 'changes' && <ChangesPanel state={state} onFocus={focus} />}
            {tab === 'live' && <LivePanel traffic={traffic} state={state} onFocus={focus} />}
            {tab === 'details' && <Details state={state} id={selected} traffic={traffic} />}
          </div>
        </aside>
      </main>
    </div>
  );
}

const editorLink = (root: string, file?: string, line?: number) => (file ? `vscode://file/${root}/${file}:${line ?? 1}` : undefined);

function ChangesPanel({ state, onFocus }: { state: State; onFocus: (id: string) => void }) {
  useLive();
  const { changes, since } = state.diff;
  return (
    <>
      <div className="panel-head">
        <span>Since {new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <button className="ghost" onClick={() => fetch('/api/baseline', { method: 'POST' })}>Start over</button>
      </div>
      {!changes.length && (
        <div className="hint">
          <p>No architecture changes yet.</p>
          <p>Ask your agent to build something. New pages, endpoints and models light up here and on the map as files are saved.</p>
        </div>
      )}
      <ul className="changes">
        {changes.map((c: Change) => (
          <li key={c.kind + c.id} className={`ch ch-${c.kind}`} onClick={() => c.kind !== 'removed' && onFocus(c.id)}>
            <div className="ch-top">
              <span className={`tag tag-${c.kind}`}>{TAG[c.kind]}</span>
              <span className="ch-entity">{c.entity}</span>
              <span className="ch-time">{ago(c.at)}</span>
            </div>
            <div className="ch-label">{c.label}</div>
            {c.detail.length > 0 && <div className="ch-detail">{c.detail.slice(0, 5).map((d) => <div key={d}>{d}</div>)}</div>}
            {c.file && <a className="loc" href={editorLink(state.graph.root, c.file, c.line)} onClick={(e) => e.stopPropagation()}>{c.file}:{c.line}</a>}
          </li>
        ))}
      </ul>
    </>
  );
}

function LivePanel({ traffic, state, onFocus }: { traffic: TrafficEvent[]; state: State; onFocus: (id: string) => void }) {
  useLive();
  const lastMin = traffic.filter((t) => Date.now() - t.ts < 60000);
  const errs = lastMin.filter((t) => t.status >= 500).length;
  const times = lastMin.map((t) => t.durationMs).filter((x): x is number => x != null).sort((a, b) => a - b);
  const p50 = times.length ? Math.round(times[Math.floor(times.length / 2)]) : null;
  return (
    <>
      <div className="stats">
        <div><b>{lastMin.length}</b><span>req / min</span></div>
        <div className={errs ? 'bad' : ''}><b>{errs}</b><span>5xx / min</span></div>
        <div><b>{p50 ?? '—'}</b><span>p50 ms</span></div>
      </div>
      {!traffic.length && (
        <div className="hint">
          <p>No requests yet.</p>
          <p>Add <code>TraceFlowMiddleware</code> to Django or call <code>initTraceFlow()</code> in your React app (both in <code>sdk/</code>), then click around. Or run <code>traceflow simulate</code>.</p>
        </div>
      )}
      <ul className="log">
        {traffic.slice().reverse().slice(0, 120).map((t) => (
          <li key={t.id} className={t.status >= 500 ? 'bad' : t.status >= 400 ? 'warn' : ''} onClick={() => t.endpoint && onFocus(t.endpoint)}>
            <span className="st">{t.status}</span>
            <span className="mt">{t.method}</span>
            <span className="pt">{t.path}</span>
            <span className="ms">{t.durationMs != null ? `${Math.round(t.durationMs)}ms` : ''}</span>
            {!t.endpoint && state.graph.endpoints.length > 0 && <span className="unk" title="Not found in code">?</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Details({ state, id, traffic }: { state: State; id: string | null; traffic: TrafficEvent[] }) {
  const g = state.graph;
  const root = g.root;
  if (!id) {
    return (
      <div className="overview">
        <div className="counts">
          <div><b>{g.pages.length}</b><span>pages</span></div>
          <div><b>{g.endpoints.length}</b><span>endpoints</span></div>
          <div><b>{g.models.length}</b><span>models</span></div>
        </div>
        <p className="hint">Click anything on the map to see where it lives, what it calls and what calls it.</p>
        {g.unmatchedCalls.length > 0 && (
          <>
            <h4>Calls with no endpoint in code</h4>
            <ul className="plain">{g.unmatchedCalls.slice(0, 8).map((c, i) => <li key={i}><code>{c.method} {c.path}</code> from {c.from}</li>)}</ul>
          </>
        )}
      </div>
    );
  }
  const page = [...g.pages, ...state.diff.removed.pages].find((p) => p.id === id);
  const ep = [...g.endpoints, ...state.diff.removed.endpoints].find((e) => e.id === id);
  const model = [...g.models, ...state.diff.removed.models].find((m) => m.id === id);
  const link = (file?: string, line?: number) => file && <a className="loc" href={editorLink(root, file, line)}>{file}:{line}</a>;

  if (page) {
    return (
      <div className="details">
        <span className="kicker">Page</span>
        <h3>{page.path ?? page.name}</h3>
        <p>{page.component} {link(page.file, page.line)}</p>
        <h4>Calls</h4>
        <ul className="plain">{page.calls.length ? page.calls.map((c) => <li key={c.endpoint + c.method}><code>{c.method} {g.endpoints.find((e) => e.id === c.endpoint)?.path}</code> {link(c.file, c.line)}</li>) : <li>No API calls found</li>}</ul>
      </div>
    );
  }
  if (ep) {
    const callers = g.pages.filter((p) => p.calls.some((c) => c.endpoint === ep.id));
    const hits = traffic.filter((t) => t.endpoint === ep.id);
    return (
      <div className="details">
        <span className="kicker">Endpoint</span>
        <h3>{ep.path}</h3>
        <p>{ep.methods.join(' · ')}</p>
        <h4>Code</h4>
        <ul className="plain">
          <li>route {link(ep.file, ep.line)}</li>
          <li>view <code>{ep.view}</code> {link(ep.viewFile, ep.viewLine)}</li>
        </ul>
        <h4>Uses</h4>
        <ul className="plain">{ep.models.length ? ep.models.map((m) => <li key={m}><code>{m}</code></li>) : <li>No models detected</li>}</ul>
        <h4>Called by</h4>
        <ul className="plain">{callers.length ? callers.map((p) => <li key={p.id}>{p.path ?? p.name}</li>) : <li>No page calls it</li>}</ul>
        <h4>Traffic</h4>
        <p>{hits.length} requests · {hits.filter((h) => h.status >= 500).length} errors</p>
      </div>
    );
  }
  if (model) {
    const users = g.endpoints.filter((e) => e.models.includes(model.name));
    return (
      <div className="details">
        <span className="kicker">Model</span>
        <h3>{model.name}</h3>
        <p>{link(model.file, model.line)}</p>
        <h4>Fields</h4>
        <ul className="plain">{model.fields.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
        {model.relations.length > 0 && (<><h4>Links</h4><ul className="plain">{model.relations.map((r) => <li key={r.field}><code>{r.field}</code> → {r.target}</li>)}</ul></>)}
        <h4>Used by</h4>
        <ul className="plain">{users.length ? users.map((e) => <li key={e.id}><code>{e.methods.join('/')} {e.path}</code></li>) : <li>No endpoint uses it</li>}</ul>
      </div>
    );
  }
  return <p className="hint">That item is no longer in the project.</p>;
}

createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
