# TraceFlow

TraceFlow is a Proof-of-Concept VS Code extension that provides **dynamic architecture visualization** and **real-time HTTP telemetry** for Django and React / React Native projects. 

It statically analyzes your project (strictly read-only, 0 writes to your codebase) using Python's `ast` module to extract services, endpoints, and database models, and renders them as an interactive graph inside VS Code.

## 🚀 Features

- **AST-Based Static Analysis**: Safely parses `urls.py`, `models.py`, and React Router / React Navigation definitions without executing your code.
- **Dynamic Granularity**: Services start collapsed. Click to expand frontends to view pages/screens, or expand backends to see grouped endpoints and models.
- **Smart Grouping**: Endpoints are automatically grouped by logical business domains (Auth, Member, Admin, Trainer, Payments, System).
- **Live Telemetry (Optional)**: Watch your architecture come alive. Dropping in a simple Django middleware and JS interceptor allows the graph edges to animate (green for successes, red for errors) as HTTP traffic flows in real-time.
- **Zero-Config Discovery**: Just point it at your project root. It auto-detects Django backends, Vite React Web projects, and Expo React Native apps.

## 🛠️ Usage

### 1. View Architecture
1. Install the extension in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run `TraceFlow: Open Architecture Panel`.
4. Select the root folder of your project (e.g., the folder containing both your frontend and backend).
5. The interactive ReactFlow graph will render!

### 2. Enable Live Telemetry (Optional)

To see requests animate in real-time:

**Django Backend:**
1. Copy `sdk/django_middleware.py` into your Django project (e.g., `core/middleware.py`).
2. Add it to your `MIDDLEWARE` list in `settings.py`.
3. `pip install websocket-client`

**React Frontend:**
1. Copy `sdk/telemetry_client.js` into your frontend project.
2. Import and initialize it at the entry point of your app.

When the TraceFlow panel is open, it runs a local WebSocket server on port `8765`. Your apps will send lightweight JSON pulses there, animating the graph edges.

## 💻 Tech Stack
- **Extension Host**: TypeScript, VS Code API
- **Webview UI**: React, ReactFlow, esbuild
- **Parser**: Python 3, `ast` module

## 🔒 Security
- **Strictly Read-Only**: TraceFlow uses `ast` (Abstract Syntax Trees) instead of executing code (`import` or `eval`). It will never modify your target project.
- **Local Only**: Telemetry runs entirely over `ws://localhost:8765`. No data ever leaves your machine.
- **CSP Compliant**: The webview uses strict Content-Security-Policy with generated nonces.

---
*Created as an MVP for architectural observability.*
