#!/usr/bin/env node
/**
 * MCP Server (stdio JSON-RPC 2.0) para o LocalAgentBridge do mcf-dual-browser-cockpit.
 * Zero dependências externas — compatível com Node.js >= 22.12.0.
 *
 * Variáveis de ambiente:
 *   MCF_BRIDGE_URL     (padrão: http://127.0.0.1:47831)
 *   MCF_BRIDGE_TOKEN   (obrigatório para rotas /v1/*)
 *   MCF_INSTANCE_ID    (opcional; envia header x-mcf-instance)
 */

import readline from 'node:readline';

const BRIDGE_URL = (process.env.MCF_BRIDGE_URL || 'http://127.0.0.1:47831').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.MCF_BRIDGE_TOKEN || '';
const INSTANCE_ID = process.env.MCF_INSTANCE_ID || '';
// O modo seguro é somente leitura; ações de navegação exigem opt-in local.
const MCP_MODE = process.env.MCF_MCP_MODE === 'interactive' ? 'interactive' : 'read-only';
const WRITE_TOOLS = new Set([
  'cockpit_navigate', 'cockpit_action', 'cockpit_click', 'cockpit_find_click',
  'cockpit_type', 'cockpit_pointer', 'cockpit_capture',
]);

// Nunca enviar o bearer token a hosts externos, mesmo com redirecionamentos HTTP.
const bridgeEndpoint = new URL(BRIDGE_URL);
if (bridgeEndpoint.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(bridgeEndpoint.hostname)
    || bridgeEndpoint.username || bridgeEndpoint.password
    || bridgeEndpoint.pathname !== '/' || bridgeEndpoint.search || bridgeEndpoint.hash) {
  console.error('[mcf-cockpit-mcp] MCF_BRIDGE_URL deve ser um endpoint HTTP de loopback.');
  process.exit(2);
}


const PANE_ENUM = ['chat', 'workspace'];

const TOOLS = [
  {
    name: 'cockpit_health',
    description: 'Verifica se o LocalAgentBridge do mcf-dual-browser-cockpit está ativo.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_state',
    description: 'Retorna o estado atual de um painel (URL, título, loading, histórico e fila).',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_navigate',
    description: 'Navega o painel especificado para uma URL http:// ou https://.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
        url: { type: 'string', description: 'URL de destino (http:// ou https://).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_action',
    description: 'Executa ação de navegação no histórico do painel (back, forward, reload ou stop).',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
        action: { type: 'string', enum: ['back', 'forward', 'reload', 'stop'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_accessibility',
    description: 'Captura a árvore de acessibilidade do Chromium para o painel (até 3000 nós), equivalente ao accessibility snapshot do Playwright MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_interactive',
    description: 'Lista elementos interativos e seletores disponíveis na página atual do painel.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_text',
    description: 'Extrai o texto visível (innerText, até 120.000 caracteres) da página atual do painel.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_click',
    description: 'Clica em um elemento identificado por seletor CSS no painel.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
        selector: { type: 'string', description: 'Seletor CSS do elemento.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_find_click',
    description: 'Localiza e clica no elemento visível que contém o texto especificado (até 240 caracteres).',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
        text: { type: 'string', description: 'Texto visível do botão, link ou controle.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_type',
    description: 'Digita texto em um campo editável identificado por seletor CSS no painel.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
        selector: { type: 'string', description: 'Seletor CSS do campo.' },
        text: { type: 'string', description: 'Texto a ser inserido.' },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_pointer',
    description: 'Envia um clique nas coordenadas (x, y) do painel.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_capture',
    description: 'Salva uma captura PNG da página atual do painel no diretório de capturas do cockpit.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', enum: PANE_ENUM, default: 'workspace' },
      },
      additionalProperties: false,
    },
  },
];

function validateToolArguments(name, args) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error('Ferramenta MCP desconhecida.');
  if (WRITE_TOOLS.has(name) && MCP_MODE !== 'interactive') {
    throw new Error('Ação bloqueada: MCP em modo read-only. Use MCF_MCP_MODE=interactive somente em sessão autorizada.');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Argumentos MCP devem ser um objeto JSON.');
  }
  const schema = tool.inputSchema;
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) throw new Error('Argumento MCP não reconhecido.');
  }
  for (const key of schema.required || []) {
    if (!(key in args)) throw new Error('Argumento MCP obrigatório ausente.');
  }
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error('Coordenada MCP inválida.');
    }
    if (field.type === 'string' && typeof value !== 'string') {
      throw new Error('Argumento MCP deve ser uma string.');
    }
    if (field.enum && !field.enum.includes(value)) throw new Error('Valor MCP fora da enumeração permitida.');
    if (key === 'selector' && (!value.trim() || value.length > 2000)) {
      throw new Error('Seletor CSS ausente ou excessivo.');
    }
    if (key === 'text' && (!value.trim() || value.length > (name === 'cockpit_find_click' ? 240 : 16000))) {
      throw new Error('Texto MCP ausente ou excessivo.');
    }
    if (key === 'url') {
      let target;
      try { target = new URL(value); } catch { throw new Error('URL MCP inválida.'); }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw new Error('URL MCP não autorizada.');
      }
    }
  }
}

async function callBridge(method, path, { auth = true, body = undefined } = {}) {
  const headers = {};
  if (auth) {
    if (!BRIDGE_TOKEN) {
      throw new Error('MCF_BRIDGE_TOKEN não definido no ambiente.');
    }
    headers['Authorization'] = `Bearer ${BRIDGE_TOKEN}`;
  }
  if (INSTANCE_ID) {
    headers['x-mcf-instance'] = INSTANCE_ID;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Bridge HTTP ${res.status}: ${JSON.stringify(parsed)}`);
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

async function handleToolCall(name, args = {}) {
  validateToolArguments(name, args);
  const pane = args.pane || 'workspace';
  const qPane = encodeURIComponent(pane);

  switch (name) {
    case 'cockpit_health':
      return callBridge('GET', '/health', { auth: false });
    case 'cockpit_state':
      return callBridge('GET', `/v1/state?pane=${qPane}`);
    case 'cockpit_navigate':
      return callBridge('POST', '/v1/navigate', { body: { pane, url: args.url } });
    case 'cockpit_action':
      return callBridge('POST', '/v1/action', { body: { pane, action: args.action } });
    case 'cockpit_accessibility':
      return callBridge('GET', `/v1/accessibility?pane=${qPane}`);
    case 'cockpit_interactive':
      return callBridge('GET', `/v1/interactive?pane=${qPane}`);
    case 'cockpit_text':
      return callBridge('GET', `/v1/text?pane=${qPane}`);
    case 'cockpit_click':
      return callBridge('POST', '/v1/click', { body: { pane, selector: args.selector } });
    case 'cockpit_find_click':
      return callBridge('POST', '/v1/find-click', { body: { pane, text: args.text } });
    case 'cockpit_type':
      return callBridge('POST', '/v1/type', {
        body: { pane, selector: args.selector, text: args.text },
      });
    case 'cockpit_pointer':
      return callBridge('POST', '/v1/pointer', {
        body: { pane, x: args.x, y: args.y },
      });
    case 'cockpit_capture':
      return callBridge('POST', '/v1/capture', { body: { pane } });
    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    sendError(null, -32700, 'JSON inválido.');
    return;
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)
      || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    sendError(req && typeof req === 'object' && !Array.isArray(req) ? (req.id ?? null) : null, -32600, 'Requisição JSON-RPC inválida.');
    return;
  }

  const { id, method, params } = req;

  // Notificações não possuem id e não devem receber resposta
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'mcf-dual-browser-cockpit-mcp',
          version: '1.0.0',
        },
      });
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, { tools: MCP_MODE === 'interactive' ? TOOLS : TOOLS.filter((tool) => !WRITE_TOOLS.has(tool.name)) });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (toolErr) {
        sendResult(id, {
          content: [{ type: 'text', text: toolErr.message }],
          isError: true,
        });
      }
      return;
    }

    sendError(id, -32601, `Método não suportado: ${method}`);
  } catch (err) {
    sendError(id, -32603, err.message);
  }
});
