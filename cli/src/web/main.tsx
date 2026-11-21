// The live map in the browser: blocks, links, changes and requests.
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { Icon } from './icons';
import { NODE_H, NODE_W, bounds, placeModules, wrap, type Placed } from './layout';
import type { Change, Module, State, TrafficEvent } from '../types';

type Tab = 'block' | 'changes' | 'live';
interface Pulse { id: number; edge: string; error: boolean }

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmt = (n: number) => n.toLocaleString('en-US');
const editor = (root: string, file?: string, line = 1) => (file ? `vscode://file/${root}/${file}:${line}` : undefined);

/** Which block a change belongs to. */
function moduleOf(c: Change, mods: Module[]): string | undefined {
  if (c.entity === 'module') return c.id;
  const key = c.entity === 'endpoint' ? 'endpointIds' : c.entity === 'model' ? 'modelIds' : c.entity === 'page' ? 'pageIds' : null;
  if (key) return mods.find((m) => m[key]?.includes(c.id))?.id;
  return c.file ? mods.find((m) => m.files.some((f) => f.path === c.file))?.id : undefined;
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [traffic, setTraffic] = useState<TrafficEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<Tab>('block');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [hits, setHits] = useState<Map<string, { status: number; ts: number; count: number }>>(new Map());
  const [, tick] = useState(0);
  const graphRef = useRef<State | null>(null);
  graphRef.current = state;

  const mods = useMemo(() => (state ? [...state.graph.modules, ...(state.diff.removed.modules ?? [])] : []), [state]);
  const edges = useMemo(() => state?.graph.moduleEdges ?? [], [state]);
  const visibleChanges = useMemo(() => (state ? state.diff.changes.filter((c) => cursor == null || c.at <= cursor) : []), [state, cursor]);
  const status = useMemo(() => {
    const s = new Map<string, Change['kind']>();
    for (const c of visibleChanges) {
      const m = moduleOf(c, mods);
      if (!m) continue;
      if (c.entity === 'module' || !s.has(m)) s.set(m, c.entity === 'module' ? c.kind : s.get(m) ?? 'changed');
    }
    return s;
  }, [visibleChanges, mods]);
  // Before the cursor, blocks added later did not exist yet.
  const hiddenLater = useMemo(() => {
    if (cursor == null || !state) return new Set<string>();
    return new Set(state.diff.changes.filter((c) => c.entity === 'module' && c.kind === 'added' && c.at > cursor).map((c) => c.id));
  }, [state, cursor]);

  const placed = useMemo(() => placeModules(mods.filter((m) => !hiddenLater.has(m.id)), edges), [mods, edges, hiddenLater]);
  const pos = useMemo(() => new Map(placed.map((p) => [p.m.id, p])), [placed]);
  const box = useMemo(() => bounds(placed), [placed]);

  // viewBox with pan and zoom; fits itself until the user moves it
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const moved = useRef(false);
  useEffect(() => { if (!moved.current) setView(box); }, [box]);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    if (!view || !svgRef.current) return;
    moved.current = true;
    const r = svgRef.current.getBoundingClientRect();
    const k = Math.exp(e.deltaY * 0.0015);
    const scale = Math.max(view.w / r.width, view.h / r.height);
    const px = view.x + (e.clientX - r.left - (r.width - view.w / scale) / 2) * scale;
    const py = view.y + (e.clientY - r.top - (r.height - view.h / scale) / 2) * scale;
    setView({ x: px - (px - view.x) * k, y: py - (py - view.y) * k, w: view.w * k, h: view.h * k });
  };
  const onDown = (e: React.PointerEvent) => {
    if (!view || (e.target as Element).closest('.node')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !view || !svgRef.current) return;
    moved.current = true;
    const r = svgRef.current.getBoundingClientRect();
    const scale = Math.max(view.w / r.width, view.h / r.height);
    setView({ ...view, x: drag.current.vx - (e.clientX - drag.current.x) * scale, y: drag.current.vy - (e.clientY - drag.current.y) * scale });
  };
  const fit = () => { moved.current = false; setView(box); };

  // live requests: a red dot runs into the block that serves the endpoint
  const onTraffic = useCallback((t: TrafficEvent) => {
    setTraffic((xs) => [...xs.slice(-399), t]);
    const s = graphRef.current;
    if (!t.endpoint || !s) return;
    const target = s.graph.modules.find((m) => m.endpointIds?.includes(t.endpoint!))?.id;
    if (!target) return;
    setHits((h) => new Map(h).set(target, { status: t.status, ts: Date.now(), count: (h.get(target)?.count ?? 0) + 1 }));
    const incoming = s.graph.moduleEdges.filter((e) => e.target === target);
    const lanes = incoming.filter((e) => e.kind === 'http');
    const born = (lanes.length ? lanes : incoming).map((e) => ({ id: Math.random(), edge: `${e.source}->${e.target}`, error: t.status >= 500 }));
    if (!born.length) return;
    setPulses((p) => [...p, ...born]);
    setTimeout(() => setPulses((p) => p.filter((x) => !born.includes(x))), 1300);
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
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => { es.close(); clearInterval(t); };
  }, [onTraffic]);

  // pick the busiest block first so the side panel is never empty
  useEffect(() => {
    if (!selected && placed.length) setSelected((placed.find((p) => p.hub) ?? placed[0]).m.id);
  }, [placed, selected]);

  if (!state) return <div className="boot"><span className="dot pulse" />Reading the project</div>;
  const g = state.graph;
  const near = hover ? new Set([hover, ...edges.filter((e) => e.source === hover || e.target === hover).flatMap((e) => [e.source, e.target])]) : null;
  const errorsMin = traffic.filter((t) => t.status >= 500 && Date.now() - t.ts < 60000).length;

  const anchor = (p: Placed, side: 'top' | 'bottom' | 'left' | 'right') => {
    const cx = p.x + 40;
    if (side === 'top') return [cx, p.y - 14];
    if (side === 'bottom') return [cx, p.y + NODE_H + 18];
    const cy = p.y + 28;
    return side === 'right' ? [p.x + NODE_W + 6, cy] : [p.x - 14, cy];
  };
  const curve = (a: Placed, b: Placed) => {
    if (Math.abs(a.y - b.y) < 10) {
      const [x1, y1] = anchor(a, a.x < b.x ? 'right' : 'left');
      const [x2, y2] = anchor(b, a.x < b.x ? 'left' : 'right');
      const dx = (x2 - x1) * 0.4;
      return `M${x1} ${y1} C${x1 + dx} ${y1 - 30} ${x2 - dx} ${y2 - 30} ${x2} ${y2}`;
    }
    const down = b.y > a.y;
    const [x1, y1] = anchor(a, down ? 'bottom' : 'top');
    const [x2, y2] = anchor(b, down ? 'top' : 'bottom');
    const rowsApart = Math.abs(b.y - a.y) / 250;
    if (rowsApart > 1.5) {
      // Skip past the rows in between through the gap beside the blocks, not through their text.
      // find a vertical lane that no block in the rows between touches
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      const between = placed.filter((p) => p.y > lo + 5 && p.y < hi - 5);
      const blocked = (x: number) => between.some((p) => x > p.x - 16 && x < p.x + NODE_W + 16);
      let right = Math.max(a.x, b.x) + NODE_W + 26;
      for (let i = 0; i < 20 && blocked(right); i++) right = Math.max(...between.filter((p) => right > p.x - 16 && right < p.x + NODE_W + 16).map((p) => p.x)) + NODE_W + 26;
      let left = Math.min(a.x, b.x) - 26;
      for (let i = 0; i < 20 && blocked(left); i++) left = Math.min(...between.filter((p) => left > p.x - 16 && left < p.x + NODE_W + 16).map((p) => p.x)) - 26;
      const gx = Math.abs(right - x1) <= Math.abs(left - x1) ? right : left;
      const s = down ? 1 : -1;
      return `M${x1} ${y1} C${x1} ${y1 + 50 * s} ${gx} ${y1 + 20 * s} ${gx} ${y1 + 80 * s} L${gx} ${y2 - 80 * s} C${gx} ${y2 - 20 * s} ${x2} ${y2 - 50 * s} ${x2} ${y2}`;
    }
    const k = (y2 - y1) * 0.5;
    return `M${x1} ${y1} C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`;
  };
  const added = new Set(state.diff.addedEdges);

  return (
    <div className="app">
      <header className="top">
        <div className="crumb">TRACEFLOW <span>/</span> <b>{g.project}</b></div>
        <div className="stack">{g.stack.join(' · ')}</div>
        <div className="live"><span className={`dot ${online ? 'pulse' : 'off'}`} />{online ? `live · ${placed.length} blocks · ${fmt(g.modules.reduce((s, m) => s + m.lines, 0))} lines` : 'reconnecting'}</div>
      </header>

      <main className="main">
        <section className="stage">
          {!mods.length ? (
            <div className="empty"><h2>Nothing to draw yet</h2><p>No source files found in <code>{g.root}</code>.</p></div>
          ) : (
            <svg ref={svgRef} className="map" viewBox={view ? `${view.x} ${view.y} ${view.w} ${view.h}` : undefined} preserveAspectRatio="xMidYMid meet"
              onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onDoubleClick={fit}
              role="img" aria-label={`Map of ${g.project}`}>
              <defs>
                <radialGradient id="halo"><stop offset="0" stopColor="#ff2a2a" stopOpacity=".5" /><stop offset=".45" stopColor="#ff2a2a" stopOpacity=".12" /><stop offset="1" stopColor="#ff2a2a" stopOpacity="0" /></radialGradient>
              </defs>
              <g>
                {edges.map((e) => {
                  const a = pos.get(e.source), b = pos.get(e.target);
                  if (!a || !b) return null;
                  const id = `${e.source}->${e.target}`;
                  const lit = near && near.has(e.source) && near.has(e.target);
                  const cls = ['ln', e.kind === 'http' && 'http', added.has(id) && 'new', lit && 'on', near && !lit && 'dim'].filter(Boolean).join(' ');
                  const d = curve(a, b);
                  return (
                    <g key={id}>
                      <path d={d} className={cls} />
                      {pulses.filter((p) => p.edge === id).map((p) => (
                        <circle key={p.id} r={p.error ? 4.5 : 3} className={p.error ? 'req err' : 'req'} style={{ offsetPath: `path('${d}')` }} />
                      ))}
                    </g>
                  );
                })}
              </g>
              <g>
                {placed.map((p) => {
                  const st = status.get(p.m.id);
                  const hot = st === 'added' || st === 'changed';
                  const hit = hits.get(p.m.id);
                  const failing = hit && hit.status >= 500 && Date.now() - hit.ts < 10000;
                  const size = p.hub ? 34 : 24;
                  const lines = wrap(p.m.desc || `${p.m.language} · ${p.m.path === '.' ? 'project root' : p.m.path}`, 31);
                  const cls = ['node', st === 'removed' && 'ghost', near && !near.has(p.m.id) && 'dim', p.m.id === selected && 'sel'].filter(Boolean).join(' ');
                  return (
                    <g key={p.m.id} className={cls} transform={`translate(${p.x} ${p.y})`} tabIndex={0} role="button" aria-label={`${p.m.name}. ${p.m.desc}`}
                      onMouseEnter={() => setHover(p.m.id)} onMouseLeave={() => setHover(null)}
                      onClick={() => { setSelected(p.m.id); setTab('block'); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(p.m.id); setTab('block'); } }}>
                      <rect x={-20} y={-24} width={NODE_W + 40} height={NODE_H + 30} fill="transparent" />
                      {(hot || p.hub || failing) && <circle cx={40} cy={28} r={hot || failing ? 74 : 62} fill="url(#halo)" className={hot || failing ? 'breathe' : 'soft'} />}
                      <g className={`ic${hot || failing ? ' hot' : ''}`} transform={p.hub ? 'translate(-12 -10) scale(1.3)' : undefined}><Icon kind={p.m.kind} /></g>
                      <text x={0} y={56 + 22 + size * 0.75} className="title" fontSize={size}>{p.m.name}</text>
                      {hot && (
                        <g transform={`translate(${Math.min(p.m.name.length * size * 0.56, NODE_W - 40) + 12} ${56 + 22 + size * 0.75 - 13})`}>
                          <rect width={st === 'added' ? 38 : 58} height={17} rx={8.5} className="pill" />
                          <text x={st === 'added' ? 19 : 29} y={12} textAnchor="middle" className="pill-t">{st === 'added' ? 'NEW' : 'EDITED'}</text>
                        </g>
                      )}
                      {lines.map((l, i) => <text key={i} x={0} y={56 + 22 + size * 0.75 + 24 + i * 19} className="desc">{l}</text>)}
                      <text x={0} y={NODE_H + 2} className={`meta${hot ? ' red' : ''}`}>
                        {hot ? `${ago(visibleChanges.find((c) => moduleOf(c, mods) === p.m.id)?.at ?? Date.now())} · by agent` : st === 'removed' ? 'removed' : `${p.m.files.length} file${p.m.files.length === 1 ? '' : 's'} · ${fmt(p.m.lines)} lines${hit ? ` · ${hit.count} req` : ''}`}
                      </text>
                      {p.m.id === selected && <rect x={0} y={NODE_H + 12} width={Math.min(p.m.name.length * size * 0.56, NODE_W)} height={1} className="underline" />}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          <div className="legend">
            <span><i className="lg-red" />changed by agent</span>
            <span><i className="lg-http" />http</span>
            <span><i className="lg-imp" />imports</span>
            <button className="link" onClick={fit}>fit</button>
          </div>
        </section>

        <aside className="side">
          <nav className="tabs">
            <button className={tab === 'block' ? 'on' : ''} onClick={() => setTab('block')}>Block</button>
            <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changes{visibleChanges.length > 0 && <b>{visibleChanges.length}</b>}</button>
            <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>Live{traffic.length > 0 && <b className={errorsMin ? '' : 'grey'}>{traffic.length}</b>}</button>
          </nav>
          <div className="panel">
            {tab === 'block' && <BlockPanel state={state} id={selected} status={status} changes={visibleChanges} mods={mods} onPick={setSelected} traffic={traffic} />}
            {tab === 'changes' && <ChangesPanel state={state} changes={visibleChanges} mods={mods} onPick={(id) => { setSelected(id); setTab('block'); }} />}
            {tab === 'live' && <LivePanel traffic={traffic} />}
          </div>
        </aside>
      </main>

      <Timeline state={state} cursor={cursor} setCursor={setCursor} />
    </div>
  );
}

function BlockPanel({ state, id, status, changes, mods, onPick, traffic }: {
  state: State; id: string | null; status: Map<string, Change['kind']>; changes: Change[]; mods: Module[]; onPick: (id: string) => void; traffic: TrafficEvent[];
}) {
  const g = state.graph;
  const m = mods.find((x) => x.id === id);
  if (!m) return <p className="muted">Click a block on the map.</p>;
  const name = (mid: string) => mods.find((x) => x.id === mid)?.name ?? mid;
  const uses = g.moduleEdges.filter((e) => e.source === m.id);
  const usedBy = g.moduleEdges.filter((e) => e.target === m.id);
  const st = status.get(m.id);
  const max = Math.max(1, ...m.files.map((f) => f.lines));
  const eps = g.endpoints.filter((e) => m.endpointIds?.includes(e.id));
  const models = g.models.filter((x) => m.modelIds?.includes(x.id));
  const pages = g.pages.filter((p) => m.pageIds?.includes(p.id));
  const mine = changes.filter((c) => moduleOf(c, mods) === m.id);
  const reqs = traffic.filter((t) => t.endpoint && m.endpointIds?.includes(t.endpoint));
  const source = m.descSource === 'code' ? 'summary from code' : m.descSource ? `from ${m.descSource}` : '';
  return (
    <>
      <div className="k">{st && st !== 'removed' ? <span className="red">changed by agent</span> : `${m.language} · ${m.path}`}</div>
      <h2>{m.name}</h2>
      {m.desc && <p>{m.desc}</p>}
      {source && <div className="src">{source}</div>}
      <div className="fig">
        <div><b>{m.files.length}</b><span>FILES</span></div>
        <div><b>{fmt(m.lines)}</b><span>LINES</span></div>
        <div><b>{uses.length + usedBy.length}</b><span>LINKS</span></div>
        {reqs.length > 0 && <div><b>{reqs.length}</b><span>REQUESTS</span></div>}
      </div>
      <ul className="rows">
        {m.files.slice(0, 12).map((f) => {
          const touched = mine.some((c) => c.detail.some((d) => d.includes(f.path)) || c.file === f.path);
          return (
            <li key={f.path} className={touched ? 'red' : ''}>
              <a href={editor(g.root, f.path)}>{f.path}</a><span>{fmt(f.lines)}</span>
              <i style={{ width: `${(f.lines / max) * 100}%` }} />
            </li>
          );
        })}
        {m.files.length > 12 && <li className="more">+ {m.files.length - 12} more files</li>}
      </ul>
      {eps.length > 0 && (
        <div className="sec"><div className="k">Endpoints</div>
          <ul className="list">{eps.map((e) => <li key={e.id}><span className="mth">{e.methods.join(' ')}</span> {e.path}</li>)}</ul></div>
      )}
      {models.length > 0 && (
        <div className="sec"><div className="k">Models</div>
          <ul className="list">{models.map((x) => <li key={x.id}>{x.name} <span className="muted">· {x.fields.length} fields</span></li>)}</ul></div>
      )}
      {pages.length > 0 && (
        <div className="sec"><div className="k">Pages</div>
          <ul className="list">{pages.map((p) => <li key={p.id}>{p.path ?? p.name} <span className="muted">· {p.calls.length} API calls</span></li>)}</ul></div>
      )}
      {uses.length > 0 && (
        <div className="sec"><div className="k">Uses</div><div className="rel">{uses.map((e) => <button key={e.target} onClick={() => onPick(e.target)}>{name(e.target)}{e.kind === 'http' && <em> http</em>}</button>)}</div></div>
      )}
      {usedBy.length > 0 && (
        <div className="sec"><div className="k">Used by</div><div className="rel">{usedBy.map((e) => <button key={e.source} onClick={() => onPick(e.source)}>{name(e.source)}{e.kind === 'http' && <em> http</em>}</button>)}</div></div>
      )}
      {mine.length > 0 && (
        <div className="sec"><div className="k">This session</div><Feed changes={mine} /></div>
      )}
    </>
  );
}

function Feed({ changes, onPick, mods }: { changes: Change[]; onPick?: (id: string) => void; mods?: Module[] }) {
  return (
    <ul className="feed">
      {changes.map((c) => {
        const target = mods ? moduleOf(c, mods) : undefined;
        return (
          <li key={c.kind + c.entity + c.id} className={c.kind} onClick={() => target && onPick?.(target)}>
            <time>{clock(c.at)}</time>
            <div>
              <b>{c.label}</b>
              <span>{c.kind === 'added' ? 'new' : c.kind === 'removed' ? 'removed' : 'edited'} {c.entity === 'module' ? 'block' : c.entity}</span>
              {c.detail.slice(0, 3).map((d) => <span key={d} className="d">{d}</span>)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ChangesPanel({ state, changes, mods, onPick }: { state: State; changes: Change[]; mods: Module[]; onPick: (id: string) => void }) {
  return (
    <>
      <div className="head">
        <span>since {clock(state.diff.since)}</span>
        <button className="link" onClick={() => fetch('/api/baseline', { method: 'POST' })}>start over</button>
      </div>
      {changes.length ? <Feed changes={changes} onPick={onPick} mods={mods} /> : (
        <p className="muted">Nothing changed yet. Ask your agent to build something and watch the blocks light up as files are saved.</p>
      )}
    </>
  );
}

function LivePanel({ traffic }: { traffic: TrafficEvent[] }) {
  const lastMin = traffic.filter((t) => Date.now() - t.ts < 60000);
  const errs = lastMin.filter((t) => t.status >= 500).length;
  const times = lastMin.map((t) => t.durationMs).filter((x): x is number => x != null).sort((a, b) => a - b);
  const p50 = times.length ? Math.round(times[Math.floor(times.length / 2)]) : null;
  return (
    <>
      <div className="fig">
        <div><b>{lastMin.length}</b><span>REQ / MIN</span></div>
        <div className={errs ? 'red' : ''}><b>{errs}</b><span>5XX / MIN</span></div>
        <div><b>{p50 ?? '—'}</b><span>P50 MS</span></div>
      </div>
      {!traffic.length && (
        <p className="muted">No requests yet. Add the TraceFlow middleware (Django) or <code>initTraceFlow()</code> (React) from <code>sdk/</code>, or run <code>traceflow simulate</code>.</p>
      )}
      <ul className="log">
        {traffic.slice().reverse().slice(0, 150).map((t) => (
          <li key={t.id} className={t.status >= 500 ? 'bad' : ''}>
            <span>{t.status}</span><span>{t.method}</span><span className="p">{t.path}</span>
            <span>{t.durationMs != null ? `${Math.round(t.durationMs)}ms` : ''}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Timeline({ state, cursor, setCursor }: { state: State; cursor: number | null; setCursor: (t: number | null) => void }) {
  const start = state.diff.since;
  const now = Date.now();
  const span = Math.max(1000, now - start);
  const at = (t: number) => `${((t - start) / span) * 100}%`;
  const times = [...new Set(state.diff.changes.map((c) => c.at))].sort((a, b) => a - b);
  const pos = cursor ?? now;
  return (
    <footer className="bottom">
      <span>{clock(start)}</span>
      <div className="track" role="slider" tabIndex={0} aria-label="Session history" aria-valuenow={pos} aria-valuemin={start} aria-valuemax={now}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = start + ((e.clientX - r.left) / r.width) * span;
          const snap = times.filter((x) => x <= t).pop();
          setCursor(t > now - span * 0.02 ? null : snap ?? start);
        }}
        onKeyDown={(e) => {
          const i = cursor == null ? times.length : times.findIndex((x) => x >= cursor);
          if (e.key === 'ArrowLeft') setCursor(times[Math.max(0, i - 1)] ?? start);
          if (e.key === 'ArrowRight') setCursor(i + 1 >= times.length ? null : times[i + 1]);
        }}>
        <div className="base" />
        <div className="fill" style={{ width: at(pos) }} />
        {times.map((t) => <div key={t} className="tick" style={{ left: at(t) }} />)}
        <div className="knob" style={{ left: at(pos) }} />
      </div>
      <span>{cursor == null ? `now · ${state.diff.changes.length} change${state.diff.changes.length === 1 ? '' : 's'}` : <button className="link" onClick={() => setCursor(null)}>{clock(cursor)} · back to now</button>}</span>
    </footer>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
