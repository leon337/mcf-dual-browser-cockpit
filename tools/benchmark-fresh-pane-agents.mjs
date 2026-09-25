#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

function arg(name, fallback = null) {
  const prefix = '--' + name + '=';
  const hit = process.argv.find(value => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function boolArg(name, fallback) {
  const value = arg(name, null);
  if (value == null) return fallback;
  return !['0', 'false', 'no'].includes(value.toLowerCase());
}

const instance = arg('instance', 'notebook');
const launch = arg('launch', null);
const timeoutMs = Number(arg('timeout-ms', '180000'));
const parallel = boolArg('parallel', true);
const profileDir = path.join(
  homedir(),
  '.config',
  'mcf-dual-browser-cockpit',
  'instances',
  instance,
);
const descriptorPath = arg('descriptor', path.join(profileDir, 'agent-bridge.json'));
const runtimeStatePath = arg('runtime-state', path.join(profileDir, 'runtime-state.json'));

const startedAt = performance.now();
const marks = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const elapsed = () => Math.round(performance.now() - startedAt);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function maybeDescriptor() {
  try {
    return await readJson(descriptorPath);
  } catch {
    return null;
  }
}

function headers(descriptor, json = false) {
  const value = {
    Authorization: 'Bearer ' + descriptor.token,
    'X-MCF-Instance': instance,
  };
  if (json) value['Content-Type'] = 'application/json';
  return value;
}

async function request(descriptor, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      'http://127.0.0.1:' + descriptor.port + pathname,
      {
        ...options,
        headers: {
          ...headers(descriptor, Boolean(options.body)),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      throw new Error(
        'bridge_http_' + response.status + (body?.error ? ':' + body.error : ''),
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function canonicalConversation(url) {
  const value = String(url || '');
  return /\/c\/[^/?]+/.test(value) && !/local-chatgpt/i.test(value);
}

async function waitUntil(check, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last?.ok) return last.value;
    } catch (error) {
      last = { ok: false, error: error.message };
    }
    await sleep(50);
  }
  throw new Error(label + '_timeout:' + JSON.stringify(last));
}

const oldDescriptor = await maybeDescriptor();

if (launch) {
  const child = spawn(launch, [], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  marks.launch_return = elapsed();
}

const descriptor = await waitUntil(async () => {
  const current = await maybeDescriptor();
  if (!current?.token || !current?.port || !current?.pid) return { ok: false };
  if (launch && oldDescriptor?.pid && current.pid === oldDescriptor.pid) {
    return { ok: false, value: current };
  }
  try {
    await request(current, '/v1/state?pane=chat');
    return { ok: true, value: current };
  } catch {
    return { ok: false, value: current };
  }
}, 'bridge_ready');
marks.bridge_ready = elapsed();

const discovery = await request(descriptor, '/v1/discovery');
const paneAgents = discovery?.discovery?.current?.paneAgents ?? [];
if (!paneAgents.length) throw new Error('pane_agents_not_discovered');

const bootstrapStarted = elapsed();
const bootstrap = await request(descriptor, '/v1/agents/bootstrap', {
  method: 'POST',
  body: JSON.stringify({ force: true, parallel }),
});
marks.bootstrap_return = elapsed();

const final = await waitUntil(async () => {
  const agentsResponse = await request(descriptor, '/v1/agents');
  const agents = agentsResponse?.agents ?? [];
  const agentReady = agents.length === paneAgents.length
    && agents.every(agent => agent.state === 'READY' && agent.handshakeVerified === true);
  if (!agentReady) return { ok: false, value: { agents } };

  const paneStates = {};
  for (const agent of agents) {
    const state = await request(
      descriptor,
      '/v1/state?pane=' + encodeURIComponent(agent.pane),
    );
    paneStates[agent.pane] = state?.state ?? null;
  }

  const stateUrlsReady = Object.values(paneStates)
    .every(state => canonicalConversation(state?.url));
  if (!stateUrlsReady) return { ok: false, value: { agents, paneStates } };

  let persisted = null;
  try {
    persisted = await readJson(runtimeStatePath);
  } catch {
    return { ok: false, value: { agents, paneStates } };
  }

  const persistedReady = canonicalConversation(persisted?.chat?.url)
    && canonicalConversation(persisted?.workspace?.url);

  return persistedReady
    ? { ok: true, value: { agents, paneStates, persisted } }
    : { ok: false, value: { agents, paneStates, persisted } };
}, 'ready_persisted');
marks.ready_persisted = elapsed();

const safeAgents = final.agents.map(agent => ({
  agentId: agent.agentId,
  pane: agent.pane,
  state: agent.state,
  handshakeVerified: agent.handshakeVerified,
}));

console.log(JSON.stringify({
  schema: 'mcf-dual-browser-fresh-pane-benchmark/v1',
  instance,
  parallel,
  timingsMs: {
    ...marks,
    bootstrap_only: marks.ready_persisted - bootstrapStarted,
    total: marks.ready_persisted,
  },
  bootstrap: {
    ok: bootstrap?.ok === true,
    parallel: bootstrap?.parallel === true,
  },
  agents: safeAgents,
  persistedUrls: {
    chat: final.persisted.chat.url,
    workspace: final.persisted.workspace.url,
  },
}, null, 2));
