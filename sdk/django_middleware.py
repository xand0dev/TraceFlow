// sdk/django_middleware.py
// ──────────────────────────────────────────────────────────────────────────────
// TraceFlow — Django Telemetry Middleware
//
// PURPOSE:
//   Sends real-time HTTP request/response telemetry to the TraceFlow VS Code
//   extension via WebSocket. This enables live edge animations on the
//   architecture graph.
//
// INSTALLATION:
//   1. pip install websocket-client
//   2. Copy this file into your Django project (e.g., crm/middleware.py)
//   3. Add to MIDDLEWARE in settings.py:
//        MIDDLEWARE = [
//            ...
//            'crm.middleware.TelemetryMiddleware',
//        ]
//
// NOTE:
//   This middleware is for LOCAL DEVELOPMENT ONLY.
//   Do NOT deploy it to production — it will slow down requests and
//   fail silently if the TraceFlow extension is not running.
// ──────────────────────────────────────────────────────────────────────────────

"""
TraceFlow Django Telemetry Middleware.
Sends {source, target, status, method} to ws://localhost:8765 on each request.
"""

import json
import logging
import threading

logger = logging.getLogger("traceflow")

# Lazy-loaded WebSocket connection (thread-local)
_ws_local = threading.local()

TRACEFLOW_WS_URL = "ws://localhost:8765"


def _get_ws():
    """Get or create a thread-local WebSocket connection."""
    ws = getattr(_ws_local, "ws", None)
    if ws is None or not ws.connected:
        try:
            import websocket  # websocket-client package

            ws = websocket.create_connection(
                TRACEFLOW_WS_URL,
                timeout=1,  # Fast fail if extension not running
            )
            _ws_local.ws = ws
        except Exception:
            _ws_local.ws = None
            return None
    return ws


class TelemetryMiddleware:
    """
    Django middleware that reports each HTTP request to the TraceFlow
    VS Code extension via WebSocket.

    Message format:
    {
        "source": "backend",
        "target": "/api/workouts/",
        "status": 200,
        "method": "GET"
    }
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        # Fire-and-forget telemetry (non-blocking)
        try:
            self._send_telemetry(request, response)
        except Exception:
            pass  # Never break the app for telemetry

        return response

    def _send_telemetry(self, request, response):
        ws = _get_ws()
        if ws is None:
            return

        message = json.dumps({
            "source": "backend",
            "target": request.path,
            "status": response.status_code,
            "method": request.method,
        })

        try:
            ws.send(message)
        except Exception:
            # Connection lost — will reconnect on next request
            _ws_local.ws = None
