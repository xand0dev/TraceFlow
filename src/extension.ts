// src/extension.ts — TraceFlow VS Code Extension
// Main entry point: File Scanner, AST Parser Caller, WebSocket Telemetry, Webview Provider

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { Server as WebSocketServer, WebSocket } from 'ws';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface ScanResult {
  djangoRoot: string | null;
  reactRoots: string[];
  hasReactNative: boolean;
}

interface ParsedEndpoint {
  path: string;
  view: string;
  methods: string[];
  type?: string;
}

interface ParsedModel {
  name: string;
  fields: string[];
}

interface ParsedService {
  id: string;
  name: string;
  type: string;
}

interface ArchitectureData {
  services: ParsedService[];
  endpoints: ParsedEndpoint[];
  models: ParsedModel[];
}

interface TelemetryMessage {
  source: string;
  target: string;
  status: number;
  method: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Extension Lifecycle
// ──────────────────────────────────────────────────────────────────────────────

let wsServer: WebSocketServer | null = null;
let currentPanel: vscode.WebviewPanel | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('TraceFlow: Extension activated');

  const disposable = vscode.commands.registerCommand('traceflow.openPanel', async () => {
    try {
      await openTraceFlowPanel(context);
    } catch (err: any) {
      vscode.window.showErrorMessage(`TraceFlow error: ${err.message}`);
      console.error('TraceFlow:', err);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {
  if (wsServer) {
    wsServer.close();
    wsServer = null;
    console.log('TraceFlow: WebSocket server stopped');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Flow
// ──────────────────────────────────────────────────────────────────────────────

async function openTraceFlowPanel(context: vscode.ExtensionContext): Promise<void> {
  // 1. Ask user to select the target project folder
  const defaultUri = vscode.Uri.file('D:\\+FITGYM');
  const selectedFolders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select Target Project',
    defaultUri,
    title: 'TraceFlow: Select Project to Analyze',
  });

  if (!selectedFolders || selectedFolders.length === 0) {
    vscode.window.showInformationMessage('TraceFlow: No folder selected.');
    return;
  }

  const targetRoot = selectedFolders[0].fsPath;

  // 2. Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'TraceFlow',
      cancellable: false,
    },
    async (progress) => {
      // 2a. Scan project structure
      progress.report({ message: 'Scanning project structure…', increment: 10 });
      const scanResult = scanProject(targetRoot);
      console.log('TraceFlow scan result:', JSON.stringify(scanResult, null, 2));

      if (!scanResult.djangoRoot) {
        vscode.window.showWarningMessage(
          'TraceFlow: No Django project found (no manage.py detected).'
        );
      }

      // 2b. Run Python parser (scans Django + React + RN in one pass)
      progress.report({ message: 'Parsing project architecture…', increment: 30 });
      let architecture: ArchitectureData;
      try {
        architecture = await runParser(context, targetRoot);
      } catch (err: any) {
        vscode.window.showWarningMessage(`TraceFlow: Parser error — ${err.message}`);
        architecture = { services: [], endpoints: [], models: [] };
      }

      // 2c. Start WebSocket telemetry server
      progress.report({ message: 'Starting telemetry server…', increment: 20 });
      startTelemetryServer();

      // 2d. Open Webview
      progress.report({ message: 'Opening architecture panel…', increment: 30 });
      createWebviewPanel(context, architecture);

      // Prompt for support (non-blocking)
      vscode.window.showInformationMessage(
        '💖 Enjoying TraceFlow? Consider supporting its development!',
        'Support on Patreon', 'Sponsor on GitHub'
      ).then(selection => {
        if (selection === 'Support on Patreon') {
          vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/xand0dev'));
        } else if (selection === 'Sponsor on GitHub') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/sponsors/xand0dev'));
        }
      });

      progress.report({ message: 'Done!', increment: 10 });
    }
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// File Scanner — READ-ONLY traversal of target project
// ──────────────────────────────────────────────────────────────────────────────

function scanProject(rootPath: string): ScanResult {
  const result: ScanResult = {
    djangoRoot: null,
    reactRoots: [],
    hasReactNative: false,
  };

  const SKIP_DIRS = new Set([
    'node_modules', '.git', '__pycache__', 'venv', '.venv',
    'env', '.env', 'dist', 'build', 'staticfiles', '.expo',
    '.idea', '.vscode', 'migrations', '.pytest_cache',
  ]);

  function walk(dir: string, depth: number = 0): void {
    if (depth > 5) { return; } // Limit recursion depth

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip inaccessible directories
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);

        // Detect Django project (manage.py)
        if (entry.name === 'manage.py' && !result.djangoRoot) {
          result.djangoRoot = dir;
        }

        // Detect React / React Native projects (package.json)
        if (entry.name === 'package.json') {
          try {
            const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps['react'] || deps['react-native']) {
              result.reactRoots.push(dir);
              if (deps['react-native'] || deps['expo']) {
                result.hasReactNative = true;
              }
            }
          } catch {
            // Ignore malformed package.json
          }
        }
      }
    }
  }

  walk(rootPath);
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// AST Parser Caller — spawns Python subprocess (READ-ONLY on target)
// ──────────────────────────────────────────────────────────────────────────────

function runParser(
  context: vscode.ExtensionContext,
  djangoRoot: string
): Promise<ArchitectureData> {
  return new Promise((resolve, reject) => {
    // Locate parser.py — check both dev (src/) and packaged (out/) locations
    const parserCandidates = [
      path.join(context.extensionPath, 'src', 'parser.py'),
      path.join(context.extensionPath, 'out', 'parser.py'),
      path.join(context.extensionPath, 'parser.py'),
    ];

    let parserPath: string | null = null;
    for (const candidate of parserCandidates) {
      if (fs.existsSync(candidate)) {
        parserPath = candidate;
        break;
      }
    }

    if (!parserPath) {
      reject(new Error('parser.py not found in extension directory'));
      return;
    }

    // Try python3, then python, then py
    const pythonCandidates = ['python3', 'python', 'py'];
    tryPythonCommand(pythonCandidates, 0, parserPath, djangoRoot, resolve, reject);
  });
}

function tryPythonCommand(
  commands: string[],
  index: number,
  parserPath: string,
  djangoRoot: string,
  resolve: (data: ArchitectureData) => void,
  reject: (err: Error) => void
): void {
  if (index >= commands.length) {
    reject(new Error('Python not found. Tried: python3, python, py'));
    return;
  }

  const pythonCmd = commands[index];
  let stdout = '';
  let stderr = '';

  const proc = spawn(pythonCmd, [parserPath, djangoRoot], {
    cwd: path.dirname(parserPath),
    env: { ...process.env },
  });

  proc.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  proc.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  proc.on('error', () => {
    // This python command failed, try next
    tryPythonCommand(commands, index + 1, parserPath, djangoRoot, resolve, reject);
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error(`TraceFlow parser stderr: ${stderr}`);
      // If exit code indicates python not found, try next
      if (stderr.includes('not found') || stderr.includes('not recognized')) {
        tryPythonCommand(commands, index + 1, parserPath, djangoRoot, resolve, reject);
        return;
      }
      reject(new Error(`Parser exited with code ${code}: ${stderr}`));
      return;
    }

    try {
      const data = JSON.parse(stdout);
      resolve(data as ArchitectureData);
    } catch (parseErr: any) {
      reject(new Error(`Failed to parse parser output: ${parseErr.message}\nOutput: ${stdout}`));
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket Telemetry Server — receives live HTTP telemetry from running apps
// ──────────────────────────────────────────────────────────────────────────────

function startTelemetryServer(): void {
  if (wsServer) {
    console.log('TraceFlow: WebSocket server already running');
    return;
  }

  try {
    wsServer = new WebSocketServer({ port: 8765 });

    wsServer.on('listening', () => {
      console.log('TraceFlow: Telemetry WebSocket server listening on ws://localhost:8765');
      vscode.window.showInformationMessage('TraceFlow: Telemetry server started on port 8765');
    });

    wsServer.on('connection', (ws: WebSocket) => {
      console.log('TraceFlow: Telemetry client connected');

      ws.on('message', (raw: Buffer) => {
        try {
          const msg: TelemetryMessage = JSON.parse(raw.toString());

          // Validate shape
          if (
            typeof msg.source === 'string' &&
            typeof msg.target === 'string' &&
            typeof msg.status === 'number' &&
            typeof msg.method === 'string'
          ) {
            // Forward to webview
            if (currentPanel) {
              currentPanel.webview.postMessage({
                type: 'telemetry',
                payload: msg,
              });
            }
          } else {
            console.warn('TraceFlow: Invalid telemetry message shape:', msg);
          }
        } catch (err) {
          console.warn('TraceFlow: Failed to parse telemetry message:', err);
        }
      });

      ws.on('close', () => {
        console.log('TraceFlow: Telemetry client disconnected');
      });
    });

    wsServer.on('error', (err: Error) => {
      if ((err as any).code === 'EADDRINUSE') {
        vscode.window.showWarningMessage(
          'TraceFlow: Port 8765 is already in use. Telemetry server not started.'
        );
      } else {
        console.error('TraceFlow WebSocket error:', err);
      }
    });
  } catch (err: any) {
    console.error('TraceFlow: Failed to start WebSocket server:', err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Webview Panel — React + ReactFlow UI
// ──────────────────────────────────────────────────────────────────────────────

function createWebviewPanel(
  context: vscode.ExtensionContext,
  architecture: ArchitectureData
): void {
  // Reuse existing panel if open
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    currentPanel.webview.postMessage({ type: 'init', payload: architecture });
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    'traceflowPanel',
    'TraceFlow — Architecture',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview')),
        vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview')),
      ],
    }
  );

  // Resolve webview URIs
  const webviewOutPath = path.join(context.extensionPath, 'out', 'webview');
  const bundleUri = currentPanel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewOutPath, 'bundle.js'))
  );
  const cssUri = currentPanel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewOutPath, 'bundle.css'))
  );

  // Generate nonce for CSP
  const nonce = getNonce();

  currentPanel.webview.html = getWebviewHtml(
    currentPanel.webview,
    bundleUri.toString(),
    cssUri.toString(),
    nonce
  );

  // Send initial architecture data once webview is ready
  // Small delay to ensure React has mounted
  setTimeout(() => {
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'init', payload: architecture });
    }
  }, 500);

  // Handle messages from webview
  currentPanel.webview.onDidReceiveMessage(
    (message: any) => {
      switch (message.type) {
        case 'ready':
          // Webview is ready, send data
          if (currentPanel) {
            currentPanel.webview.postMessage({ type: 'init', payload: architecture });
          }
          break;
        case 'log':
          console.log('TraceFlow Webview:', message.text);
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  currentPanel.onDidDispose(
    () => {
      currentPanel = null;
    },
    undefined,
    context.subscriptions
  );
}

function getWebviewHtml(
  webview: vscode.Webview,
  bundleUri: string,
  cssUri: string,
  nonce: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             font-src ${webview.cspSource};
             img-src ${webview.cspSource} data:;"
  />
  <title>TraceFlow</title>
  <link rel="stylesheet" href="${cssUri}" />
  <style>
    html, body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #0d1117;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
