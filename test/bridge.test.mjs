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
    const b = instanceConfig(['--instance=monitor', '--agent-profile=debug-engineering'], dir);
    assert.notEqual(a.userData, b.userData);
    assert.equal(a.agentProfile, 'audit-architecture');
    assert.equal(b.agentProfile, 'debug-engineering');
    assert.throws(() => instanceConfig(['--instance=../escape'], dir));
    assert.throws(() => instanceConfig(['--instance=x', '--agent-profile=../escape'], dir));
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
  const releaseFirst = release;
  release = null;
  const queued = request('/v1/navigate', {url:'https://other.test'});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  assert.equal(bridge.getState().busy, true);
  assert.equal(bridge.getState().queueDepth, 1);
  releaseFirst();
  assert.equal((await pending).status, 200);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal(bridge.getState().queueDepth, 0);
  bridge.setPaused(true); release(); assert.equal((await queued).status, 200);
  bridge.setPaused(false);
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

test('HTTP bridge mutation queues remain isolated across instances', async t => {
  const dirA = mkdtempSync(path.join(os.tmpdir(), 'mcf-bridge-a-'));
  const dirB = mkdtempSync(path.join(os.tmpdir(), 'mcf-bridge-b-'));
  let releaseA = null;
  let startedA = 0;
  let startedB = 0;
  let urlA = 'https://example.test/a';
  let urlB = 'https://example.test/b';

  const wcA = {
    isDestroyed: () => false,
    getURL: () => urlA,
    getTitle: () => 'instance-a',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    loadURL: async (target) => {
      startedA += 1;
      urlA = target;
      await new Promise(resolve => { releaseA = resolve; });
    },
  };
  const wcB = {
    isDestroyed: () => false,
    getURL: () => urlB,
    getTitle: () => 'instance-b',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    loadURL: async (target) => {
      startedB += 1;
      urlB = target;
    },
  };

  const bridgeA = new LocalAgentBridge({
    getWorkspaceWebContents: () => wcA,
    captureDir: dirA,
    instanceId: 'instance-a',
  });
  const bridgeB = new LocalAgentBridge({
    getWorkspaceWebContents: () => wcB,
    captureDir: dirB,
    instanceId: 'instance-b',
  });

  await Promise.all([bridgeA.start(0), bridgeB.start(0)]);
  t.after(async () => {
    releaseA?.();
    await Promise.all([bridgeA.stop(), bridgeB.stop()]);
    rmSync(dirA, { recursive: true });
    rmSync(dirB, { recursive: true });
  });

  const post = (bridge, body) => fetch(`http://127.0.0.1:${bridge.port}/v1/navigate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      'X-MCF-Instance': bridge.instanceId,
    },
    body: JSON.stringify(body),
  });

  const pendingA = post(bridgeA, { url: 'https://example.test/a-blocked' });
  while (!releaseA) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(startedA, 1);
  assert.equal(bridgeA.getState().busy, true);

  const responseB = await post(bridgeB, { url: 'https://example.test/b-parallel' });
  assert.equal(responseB.status, 200);
  assert.equal(startedB, 1);
  assert.equal(bridgeB.getState().busy, false);

  releaseA();
  assert.equal((await pendingA).status, 200);
});


test('message API targets chat and workspace without system input and broadcasts concurrently', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-message-'));
  let entrants = 0;
  const inserted = { chat: [], workspace: [] };
  const scripts = { chat: [], workspace: [] };

  function fakeWebContents(pane) {
    return {
      isDestroyed: () => false,
      getURL: () => 'https://chatgpt.com/c/test-' + pane,
      getTitle: () => pane,
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async script => {
        scripts[pane].push(script);
        if (script.includes('const enforceChatMode')) {
          return {
            ok: true,
            baseline: {
              url: 'https://chatgpt.com/c/test-' + pane,
              userMessageCount: 1,
              lastUserMessageId: 'user-old-' + pane,
              lastAssistantMessageId: 'assistant-old-' + pane,
            },
          };
        }
        if (script.includes('chat_send_control_not_found')) {
          return { ok: true, method: 'button' };
        }
        if (script.includes('conversationAdvanced')) {
          return {
            ok: true,
            composerCleared: true,
            conversationAdvanced: true,
            sent: true,
            url: 'https://chatgpt.com/c/test-' + pane,
            userMessageCount: 2,
            lastUserMessageId: 'user-new-' + pane,
            lastAssistantMessageId: 'assistant-old-' + pane,
            baselineLastAssistantMessageId: 'assistant-old-' + pane,
          };
        }
        if (script.includes('const expected =')) {
          return {
            ok: true,
            composerEmpty: true,
            composerTextLength: 0,
            automationResidual: false,
          };
        }
        return { ok: true };
      },
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
  assert.ok(scripts.chat.some(script => script.includes('const enforceChatMode = true')));

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
  assert.ok(scripts.workspace.some(script => script.includes('const enforceChatMode = false')));

  assert.equal((await request('/v1/message', { pane: 'other', message: 'x' })).status, 400);
  assert.equal((await request('/v1/message', { pane: 'chat', message: '' })).status, 400);

  const beforeBlocked = inserted.chat.length;
  panes.chat.executeJavaScript = async script => {
    if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
      return {
        ok: true,
        composerPresent: true,
        composerEditable: true,
        generationActive: false,
      };
    }
    if (script.includes('const enforceChatMode')) {
      return { ok: false, error: 'rate_limit_hard_block' };
    }
    return { ok: true };
  };
  const blocked = await request('/v1/message', { pane: 'chat', message: 'não deve inserir' });
  assert.equal(blocked.status, 429);
  assert.equal(inserted.chat.length, beforeBlocked);
});

test('message transport waits for active generation before touching the composer', async () => {
  let readinessCalls = 0;
  let insertCalls = 0;
  let submitCalls = 0;
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/active-generation',
    getTitle: () => 'chat',
    executeJavaScript: async script => {
      if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
        readinessCalls += 1;
        if (readinessCalls === 1) {
          return {
            ok: false,
            composerPresent: true,
            composerEditable: true,
            generationActive: true,
            stopControl: { testId: 'stop-button' },
          };
        }
        return {
          ok: true,
          composerPresent: true,
          composerEditable: true,
          generationActive: false,
          stopControl: null,
        };
      }
      if (script.includes('const enforceChatMode')) {
        return {
          ok: true,
          baseline: {
            url: 'https://chatgpt.com/c/active-generation',
            userMessageCount: 1,
            lastUserMessageId: 'user-old',
            lastAssistantMessageId: 'assistant-handshake',
          },
        };
      }
      if (script.includes('MCF_MESSAGE_INSERT_VERIFICATION')) {
        return {
          ok: true,
          composerPresent: true,
          actualLength: 15,
          expectedLength: 15,
        };
      }
      if (script.includes('chat_send_control_not_found')) {
        submitCalls += 1;
        return { ok: true, method: 'button' };
      }
      if (script.includes('conversationAdvanced')) {
        return {
          ok: true,
          composerCleared: true,
          conversationAdvanced: true,
          sent: true,
          url: 'https://chatgpt.com/c/active-generation',
          userMessageCount: 2,
          lastUserMessageId: 'user-new',
          lastAssistantMessageId: 'assistant-handshake',
          baselineLastAssistantMessageId: 'assistant-handshake',
        };
      }
      if (script.includes('const expected =')) {
        return {
          ok: true,
          composerEmpty: true,
          composerTextLength: 0,
          automationResidual: false,
        };
      }
      return { ok: true };
    },
    insertText: async () => {
      assert.equal(readinessCalls, 2);
      insertCalls += 1;
    },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: os.tmpdir(),
    instanceId: 'test',
    messageComposerReadyTimeoutMs: 50,
    messageComposerReadyPollMs: 1,
  });

  const result = await bridge.sendMessage('chat', 'mission payload');
  assert.equal(result.ok, true);
  assert.equal(readinessCalls, 2);
  assert.equal(insertCalls, 1);
  assert.equal(submitCalls, 1);
});

test('message transport fails closed when generation never becomes idle', async () => {
  let insertCalls = 0;
  let nonReadinessScripts = 0;
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/still-active',
    getTitle: () => 'chat',
    executeJavaScript: async script => {
      if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
        return {
          ok: false,
          composerPresent: true,
          composerEditable: true,
          generationActive: true,
          stopControl: {
            ariaLabel: 'Parar de responder',
            testId: 'stop-button',
          },
        };
      }
      nonReadinessScripts += 1;
      return { ok: true };
    },
    insertText: async () => { insertCalls += 1; },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: os.tmpdir(),
    instanceId: 'test',
    messageComposerReadyTimeoutMs: 5,
    messageComposerReadyPollMs: 1,
  });

  const result = await bridge.sendMessage('chat', 'must not be typed');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'message_send_blocked_generation_active');
  assert.equal(result.readiness?.generationActive, true);
  assert.equal(insertCalls, 0);
  assert.equal(nonReadinessScripts, 0);
});

test('message transport does not submit when native insertion is not observed', async () => {
  let insertCalls = 0;
  let submitCalls = 0;
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/insert-missing',
    getTitle: () => 'chat',
    executeJavaScript: async script => {
      if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
        return {
          ok: true,
          composerPresent: true,
          composerEditable: true,
          generationActive: false,
        };
      }
      if (script.includes('const enforceChatMode')) {
        return {
          ok: true,
          baseline: {
            url: 'https://chatgpt.com/c/insert-missing',
            userMessageCount: 1,
            lastUserMessageId: 'user-old',
            lastAssistantMessageId: 'assistant-old',
          },
        };
      }
      if (script.includes('MCF_MESSAGE_INSERT_VERIFICATION')) {
        return {
          ok: false,
          composerPresent: true,
          actualLength: 0,
          expectedLength: 18,
        };
      }
      if (script.includes('chat_send_control_not_found')) {
        submitCalls += 1;
        return { ok: true, method: 'button' };
      }
      return { ok: true };
    },
    insertText: async () => { insertCalls += 1; },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: os.tmpdir(),
    instanceId: 'test',
    messageComposerReadyTimeoutMs: 20,
    messageComposerReadyPollMs: 1,
  });

  const result = await bridge.sendMessage('chat', 'insertion vanished');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'message_native_insert_not_observed');
  assert.equal(insertCalls, 1);
  assert.equal(submitCalls, 0);
});

test('CR-01: unconfirmed delivery after one submit never resubmits or clicks Stop', async () => {
  let insertCalls = 0;
  let submitClicks = 0;
  let submitGuardCalls = 0;
  let stopClicks = 0;
  let verificationCalls = 0;
  let generationActive = false;

  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/cr01',
    getTitle: () => 'chat',
    executeJavaScript: async script => {
      if (script.includes('stopControl.click')) stopClicks += 1;

      if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
        return {
          ok: true,
          composerPresent: true,
          composerEditable: true,
          generationActive: false,
          stopControl: null,
        };
      }
      if (script.includes('const enforceChatMode')) {
        return {
          ok: true,
          baseline: {
            url: 'https://chatgpt.com/c/cr01',
            userMessageCount: 1,
            lastUserMessageId: 'user-before',
            lastAssistantMessageId: 'assistant-before',
          },
        };
      }
      if (script.includes('MCF_MESSAGE_INSERT_VERIFICATION')) {
        return {
          ok: true,
          composerPresent: true,
          actualLength: 12,
          expectedLength: 12,
        };
      }
      if (script.includes('chat_send_control_not_found')) {
        submitGuardCalls += 1;
        submitClicks += 1;
        generationActive = true;
        return { ok: true, method: 'button' };
      }
      if (script.includes('conversationAdvanced')) {
        verificationCalls += 1;
        assert.equal(generationActive, true);
        assert.equal(script.includes('send.click()'), false);
        assert.equal(script.includes('stopControl.click'), false);
        return {
          ok: true,
          composerCleared: true,
          conversationAdvanced: false,
          sent: false,
          url: 'https://chatgpt.com/c/cr01',
          userMessageCount: 1,
          lastUserMessageId: 'user-before',
          lastAssistantMessageId: 'assistant-before',
          baselineLastAssistantMessageId: 'assistant-before',
        };
      }
      if (script.includes('MCF_DRAFT_CLEANUP')) {
        return {
          ok: true,
          cleaned: true,
          remainingLength: 0,
        };
      }
      return { ok: true };
    },
    insertText: async () => { insertCalls += 1; },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: os.tmpdir(),
    instanceId: 'test',
    messageComposerReadyTimeoutMs: 20,
    messageComposerReadyPollMs: 1,
  });

  const result = await bridge.sendMessage('chat', 'mission CR01');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'message_send_unconfirmed');
  assert.equal(insertCalls, 1);
  assert.equal(submitGuardCalls, 1);
  assert.equal(submitClicks, 1);
  assert.equal(stopClicks, 0);
  assert.equal(verificationCalls, 20);
});

test('CR-14: Stop appearing after insert blocks submit without clicking it', async () => {
  let insertCalls = 0;
  let submitGuardCalls = 0;
  let submitClicks = 0;
  let stopClicks = 0;

  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/cr14',
    getTitle: () => 'chat',
    executeJavaScript: async script => {
      if (script.includes('stopControl.click')) stopClicks += 1;

      if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
        return {
          ok: true,
          composerPresent: true,
          composerEditable: true,
          generationActive: false,
          stopControl: null,
        };
      }
      if (script.includes('const enforceChatMode')) {
        return {
          ok: true,
          baseline: {
            url: 'https://chatgpt.com/c/cr14',
            userMessageCount: 1,
            lastUserMessageId: 'user-before',
            lastAssistantMessageId: 'assistant-before',
          },
        };
      }
      if (script.includes('MCF_MESSAGE_INSERT_VERIFICATION')) {
        return {
          ok: true,
          composerPresent: true,
          actualLength: 12,
          expectedLength: 12,
        };
      }
      if (script.includes('chat_send_control_not_found')) {
        submitGuardCalls += 1;
        const stopGuardIndex = script.indexOf('if (stopControl)');
        const sendClickIndex = script.indexOf('send.click()');
        assert.ok(stopGuardIndex >= 0);
        assert.ok(sendClickIndex > stopGuardIndex);
        return {
          ok: false,
          error: 'message_send_blocked_generation_active',
        };
      }
      if (script.includes('MCF_DRAFT_CLEANUP')) {
        return {
          ok: true,
          cleaned: true,
          remainingLength: 0,
        };
      }
      return { ok: true };
    },
    insertText: async () => { insertCalls += 1; },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: os.tmpdir(),
    instanceId: 'test',
    messageComposerReadyTimeoutMs: 20,
    messageComposerReadyPollMs: 1,
  });

  const result = await bridge.sendMessage('chat', 'mission CR14');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'message_send_blocked_generation_active');
  assert.equal(insertCalls, 1);
  assert.equal(submitGuardCalls, 1);
  assert.equal(submitClicks, 0);
  assert.equal(stopClicks, 0);
});

test('CR-15: present but non-editable composer blocks insert and submit', async () => {
  let readinessCalls = 0;
  let insertCalls = 0;
  let submitGuardCalls = 0;

  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/cr15',
    getTitle: () => 'chat',
    executeJavaScript: async script => {
      if (script.includes('MCF_MESSAGE_COMPOSER_READINESS')) {
        readinessCalls += 1;
        return {
          ok: false,
          composerPresent: true,
          composerEditable: false,
          generationActive: false,
          stopControl: null,
        };
      }
      if (script.includes('chat_send_control_not_found')) submitGuardCalls += 1;
      return { ok: true };
    },
    insertText: async () => { insertCalls += 1; },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: os.tmpdir(),
    instanceId: 'test',
    messageComposerReadyTimeoutMs: 5,
    messageComposerReadyPollMs: 1,
  });

  const result = await bridge.sendMessage('chat', 'mission CR15');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chat_composer_not_ready');
  assert.equal(result.readiness?.composerPresent, true);
  assert.equal(result.readiness?.composerEditable, false);
  assert.ok(readinessCalls >= 1);
  assert.equal(insertCalls, 0);
  assert.equal(submitGuardCalls, 0);
});


test('browser automation routes target chat or workspace explicitly', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-pane-routes-'));
  const calls = { chat: [], workspace: [] };

  function fakeWebContents(pane) {
    let currentUrl = 'https://' + pane + '.test/';
    return {
      isDestroyed: () => false,
      getURL: () => currentUrl,
      getTitle: () => pane.toUpperCase(),
      isLoading: () => false,
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => true,
        goBack: () => calls[pane].push(['back']),
        goForward: () => calls[pane].push(['forward']),
      },
      loadURL: async url => { currentUrl = url; calls[pane].push(['navigate', url]); },
      reload: () => calls[pane].push(['reload']),
      stop: () => calls[pane].push(['stop']),
      sendInputEvent: event => calls[pane].push(['input', event.type]),
      executeJavaScript: async script => {
        calls[pane].push(['script', script]);
        if (script.includes('document.body?.innerText')) {
          return { url: currentUrl, title: pane.toUpperCase(), text: 'TEXT-' + pane };
        }
        if (script.includes('const nodes =')) {
          return { url: currentUrl, title: pane.toUpperCase(), nodes: [{ text: pane }] };
        }
        return { ok: true };
      },
      mainFrame: {
        framesInSubtree: [{
          executeJavaScript: async () => {
            calls[pane].push(['frame-click']);
            return { ok: true };
          },
        }],
      },
      capturePage: async () => ({ toPNG: () => Buffer.from(pane) }),
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

  const base = 'http://127.0.0.1:' + bridge.port;
  const auth = { Authorization: 'Bearer ' + bridge.token };
  const get = route => fetch(base + route, { headers: auth });
  const post = (route, body) => fetch(base + route, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const chatState = await (await get('/v1/state?pane=chat')).json();
  assert.equal(chatState.state.pane, 'chat');
  assert.equal(chatState.state.title, 'CHAT');

  const defaultState = await (await get('/v1/state')).json();
  assert.equal(defaultState.state.pane, 'workspace');
  assert.equal(defaultState.state.title, 'WORKSPACE');

  const chatText = await (await get('/v1/text?pane=chat')).json();
  assert.equal(chatText.pane, 'chat');
  assert.equal(chatText.page.text, 'TEXT-chat');

  const chatInteractive = await (await get('/v1/interactive?pane=chat')).json();
  assert.equal(chatInteractive.pane, 'chat');
  assert.equal(chatInteractive.page.title, 'CHAT');

  assert.equal((await post('/v1/navigate', { pane: 'chat', url: 'https://example.com/chat' })).status, 200);
  assert.ok(calls.chat.some(call => call[0] === 'navigate'));
  assert.ok(!calls.workspace.some(call => call[0] === 'navigate'));

  assert.equal((await post('/v1/action', { pane: 'chat', action: 'reload' })).status, 200);
  assert.ok(calls.chat.some(call => call[0] === 'reload'));

  assert.equal((await post('/v1/find-click', { pane: 'chat', text: 'continue' })).status, 200);
  assert.ok(calls.chat.some(call => call[0] === 'frame-click'));

  assert.equal((await post('/v1/click', { pane: 'chat', selector: '#go' })).status, 200);
  assert.equal((await post('/v1/type', { pane: 'chat', selector: '#field', text: 'abc' })).status, 200);
  assert.equal((await post('/v1/pointer', { pane: 'chat', x: 10, y: 20 })).status, 200);
  assert.ok(calls.chat.some(call => call[0] === 'input'));

  assert.equal((await get('/v1/state?pane=other')).status, 400);
  assert.equal((await post('/v1/navigate', { pane: 'other', url: 'https://example.com/' })).status, 400);
});


test('identity runtime endpoints expose agents, bootstrap, missions and receipts', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-identity-api-'));
  const calls = [];
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => ({
      isDestroyed: () => false,
      getURL: () => 'https://workspace.test/',
      getTitle: () => 'workspace',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    }),
    captureDir: dir,
    instanceId: 'test',
    getAgentIdentities: async () => ([
      { pane: 'chat', agentId: 'Emily', state: 'READY' },
      { pane: 'workspace', agentId: 'Sofia', state: 'READY' },
    ]),
    bootstrapAgentIdentities: async input => {
      calls.push(['bootstrap', input]);
      return { ok: true, agents: ['Emily', 'Sofia'] };
    },
    dispatchAgentMission: async input => {
      calls.push(['mission', input]);
      return {
        ok: true,
        envelope: { envelopeId: 'env-1', agent: { agentId: input.agentId } },
        receipt: { receiptId: 'receipt-1', status: 'DELIVERED' },
      };
    },
    listAgentReceipts: async () => ([{ receiptId: 'receipt-1', status: 'DELIVERED' }]),
    listAgentMissions: async () => ([
      { envelopeId: 'env-1', missionId: 'MISSION-1', parentMissionId: 'PARENT-1', state: 'COMPLETED', result: { resultSha256: 'a'.repeat(64) } },
    ]),
    getAgentMission: async envelopeId => envelopeId === 'env-1'
      ? { envelopeId: 'env-1', missionId: 'MISSION-1', parentMissionId: 'PARENT-1', state: 'COMPLETED', result: { resultSha256: 'a'.repeat(64) } }
      : null,
    getParentAgentMissionStatus: async missionId => ({
      parentMissionId: missionId,
      required: 1,
      completed: 1,
      active: 0,
      closable: true,
      blockers: [],
    }),
  });
  await bridge.start(0);
  t.after(async () => { await bridge.stop(); rmSync(dir, { recursive: true }); });

  const base = 'http://127.0.0.1:' + bridge.port;
  const auth = { Authorization: 'Bearer ' + bridge.token };
  const get = route => fetch(base + route, { headers: auth });
  const post = (route, body) => fetch(base + route, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const agents = await (await get('/v1/agents')).json();
  assert.equal(agents.ok, true);
  assert.equal(agents.agents.length, 2);
  assert.equal(agents.agents[0].agentId, 'Emily');

  const boot = await (await post('/v1/agents/bootstrap', { agentId: 'Emily' })).json();
  assert.equal(boot.ok, true);
  assert.deepEqual(calls[0], ['bootstrap', { agentId: 'Emily' }]);

  const mission = await (await post('/v1/mission-envelope', {
    agentId: 'Sofia',
    missionId: 'MISSION-1',
    objective: 'Definir uma fronteira.',
  })).json();
  assert.equal(mission.ok, true);
  assert.equal(mission.envelope.agent.agentId, 'Sofia');

  const receipts = await (await get('/v1/agent-receipts')).json();
  assert.equal(receipts.ok, true);
  assert.equal(receipts.receipts[0].receiptId, 'receipt-1');

  const missions = await (await get('/v1/missions')).json();
  assert.equal(missions.ok, true);
  assert.equal(missions.missions[0].state, 'COMPLETED');

  const missionStatus = await (await get('/v1/mission-status?envelopeId=env-1')).json();
  assert.equal(missionStatus.ok, true);
  assert.equal(missionStatus.mission.envelopeId, 'env-1');

  const result = await (await get('/v1/mission-result?envelopeId=env-1')).json();
  assert.equal(result.ok, true);
  assert.equal(result.result.resultSha256, 'a'.repeat(64));

  const parent = await (await get('/v1/parent-mission-status?missionId=PARENT-1')).json();
  assert.equal(parent.ok, true);
  assert.equal(parent.status.closable, true);

  assert.equal((await get('/v1/mission-status?envelopeId=missing')).status, 404);
});


test('message delivery requires conversation advancement and cleans residual draft on failure', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-message-confirm-'));
  const scripts = [];
  let composerText = '';
  let userMessageCount = 4;
  const url = 'https://chatgpt.com/g/project/c/conversation-1';

  const wc = {
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => 'chat',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    insertText: async value => { composerText = value; },
    executeJavaScript: async script => {
      scripts.push(script);
      if (script.includes('const enforceChatMode')) {
        composerText = '';
        return {
          ok: true,
          baseline: { url, userMessageCount, lastUserMessageId: 'user-old', lastAssistantMessageId: 'assistant-old' },
        };
      }
      if (script.includes('chat_send_control_not_found')) {
        return { ok: true, method: 'button' };
      }
      if (script.includes('conversationAdvanced')) {
        return {
          ok: true,
          composerCleared: false,
          conversationAdvanced: false,
          sent: false,
          url,
          userMessageCount,
        };
      }
      if (script.includes('MCF_DRAFT_CLEANUP')) {
        composerText = '';
        return { ok: true, cleaned: true, remainingLength: 0 };
      }
      return { ok: true };
    },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: pane => pane === 'chat' ? wc : null,
    captureDir: dir,
    instanceId: 'test',
  });
  t.after(async () => { await bridge.stop(); rmSync(dir, { recursive: true }); });

  const failed = await bridge.sendMessage('chat', 'mensagem residual');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'message_send_unconfirmed');
  assert.equal(failed.cleanup?.cleaned, true);
  assert.equal(composerText, '');
  assert.ok(scripts.some(script => script.includes('MCF_DRAFT_CLEANUP')));

  // Now prove that an empty composer alone is not enough: conversation must advance.
  let verificationCalls = 0;
  wc.executeJavaScript = async script => {
    scripts.push(script);
    if (script.includes('const enforceChatMode')) {
      composerText = '';
      return { ok: true, baseline: { url, userMessageCount, lastUserMessageId: 'user-old', lastAssistantMessageId: 'assistant-old' } };
    }
    if (script.includes('chat_send_control_not_found')) {
      return { ok: true, method: 'button' };
    }
    if (script.includes('conversationAdvanced')) {
      verificationCalls += 1;
      composerText = '';
      if (verificationCalls < 2) {
        return {
          ok: true,
          composerCleared: true,
          conversationAdvanced: false,
          sent: false,
          url,
          userMessageCount,
        };
      }
      userMessageCount += 1;
      return {
        ok: true,
        composerCleared: true,
        conversationAdvanced: true,
        sent: true,
        url,
        userMessageCount,
        lastUserMessageId: 'user-new',
        lastAssistantMessageId: 'assistant-old',
        baselineLastAssistantMessageId: 'assistant-old',
      };
    }
    if (script.includes('MCF_DRAFT_CLEANUP')) {
      composerText = '';
      return { ok: true, cleaned: true, remainingLength: 0 };
    }
    if (script.includes('const expected =')) {
      return {
        ok: true,
        composerEmpty: true,
        composerTextLength: 0,
        automationResidual: false,
      };
    }
    return { ok: true };
  };

  const delivered = await bridge.sendMessage('chat', 'mensagem confirmada');
  assert.equal(delivered.ok, true);
  assert.equal(delivered.deliveryConfirmed, true);
  assert.ok(verificationCalls >= 2);
});


test('post-send stabilization cleans only automation residuals and preserves unknown drafts', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-postsend-'));
  let mode = 'automation';
  let cleanupCalls = 0;
  const url = 'https://chatgpt.com/g/project/c/conversation-2';

  const wc = {
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => 'chat',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    insertText: async () => {},
    executeJavaScript: async script => {
      if (script.includes('const enforceChatMode')) {
        return {
          ok: true,
          baseline: {
            url,
            userMessageCount: 2,
            lastUserMessageId: 'user-old',
            lastAssistantMessageId: 'assistant-old',
          },
        };
      }
      if (script.includes('chat_send_control_not_found')) {
        return { ok: true, method: 'button' };
      }
      if (script.includes('conversationAdvanced')) {
        return {
          ok: true,
          composerCleared: true,
          conversationAdvanced: true,
          sent: true,
          url,
          userMessageCount: 2,
          lastUserMessageId: 'user-new',
          lastAssistantMessageId: 'assistant-old',
          baselineLastAssistantMessageId: 'assistant-old',
        };
      }
      if (script.includes('const expected =')) {
        return mode === 'automation'
          ? {
              ok: true,
              composerEmpty: false,
              composerTextLength: 200,
              automationResidual: true,
            }
          : {
              ok: true,
              composerEmpty: false,
              composerTextLength: 22,
              automationResidual: false,
            };
      }
      if (script.includes('MCF_DRAFT_CLEANUP')) {
        cleanupCalls += 1;
        return { ok: true, cleaned: true, remainingLength: 0 };
      }
      return { ok: true };
    },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: pane => pane === 'chat' ? wc : null,
    captureDir: dir,
    instanceId: 'test',
  });
  t.after(async () => { await bridge.stop(); rmSync(dir, { recursive: true }); });

  const cleaned = await bridge.sendMessage(
    'chat',
    '[MCF MISSION ENVELOPE]\nparentMissionId: PARENT-1',
  );
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.deliveryConfirmed, true);
  assert.equal(cleaned.postSendStable, true);
  assert.equal(cleaned.postSendCleanup?.cleaned, true);
  assert.equal(cleanupCalls, 1);

  mode = 'human';
  const preserved = await bridge.sendMessage('chat', 'mensagem normal');
  assert.equal(preserved.ok, false);
  assert.equal(preserved.error, 'message_postsend_draft_present');
  assert.equal(preserved.cleanup?.preserved, true);
  assert.equal(preserved.cleanup?.reason, 'unrecognized_draft_preserved');
  assert.equal(cleanupCalls, 1);
});

test('mission endpoint returns 503 while agent runtime startup recovery is incomplete', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-runtime-startup-gate-'));
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => ({
      isDestroyed: () => false,
      getURL: () => 'https://workspace.test/',
      getTitle: () => 'workspace',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    }),
    captureDir: dir,
    instanceId: 'test',
    dispatchAgentMission: async () => ({
      ok: false,
      error: 'agent_runtime_initializing',
    }),
  });
  await bridge.start(0);
  t.after(async () => { await bridge.stop(); rmSync(dir, { recursive: true }); });

  const response = await fetch('http://127.0.0.1:' + bridge.port + '/v1/mission-envelope', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + bridge.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agentId: 'Sofia',
      missionId: 'MISSION-STARTUP-GATE-HTTP',
      objective: 'Aguardar startup.',
    }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'agent_runtime_initializing');
});


test('recovery checkpoint gates messages and exposes reconcile/cancel lifecycle controls', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-recovery-api-'));
  const calls = [];
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.test/c/recovery',
    getTitle: () => 'recovery',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    executeJavaScript: async () => ({ ok: true }),
  };
  const checkpointFor = async ({ pane = null } = {}) => {
    calls.push(['checkpoint', pane]);
    const blocked = pane === 'chat';
    return {
      ok: true,
      pane,
      recoveryRequired: blocked,
      mutationAllowed: !blocked,
      blockers: blocked ? [{ envelopeId: 'env-recovery', pane: 'chat', state: 'UNVERIFIED' }] : [],
    };
  };
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: dir,
    instanceId: 'test',
    getAgentRecoveryCheckpoint: checkpointFor,
    reconcileAgentMission: async input => {
      calls.push(['reconcile', input]);
      return { ok: true, envelopeId: input.envelopeId, reconciliationRequired: false, state: 'UNVERIFIED' };
    },
    cancelAgentMission: async input => {
      calls.push(['cancel', input]);
      return { ok: true, envelopeId: input.envelopeId, cancellationRequested: true, reconciliationRequired: true };
    },
  });
  await bridge.start(0);
  t.after(async () => { await bridge.stop(); rmSync(dir, { recursive: true }); });

  const base = 'http://127.0.0.1:' + bridge.port;
  const headers = {
    Authorization: 'Bearer ' + bridge.token,
    'Content-Type': 'application/json',
  };

  const checkpoint = await fetch(base + '/v1/recovery-checkpoint?pane=chat', { headers });
  assert.equal(checkpoint.status, 200);
  const checkpointBody = await checkpoint.json();
  assert.equal(checkpointBody.recoveryRequired, true);
  assert.equal(checkpointBody.mutationAllowed, false);

  const invalid = await fetch(base + '/v1/recovery-checkpoint?pane=invalid', { headers });
  assert.equal(invalid.status, 400);

  const blockedMessage = await fetch(base + '/v1/message', {
    method: 'POST',
    headers,
    body: JSON.stringify({ pane: 'chat', message: 'não deve ser enviada' }),
  });
  assert.equal(blockedMessage.status, 409);
  assert.equal((await blockedMessage.json()).error, 'recovery_required');

  const blockedBroadcast = await fetch(base + '/v1/messages/broadcast', {
    method: 'POST',
    headers,
    body: JSON.stringify({ targets: ['chat', 'workspace'], message: 'não deve duplicar' }),
  });
  assert.equal(blockedBroadcast.status, 409);
  assert.equal((await blockedBroadcast.json()).error, 'recovery_required');

  const guardedMutations = [
    ['/v1/navigate', { pane: 'chat', url: 'https://example.test/recovery-blocked' }],
    ['/v1/action', { pane: 'chat', action: 'reload' }],
    ['/v1/find-click', { pane: 'chat', text: 'qualquer botão' }],
    ['/v1/click', { pane: 'chat', selector: '#prompt-textarea' }],
    ['/v1/type', { pane: 'chat', selector: '#prompt-textarea', text: 'não deve escrever' }],
    ['/v1/pointer', { pane: 'chat', x: 10, y: 10 }],
    ['/v1/upload-file', { pane: 'chat', file: '/tmp/nao-deve-ser-lido' }],
  ];
  for (const [route, payload] of guardedMutations) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 409, route);
    const body = await response.json();
    assert.equal(body.error, 'recovery_required', route);
    assert.equal(body.pane, 'chat', route);
  }

  const reconciled = await fetch(base + '/v1/mission-reconcile', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      envelopeId: 'env-recovery',
      outcome: 'no_active_execution_confirmed',
      authority: 'LEANDRO',
    }),
  });
  assert.equal(reconciled.status, 200);
  assert.equal((await reconciled.json()).ok, true);

  const cancelled = await fetch(base + '/v1/mission-cancel', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      envelopeId: 'env-recovery',
      authority: 'LEANDRO',
      reason: 'explicit test cancel',
    }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).cancellationRequested, true);

  assert.ok(calls.some(call => call[0] === 'reconcile'));
  assert.ok(calls.some(call => call[0] === 'cancel'));
});
