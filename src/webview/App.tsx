// src/webview/App.tsx
// ──────────────────────────────────────────────────────────────────────────────
// TraceFlow — Architecture Visualization Webview
// Dynamic granularity: click to drill into service blocks.
// Frontends show pages/screens, Backend shows grouped endpoints + models.
// Uses Dagre for automatic, beautiful directed graph layout.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  MarkerType,
  ConnectionLineType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  BackgroundVariant,
} from 'reactflow';
import dagre from 'dagre';

import 'reactflow/dist/style.css';
import './styles.css';

import ServiceNode from './nodes/ServiceNode';
import EndpointNode from './nodes/EndpointNode';
import ModelNode from './nodes/ModelNode';
import PageNode from './nodes/PageNode';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface ParsedService {
  id: string; name: string; type: string; subtype?: string;
  pages?: FrontendPage[]; screens?: FrontendScreen[];
}
interface FrontendPage { name: string; path: string; component: string; auth?: boolean; }
interface FrontendScreen { name: string; component: string; navType: string; title?: string; }
interface ParsedEndpoint {
  path: string; view: string; methods: string[];
  type?: string; name?: string; group?: string; groupOrder?: number;
}
interface ParsedModel { name: string; fields: string[]; }
interface ArchitectureData { services: ParsedService[]; endpoints: ParsedEndpoint[]; models: ParsedModel[]; }
interface TelemetryMessage { source: string; target: string; status: number; method: string; }
interface VSCodeMessage { type: 'init' | 'telemetry'; payload: ArchitectureData | TelemetryMessage; }

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(state: any): void; };
const vscode = acquireVsCodeApi();

const nodeTypes = {
  serviceNode: ServiceNode,
  endpointNode: EndpointNode,
  modelNode: ModelNode,
  pageNode: PageNode,
};

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const W = 220;
const SVC_H = 70;
const EP_H = 55;
const MODEL_H = 150;
const PAGE_H = 55;

// Group metadata
const GROUPS: Record<string, { icon: string; label: string; color: string }> = {
  auth:     { icon: '🔐', label: 'Authentication',   color: '#e3b341' },
  public:   { icon: '🌐', label: 'Public API',       color: '#79c0ff' },
  member:   { icon: '👤', label: 'Member / Profile',  color: '#7ee787' },
  admin:    { icon: '🛡️', label: 'Admin Panel',      color: '#f0883e' },
  owner:    { icon: '👑', label: 'Owner / SaaS',     color: '#a371f7' },
  trainer:  { icon: '🏋️', label: 'Trainer',           color: '#56d364' },
  payments: { icon: '💳', label: 'Payments',          color: '#ffa198' },
  exports:  { icon: '📊', label: 'Import / Export',   color: '#79c0ff' },
  system:   { icon: '⚙️', label: 'System / Docs',    color: '#8b949e' },
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function dedup(eps: ParsedEndpoint[]): ParsedEndpoint[] {
  const m = new Map<string, ParsedEndpoint>();
  for (const ep of eps) {
    const k = ep.view + ':' + ep.path.replace('{id}/', '');
    const prev = m.get(k);
    if (prev) { prev.methods = [...new Set([...prev.methods, ...ep.methods])]; }
    else { m.set(k, { ...ep }); }
  }
  return [...m.values()];
}

// ──────────────────────────────────────────────────────────────────────────────
// Layout builder with Dagre
// ──────────────────────────────────────────────────────────────────────────────

interface ExpandState { [id: string]: boolean; }

function getLayoutedElements(nodes: Node[], edges: Edge[]) {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Configure general layout
  dagreGraph.setGraph({ 
    rankdir: 'TB',
    nodesep: 40,
    edgesep: 40,
    ranksep: 80,
  });

  // Add nodes to dagre
  nodes.forEach((node) => {
    let width = W;
    let height = SVC_H;
    
    if (node.type === 'pageNode') height = PAGE_H;
    if (node.type === 'endpointNode') height = EP_H;
    if (node.type === 'modelNode') height = MODEL_H;
    
    // Custom width for header nodes
    if (node.id.startsWith('group-') || node.id === 'models-header') {
      width = W * 2;
      height = 40;
    }

    dagreGraph.setNode(node.id, { width, height });
  });

  // Add edges to dagre
  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  // Execute layout
  dagre.layout(dagreGraph);

  // Apply positions back to nodes
  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    
    // We are shifting the dagre node position (anchor=center center) to the top left
    // so it matches the React Flow node anchor point (top left).
    let width = W;
    let height = SVC_H;
    if (node.type === 'pageNode') height = PAGE_H;
    if (node.type === 'endpointNode') height = EP_H;
    if (node.type === 'modelNode') height = MODEL_H;
    if (node.id.startsWith('group-') || node.id === 'models-header') {
      width = W * 2;
      height = 40;
    }

    return {
      ...node,
      position: {
        x: nodeWithPosition.x - width / 2,
        y: nodeWithPosition.y - height / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

function buildGraph(
  data: ArchitectureData,
  exp: ExpandState,
  toggle: (id: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  let nodes: Node[] = [];
  let edges: Edge[] = [];

  const frontends = data.services.filter(s => s.type === 'frontend');
  const backends  = data.services.filter(s => s.type === 'backend');
  const databases = data.services.filter(s => s.type === 'database');
  const uniqueEps = dedup(data.endpoints);

  // ════════════════════════════════════════════════════════════════════════
  // Frontends
  // ════════════════════════════════════════════════════════════════════════
  for (const svc of frontends) {
    const pages = svc.pages || [];
    const screens = svc.screens || [];
    const childCount = pages.length + screens.length;
    const isExpanded = exp[svc.id] ?? false;

    nodes.push({
      id: svc.id,
      type: 'serviceNode',
      position: { x: 0, y: 0 },
      data: {
        label: svc.name,
        serviceType: 'frontend',
        expanded: isExpanded,
        endpointCount: childCount,
        modelCount: 0,
        onToggleExpand: childCount > 0 ? () => toggle(svc.id) : undefined,
        subtitle: childCount > 0
          ? (isExpanded ? 'EXPANDED' : `${childCount} ${svc.subtype === 'mobile' ? 'screens' : 'pages'}`)
          : 'CLIENT',
      },
    });

    if (isExpanded && childCount > 0) {
      const items = svc.subtype === 'mobile'
        ? screens.map(s => ({ name: s.name, path: undefined as string | undefined, navType: s.navType, auth: false, component: s.component }))
        : pages.map(p => ({ name: p.name, path: p.path, navType: 'route' as string, auth: p.auth ?? false, component: p.component }));

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const nid = `${svc.id}-page-${i}`;
        nodes.push({
          id: nid,
          type: 'pageNode',
          position: { x: 0, y: 0 },
          data: { name: item.name, path: item.path, navType: item.navType as any, auth: item.auth },
        });
        edges.push({
          id: `${svc.id}->${nid}`,
          source: svc.id, target: nid,
          type: 'smoothstep',
          style: { stroke: '#21262d', strokeWidth: 1 },
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Backend
  // ════════════════════════════════════════════════════════════════════════
  for (const svc of backends) {
    const isExp = exp[svc.id] ?? false;

    nodes.push({
      id: svc.id,
      type: 'serviceNode',
      position: { x: 0, y: 0 },
      data: {
        label: svc.name,
        serviceType: 'backend',
        expanded: isExp,
        endpointCount: uniqueEps.length,
        modelCount: data.models.length,
        onToggleExpand: () => toggle(svc.id),
      },
    });

    // Frontend → Backend edges
    for (const fe of frontends) {
      edges.push({
        id: `${fe.id}->${svc.id}`,
        source: fe.id, target: svc.id,
        type: 'smoothstep',
        style: { stroke: '#58a6ff', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#58a6ff', width: 14, height: 14 },
        label: 'REST API',
        labelStyle: { fill: '#6e7681', fontSize: 9 },
        labelBgStyle: { fill: '#0d1117', fillOpacity: 0.85 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
      });
    }

    if (isExp) {
      // Group endpoints
      const grouped = new Map<string, ParsedEndpoint[]>();
      for (const ep of uniqueEps) {
        const g = ep.group || 'public';
        if (!grouped.has(g)) grouped.set(g, []);
        grouped.get(g)!.push(ep);
      }
      const groupOrder = ['auth', 'public', 'member', 'admin', 'owner', 'trainer', 'payments', 'exports', 'system'];
      const sortedGroups = groupOrder.filter(g => grouped.has(g));

      let epIdx = 0;
      for (const groupName of sortedGroups) {
        const groupEps = grouped.get(groupName)!;
        const gm = GROUPS[groupName] || { icon: '📁', label: groupName, color: '#8b949e' };

        const headerId = `group-${groupName}`;
        nodes.push({
          id: headerId,
          type: 'default',
          position: { x: 0, y: 0 },
          data: { label: `${gm.icon}  ${gm.label}  (${groupEps.length})` },
          draggable: false,
          selectable: false,
          style: {
            background: 'transparent',
            border: `1px solid ${gm.color}22`,
            borderRadius: '8px',
            color: gm.color,
            fontSize: '11px',
            fontWeight: '600',
            letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            padding: '5px 14px',
          },
        });
        
        edges.push({
          id: `${svc.id}->${headerId}`,
          source: svc.id, target: headerId,
          type: 'smoothstep',
          style: { stroke: '#21262d', strokeWidth: 1 },
        });

        for (const ep of groupEps) {
          const nid = `ep-${epIdx}`;
          nodes.push({
            id: nid,
            type: 'endpointNode',
            position: { x: 0, y: 0 },
            data: { path: ep.path, methods: ep.methods, view: ep.view },
          });
          edges.push({
            id: `${headerId}->${nid}`,
            source: headerId, target: nid,
            type: 'smoothstep',
            style: { stroke: '#21262d', strokeWidth: 1 },
          });
          epIdx++;
        }
      }

      // Models
      if (data.models.length > 0) {
        nodes.push({
          id: 'models-header',
          type: 'default',
          position: { x: 0, y: 0 },
          data: { label: `🗃️  Django Models  (${data.models.length})` },
          draggable: false,
          selectable: false,
          style: {
            background: 'transparent',
            border: '1px solid #7ee78722',
            borderRadius: '8px',
            color: '#7ee787',
            fontSize: '11px',
            fontWeight: '600',
            letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            padding: '5px 14px',
          },
        });
        
        edges.push({
          id: `${svc.id}->models-header`,
          source: svc.id, target: 'models-header',
          type: 'smoothstep',
          style: { stroke: '#21262d', strokeWidth: 1 },
        });

        for (let i = 0; i < data.models.length; i++) {
          const model = data.models[i];
          const nid = `model-${i}`;
          nodes.push({
            id: nid,
            type: 'modelNode',
            position: { x: 0, y: 0 },
            data: { name: model.name, fields: model.fields },
          });
          edges.push({
            id: `models-header->${nid}`,
            source: 'models-header', target: nid,
            type: 'smoothstep',
            style: { stroke: '#21262d', strokeWidth: 1 },
          });
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Database
  // ════════════════════════════════════════════════════════════════════════
  for (const svc of databases) {
    nodes.push({
      id: svc.id,
      type: 'serviceNode',
      position: { x: 0, y: 0 },
      data: { label: svc.name, serviceType: 'database' },
    });

    for (const be of backends) {
      edges.push({
        id: `${be.id}->${svc.id}`,
        source: be.id, target: svc.id,
        type: 'smoothstep',
        style: { stroke: '#a371f7', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#a371f7', width: 14, height: 14 },
        label: 'ORM',
        labelStyle: { fill: '#6e7681', fontSize: 9 },
        labelBgStyle: { fill: '#0d1117', fillOpacity: 0.85 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
      });

      // Models → DB edges when expanded
      if (exp[be.id]) {
        for (let i = 0; i < data.models.length; i++) {
          edges.push({
            id: `model-${i}->${svc.id}`,
            source: `model-${i}`, target: svc.id,
            type: 'smoothstep',
            style: { stroke: '#21262d', strokeWidth: 1 },
          });
        }
      }
    }
  }

  return getLayoutedElements(nodes, edges);
}

// ──────────────────────────────────────────────────────────────────────────────
// Flow Canvas
// ──────────────────────────────────────────────────────────────────────────────

function FlowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandState, setExpandState] = useState<ExpandState>({});
  const archRef = useRef<ArchitectureData | null>(null);
  const telemetryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const { fitView } = useReactFlow();

  const toggle = useCallback((id: string) => {
    setExpandState(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Rebuild graph on expand changes
  useEffect(() => {
    if (!archRef.current) return;
    const g = buildGraph(archRef.current, expandState, toggle);
    setNodes(g.nodes);
    setEdges(g.edges);
    requestAnimationFrame(() => {
      setTimeout(() => fitView({ padding: 0.15, duration: 600 }), 50);
    });
  }, [expandState, toggle, setNodes, setEdges, fitView]);

  // Telemetry animation
  const animateEdge = useCallback((source: string, target: string, status: number) => {
    const color = (status >= 200 && status < 300) ? '#3fb950' : '#f85149';
    setEdges(cur => cur.map(edge => {
      if (!edge.source.includes(source) && !edge.id.includes(target)) return edge;
      const eid = edge.id;
      const prev = telemetryTimers.current.get(eid);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        setEdges(es => es.map(e => e.id === eid
          ? { ...e, animated: false, style: { ...e.style, stroke: '#30363d', strokeWidth: 2 } } : e
        ));
        telemetryTimers.current.delete(eid);
      }, 2000);
      telemetryTimers.current.set(eid, timer);
      return { ...edge, animated: true, style: { ...edge.style, stroke: color, strokeWidth: 3, filter: `drop-shadow(0 0 6px ${color})` } };
    }));
  }, [setEdges]);

  // Message listener
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const msg: VSCodeMessage = e.data;
      if (msg.type === 'init') {
        const d = msg.payload as ArchitectureData;
        archRef.current = d;
        const init: ExpandState = {};
        for (const s of d.services) init[s.id] = false;
        setExpandState(init);
        setIsLoading(false);
      } else if (msg.type === 'telemetry') {
        const t = msg.payload as TelemetryMessage;
        animateEdge(t.source, t.target, t.status);
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, [animateEdge]);

  const mmColor = useCallback((n: Node) => {
    if (n.type === 'serviceNode') {
      const t = n.data?.serviceType;
      return t === 'frontend' ? '#58a6ff' : t === 'backend' ? '#f0883e' : t === 'database' ? '#a371f7' : '#30363d';
    }
    if (n.type === 'endpointNode') return '#79c0ff';
    if (n.type === 'modelNode') return '#7ee787';
    if (n.type === 'pageNode') return '#58a6ff';
    return '#30363d';
  }, []);

  if (isLoading) {
    return (
      <div className="tf-loading">
        <div className="tf-loading-spinner" />
        <div>Analyzing project architecture…</div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05} maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#21262d" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap nodeColor={mmColor} maskColor="rgba(0,0,0,0.7)" position="bottom-left" pannable zoomable />
      </ReactFlow>
      <div className="tf-zoom-hint">
        Click a service to expand/collapse
      </div>
    </div>
  );
}

function App() {
  return <ReactFlowProvider><FlowCanvas /></ReactFlowProvider>;
}

const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<App />);
