import assert from 'node:assert/strict';
import {cp, mkdtemp, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// Run the staged bundle outside node_modules so missing bundled imports fail here.
const root = fileURLToPath(new URL('../', import.meta.url));
const isolated = await mkdtemp(join(tmpdir(), 'dsh-plugin-smoke-'));
await cp(join(root, 'plugins', 'deepseek-harness', 'dist'), join(isolated, 'dist'), {recursive: true});
assert.ok((await stat(join(isolated, 'dist', 'read-model-config.cjs'))).isFile());
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  typeof value === 'string' && !/^(?:DSH_|DEEPSEEK_|OPENCODE_|PLUGIN_DATA$)/i.test(key)));
env.DSH_MCP_RUNTIME = 'npm';
env.DSH_MCP_DATA_DIR = join(isolated, 'data');
const transport = new StdioClientTransport({command: process.execPath, args: [join(isolated, 'dist', 'bin.mjs')], env, stderr: 'pipe'});
const client = new Client({name: 'packaging-smoke', version: '1.0.0'});
const deadline = setTimeout(() => { console.error('Packaged MCP smoke test timed out.'); process.exit(1); }, 30_000);
try {
  await client.connect(transport);
  const {tools} = await client.listTools();
  assert.equal(tools.length, 10);
  for (const name of ['doctor', 'start_service', 'start_run', 'stop_service']) {
    assert.ok(tools.some(tool => tool.name === name), `Missing MCP tool ${name}`);
  }
  const doctor = await client.callTool({name: 'doctor', arguments: {}});
  assert.notEqual(doctor.isError, true);
  assert.equal(doctor.structuredContent?.runtime, 'npm');
  assert.equal(doctor.structuredContent?.ready, true, 'Packaged doctor must find Node and npm without downloading Harness');
  console.log('Packaged MCP handshake, 10 tools, and offline doctor passed without repository dependencies.');
} finally {
  clearTimeout(deadline);
  await client.close();
}
