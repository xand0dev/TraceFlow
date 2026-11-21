// Shapes produced by parser.py (schema 2) and shared by the core, the MCP server and the web map.

export interface CallLink {
  endpoint: string;
  method: string;
  file: string;
  line: number;
}

export interface Page {
  id: string;
  name: string;
  path?: string;
  component: string;
  service: string;
  file: string;
  line: number;
  auth?: boolean;
  navType?: string;
  calls: CallLink[];
}

export interface Endpoint {
  id: string;
  path: string;
  view: string;
  name: string;
  type: string;
  methods: string[];
  models: string[];
  group: string;
  file: string;
  line: number;
  viewFile?: string;
  viewLine?: number;
}

export interface Model {
  id: string;
  name: string;
  fields: string[];
  relations: { field: string; type: string; target: string }[];
  file: string;
  line: number;
}

export interface Service {
  id: string;
  name: string;
  type: 'frontend' | 'backend' | 'database';
  subtype?: 'web' | 'mobile';
  root?: string;
  calls?: CallLink[];
}

export interface ModuleFile {
  path: string;
  lines: number;
}

/** A block on the system map: a folder or a file, found for any language. */
export interface Module {
  id: string;
  name: string;
  desc: string;
  /** Where the description came from: package.json, a docstring, README, or "code" for a generated summary. */
  descSource: string;
  kind: 'terminal' | 'editor' | 'plug' | 'core' | 'parser' | 'antenna' | 'book' | 'database' | 'browser' | 'server' | 'cube';
  path: string;
  language: string;
  files: ModuleFile[];
  lines: number;
  counts?: { endpoints: number; models: number; pages: number };
  endpointIds?: string[];
  modelIds?: string[];
  pageIds?: string[];
}

export interface ModuleEdge {
  source: string;
  target: string;
  weight: number;
  kind?: 'http';
}

export interface Edge {
  source: string;
  target: string;
  kind: 'calls' | 'uses' | 'relation';
  method?: string;
  field?: string;
}

export interface Graph {
  schema: number;
  root: string;
  project: string;
  stack: string[];
  services: Service[];
  pages: Page[];
  endpoints: Endpoint[];
  models: Model[];
  edges: Edge[];
  unmatchedCalls: { path: string; method: string; file: string; line: number; from: string }[];
  modules: Module[];
  moduleEdges: ModuleEdge[];
  sharedFiles: string[];
}

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface Change {
  id: string;
  kind: ChangeKind;
  entity: 'page' | 'endpoint' | 'model' | 'service' | 'module';
  label: string;
  detail: string[];
  file?: string;
  line?: number;
  at: number;
}

export interface Diff {
  since: number;
  changes: Change[];
  /** Entities that existed at the baseline and are gone now, so the map can draw them as ghosts. */
  removed: { pages: Page[]; endpoints: Endpoint[]; models: Model[]; modules: Module[] };
  addedEdges: string[];
}

export interface TrafficEvent {
  id: number;
  ts: number;
  source: string;
  method: string;
  path: string;
  status: number;
  durationMs?: number;
  endpoint?: string;
}

export interface State {
  graph: Graph;
  diff: Diff;
  traffic: TrafficEvent[];
  scannedAt: number;
  scanMs: number;
  error?: string;
}

export const edgeKey = (e: Edge) => `${e.source}->${e.target}`;
