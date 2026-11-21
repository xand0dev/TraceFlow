// Smoke test: start `traceflow mcp` over stdio and call every tool.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? join(here, '..', '..', 'examples', 'shop');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, '..', 'dist', 'cli.js'), 'mcp', root, '--port', process.env.TF_PORT ?? '4317'],
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
for (const [name, args] of [
  ['architecture', { focus: 'orders' }],
  ['trace', { endpoint: '/api/orders/' }],
  ['changes', {}],
  ['traffic', { errors_only: true, limit: 3 }],
  ['open_map', {}],
]) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n── ${name}\n${res.content[0].text.split('\n').slice(0, 14).join('\n')}`);
}
await client.close();
