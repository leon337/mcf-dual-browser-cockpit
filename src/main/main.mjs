import { app, BrowserWindow, WebContentsView, ipcMain, shell, clipboard, session, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalAgentBridge } from './bridge.mjs';
import { PaneAgentRuntime } from './agent-runtime.mjs';
import { agentBindingsForProfile } from './agent-identity.mjs';
import { isGenerationStopControl, isTargetGenerationActive } from './generation-control.mjs';
import { instanceConfig, atomicJson } from './instance.mjs';

const instance = instanceConfig(process.argv, app.getPath('userData'));
const agentBindings = agentBindingsForProfile(instance.agentProfile);
mkdirSync(instance.userData, { recursive: true, mode: 0o700 });
app.setPath('userData', instance.userData);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.exit(0);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(SRC_ROOT, 'preload', 'preload.cjs');
const RENDERER = path.join(SRC_ROOT, 'renderer', 'index.html');
const execFileAsync = promisify(execFile);

const HEADER_HEIGHT = 124;
const STATUS_HEIGHT = 28;
const VIEW_GAP = 8;
const MIN_PANE = 320;
const CHATGPT_URL = 'https://chatgpt.com/';
const WORKSPACE_URL = 'https://www.google.com/';

let mainWindow = null;
let chatView = null;
let workspaceView = null;
let workspaceAuxWindow = null;
const agentSessionWindows = new Map();
const agentSessionRuntime = new Map();
let splitRatio = 0.5;
let bridge = null;
let paneAgentRuntime = null;
let restoredRuntimeState = null;
let runtimePersistTimer = null;
const RUNTIME_STATE_VERSION = 1;
const PANE_AGENT_MISSION_ID = instance.agentProfile === 'debug-engineering'
  ? 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003'
  : 'MCF-DUAL-AGENT-IDENTITY-001';

const viewState = {
  chat: { url: CHATGPT_URL, title: 'ChatGPT', loading: true, canGoBack: false, canGoForward: false },
  workspace: { url: WORKSPACE_URL, title: 'Workspace', loading: true, canGoBack: false, canGoForward: false },
};

function sanitizeFileName(name) {
  return String(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 180);
}

function normalizeNavigation(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw)) {
    try { return new URL(`https://${raw}`).href; } catch { return null; }
  }

  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

function safeState(key, wc) {
  const history = wc.navigationHistory;
  return {
    url: wc.getURL() || viewState[key].url,
    title: wc.getTitle() || viewState[key].title,
    loading: wc.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

function emitState(key, wc) {
  viewState[key] = safeState(key, wc);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:state', { pane: key, ...viewState[key] });
  }
  bridge?.publishLiveEvent({
    type: 'PANE_STATE',
    source: 'WebContents',
    authority: 'observational',
    pane: key,
    state: { ...viewState[key] },
  });
}

function emitBridgeEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bridge:event', { timestamp: Date.now(), ...payload });
  }
}

function persistBridgeState(state) {
  const dir = app.getPath('userData');
  const output = path.join(dir, 'agent-bridge.json');
  mkdirSync(dir, { recursive: true });
  const payload = state?.enabled
    ? state
    : { enabled: false, host: '127.0.0.1', port: null, token: null };
  atomicJson(output, {
    ...payload,
    instanceId: instance.id,
    agentProfile: instance.agentProfile,
    pid: process.pid,
    version: app.getVersion(),
  });
}


function runtimeStateFile() {
  return path.join(app.getPath('userData'), 'runtime-state.json');
}

function normalizeRestoredUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : fallback;
  } catch {
    return fallback;
  }
}

function loadRuntimeState() {
  try {
    const file = runtimeStateFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== RUNTIME_STATE_VERSION) return null;
    return parsed;
  } catch (error) {
    console.error('Falha ao carregar runtime-state:', error.message);
    return null;
  }
}

function restoredWindowBounds() {
  const raw = restoredRuntimeState?.window?.bounds;
  if (!raw || ![raw.x, raw.y, raw.width, raw.height].every(Number.isFinite)) return null;
  const requested = {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.max(900, Math.round(raw.width)),
    height: Math.max(620, Math.round(raw.height)),
  };
  try {
    const area = screen.getDisplayMatching(requested).workArea;
    const width = Math.min(requested.width, area.width);
    const height = Math.min(requested.height, area.height);
    const x = Math.min(Math.max(requested.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(requested.y, area.y), area.y + area.height - height);
    return { x, y, width, height };
  } catch {
    return requested;
  }
}

function snapshotRuntimeState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const chatUrl = chatView && !chatView.webContents.isDestroyed()
    ? chatView.webContents.getURL()
    : restoredRuntimeState?.chat?.url;
  const workspaceUrl = workspaceView && !workspaceView.webContents.isDestroyed()
    ? workspaceView.webContents.getURL()
    : restoredRuntimeState?.workspace?.url;
  return {
    version: RUNTIME_STATE_VERSION,
    chat: { url: normalizeRestoredUrl(chatUrl, CHATGPT_URL) },
    workspace: { url: normalizeRestoredUrl(workspaceUrl, WORKSPACE_URL) },
    splitRatio,
    window: {
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    },
    savedAt: new Date().toISOString(),
  };
}

function persistRuntimeState() {
  const state = snapshotRuntimeState();
  if (!state) return null;
  const file = runtimeStateFile();
  atomicJson(file, state);
  restoredRuntimeState = state;
  return state;
}

function scheduleRuntimeStatePersist(delay = 250) {
  if (runtimePersistTimer) clearTimeout(runtimePersistTimer);
  runtimePersistTimer = setTimeout(() => {
    runtimePersistTimer = null;
    try { persistRuntimeState(); } catch (error) {
      emitBridgeEvent({ level: 'error', message: 'Falha ao persistir sessão: ' + error.message });
    }
  }, delay);
}

function configureSession(partition, { chat = false } = {}) {
  const ses = session.fromPartition(partition);

  const currentUA = ses.getUserAgent();
  if (currentUA.includes('Electron/')) {
    ses.setUserAgent(currentUA.replace(/\sElectron\/[^\s]+/g, ''));
  }

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let trusted = false;
    try {
      const host = new URL(details.requestingUrl || webContents.getURL()).hostname;
      trusted = host === 'chatgpt.com' || host.endsWith('.openai.com') || host.endsWith('.chatgpt.com');
    } catch {}

    const allowedForChat = chat && trusted && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
    callback(Boolean(allowedForChat));
  });

  const downloadDir = path.join(app.getPath('downloads'), chat ? 'MCF-ChatGPT' : 'MCF-Workspace');
  ses.on('will-download', (_event, item) => {
    mkdirSync(downloadDir, { recursive: true });
    const filename = sanitizeFileName(item.getFilename());
    item.setSavePath(path.join(downloadDir, filename));
    emitBridgeEvent({ level: 'info', message: `Download: ${filename}` });
    item.once('done', (_e, state) => {
      emitBridgeEvent({ level: state === 'completed' ? 'ok' : 'error', message: `Download ${state}: ${filename}` });
    });
  });

  return ses;
}

function secureWebContents(key, view, partition) {
  const wc = view.webContents;
  wc.setAudioMuted(false);

  wc.setWindowOpenHandler(({ url }) => {
    let parsed;
    try { parsed = new URL(url); } catch { return { action: 'deny' }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      emitBridgeEvent({ level: 'info', message: 'Protocolo externo bloqueado.' });
      return { action: 'deny' };
    }

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1080,
        height: 760,
        backgroundColor: '#0b0f14',
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    };
  });

  if (key === 'workspace') {
    wc.on('did-create-window', (childWindow) => {
      workspaceAuxWindow = childWindow;
      childWindow.webContents.setAudioMuted(false);
      emitBridgeEvent({
        level: 'info',
        message: 'Workspace auxiliar detectado: ' + (childWindow.webContents.getTitle() || 'janela web'),
      });
      childWindow.webContents.on('page-title-updated', () => {
        emitBridgeEvent({
          level: 'info',
          message: 'Workspace auxiliar: ' + (childWindow.webContents.getTitle() || 'janela web'),
        });
      });
      childWindow.on('closed', () => {
        if (workspaceAuxWindow === childWindow) workspaceAuxWindow = null;
        emitBridgeEvent({ level: 'info', message: 'Workspace auxiliar fechado.' });
      });
    });
  }

  wc.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        event.preventDefault();
        emitBridgeEvent({ level: 'info', message: 'Protocolo externo bloqueado.' });
      }
    } catch {
      event.preventDefault();
    }
  });

  for (const eventName of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) {
    wc.on(eventName, () => {
      emitState(key, wc);
      if (eventName !== 'did-start-loading') scheduleRuntimeStatePersist();
    });
  }
  wc.on('page-title-updated', () => emitState(key, wc));
  wc.on('render-process-gone', (_event, details) => {
    emitBridgeEvent({ level: 'error', message: `${key}: renderer encerrado (${details.reason}).` });
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    emitBridgeEvent({ level: 'error', message: `${key}: falha de carregamento (${errorCode}).` });
  });
}


function agentSessionToolPath() {
  const configured = String(process.env.MCF_AGENT_SESSION_TOOL || '').trim();
  if (configured) return configured;
  return path.join(app.getPath('home'), '.local', 'bin', 'mcf-agent-session');
}

async function runAgentSessionTool(args) {
  const tool = agentSessionToolPath();
  if (!existsSync(tool)) throw new Error('mcf_agent_session_tool_missing');
  const { stdout } = await execFileAsync(tool, args, {
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env },
  });
  const output = String(stdout || '').trim();
  if (!output) throw new Error('mcf_agent_session_empty_response');
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('mcf_agent_session_invalid_json');
  }
}


function paneAgentStateFile() {
  return path.join(app.getPath('userData'), 'agent-identities.json');
}

function loadPaneAgentState() {
  try {
    const file = paneAgentStateFile();
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    emitBridgeEvent({ level: 'error', message: 'Agent Identity: estado inválido — ' + error.message });
    return null;
  }
}

function savePaneAgentState(state) {
  atomicJson(paneAgentStateFile(), state);
}

function projectRootForPane(pane) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) return CHATGPT_URL;
  try {
    const current = new URL(wc.getURL());
    if (current.hostname === 'chatgpt.com') {
      const match = current.pathname.match(/^\/g\/([^/]+)/);
      if (match) return current.origin + '/g/' + match[1];
    }
  } catch {}
  return CHATGPT_URL;
}

async function freshAgentConversation(pane) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) throw new Error('pane_unavailable');
  const target = projectRootForPane(pane);
  if (wc.getURL() !== target) await wc.loadURL(target);
  const ready = await waitForChatComposer(wc, 30000);
  if (!ready) throw new Error('chat_composer_not_found');
  return { ok: true, url: wc.getURL() };
}

async function reconcileFreshAgentConversation(pane) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, fresh: false, composerAvailable: false, error: 'pane_unavailable' };
  }

  const currentUrl = wc.getURL();
  const target = projectRootForPane(pane);
  if (currentUrl !== target) {
    return {
      ok: false,
      fresh: false,
      composerAvailable: false,
      error: 'fresh_conversation_navigation_unconfirmed',
      url: currentUrl,
      target,
    };
  }

  const ready = await waitForChatComposer(wc, 3000);
  return {
    ok: Boolean(ready),
    fresh: Boolean(ready),
    composerAvailable: Boolean(ready),
    error: ready ? null : 'fresh_conversation_composer_unconfirmed',
    url: wc.getURL(),
    target,
  };
}

async function inspectIdentityBootstrap(
  pane,
  {
    agentId = null,
    sessionId = null,
    contractDigest = null,
    marker = null,
    userMessageId = null,
    expectedConversationUrl = null,
    expectedProjectRoot = null,
  } = {},
) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, verified: false, error: 'pane_unavailable' };
  }
  if (!agentId || !sessionId || !contractDigest || !marker) {
    return { ok: false, verified: false, error: 'identity_bootstrap_probe_invalid' };
  }

  const script = [
    '(() => {',
    'const agentId=' + JSON.stringify(agentId) + ';',
    'const sessionId=' + JSON.stringify(sessionId) + ';',
    'const contractDigest=' + JSON.stringify(contractDigest) + ';',
    'const marker=' + JSON.stringify(marker) + ';',
    'const expectedUserMessageId=' + JSON.stringify(userMessageId) + ';',
    'const expectedConversationUrl=' + JSON.stringify(expectedConversationUrl) + ';',
    'const expectedProjectRoot=' + JSON.stringify(expectedProjectRoot) + ';',
    'const messages=[...document.querySelectorAll("[data-message-author-role]")];',
    'const users=messages.filter(n=>n.getAttribute("data-message-author-role")==="user");',
    'const textOf=n=>String(n?.innerText||n?.textContent||"");',
    'const header="[MCF PANE AGENT IDENTITY]";',
    'const agentNeedle="agent_id: "+agentId;',
    'const sessionNeedle="session_id: "+sessionId;',
    'const digestNeedle="contract_sha256: "+contractDigest;',
    'const identityAttempts=users.filter(n=>{const t=textOf(n);return t.includes(header)&&t.includes(agentNeedle);});',
    'const matches=identityAttempts.filter(n=>{const t=textOf(n);return t.includes(sessionNeedle)&&t.includes(digestNeedle);});',
    'let user=null;',
    'if(expectedUserMessageId){user=matches.find(n=>n.getAttribute("data-message-id")===expectedUserMessageId)||null;}',
    'else if(matches.length===1){user=matches[0];}',
    'const userAnchorFound=Boolean(user);',
    'const conflictingAttempt=identityAttempts.some(n=>n!==user);',
    'const userIndex=user?messages.indexOf(user):-1;',
    'let nextUserIndex=messages.length;',
    'if(userIndex>=0){for(let i=userIndex+1;i<messages.length;i+=1){if(messages[i].getAttribute("data-message-author-role")==="user"){nextUserIndex=i;break;}}}',
    'const assistants=userIndex>=0?messages.slice(userIndex+1,nextUserIndex).filter(n=>n.getAttribute("data-message-author-role")==="assistant"):[];',
    'const markerNode=assistants.find(n=>textOf(n).includes(marker))||null;',
    'const markerObserved=Boolean(markerNode);',
    'const url=location.href;',
    'const conversationUrlOk=!expectedConversationUrl||url===expectedConversationUrl;',
    'const projectRootOk=!expectedProjectRoot||url===expectedProjectRoot||url.startsWith(expectedProjectRoot.replace(/\/$/,"")+"/");',
    'const verified=userAnchorFound&&markerObserved&&!conflictingAttempt&&conversationUrlOk&&projectRootOk;',
    'return {',
    'ok:true,verified,userAnchorFound,markerObserved,conflictingAttempt,',
    'matchingUserCount:matches.length,identityAttemptCount:identityAttempts.length,',
    'conversationUrlOk,projectRootOk,',
    'userMessageId:user?.getAttribute("data-message-id")||null,',
    'assistantMessageId:markerNode?.getAttribute("data-message-id")||null,',
    'url,',
    'error:verified?null:conflictingAttempt?"identity_bootstrap_conflicting_attempt":!userAnchorFound?"identity_bootstrap_user_anchor_not_found":!markerObserved?"identity_bootstrap_marker_not_linked":!conversationUrlOk?"identity_bootstrap_conversation_mismatch":"identity_bootstrap_project_mismatch"',
    '};',
    '})()',
  ].join('\n');

  return wc.executeJavaScript(script, true).catch(error => ({
    ok: false,
    verified: false,
    error: 'identity_bootstrap_probe_failed',
    detail: error?.message ?? String(error),
  }));
}

async function waitForConversationUrl(pane, timeoutMs = 15000) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = wc.getURL();
    try {
      const parsed = new URL(current);
      if (parsed.hostname === 'chatgpt.com' && /\/c\/[^/]+/.test(parsed.pathname)) return current;
    } catch {}
    await sleep(250);
  }
  return wc.getURL();
}

async function waitForAssistantMarker(pane, marker, timeoutMs = 60000) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return false;
    const found = await wc.executeJavaScript(
      "(() => [...document.querySelectorAll('[data-message-author-role=\\\"assistant\\\"]')]"
      + ".some(node => String(node.innerText || node.textContent || '').includes("
      + JSON.stringify(marker)
      + ")))()",
      true,
    ).catch(() => false);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

async function waitForAssistantStart(
  pane,
  {
    marker = null,
    userMessageId = null,
    baselineAssistantMessageId = null,
  } = {},
  timeoutMs = 60000,
) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, accepted: false, error: 'pane_unavailable' };
  }

  const deadline = Date.now() + timeoutMs;
  let positiveActivityObserved = false;
  let lastActivityAt = null;

  while (Date.now() < deadline) {
    if (wc.isDestroyed()) {
      return { ok: false, accepted: false, error: 'pane_destroyed' };
    }

    const snapshot = await wc.executeJavaScript(
      `(() => {
        const marker = ${JSON.stringify(marker)};
        const userMessageId = ${JSON.stringify(userMessageId)};
        const baselineAssistantMessageId = ${JSON.stringify(baselineAssistantMessageId)};
        const isStopControl = ${isGenerationStopControl.toString()};
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const stopControl = [...document.querySelectorAll('button')].find(button =>
          visible(button) && isStopControl({
            ariaLabel: button.getAttribute('aria-label'),
            testId: button.getAttribute('data-testid'),
            title: button.title,
            text: button.innerText,
          })
        );
        const busyObserved = [...document.querySelectorAll('[aria-busy="true"]')].some(visible);
        const statusText = [...document.querySelectorAll('[role="status"],[aria-live],[data-state="running"]')]
          .filter(visible)
          .map(node => String(node.innerText || node.textContent || ''))
          .join(' ');
        const activityTextObserved = /pensando|thinking|ferramenta chamada|tool called|tool use|analisando|working|processing|searching|pesquisando/i.test(statusText);
        const activityObserved = Boolean(stopControl || busyObserved || activityTextObserved);

        const allMessages = [...document.querySelectorAll('[data-message-author-role]')];
        const assistants = allMessages.filter(node =>
          node.getAttribute('data-message-author-role') === 'assistant'
        );
        if (!assistants.length) {
          return {
            found:false,
            generationActive:Boolean(stopControl),
            activityObserved,
            busyObserved,
            activityTextObserved,
            url:location.href,
          };
        }

        let candidate = null;
        let linkedUserMessageId = null;

        if (userMessageId) {
          const userIndex = allMessages.findIndex(node =>
            node.getAttribute('data-message-author-role') === 'user'
            && node.getAttribute('data-message-id') === userMessageId
          );
          if (userIndex < 0) {
            return {
              found:false,
              error:'delivered_user_message_not_found',
              generationActive:Boolean(stopControl),
              activityObserved,
              busyObserved,
              activityTextObserved,
              url:location.href,
            };
          }
          linkedUserMessageId = userMessageId;
          const userNode = allMessages[userIndex];
          const turns = [...document.querySelectorAll('section[data-testid^="conversation-turn-"]')];
          const userTurn = userNode.closest('section[data-testid^="conversation-turn-"]');
          const userTurnIndex = turns.indexOf(userTurn);
          const nextTurn = userTurnIndex >= 0 ? turns[userTurnIndex + 1] : null;
          const nextTurnText = String(nextTurn?.innerText || nextTurn?.textContent || '').trim();
          const nextTurnHasUser = Boolean(nextTurn?.querySelector('[data-message-author-role="user"]'));
          const nextTurnHasAssistant = Boolean(nextTurn?.querySelector('[data-message-author-role="assistant"]'));
          const interruptionButton = nextTurn
            ? [...nextTurn.querySelectorAll('button')].find(button => {
                const text = String(button.innerText || button.textContent || '').trim();
                return /^(racioc[ií]nio interrompido|reasoning interrupted|generation interrupted|response interrupted)$/i.test(text);
              })
            : null;
          if (nextTurn && !nextTurnHasUser && !nextTurnHasAssistant && interruptionButton) {
            return {
              found:false,
              interrupted:true,
              linkedUserMessageId,
              interruptionText:nextTurnText.slice(0, 500),
              generationActive:Boolean(stopControl),
              activityObserved,
              url:location.href,
            };
          }
          for (let i = userIndex + 1; i < allMessages.length; i += 1) {
            const role = allMessages[i].getAttribute('data-message-author-role');
            if (role === 'user') break;
            if (role === 'assistant') {
              candidate = allMessages[i];
              break;
            }
          }
        } else if (baselineAssistantMessageId) {
          const baselineIndex = assistants.findIndex(node =>
            node.getAttribute('data-message-id') === baselineAssistantMessageId
          );
          if (baselineIndex >= 0 && baselineIndex < assistants.length - 1) {
            candidate = assistants[assistants.length - 1];
          } else if (baselineIndex < 0) {
            const last = assistants[assistants.length - 1];
            const lastId = last?.getAttribute('data-message-id') || null;
            if (lastId && lastId !== baselineAssistantMessageId) candidate = last;
          }
        } else {
          candidate = assistants[assistants.length - 1];
        }

        if (!candidate) {
          return {
            found:false,
            generationActive:Boolean(stopControl),
            activityObserved,
            busyObserved,
            activityTextObserved,
            url:location.href,
          };
        }
        const assistantMessageId = candidate.getAttribute('data-message-id') || null;
        if (!assistantMessageId) {
          return {
            found:false,
            generationActive:Boolean(stopControl),
            activityObserved,
            url:location.href,
          };
        }

        const text = String(candidate.innerText || candidate.textContent || '');
        return {
          found:true,
          assistantMessageId,
          linkedUserMessageId,
          markerObserved:Boolean(marker && text.includes(marker)),
          generationActive:Boolean(stopControl),
          activityObserved:Boolean(activityObserved || text.trim()),
          textLength:text.length,
          url:location.href,
        };
      })()`,
      true,
    ).catch(() => null);

    if (snapshot?.generationActive || snapshot?.activityObserved) {
      positiveActivityObserved = true;
      lastActivityAt = Date.now();
    }

    if (snapshot?.interrupted) {
      return {
        ok: false,
        accepted: false,
        interrupted: true,
        error: 'assistant_interrupted',
        terminalSignal: 'assistant_interrupted',
        linkedUserMessageId: snapshot.linkedUserMessageId ?? userMessageId ?? null,
        interruptionText: snapshot.interruptionText ?? null,
        generationActive: Boolean(snapshot.generationActive),
        activityObserved: Boolean(snapshot.activityObserved),
        positiveActivityObserved,
        lastActivityAt,
        url: snapshot.url ?? wc.getURL(),
      };
    }

    if (snapshot?.found && snapshot?.assistantMessageId) {
      return {
        ok: true,
        accepted: true,
        assistantMessageId: snapshot.assistantMessageId,
        linkedUserMessageId: snapshot.linkedUserMessageId ?? userMessageId ?? null,
        baselineAssistantMessageId,
        markerObserved: Boolean(snapshot.markerObserved),
        generationActive: Boolean(snapshot.generationActive),
        activityObserved: Boolean(snapshot.activityObserved),
        positiveActivityObserved,
        lastActivityAt,
        url: snapshot.url ?? wc.getURL(),
      };
    }

    await sleep(250);
  }

  return {
    ok: false,
    accepted: false,
    error: 'assistant_start_timeout',
    generationActive: false,
    activityObserved: positiveActivityObserved,
    positiveActivityObserved,
    lastActivityAt,
    linkedUserMessageId: userMessageId ?? null,
    baselineAssistantMessageId,
    url: wc.getURL(),
  };
}

async function waitForAssistantResult(
  pane,
  {
    marker = null,
    assistantMessageId = null,
    userMessageId = null,
    expectedConversationUrl = null,
  },
  timeoutMs = 120000,
) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, generationFinished: false, terminalSignal: 'pane_unavailable' };
  }

  let expectedConversationId = null;
  try {
    const parsedExpected = new URL(expectedConversationUrl);
    expectedConversationId = parsedExpected.pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
  } catch {}

  const deadline = Date.now() + timeoutMs;
  let lastMessageId = null;
  let lastText = '';
  let stableSince = 0;
  let anchorMissingSince = 0;

  while (Date.now() < deadline) {
    if (wc.isDestroyed()) {
      return { ok: false, generationFinished: false, terminalSignal: 'pane_destroyed' };
    }

    if (expectedConversationId && !wc.isLoading()) {
      const currentUrl = wc.getURL();
      let currentConversationId = null;
      try {
        currentConversationId = new URL(currentUrl).pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
      } catch {}
      if (currentConversationId !== expectedConversationId) {
        return {
          ok: false,
          generationFinished: false,
          generationActive: null,
          terminalSignal: 'conversation_changed',
          expectedConversationId,
          currentConversationId,
          assistantMessageId: lastMessageId ?? assistantMessageId ?? null,
          linkedUserMessageId: userMessageId ?? null,
          url: currentUrl,
          stableForMs: 0,
          finalActionsObserved: false,
        };
      }
    }

    const snapshot = await wc.executeJavaScript(
      `(() => {
        const marker = ${JSON.stringify(marker)};
        const acceptedAssistantMessageId = ${JSON.stringify(assistantMessageId)};
        const userMessageId = ${JSON.stringify(userMessageId)};
        const isStopControl = ${isGenerationStopControl.toString()};
        const targetGenerationActive = ${isTargetGenerationActive.toString()};
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const allMessages = [...document.querySelectorAll('[data-message-author-role]')];
        const assistants = allMessages.filter(node =>
          node.getAttribute('data-message-author-role') === 'assistant'
        );

        let message = null;
        let linkedUserMessageId = null;

        if (userMessageId) {
          const userIndex = allMessages.findIndex(node =>
            node.getAttribute('data-message-author-role') === 'user'
            && node.getAttribute('data-message-id') === userMessageId
          );
          if (userIndex < 0) {
            return {
              found: false,
              anchorMissing: true,
              generationActive: null,
              finalActionsObserved: false,
              linkedUserMessageId: userMessageId,
              url: location.href,
            };
          }
          if (userIndex >= 0) {
            linkedUserMessageId = userMessageId;
            const userNode = allMessages[userIndex];
            const turns = [...document.querySelectorAll('section[data-testid^="conversation-turn-"]')];
            const userTurn = userNode.closest('section[data-testid^="conversation-turn-"]');
            const userTurnIndex = turns.indexOf(userTurn);
            const nextTurn = userTurnIndex >= 0 ? turns[userTurnIndex + 1] : null;
            const nextTurnText = String(nextTurn?.innerText || nextTurn?.textContent || '').trim();
            const nextTurnHasUser = Boolean(nextTurn?.querySelector('[data-message-author-role="user"]'));
            const nextTurnHasAssistant = Boolean(nextTurn?.querySelector('[data-message-author-role="assistant"]'));
            const interruptionButton = nextTurn
              ? [...nextTurn.querySelectorAll('button')].find(button => {
                  const text = String(button.innerText || button.textContent || '').trim();
                  return /^(racioc[ií]nio interrompido|reasoning interrupted|generation interrupted|response interrupted)$/i.test(text);
                })
              : null;
            if (nextTurn && !nextTurnHasUser && !nextTurnHasAssistant && interruptionButton) {
              return {
                found: false,
                interrupted: true,
                generationActive: false,
                finalActionsObserved: false,
                linkedUserMessageId,
                interruptionText: nextTurnText.slice(0, 500),
                url: location.href,
              };
            }
            for (let i = userIndex + 1; i < allMessages.length; i += 1) {
              const role = allMessages[i].getAttribute('data-message-author-role');
              if (role === 'user') break;
              if (role === 'assistant') {
                message = allMessages[i];
                break;
              }
            }
          }
        }

        if (!message && acceptedAssistantMessageId) {
          message = assistants.find(node =>
            node.getAttribute('data-message-id') === acceptedAssistantMessageId
          ) || null;
        }

        if (!message && !acceptedAssistantMessageId) {
          message = [...assistants].reverse().find(node =>
            marker && String(node.innerText || node.textContent || '').includes(marker)
          ) || null;
        }

        if (!message) {
          return {
            found: false,
            generationActive: true,
            finalActionsObserved: false,
            linkedUserMessageId,
          };
        }

        const text = String(message.innerText || message.textContent || '');
        const currentAssistantMessageId = message.getAttribute('data-message-id') || null;
        const assistantIdMigratedFrom = acceptedAssistantMessageId
          && currentAssistantMessageId
          && currentAssistantMessageId !== acceptedAssistantMessageId
          && String(acceptedAssistantMessageId).startsWith('request-placeholder-')
          ? acceptedAssistantMessageId
          : null;
        const messageIndex = allMessages.indexOf(message);
        const laterUserMessageObserved = messageIndex >= 0
          && allMessages.slice(messageIndex + 1).some(node =>
            node.getAttribute('data-message-author-role') === 'user'
          );
        const stopControl = [...document.querySelectorAll('button')].find(button => {
          if (!visible(button)) return false;
          return isStopControl({
            ariaLabel: button.getAttribute('aria-label'),
            testId: button.getAttribute('data-testid'),
            title: button.title,
            text: button.innerText,
          });
        });

        const turn = message.closest('section[data-testid^="conversation-turn-"]');
        const turnText = String(turn?.innerText || turn?.textContent || '').trim();
        const turnInterruptionButton = turn
          ? [...turn.querySelectorAll('button')].find(button => {
              const text = String(button.innerText || button.textContent || '').trim();
              return /^(racioc[ií]nio interrompido|reasoning interrupted|generation interrupted|response interrupted)$/i.test(text);
            })
          : null;
        const interrupted = Boolean(
          turnInterruptionButton
          && !turn?.querySelector('[data-message-author-role="assistant"]')
          && !turn?.querySelector('[data-message-author-role="user"]')
        );
        const finalActionButtons = turn
          ? [...turn.querySelectorAll('button')].filter(visible)
          : [];
        const finalActionsObserved = finalActionButtons.some(button => {
          const label = String(
            button.getAttribute('aria-label')
            || button.getAttribute('data-testid')
            || button.title
            || button.innerText
            || ''
          ).toLowerCase();
          return label.includes('copy')
            || label.includes('copiar')
            || label.includes('copy-turn-action-button')
            || label.includes('add to library')
            || label.includes('adicionar à biblioteca')
            || label.includes('open editor')
            || label.includes('abrir editor');
        });

        return {
          found: true,
          text,
          assistantMessageId: currentAssistantMessageId,
          linkedUserMessageId,
          assistantIdMigratedFrom,
          interrupted,
          interruptionText: interrupted ? turnText.slice(0, 500) : null,
          generationActive: targetGenerationActive({
            stopControlPresent: Boolean(stopControl),
            laterUserMessageObserved,
          }),
          laterUserMessageObserved,
          finalActionsObserved,
          url: location.href,
        };
      })()`,
      true,
    ).catch(() => null);

    if (snapshot?.interrupted) {
      return {
        ok: false,
        interrupted: true,
        generationFinished: false,
        generationActive: false,
        terminalSignal: 'assistant_interrupted',
        linkedUserMessageId: snapshot.linkedUserMessageId ?? userMessageId ?? null,
        interruptionText: snapshot.interruptionText ?? null,
        url: snapshot.url ?? wc.getURL(),
      };
    }

    if (snapshot?.interrupted) {
      return {
        ok: false,
        interrupted: true,
        generationFinished: false,
        generationActive: false,
        terminalSignal: 'assistant_interrupted',
        assistantMessageId: snapshot.assistantMessageId ?? assistantMessageId ?? null,
        linkedUserMessageId: snapshot.linkedUserMessageId ?? userMessageId ?? null,
        interruptionText: snapshot.interruptionText ?? null,
        url: snapshot.url ?? wc.getURL(),
      };
    }

    if (!snapshot?.found) {
      if (snapshot?.anchorMissing) {
        if (!anchorMissingSince) anchorMissingSince = Date.now();
        if (Date.now() - anchorMissingSince >= 5000) {
          return {
            ok: false,
            generationFinished: false,
            generationActive: snapshot?.generationActive ?? null,
            terminalSignal: 'conversation_anchor_lost',
            assistantMessageId: lastMessageId ?? assistantMessageId ?? null,
            linkedUserMessageId: userMessageId ?? null,
            url: snapshot?.url ?? wc.getURL(),
            stableForMs: 0,
            finalActionsObserved: false,
          };
        }
      } else {
        anchorMissingSince = 0;
      }
      lastMessageId = null;
      lastText = '';
      stableSince = 0;
      await sleep(400);
      continue;
    }
    anchorMissingSince = 0;

    const now = Date.now();
    if (snapshot.assistantMessageId === lastMessageId && snapshot.text === lastText) {
      if (!stableSince) stableSince = now;
    } else {
      lastMessageId = snapshot.assistantMessageId;
      lastText = snapshot.text;
      stableSince = now;
    }

    const stableForMs = Math.max(0, now - stableSince);
    const normalizedText = String(snapshot.text || '').trim();
    const definitiveAssistantId = Boolean(snapshot.assistantMessageId)
      && !String(snapshot.assistantMessageId).startsWith('request-placeholder-');
    const transientText = /^(pensando|thinking)(?:\.{0,3})?$/i.test(normalizedText)
      || /^(racioc[ií]nio interrompido|reasoning interrupted|generation interrupted|response interrupted)$/i.test(normalizedText);
    const terminal = !snapshot.generationActive
      && !snapshot.interrupted
      && snapshot.finalActionsObserved
      && definitiveAssistantId
      && !transientText
      && stableForMs >= 1200;

    if (terminal) {
      let conversationId = null;
      try {
        const parsed = new URL(snapshot.url);
        const match = parsed.pathname.match(/\/c\/([^/]+)/);
        conversationId = match?.[1] ?? null;
      } catch {}

      if (!conversationId) {
        return {
          ok: false,
          generationFinished: false,
          generationActive: false,
          terminalSignal: 'conversation_identity_missing',
          assistantMessageId: snapshot.assistantMessageId,
          text: snapshot.text,
          url: snapshot.url,
          stableForMs,
          finalActionsObserved: snapshot.finalActionsObserved,
        };
      }

      return {
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'ui_generation_inactive_with_final_actions',
        assistantMessageId: snapshot.assistantMessageId,
        linkedUserMessageId: snapshot.linkedUserMessageId ?? userMessageId ?? null,
        assistantIdMigratedFrom: snapshot.assistantIdMigratedFrom ?? null,
        conversationId,
        text: snapshot.text,
        url: snapshot.url,
        stableForMs,
        finalActionsObserved: true,
      };
    }

    await sleep(400);
  }

  return {
    ok: false,
    generationFinished: false,
    generationActive: null,
    terminalSignal: 'result_timeout',
    assistantMessageId: lastMessageId,
    text: lastText,
    url: wc.getURL(),
    stableForMs: 0,
    finalActionsObserved: false,
  };
}


function conversationIdFromUrl(value) {
  try {
    return new URL(String(value || '')).pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function inspectMissionExecution(
  pane,
  {
    expectedConversationUrl = null,
    userMessageId = null,
    assistantMessageId = null,
  } = {},
) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, verified: false, error: 'pane_unavailable' };
  }

  const currentUrl = wc.getURL();
  const expectedConversationId = conversationIdFromUrl(expectedConversationUrl);
  const currentConversationId = conversationIdFromUrl(currentUrl);
  if (expectedConversationId && currentConversationId !== expectedConversationId) {
    return {
      ok: false,
      verified: false,
      error: 'reconciliation_conversation_mismatch',
      expectedConversationId,
      currentConversationId,
      url: currentUrl,
    };
  }

  const script = [
    '(() => {',
    'const userMessageId = ' + JSON.stringify(userMessageId) + ';',
    'const expectedAssistantMessageId = ' + JSON.stringify(assistantMessageId) + ';',
    'const visible = (el) => { if (!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=="none" && s.visibility!=="hidden"; };',
    'const stopControl = [...document.querySelectorAll("button")].find(button => {',
    '  if (!visible(button)) return false;',
    '  const aria=String(button.getAttribute("aria-label")||"");',
    '  const testId=String(button.getAttribute("data-testid")||"");',
    '  const title=String(button.title||"");',
    '  const text=String(button.innerText||"");',
    '  return /parar de responder|stop generating|stop responding|parar geração/i.test(aria+" "+title+" "+text) || /stop-button/i.test(testId);',
    '});',
    'const busyObserved = [...document.querySelectorAll("[aria-busy=true]")].some(visible);',
    'const statusText = [...document.querySelectorAll("[role=status],[aria-live],[data-state=running]")].filter(visible).map(n=>String(n.innerText||n.textContent||"")).join(" ");',
    'const activityTextObserved = /pensando|thinking|ferramenta chamada|tool called|tool use|analisando|working|processing|searching|pesquisando/i.test(statusText);',
    'const activeExecution = Boolean(stopControl || busyObserved || activityTextObserved);',
    'const allMessages=[...document.querySelectorAll("[data-message-author-role]")];',
    'let userAnchorFound = userMessageId == null;',
    'let assistantAfterUser = null;',
    'if (userMessageId) {',
    '  const userIndex=allMessages.findIndex(n=>n.getAttribute("data-message-author-role")==="user" && n.getAttribute("data-message-id")===userMessageId);',
    '  userAnchorFound=userIndex>=0;',
    '  if (userAnchorFound) { for (let i=userIndex+1;i<allMessages.length;i+=1) { const role=allMessages[i].getAttribute("data-message-author-role"); if (role==="user") break; if (role==="assistant") { assistantAfterUser=allMessages[i]; break; } } }',
    '} else if (expectedAssistantMessageId) {',
    '  assistantAfterUser=allMessages.find(n=>n.getAttribute("data-message-author-role")==="assistant" && n.getAttribute("data-message-id")===expectedAssistantMessageId) || null;',
    '}',
    'const observedAssistantMessageId=assistantAfterUser?.getAttribute("data-message-id")||null;',
    'const assistantText=String(assistantAfterUser?.innerText||assistantAfterUser?.textContent||"").trim();',
    'const lateResultObserved=Boolean(observedAssistantMessageId && assistantText);',
    'return {ok:true,verified:true,activeExecution,generationActive:Boolean(stopControl),busyObserved,activityTextObserved,userAnchorFound,lateResultObserved,assistantMessageId:observedAssistantMessageId,assistantTextLength:assistantText.length,url:location.href};',
    '})()',
  ].join('\n');

  const snapshot = await wc.executeJavaScript(script, true).catch(error => ({
    ok: false,
    verified: false,
    error: 'reconciliation_observation_failed',
    detail: error?.message ?? String(error),
  }));

  return {
    ...snapshot,
    expectedConversationId,
    currentConversationId,
    url: snapshot?.url ?? currentUrl,
  };
}

async function cancelAssistantGeneration(
  pane,
  {
    expectedConversationUrl = null,
    expectedUserMessageId = null,
    envelopeId = null,
    executionId = null,
  } = {},
) {
  const wc = getPane(pane);
  if (!wc || wc.isDestroyed()) {
    return {
      ok: false,
      requested: false,
      error: 'pane_unavailable',
      envelopeId,
      executionId,
    };
  }

  const currentUrl = wc.getURL();
  const expectedConversationId = conversationIdFromUrl(expectedConversationUrl);
  const currentConversationId = conversationIdFromUrl(currentUrl);
  if (expectedConversationId && currentConversationId !== expectedConversationId) {
    return {
      ok: false,
      requested: false,
      error: 'cancel_conversation_mismatch',
      expectedConversationId,
      currentConversationId,
      url: currentUrl,
      envelopeId,
      executionId,
    };
  }

  const clicked = await wc.executeJavaScript(
    `(() => {
      const isStopControl = ${isGenerationStopControl.toString()};
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const expectedUserMessageId = ${JSON.stringify(expectedUserMessageId)};
      if (expectedUserMessageId) {
        const userMessages = [...document.querySelectorAll('[data-message-author-role="user"]')];
        const lastUserMessageId = userMessages.at(-1)?.getAttribute('data-message-id') || null;
        if (lastUserMessageId !== expectedUserMessageId) {
          return {
            ok:false,
            error:'cancel_user_turn_mismatch',
            expectedUserMessageId,
            lastUserMessageId,
            url:location.href,
          };
        }
      }
      const controls = [...document.querySelectorAll('button')].filter(button =>
        visible(button) && isStopControl({
          ariaLabel: button.getAttribute('aria-label'),
          testId: button.getAttribute('data-testid'),
          title: button.title,
          text: button.innerText,
        })
      );
      if (controls.length !== 1) {
        return {
          ok:false,
          error:controls.length === 0
            ? 'generation_stop_control_not_found'
            : 'generation_stop_control_ambiguous',
          candidates:controls.length,
          url:location.href,
        };
      }
      controls[0].click();
      return {ok:true, requested:true, url:location.href};
    })()`,
    true,
  ).catch(error => ({
    ok: false,
    requested: false,
    error: 'cancel_signal_execution_failed',
    detail: error?.message ?? String(error),
  }));

  if (!clicked?.ok) {
    return {
      ...clicked,
      requested: false,
      envelopeId,
      executionId,
    };
  }

  let generationInactiveObserved = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    generationInactiveObserved = await wc.executeJavaScript(
      `(() => {
        const isStopControl = ${isGenerationStopControl.toString()};
        return ![...document.querySelectorAll('button')].some(button => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          if (!(rect.width > 0 && rect.height > 0)
              || style.display === 'none'
              || style.visibility === 'hidden') return false;
          return isStopControl({
            ariaLabel: button.getAttribute('aria-label'),
            testId: button.getAttribute('data-testid'),
            title: button.title,
            text: button.innerText,
          });
        });
      })()`,
      true,
    ).catch(() => false);
    if (generationInactiveObserved) break;
  }

  return {
    ok: true,
    requested: true,
    generationInactiveObserved,
    cancellationConfirmed: false,
    reconciliationRequired: true,
    url: wc.getURL(),
    envelopeId,
    executionId,
  };
}

function createPaneAgentIdentityRuntime() {
  const broker = {
    listAgents: async () => {
      const result = await runAgentSessionTool(['list']);
      return Array.isArray(result?.agents) ? result.agents : [];
    },
    showSession: async (sessionId) => runAgentSessionTool([
      'show',
      '--session',
      sessionId,
    ]),
    createSession: async ({ agentId, missionId, objective, surface }) => {
      const args = ['create', '--agent', agentId, '--surface', surface || 'dual-browser-pane'];
      if (missionId) args.push('--mission', missionId);
      if (objective) args.push('--objective', objective);
      return runAgentSessionTool(args);
    },
    markOpen: async (sessionId, chatUrl) => runAgentSessionTool([
      'mark-open',
      '--session',
      sessionId,
      ...(chatUrl ? ['--chat-url', chatUrl] : []),
    ]),
  };

  const surface = {
    getUrl: (pane) => {
      const wc = getPane(pane);
      return wc && !wc.isDestroyed() ? wc.getURL() : null;
    },
    freshConversation: freshAgentConversation,
    reconcileFreshConversation: reconcileFreshAgentConversation,
    sendMessage: async (pane, message) => {
      if (!bridge) return { ok: false, error: 'bridge_unavailable' };
      const result = await bridge.sendMessage(pane, message);
      if (!result?.ok) return result;
      const url = await waitForConversationUrl(pane);
      return { ...result, url };
    },
    waitForAssistantMarker,
    inspectIdentityBootstrap,
    waitForAssistantStart,
    waitForAssistantResult,
    inspectMissionExecution,
    cancelAssistantGeneration,
  };

  return new PaneAgentRuntime({
    instanceId: instance.id,
    missionId: PANE_AGENT_MISSION_ID,
    broker,
    surface,
    agentBindings,
    loadState: loadPaneAgentState,
    saveState: savePaneAgentState,
    startupReady: false,
    onEvent: (event) => bridge?.publishLiveEvent(event),
  });
}

function publicAgentSession(record) {
  return {
    sessionId: record.sessionId,
    traceId: record.traceId,
    missionId: record.missionId ?? null,
    agentId: record.agentId,
    displayName: record.displayName,
    role: record.role,
    contractRef: record.contractRef,
    contractDigest: record.contractDigest,
    surface: record.surface,
    surfaceState: record.surfaceState,
    chatUrl: record.chatUrl ?? null,
    windowOpen: Boolean(record.windowOpen),
    bootstrapSent: Boolean(record.bootstrapSent),
    bootstrapError: record.bootstrapError ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function listAgentSessions() {
  const persisted = await runAgentSessionTool(['list-sessions', '--limit', '100']);
  const sessions = Array.isArray(persisted?.sessions) ? persisted.sessions : [];
  return sessions.map((session) => {
    const runtime = agentSessionRuntime.get(session.sessionId);
    return publicAgentSession({
      ...session,
      windowOpen: runtime ? runtime.windowOpen : false,
      bootstrapSent: runtime ? runtime.bootstrapSent : session.surfaceState === 'OPEN',
      bootstrapError: runtime?.bootstrapError ?? null,
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChatComposer(wc, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return false;
    const found = await wc.executeJavaScript(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const nodes = [
        document.querySelector('#prompt-textarea'),
        document.querySelector('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]')
      ].filter(Boolean);
      return nodes.some(visible);
    })()`, true).catch(() => false);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

async function injectAgentBootstrap(wc, bootstrap) {
  const ready = await waitForChatComposer(wc);
  if (!ready) return { ok: false, error: 'chat_composer_not_found' };

  const prepared = await wc.executeJavaScript(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const nodes = [
      document.querySelector('#prompt-textarea'),
      document.querySelector('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]')
    ].filter(Boolean);
    const el = nodes.find(visible);
    if (!el) return { ok:false, error:'chat_composer_not_found' };
    el.focus();
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      try { document.execCommand('delete', false); } catch {}
      if ((el.innerText || '').trim()) el.textContent = '';
    } else if ('value' in el) {
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, '');
      else el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward', data:null }));
    } else {
      return { ok:false, error:'chat_composer_not_editable' };
    }
    return { ok:true };
  })()`, true);

  if (!prepared?.ok) return prepared ?? { ok: false, error: 'chat_composer_prepare_failed' };

  try {
    await wc.insertText(bootstrap);
  } catch (error) {
    return { ok: false, error: 'chat_native_insert_failed', detail: error.message };
  }

  await sleep(700);
  const typed = await wc.executeJavaScript(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const nodes = [
      document.querySelector('#prompt-textarea'),
      document.querySelector('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]')
    ].filter(Boolean);
    const el = nodes.find(visible);
    const text = el ? String(el.innerText || el.value || '') : '';
    return {
      ok: Boolean(el) && text.includes('[MCF AGENT SESSION]'),
      length: text.length,
      hasMarker: text.includes('[MCF AGENT SESSION]')
    };
  })()`, true);

  if (!typed?.ok) return { ok: false, error: 'chat_native_insert_not_observed', typed };

  const sent = await wc.executeJavaScript(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const direct = document.querySelector('[data-testid="send-button"]');
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const send = direct || buttons.find((button) => {
      const label = String(button.getAttribute('aria-label') || button.title || button.innerText || '').toLowerCase();
      return (label.includes('send') || label.includes('enviar')) && !button.disabled;
    });
    if (send && !send.disabled) {
      send.click();
      return {ok:true, method:'button'};
    }
    const composer = document.querySelector('#prompt-textarea') || document.querySelector('textarea') || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
    const form = composer?.closest('form');
    if (form?.requestSubmit) {
      form.requestSubmit();
      return {ok:true, method:'form'};
    }
    return {ok:false,error:'chat_send_control_not_found'};
  })()`, true);

  if (!sent?.ok) return sent ?? { ok: false, error: 'chat_send_failed' };

  const sessionId = bootstrap.match(/^session_id:\s*(\S+)/m)?.[1] || '';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const evidence = await wc.executeJavaScript(`(() => {
      const body = document.body?.innerText || '';
      return {
        path: location.pathname,
        title: document.title,
        hasSession: ${JSON.stringify(sessionId)} ? body.includes(${JSON.stringify(sessionId)}) : false,
        hasUserTurn: body.includes('You said:') || body.includes('Você disse:') || body.includes('[MCF AGENT SESSION]')
      };
    })()`, true).catch(() => null);

    if (evidence && (String(evidence.path || '').startsWith('/c/') || (evidence.hasSession && evidence.hasUserTurn))) {
      return { ok: true, typed, sent, evidence };
    }
    await sleep(500);
  }

  return { ok: false, error: 'chat_conversation_not_created', typed, sent };
}

async function markAgentSessionOpen(sessionId, chatUrl) {
  try {
    return await runAgentSessionTool([
      'mark-open',
      '--session', sessionId,
      ...(chatUrl ? ['--chat-url', chatUrl] : []),
    ]);
  } catch (error) {
    emitBridgeEvent({ level: 'error', message: 'Agent Session: falha ao persistir abertura — ' + error.message });
    return null;
  }
}

async function markAgentSessionFailed(sessionId, errorMessage) {
  try {
    return await runAgentSessionTool([
      'mark-failed',
      '--session', sessionId,
      '--error', String(errorMessage || 'agent_session_open_failed').slice(0, 500),
    ]);
  } catch (error) {
    emitBridgeEvent({ level: 'error', message: 'Agent Session: falha ao persistir erro — ' + error.message });
    return null;
  }
}

function secureAgentWindow(win) {
  const wc = win.webContents;
  wc.setAudioMuted(false);
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        emitBridgeEvent({ level: 'info', message: 'Protocolo externo bloqueado.' });
        return { action: 'deny' };
      }
    } catch {
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1080,
        height: 760,
        backgroundColor: '#0b0f14',
        webPreferences: {
          partition: 'persist:mcf-chatgpt',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    };
  });
}

async function openAgentSession({ agent, mission = null, objective = null }) {
  let created;
  try {
    const args = ['create', '--agent', agent, '--surface', 'chatgpt'];
    if (mission) args.push('--mission', mission);
    if (objective) args.push('--objective', objective);
    created = await runAgentSessionTool(args);
  } catch (error) {
    emitBridgeEvent({ level: 'error', message: 'Agent Session rejeitada: ' + error.message });
    return { ok: false, error: error.message };
  }

  if (!created?.sessionId || !created?.agentId || !created?.bootstrap) {
    return { ok: false, error: 'invalid_agent_session_record' };
  }

  const record = {
    ...created,
    windowOpen: false,
    bootstrapSent: false,
    bootstrapError: null,
  };
  agentSessionRuntime.set(created.sessionId, record);

  const win = new BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: `MCF · ${created.agentId} · Agent Session`,
    backgroundColor: '#090d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:mcf-chatgpt',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  secureAgentWindow(win);
  agentSessionWindows.set(created.sessionId, win);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    record.windowOpen = true;
    record.updatedAt = new Date().toISOString();
  });

  win.on('closed', () => {
    record.windowOpen = false;
    record.surfaceState = 'CLOSED';
    record.updatedAt = new Date().toISOString();
    agentSessionWindows.delete(created.sessionId);
    emitBridgeEvent({ level: 'info', message: `Sessão de agente fechada: ${created.agentId}` });
  });

  try {
    await win.loadURL(CHATGPT_URL);
    const injected = await injectAgentBootstrap(win.webContents, created.bootstrap);
    if (!injected?.ok) {
      record.bootstrapError = injected?.error || 'bootstrap_failed';
      record.surfaceState = 'OPEN_BOOTSTRAP_FAILED';
      record.chatUrl = win.webContents.getURL();
      await markAgentSessionFailed(created.sessionId, record.bootstrapError);
      emitBridgeEvent({
        level: 'error',
        message: `Sessão ${created.agentId} aberta, mas bootstrap falhou: ${record.bootstrapError}`,
      });
      return { ok: false, error: record.bootstrapError, session: publicAgentSession(record) };
    }

    record.bootstrapSent = true;
    record.surfaceState = 'OPEN';
    record.chatUrl = win.webContents.getURL();
    record.updatedAt = new Date().toISOString();
    await markAgentSessionOpen(created.sessionId, record.chatUrl);

    emitBridgeEvent({
      level: 'ok',
      message: `Agent Session ativa: ${created.agentId} · ${created.sessionId.slice(0, 8)}`,
    });
    return { ok: true, session: publicAgentSession(record) };
  } catch (error) {
    record.bootstrapError = error.message;
    record.surfaceState = 'OPEN_FAILED';
    record.updatedAt = new Date().toISOString();
    await markAgentSessionFailed(created.sessionId, error.message);
    emitBridgeEvent({ level: 'error', message: `Agent Session ${created.agentId}: ${error.message}` });
    return { ok: false, error: error.message, session: publicAgentSession(record) };
  }
}
function updateViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !chatView || !workspaceView) return;
  const [width, height] = mainWindow.getContentSize();
  const availableHeight = Math.max(120, height - HEADER_HEIGHT - STATUS_HEIGHT);
  const usableWidth = Math.max(MIN_PANE * 2 + VIEW_GAP, width - VIEW_GAP);
  const minRatio = Math.min(0.48, MIN_PANE / usableWidth);
  const maxRatio = Math.max(0.52, 1 - MIN_PANE / usableWidth);
  splitRatio = Math.min(maxRatio, Math.max(minRatio, splitRatio));

  const leftWidth = Math.floor((width - VIEW_GAP) * splitRatio);
  const rightX = leftWidth + VIEW_GAP;
  const rightWidth = Math.max(0, width - rightX);

  chatView.setBounds({ x: 0, y: HEADER_HEIGHT, width: leftWidth, height: availableHeight });
  workspaceView.setBounds({ x: rightX, y: HEADER_HEIGHT, width: rightWidth, height: availableHeight });

  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:state', { pane: 'layout', splitRatio });
  }
}

function createViews() {
  const chatPartition = 'persist:mcf-chatgpt';
  const workspacePartition = 'persist:mcf-workspace';
  configureSession(chatPartition, { chat: true });
  configureSession(workspacePartition, { chat: false });

  chatView = new WebContentsView({
    webPreferences: {
      partition: chatPartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  workspaceView = new WebContentsView({
    webPreferences: {
      partition: workspacePartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  secureWebContents('chat', chatView, chatPartition);
  secureWebContents('workspace', workspaceView, workspacePartition);

  mainWindow.contentView.addChildView(chatView);
  mainWindow.contentView.addChildView(workspaceView);
  updateViewBounds();

  const chatStartUrl = normalizeRestoredUrl(restoredRuntimeState?.chat?.url, CHATGPT_URL);
  const workspaceStartUrl = normalizeRestoredUrl(restoredRuntimeState?.workspace?.url, WORKSPACE_URL);

  chatView.webContents.loadURL(chatStartUrl).catch((error) => {
    emitBridgeEvent({ level: 'error', message: `ChatGPT: ${error.message}` });
  });
  workspaceView.webContents.loadURL(workspaceStartUrl).catch((error) => {
    emitBridgeEvent({ level: 'error', message: `Workspace: ${error.message}` });
  });
}

function createWindow() {
  const savedBounds = restoredWindowBounds();
  mainWindow = new BrowserWindow({
    ...(savedBounds ?? { width: 1500, height: 920 }),
    minWidth: 900,
    minHeight: 620,
    title: `MCF Dual Browser Cockpit · ${instance.id} · ${instance.agentProfile}`,
    backgroundColor: '#090d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
    },
  });

  if (restoredRuntimeState?.window?.maximized) mainWindow.maximize();

  mainWindow.loadFile(RENDERER);
  createViews();

  const captureDir = path.join(app.getPath('pictures'), 'MCF-Cockpit-Captures');
  const uploadDir = path.join(app.getPath('userData'), 'approved-uploads');
  mkdirSync(uploadDir, { recursive: true });

  paneAgentRuntime = createPaneAgentIdentityRuntime();
  bridge = new LocalAgentBridge({
    getWorkspaceWebContents: activeWorkspaceWebContents,
    getPaneWebContents: getPane,
    captureDir,
    instanceId: instance.id,
    agentProfile: instance.agentProfile,
    uploadDir,
    captureWorkspace,
    openAgentSession,
    listAgentSessions,
    getAgentIdentities: async () => paneAgentRuntime?.getIdentities() ?? [],
    bootstrapAgentIdentities: async (input) => {
      if (!paneAgentRuntime) return { ok: false, error: 'agent_identity_runtime_unavailable' };
      return paneAgentRuntime.bootstrap(input ?? {});
    },
    dispatchAgentMission: async (input) => {
      if (!paneAgentRuntime) return { ok: false, error: 'agent_identity_runtime_unavailable' };
      return paneAgentRuntime.dispatchMission(input ?? {});
    },
    listAgentReceipts: async () => paneAgentRuntime?.listReceipts() ?? [],
    listAgentMissions: async () => paneAgentRuntime?.listMissions() ?? [],
    getAgentMission: async (envelopeId) => paneAgentRuntime?.getMission(envelopeId) ?? null,
    getParentAgentMissionStatus: async (missionId) => (
      paneAgentRuntime?.getParentMissionStatus(missionId)
      ?? { parentMissionId: missionId, required: 0, completed: 0, active: 0, closable: false, blockers: [] }
    ),
    getAgentRecoveryCheckpoint: async (input) => (
      paneAgentRuntime?.getRecoveryCheckpoint(input ?? {})
      ?? { ok: false, error: 'agent_lifecycle_runtime_unavailable' }
    ),
    reconcileAgentMission: async (input) => (
      paneAgentRuntime?.reconcileMission(input ?? {})
      ?? { ok: false, error: 'agent_lifecycle_runtime_unavailable' }
    ),
    cancelAgentMission: async (input) => (
      await paneAgentRuntime?.requestMissionCancellation(input ?? {})
      ?? { ok: false, error: 'agent_lifecycle_runtime_unavailable' }
    ),
    onEvent: emitBridgeEvent,
  });

  bridge.start()
    .then(async (state) => {
      persistBridgeState(state);
      await sleep(1200);
      const bootstrap = await paneAgentRuntime?.bootstrap().catch((error) => ({
        ok: false,
        error: error.message,
      }));
      if (bootstrap?.ok) {
        emitBridgeEvent({ level: 'ok', message: 'MCF Agent Identity: Emily e Sofia READY.' });
      } else {
        emitBridgeEvent({
          level: 'error',
          message: 'MCF Agent Identity: bootstrap incompleto — ' + (bootstrap?.error || 'verificar /v1/agents'),
        });
      }

      try {
        const recovery = await paneAgentRuntime?.recoverPersistedMissions();
        if (recovery?.recovered?.length) {
          const completed = recovery.recovered.filter(item => item.state === 'COMPLETED').length;
          const unresolved = recovery.recovered.length - completed;
          emitBridgeEvent({
            level: unresolved ? 'error' : 'ok',
            message: 'MCF Mission Recovery: '
              + completed + ' concluída(s), '
              + unresolved + ' não verificada(s).',
          });
        }
        paneAgentRuntime?.markStartupReady();
        emitBridgeEvent({
          level: 'ok',
          message: 'MCF Agent Runtime: startup/recovery concluído — missões liberadas.',
        });
      } catch (error) {
        paneAgentRuntime?.markStartupInitializing();
        emitBridgeEvent({
          level: 'error',
          message: 'MCF Mission Recovery falhou: ' + error.message,
        });
      }
    })
    .catch((error) => {
      persistBridgeState(null);
      emitBridgeEvent({ level: 'error', message: 'Agent Bridge não iniciou: ' + error.message });
    });

  mainWindow.on('resize', () => { updateViewBounds(); scheduleRuntimeStatePersist(); });
  mainWindow.on('move', () => scheduleRuntimeStatePersist());
  mainWindow.on('maximize', () => { updateViewBounds(); scheduleRuntimeStatePersist(); });
  mainWindow.on('unmaximize', () => { updateViewBounds(); scheduleRuntimeStatePersist(); });
  mainWindow.on('close', () => {
    try { persistRuntimeState(); } catch (error) {
      console.error('Falha ao persistir sessão no fechamento:', error.message);
    }
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', async () => {
    const state = await bridge?.stop().catch(() => null);
    persistBridgeState(state);
    bridge = null;
    paneAgentRuntime = null;
    chatView = null;
    workspaceView = null;
    workspaceAuxWindow = null;
    for (const win of agentSessionWindows.values()) {
      if (win && !win.isDestroyed()) win.close();
    }
    agentSessionWindows.clear();
    mainWindow = null;
  });
}

function activeWorkspaceWebContents() {
  if (workspaceAuxWindow && !workspaceAuxWindow.isDestroyed()) {
    const child = workspaceAuxWindow.webContents;
    if (child && !child.isDestroyed()) return child;
  }
  return workspaceView?.webContents ?? null;
}

function getPane(pane) {
  if (pane === 'chat') return chatView?.webContents ?? null;
  if (pane === 'workspace') return activeWorkspaceWebContents();
  return null;
}

async function captureWorkspace() {
  const wc = activeWorkspaceWebContents();
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'workspace_unavailable' };
  const dir = path.join(app.getPath('pictures'), 'MCF-Cockpit-Captures');
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `workspace-${instance.id}-${process.pid}-${Date.now()}.png`);
  const image = await wc.capturePage();
  writeFileSync(output, image.toPNG(), { mode: 0o600, flag: 'wx' });
  emitBridgeEvent({ level: 'ok', message: `Captura salva: ${output}` });
  return { ok: true, path: output };
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('untrusted_ipc_sender');
    }
    return handler(event, ...args);
  });
}

handleTrusted('bridge:pause', () => {
  const state = bridge.setPaused(!bridge.paused);
  persistBridgeState(state);
  return state;
});

handleTrusted('layout:set-split', (_event, ratio) => {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return { ok: false };
  splitRatio = Math.min(0.72, Math.max(0.28, n));
  updateViewBounds();
  scheduleRuntimeStatePersist();
  return { ok: true, splitRatio };
});

handleTrusted('layout:preset', (_event, preset) => {
  const presets = { balanced: 0.5, leandro: 0.65, mestre: 0.35 };
  if (!(preset in presets)) return { ok: false };
  splitRatio = presets[preset];
  updateViewBounds();
  scheduleRuntimeStatePersist();
  return { ok: true, splitRatio };
});

handleTrusted('browser:navigate', async (_event, pane, input) => {
  const wc = getPane(pane);
  if (!wc) return { ok: false, error: 'pane_unavailable' };
  const url = normalizeNavigation(input);
  if (!url) return { ok: false, error: 'invalid_navigation' };
  await wc.loadURL(url);
  return { ok: true, url };
});

handleTrusted('browser:action', (_event, pane, action) => {
  const wc = getPane(pane);
  if (!wc) return { ok: false, error: 'pane_unavailable' };
  const history = wc.navigationHistory;

  if (action === 'back' && history.canGoBack()) history.goBack();
  else if (action === 'forward' && history.canGoForward()) history.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
  else if (action === 'home') wc.loadURL(pane === 'chat' ? CHATGPT_URL : WORKSPACE_URL);
  else if (action === 'devtools') wc.openDevTools({ mode: 'detach' });
  else return { ok: false, error: 'invalid_or_unavailable_action' };

  return { ok: true };
});

handleTrusted('browser:open-external', async (_event, pane) => {
  const wc = getPane(pane);
  if (!wc) return { ok: false };
  const url = wc.getURL();
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

handleTrusted('browser:get-states', () => ({
  chat: chatView ? safeState('chat', chatView.webContents) : viewState.chat,
  workspace: workspaceView ? safeState('workspace', workspaceView.webContents) : viewState.workspace,
  splitRatio,
}));

handleTrusted('workspace:capture', async () => captureWorkspace());

handleTrusted('bridge:toggle', async () => {
  const state = await bridge?.toggle() ?? { enabled: false, host: '127.0.0.1', port: null, token: null };
  persistBridgeState(state);
  return state;
});
handleTrusted('bridge:get-state', () => bridge?.getState() ?? { enabled: false, host: '127.0.0.1', port: null, token: null });
handleTrusted('bridge:copy-token', () => {
  const state = bridge?.getState();
  if (!state?.enabled || !state.token) return { ok: false };
  clipboard.writeText(state.token);
  return { ok: true };
});

app.whenReady().then(() => {
  if (!ownsInstance) return;
  app.setAccessibilitySupportEnabled(true);
  restoredRuntimeState = loadRuntimeState();
  const savedSplit = Number(restoredRuntimeState?.splitRatio);
  if (Number.isFinite(savedSplit)) splitRatio = Math.min(0.72, Math.max(0.28, savedSplit));
  createWindow();
});

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
});

app.on('activate', () => {
  if (!ownsInstance) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async () => {
  if (runtimePersistTimer) { clearTimeout(runtimePersistTimer); runtimePersistTimer = null; }
  try { persistRuntimeState(); } catch {}
  await bridge?.stop().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
