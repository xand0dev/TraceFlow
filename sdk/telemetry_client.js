// TraceFlow client for React and React Native: reports every fetch() to the live map.
//
// Install
//   Copy this file into your app (for example src/traceflow.js) and call it once at startup,
//   in development only:
//
//     import { initTraceFlow } from './traceflow';
//     if (import.meta.env?.DEV || __DEV__) initTraceFlow();
//
// Options
//   initTraceFlow({ url: 'http://192.168.1.10:4317' })  // React Native on a device: use your computer's IP
//
// No dependencies. Events are batched and sent with the original fetch, so a stopped
// map never breaks or slows the app.

const DEFAULT_URL = 'http://127.0.0.1:4317';

let installed = false;

export function initTraceFlow(options = {}) {
  if (installed || typeof fetch !== 'function') return;
  installed = true;

  const base = (options.url || DEFAULT_URL).replace(/\/$/, '');
  const ingest = `${base}/api/ingest`;
  const source = options.source || 'web';
  const originalFetch = fetch.bind(globalThis);
  let buffer = [];
  let timer = null;
  let backoffUntil = 0;

  const flush = () => {
    timer = null;
    if (!buffer.length || Date.now() < backoffUntil) {
      buffer = buffer.slice(-200);
      return;
    }
    const batch = buffer;
    buffer = [];
    originalFetch(ingest, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    }).catch(() => {
      backoffUntil = Date.now() + 5000;
    });
  };

  const report = (event) => {
    buffer.push(event);
    if (!timer) timer = setTimeout(flush, 250);
  };

  globalThis.fetch = async function tracedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!url || url.startsWith(base)) return originalFetch(input, init);
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const started = Date.now();
    let path = url;
    try {
      path = new URL(url, globalThis.location?.href || 'http://localhost').pathname;
    } catch {}
    try {
      const response = await originalFetch(input, init);
      report({ source, target: path, method, status: response.status, duration_ms: Date.now() - started, ts: started });
      return response;
    } catch (error) {
      report({ source, target: path, method, status: 0, duration_ms: Date.now() - started, ts: started });
      throw error;
    }
  };
}

export default initTraceFlow;
