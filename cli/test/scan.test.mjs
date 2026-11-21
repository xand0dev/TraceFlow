import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const demo = join(here, '..', '..', 'examples', 'shop');
const scan = (root) => JSON.parse(execFileSync(process.execPath, [cli, 'scan', root, '--json'], { encoding: 'utf8' }));

test('demo shop: pages, endpoints, models and links', () => {
  const g = scan(demo);
  assert.deepEqual(g.stack.includes('Django') && g.stack.includes('React'), true);
  assert.equal(g.pages.length, 5);
  assert.equal(g.endpoints.length, 8);
  assert.equal(g.models.length, 5);
  const orders = g.endpoints.find((e) => e.path === '/api/orders/');
  assert.deepEqual(orders.methods, ['GET', 'POST']);
  assert.deepEqual(orders.models, ['Order', 'OrderItem']);
  assert.equal(orders.viewFile, 'backend/orders/views.py');
  const cart = g.pages.find((p) => p.path === '/cart');
  assert.deepEqual(cart.calls.map((c) => `${c.method} ${c.endpoint}`), ['POST ep:/api/orders']);
  const product = g.pages.find((p) => p.path === '/product/:id');
  assert.equal(product.calls[0].endpoint, 'ep:/api/catalog/products/*');
  assert.equal(g.unmatchedCalls.length, 0);
  assert.ok(g.edges.some((e) => e.source === 'model:OrderItem' && e.target === 'model:Order'));
});

test('a new payments app shows up as added endpoint and model', async () => {
  const { computeDiff } = await import('./diff-under-test.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'tf-'));
  try {
    cpSync(demo, dir, { recursive: true });
    const before = scan(dir);
    const pay = join(dir, 'backend', 'payments');
    mkdirSync(pay);
    writeFileSync(join(pay, '__init__.py'), '');
    writeFileSync(join(pay, 'models.py'), 'from django.db import models\n\nclass Payment(models.Model):\n    amount = models.DecimalField(max_digits=9, decimal_places=2)\n');
    writeFileSync(join(pay, 'views.py'), 'from rest_framework.views import APIView\nfrom .models import Payment\n\nclass PayView(APIView):\n    def post(self, request):\n        return Payment.objects.create(amount=1)\n');
    writeFileSync(join(pay, 'urls.py'), 'from django.urls import path\nfrom .views import PayView\nurlpatterns = [path("pay/", PayView.as_view())]\n');
    const urls = join(dir, 'backend', 'shop', 'urls.py');
    const src = (await import('node:fs')).readFileSync(urls, 'utf8');
    writeFileSync(urls, src.replace(']', '    path("api/payments/", include("payments.urls")),\n]'));
    const after = scan(dir);
    const diff = computeDiff(before, after, 0, new Map());
    const kinds = diff.changes.map((c) => `${c.kind}:${c.id}`).sort();
    assert.deepEqual(kinds, ['added:ep:/api/payments/pay', 'added:model:Payment']);
    assert.deepEqual(diff.changes.find((c) => c.id === 'ep:/api/payments/pay').detail, ['view PayView', 'uses Payment']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DRF router mounted with include(router.urls) keeps its prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-'));
  try {
    cpSync(demo, dir, { recursive: true });
    writeFileSync(join(dir, 'backend', 'shop', 'routers.py'),
      'from rest_framework.routers import DefaultRouter\nfrom catalog.views import ProductViewSet\n\nrouter = DefaultRouter()\nrouter.register(r"products", ProductViewSet)\n');
    writeFileSync(join(dir, 'backend', 'shop', 'urls.py'),
      'from django.urls import include, path\nfrom .routers import router\n\nurlpatterns = [\n    path("api/catalog/", include(router.urls)),\n    path("api/orders/", include("orders.urls")),\n]\n');
    const g = scan(dir);
    const paths = g.endpoints.map((e) => e.path);
    assert.ok(paths.includes('/api/catalog/products/'), paths.join(', '));
    assert.ok(paths.includes('/api/catalog/products/{id}/'));
    assert.equal(g.pages.find((p) => p.path === '/').calls[0].endpoint, 'ep:/api/catalog/products');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
