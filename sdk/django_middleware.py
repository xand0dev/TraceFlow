"""
TraceFlow middleware for Django: reports every request to the live map.

Install
  1. Copy this file into your project, for example as `myproject/traceflow_middleware.py`.
  2. Add it near the top of MIDDLEWARE (development only):

        if DEBUG:
            MIDDLEWARE.insert(0, "myproject.traceflow_middleware.TraceFlowMiddleware")

  3. Run `traceflow` (or connect the MCP server) and use your app.

No dependencies. Requests are sent from a background thread, so a stopped
map never slows your app down. Set TRACEFLOW_URL to change the target
(default http://127.0.0.1:4317/api/ingest) or TRACEFLOW_DISABLED=1 to switch off.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.request

TRACEFLOW_URL = os.environ.get("TRACEFLOW_URL", "http://127.0.0.1:4317/api/ingest")
DISABLED = os.environ.get("TRACEFLOW_DISABLED") == "1"
SKIP_PREFIXES = ("/static/", "/media/", "/favicon.ico", "/__debug__/")

_queue: "queue.Queue[dict]" = queue.Queue(maxsize=2000)
_started = False
_lock = threading.Lock()


def _sender() -> None:
    while True:
        batch = [_queue.get()]
        while len(batch) < 50:
            try:
                batch.append(_queue.get_nowait())
            except queue.Empty:
                break
        body = json.dumps(batch).encode()
        req = urllib.request.Request(TRACEFLOW_URL, data=body, headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=0.5).close()
        except Exception:
            time.sleep(2)  # map not running; drop this batch and back off


def _ensure_sender() -> None:
    global _started
    if _started:
        return
    with _lock:
        if not _started:
            threading.Thread(target=_sender, name="traceflow", daemon=True).start()
            _started = True


class TraceFlowMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if DISABLED or request.path.startswith(SKIP_PREFIXES):
            return self.get_response(request)
        started = time.perf_counter()
        response = self.get_response(request)
        try:
            _ensure_sender()
            _queue.put_nowait({
                "source": "backend",
                "target": request.path,
                "method": request.method,
                "status": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "ts": int(time.time() * 1000),
            })
        except queue.Full:
            pass
        except Exception:
            pass  # telemetry must never break the app
        return response


# Old name, kept so existing settings keep working.
TelemetryMiddleware = TraceFlowMiddleware
