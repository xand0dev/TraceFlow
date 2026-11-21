import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { relative, sep } from 'node:path';
import { computeDiff, emptyDiff } from './diff.js';
import { matchEndpoint, scanProject } from './scan.js';
import type { Diff, Graph, State, TrafficEvent } from './types.js';

const IGNORED = new Set([
  'node_modules', '.git', '__pycache__', 'venv', '.venv', 'env', 'dist', 'build', 'out', '.next',
  '.expo', 'migrations', 'coverage', '.turbo', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'staticfiles',
]);
const RELEVANT = /\.(py|jsx?|tsx?)$|(^|\/)package\.json$|requirements[^/]*\.txt$|pyproject\.toml$/;
const TRAFFIC_LIMIT = 400;

export interface CoreEvents {
  state: [State];
  traffic: [TrafficEvent];
  log: [string];
}

/**
 * The engine: scans a project, rescans on save, keeps the session baseline for the diff,
 * and a ring buffer of live requests reported by the SDKs.
 */
export class Core extends EventEmitter<CoreEvents> {
  graph: Graph | null = null;
  private baseline: Graph | null = null;
  private since = Date.now();
  private firstSeen = new Map<string, number>();
  diff: Diff = emptyDiff(this.since);
  traffic: TrafficEvent[] = [];
  private nextTrafficId = 1;
  scannedAt = 0;
  scanMs = 0;
  error: string | undefined;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private dirty = false;

  constructor(readonly root: string) {
    super();
  }

  async start(opts: { watch?: boolean } = {}): Promise<void> {
    await this.rescan();
    if (opts.watch !== false) this.watch();
  }

  state(): State {
    if (!this.graph) throw new Error('not scanned yet');
    return {
      graph: this.graph,
      diff: this.diff,
      traffic: this.traffic,
      scannedAt: this.scannedAt,
      scanMs: this.scanMs,
      error: this.error,
    };
  }

  /** Start the diff over from what the project looks like right now. */
  resetBaseline(): void {
    this.baseline = this.graph;
    this.since = Date.now();
    this.firstSeen.clear();
    this.diff = emptyDiff(this.since);
    if (this.graph) this.emit('state', this.state());
  }

  rescan(): Promise<void> {
    if (this.scanning) {
      this.dirty = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      const t0 = Date.now();
      try {
        const graph = await scanProject(this.root);
        this.graph = graph;
        this.error = undefined;
        if (!this.baseline) this.baseline = graph;
        this.diff = computeDiff(this.baseline, graph, this.since, this.firstSeen);
        this.traffic.forEach((t) => (t.endpoint = matchEndpoint(graph, t.path)));
      } catch (e: any) {
        this.error = String(e?.message ?? e);
        this.emit('log', `scan failed: ${this.error}`);
        if (!this.graph) throw e;
      } finally {
        this.scanMs = Date.now() - t0;
        this.scannedAt = Date.now();
        this.scanning = null;
      }
      this.emit('state', this.state());
      if (this.dirty) {
        this.dirty = false;
        await this.rescan();
      }
    })();
    return this.scanning;
  }

  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, file) => {
        if (!file) return;
        const relPath = String(file).split(sep).join('/');
        if (relPath.split('/').some((part) => IGNORED.has(part) || (part.startsWith('.') && part !== '.'))) return;
        if (!RELEVANT.test(relPath)) return;
        this.schedule();
      });
      this.watcher.on('error', (e) => this.emit('log', `watcher error: ${e.message}`));
    } catch (e: any) {
      this.emit('log', `file watching unavailable (${e.message}); rescan from the map instead`);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rescan().catch(() => {});
    }, 300);
  }

  /** Accepts the SDK message shape ({source, target, status, method}) plus optional timing. */
  ingest(raw: any): TrafficEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const path = typeof raw.target === 'string' ? raw.target : typeof raw.path === 'string' ? raw.path : null;
    const status = Number(raw.status);
    if (!path || !Number.isFinite(status)) return null;
    let pathname = path;
    try {
      if (/^https?:\/\//.test(path)) pathname = new URL(path).pathname;
    } catch {}
    const event: TrafficEvent = {
      id: this.nextTrafficId++,
      ts: Number(raw.ts) || Date.now(),
      source: typeof raw.source === 'string' ? raw.source : 'app',
      method: typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET',
      path: pathname,
      status,
      durationMs: Number.isFinite(Number(raw.duration_ms ?? raw.durationMs)) ? Number(raw.duration_ms ?? raw.durationMs) : undefined,
      endpoint: this.graph ? matchEndpoint(this.graph, pathname) : undefined,
    };
    this.traffic.push(event);
    if (this.traffic.length > TRAFFIC_LIMIT) this.traffic.splice(0, this.traffic.length - TRAFFIC_LIMIT);
    this.emit('traffic', event);
    return event;
  }

  close(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }

  relative(file: string): string {
    return relative(this.root, file);
  }
}
