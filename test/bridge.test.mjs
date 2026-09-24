import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAgentBridge } from '../src/main/bridge.mjs';
import { instanceConfig, atomicJson } from '../src/main/instance.mjs';

test('profiles reject traversal and isolate atomic state', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-test-'));
  try {
    const a = instanceConfig(['--instance=notebook'], dir);
    const b = instanceConfig(['--instance=monitor'], dir);
    assert.notEqual(a.userData, b.userData);
    assert.throws(() => instanceConfig(['--instance=../escape'], dir));
    for (const c of [a,b]) atomicJson(path.join(c.userData, 'state.json'), { id: c.id });
    assert.equal(JSON.parse(readFileSync(path.join(a.userData, 'state.json'))).id, 'notebook');
    assert.equal(statSync(path.join(a.userData, 'state.json')).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true }); }
});

test('HTTP bridge security and concurrency', async t => {
  let release;
  let calls = 0;
  let lastScript = '';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-bridge-'));
  const approved = path.join(dir, 'approved'); mkdirSync(approved);
  const secret = path.join(dir, 'outside.txt'); writeFileSync(secret, 'private');
  symlinkSync(secret, path.join(approved, 'escape.txt'));
  const wc = {
    isDestroyed: () => false, getURL: () => 'https://example.test/', getTitle: () => 'fixture', isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    loadURL: async () => { calls++; await new Promise(resolve => { release = resolve; }); },
    executeJavaScript: async script => { lastScript = script; return {}; },
  };
  const bridge = new LocalAgentBridge({ getWorkspaceWebContents: () => wc, captureDir: dir, uploadDir: approved, instanceId: 'test' });
  await bridge.start(0);
  t.after(async () => { release?.(); await bridge.stop(); rmSync(dir, {recursive:true}); });
  const url = `http://127.0.0.1:${bridge.port}`;
  const request = (route, body, headers = {}) => fetch(url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${bridge.token}`, ...headers },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  assert.equal((await fetch(url + '/v1/state')).status, 401);
  assert.equal((await request('/v1/state', undefined, { Origin: 'https://example.test' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { http.get(url+'/v1/state', {headers:{Host:'attacker.test',Authorization:`Bearer ${bridge.token}`}}, response => { response.resume(); resolve(response.statusCode); }).on('error',reject); });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/v1/state', undefined, {'x-mcf-instance':'other'})).status, 409);
  bridge.setPaused(true);
  assert.equal((await request('/v1/navigate', {url:'https://example.test'})).status, 423);
  assert.equal((await request('/v1/state')).status, 200);
  bridge.setPaused(false);
  const pending = request('/v1/navigate', {url:'https://example.test'});
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await request('/v1/navigate', {url:'https://other.test'})).status, 409);
  bridge.setPaused(true); release(); assert.equal((await pending).status, 200);
  assert.equal(calls, 1); bridge.setPaused(false);
  assert.equal((await request('/v1/upload-file', {file:path.join(approved,'escape.txt')})).status, 403);
  assert.equal((await request('/v1/navigate', {url:'https://user:password@example.test'})).status, 400);
  const malformed = await fetch(url+'/v1/navigate', {method:'POST',headers:{Authorization:`Bearer ${bridge.token}`},body:'{'});
  assert.equal(malformed.status, 400);
  await request('/v1/interactive');
  class Element {}
  const input = new Element(); Object.assign(input, {tagName:'INPUT', id:'secret', value:'DO_NOT_LEAK',innerText:'',getAttribute:()=>null,getBoundingClientRect:()=>({x:0,y:0,width:100,height:20})});
  const page = vm.runInNewContext(lastScript, {Element, CSS:{escape:x=>x},document:{title:'fixture',querySelectorAll:()=>[input]},location:{href:'https://example.test'},getComputedStyle:()=>({})});
  assert.equal(page.nodes[0].text, '');
  assert.ok(!JSON.stringify(page).includes('DO_NOT_LEAK'));
  const oldToken = bridge.token; await bridge.stop(); await bridge.start(0); assert.notEqual(oldToken, bridge.token);
});


test('message API targets chat and workspace without system input and broadcasts concurrently', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-message-'));
  let entrants = 0;
  const inserted = { chat: [], workspace: [] };

  function fakeWebContents(pane) {
    return {
      isDestroyed: () => false,
      getURL: () => 'https://chatgpt.com/',
      getTitle: () => pane,
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async () => ({ ok: true, sent: true }),
      insertText: async value => {
        inserted[pane].push(value);
      },
    };
  }

  const panes = {
    chat: fakeWebContents('chat'),
    workspace: fakeWebContents('workspace'),
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => panes.workspace,
    getPaneWebContents: pane => panes[pane] ?? null,
    captureDir: dir,
    instanceId: 'test',
  });
  await bridge.start(0);
  t.after(async () => { await bridge.stop(); rmSync(dir, { recursive: true }); });

  const url = 'http://127.0.0.1:' + bridge.port;
  const request = (route, body) => fetch(url + route, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + bridge.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const single = await request('/v1/message', { pane: 'chat', message: 'olá emilly' });
  assert.equal(single.status, 200);
  assert.deepEqual(inserted.chat, ['olá emilly']);

  entrants = 0;
  let releaseBroadcast;
  const broadcastGate = new Promise(resolve => { releaseBroadcast = resolve; });
  for (const pane of Object.values(panes)) {
    pane.insertText = async value => {
      entrants += 1;
      if (entrants === 2) releaseBroadcast();
      await Promise.race([
        broadcastGate,
        new Promise((_, reject) => setTimeout(() => reject(new Error('broadcast_not_parallel')), 250)),
      ]);
      inserted[pane.getTitle()].push(value);
    };
  }

  const broadcast = await request('/v1/messages/broadcast', {
    targets: ['chat', 'workspace'],
    message: 'teste simultâneo',
  });
  assert.equal(broadcast.status, 200);
  const payload = await broadcast.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.targets.sort(), ['chat', 'workspace']);
  assert.deepEqual(inserted.chat, ['olá emilly', 'teste simultâneo']);
  assert.deepEqual(inserted.workspace, ['teste simultâneo']);

  assert.equal((await request('/v1/message', { pane: 'other', message: 'x' })).status, 400);
  assert.equal((await request('/v1/message', { pane: 'chat', message: '' })).status, 400);

  const beforeBlocked = inserted.chat.length;
  panes.chat.executeJavaScript = async () => ({ ok: false, error: 'rate_limit_hard_block' });
  const blocked = await request('/v1/message', { pane: 'chat', message: 'não deve inserir' });
  assert.equal(blocked.status, 429);
  assert.equal(inserted.chat.length, beforeBlocked);
});
