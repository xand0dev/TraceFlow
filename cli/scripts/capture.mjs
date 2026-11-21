// Records the README demo: the map of examples/shop while an "agent" adds payments and traffic flows.
// Usage: node scripts/capture.mjs <out-dir>   (needs Google Chrome and ffmpeg)
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '..', '..', 'docs', 'images'));
const cli = join(here, '..', 'dist', 'cli.js');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4950;
const W = 1440;
const H = 860;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'tf-capture-'));
const project = join(work, 'shop');
cpSync(join(here, '..', '..', 'examples', 'shop'), project, { recursive: true });
const frames = join(work, 'frames');
mkdirSync(frames);
mkdirSync(out, { recursive: true });

const procs = [];
const run = (cmd, args) => {
  const p = spawn(cmd, args, { stdio: 'ignore' });
  procs.push(p);
  return p;
};
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

run(process.execPath, [cli, project, '--no-open', '--port', String(PORT), '--telemetry', '8951']);
await sleep(1500);
run(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${join(work, 'chrome')}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank']);
await sleep(1500);

const target = await (await fetch(`http://127.0.0.1:9333/json/new?http://127.0.0.1:${PORT}/`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
const cdp = (method, params = {}) => new Promise((r) => {
  const id = ++seq;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params }));
});
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp('Page.reload');
await sleep(2500);

const shot = async (file, scale = 1) => {
  if (scale !== 1) await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: scale, mobile: false });
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  if (scale !== 1) await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
};
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true });

// Agent steps, applied while recording.
const b = join(project, 'backend');
const steps = [
  () => {
    mkdirSync(join(b, 'payments'), { recursive: true });
    writeFileSync(join(b, 'payments', '__init__.py'), '');
    writeFileSync(join(b, 'payments', 'models.py'), 'from django.db import models\n\nfrom orders.models import Order\n\n\nclass Payment(models.Model):\n    order = models.OneToOneField(Order, on_delete=models.CASCADE)\n    provider = models.CharField(max_length=30, default="stripe")\n    amount = models.DecimalField(max_digits=10, decimal_places=2)\n    status = models.CharField(max_length=20, default="pending")\n');
  },
  () => {
    writeFileSync(join(b, 'payments', 'views.py'), 'from rest_framework.views import APIView\nfrom rest_framework.response import Response\n\nfrom orders.models import Order\nfrom .models import Payment\n\n\nclass CheckoutView(APIView):\n    def post(self, request):\n        order = Order.objects.get(pk=request.data["order"])\n        payment = Payment.objects.create(order=order, amount=order.total)\n        return Response({"id": payment.id}, status=201)\n');
    writeFileSync(join(b, 'payments', 'urls.py'), 'from django.urls import path\n\nfrom .views import CheckoutView\n\nurlpatterns = [\n    path("checkout/", CheckoutView.as_view(), name="checkout"),\n]\n');
    const urls = join(b, 'shop', 'urls.py');
    writeFileSync(urls, readFileSync(urls, 'utf8').replace(']', '    path("api/payments/", include("payments.urls")),\n]'));
  },
  () => {
    const orders = join(b, 'orders', 'models.py');
    writeFileSync(orders, readFileSync(orders, 'utf8').replace('default="new")\n', 'default="new")\n    paid_at = models.DateTimeField(null=True, blank=True)\n'));
    const cart = join(project, 'web', 'src', 'pages', 'CartPage.jsx');
    writeFileSync(cart, readFileSync(cart, 'utf8').replace(
      '  const checkout = () =>\n    api("/api/orders/", { method: "POST", body: JSON.stringify({ items }) });',
      '  const checkout = async () => {\n    const order = await api("/api/orders/", { method: "POST", body: JSON.stringify({ items }) });\n    return api("/api/payments/checkout/", { method: "POST", body: JSON.stringify({ order: order.id }) });\n  };',
    ));
  },
];

run(process.execPath, [cli, 'simulate', `http://127.0.0.1:${PORT}`, '--fail', 'payments']);
const timeline = { 25: steps[0], 45: steps[1], 65: steps[2] };
for (let i = 0; i < 150; i++) {
  timeline[i]?.();
  const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  writeFileSync(join(frames, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(data, 'base64'));
  await sleep(70);
}

await shot(join(out, 'changes.png'), 2);
await evaluate(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('Live'))?.click()`);
await sleep(600);
await shot(join(out, 'live.png'), 2);
await evaluate(`(() => { const el = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('/api/payments/checkout/')); el?.click(); })()`);
await sleep(900);
await shot(join(out, 'details.png'), 2);

ws.close();
cleanup();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '10', '-i', join(frames, 'f%04d.jpg'),
  '-vf', 'scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
  join(out, 'demo.gif')]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}/{changes,live,details}.png and demo.gif`);
process.exit(0);
