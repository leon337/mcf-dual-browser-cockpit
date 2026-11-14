import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../bin/mcf-cockpit-mcp.mjs', import.meta.url));
const WRITE_TOOLS = ['cockpit_navigate', 'cockpit_action', 'cockpit_click', 'cockpit_find_click', 'cockpit_type', 'cockpit_pointer', 'cockpit_capture'];

async function fixture(t, mode = 'read-only') {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part.toString();
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization || null,
      instance: req.headers['x-mcf-instance'] || null,
      body: raw ? JSON.parse(raw) : null,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      MCF_BRIDGE_URL: `http://127.0.0.1:${port}`,
      MCF_BRIDGE_TOKEN: 'test-token',
      MCF_INSTANCE_ID: 'test-instance',
      MCF_MCP_MODE: mode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const match = pending.get(message.id);
      if (match) { pending.delete(message.id); match.resolve(message); }
    } catch (error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    }
  });
  child.on('exit', (code) => {
    for (const entry of pending.values()) entry.reject(new Error(`MCP process exited ${code}`));
    pending.clear();
  });
  let sequence = 0;
  function rpc(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for MCP ${method}`));
      }, 4000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, rpc };
}

test('MCP inicializa e oferece somente ferramentas de leitura por padrão', async (t) => {
  const { rpc, requests } = await fixture(t);
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'mcf-dual-browser-cockpit-mcp');
  assert.deepEqual((await rpc('ping')).result, {});
  const listed = (await rpc('tools/list')).result.tools;
  assert.equal(listed.length, 5);
  assert.ok(WRITE_TOOLS.every((name) => !listed.some((tool) => tool.name === name)));
  const health = await rpc('tools/call', { name: 'cockpit_health', arguments: {} });
  assert.equal(health.result.isError, undefined);
  assert.equal(requests.at(-1).url, '/health');
  assert.equal(requests.at(-1).auth, null);
  const state = await rpc('tools/call', { name: 'cockpit_state', arguments: { pane: 'chat' } });
  assert.equal(state.result.isError, undefined);
  assert.equal(requests.at(-1).url, '/v1/state?pane=chat');
  assert.equal(requests.at(-1).auth, 'Bearer test-token');
  assert.equal(requests.at(-1).instance, 'test-instance');
});

test('modo somente leitura bloqueia mutações mesmo por tools/call', async (t) => {
  const { rpc, requests } = await fixture(t);
  const start = requests.length;
  const blocked = await rpc('tools/call', {
    name: 'cockpit_navigate',
    arguments: { pane: 'workspace', url: 'https://example.com' },
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /read-only/);
  const invalid = await rpc('tools/call', { name: 'cockpit_state', arguments: { pane: 'inválido' } });
  assert.equal(invalid.result.isError, true);
  const extra = await rpc('tools/call', { name: 'cockpit_state', arguments: { pane: 'chat', untrusted: 1 } });
  assert.equal(extra.result.isError, true);
  assert.equal(requests.length, start);
});

test('modo interativo mapeia as 12 ferramentas para as rotas da Bridge simulada', async (t) => {
  const { rpc, requests } = await fixture(t, 'interactive');
  const tools = (await rpc('tools/list')).result.tools;
  assert.equal(tools.length, 12);
  const calls = [
    ['cockpit_health', {}, 'GET', '/health'],
    ['cockpit_state', { pane: 'chat' }, 'GET', '/v1/state?pane=chat'],
    ['cockpit_accessibility', {}, 'GET', '/v1/accessibility?pane=workspace'],
    ['cockpit_interactive', {}, 'GET', '/v1/interactive?pane=workspace'],
    ['cockpit_text', {}, 'GET', '/v1/text?pane=workspace'],
    ['cockpit_navigate', { url: 'https://example.com' }, 'POST', '/v1/navigate'],
    ['cockpit_action', { action: 'reload' }, 'POST', '/v1/action'],
    ['cockpit_click', { selector: '#ok' }, 'POST', '/v1/click'],
    ['cockpit_find_click', { text: 'OK' }, 'POST', '/v1/find-click'],
    ['cockpit_type', { selector: '#input', text: 'texto de teste' }, 'POST', '/v1/type'],
    ['cockpit_pointer', { x: 15, y: 22 }, 'POST', '/v1/pointer'],
    ['cockpit_capture', {}, 'POST', '/v1/capture'],
  ];
  for (const [name, args, method, url] of calls) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, undefined, name);
    assert.equal(requests.at(-1).method, method, name);
    assert.equal(requests.at(-1).url, url, name);
  }
  assert.deepEqual(requests.find((req) => req.url === '/v1/type').body, {
    pane: 'workspace', selector: '#input', text: 'texto de teste',
  });
  assert.deepEqual(requests.find((req) => req.url === '/v1/pointer').body, {
    pane: 'workspace', x: 15, y: 22,
  });
});

test('entradas inseguras são rejeitadas antes de chamar a Bridge', async (t) => {
  const { rpc, requests } = await fixture(t, 'interactive');
  const cases = [
    { name: 'cockpit_navigate', arguments: { url: 'file:///etc/passwd' } },
    { name: 'cockpit_navigate', arguments: { url: 'https://usuario:senha@example.com/' } },
    { name: 'cockpit_find_click', arguments: { text: 'x'.repeat(241) } },
    { name: 'cockpit_pointer', arguments: { x: -1, y: 5 } },
    { name: 'cockpit_type', arguments: { text: 'abc' } },
    { name: 'cockpit_missing', arguments: {} },
  ];
  for (const item of cases) {
    const result = await rpc('tools/call', item);
    assert.equal(result.result.isError, true);
  }
  assert.equal(requests.length, 0);
});


test('JSON inválido ou requisição malformada não derruba o processo', () => {
  const run = spawnSync(process.execPath, [script], {
    input: 'not-json\nnull\n{"jsonrpc":"2.0","method":1,"id":2}\n',
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 0);
  const responses = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((res) => res.error.code), [-32700, -32600, -32600]);
});

test('o servidor rejeita Bridge remota para proteger o bearer token', () => {
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, MCF_BRIDGE_URL: 'https://127.0.0.1.evil.example:47831', MCF_BRIDGE_TOKEN: 'secret-test' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /HTTP de loopback/);
  assert.doesNotMatch(run.stderr, /secret-test/);
});
