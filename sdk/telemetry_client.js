// sdk/telemetry_client.js
// ──────────────────────────────────────────────────────────────────────────────
// TraceFlow — JavaScript/React Telemetry Client
//
// PURPOSE:
//   Wraps the global `fetch` function to intercept all HTTP calls and report
//   them to the TraceFlow VS Code extension via WebSocket. This enables live
//   edge animations on the architecture graph.
//
// INSTALLATION:
//   1. Copy this file into your React/RN project (e.g., src/utils/telemetry.js)
//   2. Import and call `initTraceFlow()` ONCE at app startup:
//
//        // In App.js or index.js:
//        import { initTraceFlow } from './utils/telemetry';
//        if (__DEV__) {
//          initTraceFlow();
//        }
//
// NOTE:
//   This client is for LOCAL DEVELOPMENT ONLY.
//   Only initialise it in __DEV__ mode. It will fail silently if the
//   TraceFlow extension is not running.
// ──────────────────────────────────────────────────────────────────────────────

const TRACEFLOW_WS_URL = 'ws://localhost:8765';

let _ws = null;
let _reconnectTimer = null;
let _isInitialised = false;

/**
 * Connect (or reconnect) to the TraceFlow WebSocket server.
 */
function _connect() {
  try {
    _ws = new WebSocket(TRACEFLOW_WS_URL);

    _ws.onopen = () => {
      console.log('[TraceFlow] Connected to telemetry server');
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
      }
    };

    _ws.onclose = () => {
      _ws = null;
      // Reconnect after 5 seconds
      if (!_reconnectTimer) {
        _reconnectTimer = setTimeout(() => {
          _reconnectTimer = null;
          _connect();
        }, 5000);
      }
    };

    _ws.onerror = () => {
      // Silently fail — extension might not be running
      try { _ws?.close(); } catch (e) { /* noop */ }
    };
  } catch (e) {
    // WebSocket constructor can throw if URL is invalid
    _ws = null;
  }
}

/**
 * Send a telemetry message to the TraceFlow extension.
 *
 * @param {{ source: string, target: string, status: number, method: string }} msg
 */
function _send(msg) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(JSON.stringify(msg));
    } catch (e) {
      // Ignore send failures
    }
  }
}

/**
 * Extract the pathname from a URL string or Request object.
 */
function _extractPath(input) {
  try {
    if (typeof input === 'string') {
      // Absolute URL
      if (input.startsWith('http://') || input.startsWith('https://')) {
        return new URL(input).pathname;
      }
      // Relative URL — return as-is
      return input.split('?')[0];
    }
    if (input instanceof Request) {
      return new URL(input.url).pathname;
    }
  } catch (e) {
    // Fallback
  }
  return String(input);
}

/**
 * Initialise TraceFlow telemetry.
 * Monkey-patches `globalThis.fetch` to intercept all HTTP requests.
 * Call this ONCE at app startup, only in development mode.
 */
export function initTraceFlow() {
  if (_isInitialised) return;
  _isInitialised = true;

  _connect();

  const _originalFetch = globalThis.fetch;

  globalThis.fetch = async function traceFlowFetch(input, init) {
    const method = (init?.method || 'GET').toUpperCase();
    const target = _extractPath(input);

    let response;
    try {
      response = await _originalFetch.call(this, input, init);
    } catch (err) {
      // Report network error as status 0
      _send({
        source: 'frontend',
        target,
        status: 0,
        method,
      });
      throw err;
    }

    // Report successful (or error) response
    _send({
      source: 'frontend',
      target,
      status: response.status,
      method,
    });

    return response;
  };

  console.log('[TraceFlow] Telemetry initialised (fetch interceptor active)');
}

/**
 * Stop TraceFlow telemetry and restore original fetch.
 */
export function stopTraceFlow() {
  if (_ws) {
    try { _ws.close(); } catch (e) { /* noop */ }
    _ws = null;
  }
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _isInitialised = false;
}
