<img src="docs/images/hero.svg" width="100%" alt="TraceFlow — see what your AI is building. A live map of your app, what the agent just changed, and real requests from web to API to database." />

<img src="docs/images/readme/label-see.svg" width="100%" alt="See it" />

<img src="docs/images/demo.gif" width="100%" alt="An agent adds payments to a Django + React shop: the new endpoint and model light up red, the cart page and Order model get a dashed edge, and requests travel the map with failed payments in red." />

<img src="docs/images/readme/label-views.svg" width="100%" alt="Four things it does" />

<p align="center">
  <img src="docs/images/readme/card-map.svg" width="49%" alt="Map: any project in any language, every part with a picture and a plain description, without AI." />
  <img src="docs/images/readme/card-changes.svg" width="49%" alt="Changes: new parts glow red, changed parts get a dashed edge, everything since the session started." />
  <img src="docs/images/readme/card-live.svg" width="49%" alt="Live: real requests travel the map, matched to the code that serves them, and errors turn red." />
  <img src="docs/images/readme/card-mcp.svg" width="49%" alt="MCP: Claude Code, Codex and Cursor ask the map before they touch the code." />
</p>

<img src="docs/images/changes.png" width="100%" alt="The map of a Django + React shop: each part drawn with its own picture, the new Payments block and edited Orders and Pages in red, HTTP lanes from the pages to the backend, and the list of changes on the right." />

<img src="docs/images/readme/label-run.svg" width="100%" alt="Run it" />

Inside any project. Needs Node 20+ and Python 3.9+, installs nothing into your project.

```bash
npx @xand0dev/traceflow
```

The map opens at `localhost:4317` and redraws on every save.

<img src="docs/images/readme/label-agents.svg" width="100%" alt="Connect your agent" />

<img src="docs/images/readme/agents.svg" width="100%" alt="Works with Claude Code and Codex (tested), Claude Desktop and Cursor (same MCP config)." />

```bash
claude mcp add traceflow -- npx -y @xand0dev/traceflow mcp
```

<details>
<summary><b>Codex</b>, <b>Claude Desktop</b>, <b>Cursor</b></summary>

`~/.codex/config.toml`

```toml
[mcp_servers.traceflow]
command = "npx"
args = ["-y", "@xand0dev/traceflow", "mcp", "/absolute/path/to/your/project"]
```

`claude_desktop_config.json` or `.cursor/mcp.json`

```json
{ "mcpServers": { "traceflow": { "command": "npx", "args": ["-y", "@xand0dev/traceflow", "mcp", "/absolute/path/to/your/project"] } } }
```

Desktop apps start servers with a short `PATH`. If `npx` is not found, use the full path from `which npx`.

</details>

<details>
<summary>Tools the agent gets</summary>

| | |
|:---|:---|
| `architecture` | Pages → endpoints → models with `file:line`. Optional `focus` word. |
| `trace` | Where an endpoint lives, what it uses, who calls it, its recent errors. |
| `changes` | What moved in the architecture during this session. |
| `traffic` | Recent requests, or only failures. |
| `open_map` | The map URL. |
| `reset_changes` | Track changes from now on. |

</details>

<img src="docs/images/readme/label-traffic.svg" width="100%" alt="Live traffic" />

<img src="docs/images/readme/traffic.svg" width="100%" alt="Live traffic: copy the Django middleware or the React fetch wrapper from sdk/, or POST JSON to /api/ingest. No dependencies, sends in the background." />

<details>
<summary>Django and React snippets</summary>

Copy [`sdk/django_middleware.py`](sdk/django_middleware.py) into your project:

```python
if DEBUG:
    MIDDLEWARE.insert(0, "myproject.traceflow_middleware.TraceFlowMiddleware")
```

Copy [`sdk/telemetry_client.js`](sdk/telemetry_client.js) into your app as `src/traceflow.js`:

```js
import { initTraceFlow } from './traceflow';
if (import.meta.env.DEV) initTraceFlow();
```

No app running yet? `npx @xand0dev/traceflow simulate` sends demo traffic to the open map.

</details>

<img src="docs/images/readme/label-how.svg" width="100%" alt="How it works" />

<img src="docs/images/readme/how.svg" width="100%" alt="How it works: the read-only parser reads your code, the core watches files, computes the diff and collects traffic from the SDKs, and serves the live map and the MCP tools." />

<details>
<summary>What it understands today</summary>

**Any language**: blocks from folders and files, links from imports (Python, JS/TS), descriptions from `package.json`, `pyproject.toml`, docstrings and README, a picture per kind of block. No AI involved.<br/>
**Django**: `ROOT_URLCONF` (settings file or package), nested `include()`, `path` / `re_path`, DRF routers and viewsets, `APIView` methods, `@api_view`, models including inherited and custom user models, relations, which models each view touches.<br/>
**React**: React Router routes, pages and their imports, `fetch` / axios calls to `/api/...`.<br/>
**React Native**: React Navigation stacks and tabs, expo-router screens.<br/>
**Not yet**: FastAPI, Express, Next.js API routes, routers registered in loops.

</details>

<details>
<summary>Develop</summary>

```bash
git clone https://github.com/xand0dev/TraceFlow.git
cd TraceFlow/cli && npm install && npm test
```

`npm test` runs the parser and diff tests and drives the MCP server with a real MCP client. `node scripts/capture.mjs` re-records the demo. `python3 docs/readme/make_assets.py` regenerates these images. The VS Code extension lives in `src/`.

</details>

<br/>

<p align="center">
  <a href="https://www.npmjs.com/package/@xand0dev/traceflow"><img src="docs/images/readme/btn-npm.svg" height="52" alt="npm" /></a>
  &nbsp;
  <a href="https://github.com/sponsors/xand0dev"><img src="docs/images/readme/btn-sponsor.svg" height="52" alt="Sponsor" /></a>
  &nbsp;
  <a href="https://www.patreon.com/xand0dev"><img src="docs/images/readme/btn-patreon.svg" height="52" alt="Patreon" /></a>
</p>

<p align="center"><sub>MIT · <a href="https://github.com/xand0dev">xand0dev</a></sub></p>
