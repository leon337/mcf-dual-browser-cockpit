import { app, BrowserWindow, WebContentsView, ipcMain, shell, clipboard, session, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { LocalAgentBridge } from './bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(SRC_ROOT, 'preload', 'preload.cjs');
const RENDERER = path.join(SRC_ROOT, 'renderer', 'index.html');

const HEADER_HEIGHT = 124;
const STATUS_HEIGHT = 28;
const VIEW_GAP = 8;
const MIN_PANE = 320;
const CHATGPT_URL = 'https://chatgpt.com/';
const WORKSPACE_URL = 'https://www.google.com/';

let mainWindow = null;
let chatView = null;
let workspaceView = null;
let splitRatio = 0.5;
let bridge = null;
let restoredRuntimeState = null;
let runtimePersistTimer = null;
const RUNTIME_STATE_VERSION = 1;

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
  writeFileSync(output, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(output, 0o600);
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
  const temp = file + '.tmp';
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
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
      shell.openExternal(url).catch(() => {});
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

  wc.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
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
    emitBridgeEvent({ level: 'error', message: `${key}: falha ao abrir ${validatedURL} — ${errorDescription}` });
  });
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
    title: 'MCF Dual Browser Cockpit',
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
  bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => workspaceView?.webContents ?? null,
    captureDir,
    onEvent: emitBridgeEvent,
  });

  bridge.start()
    .then((state) => persistBridgeState(state))
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
    chatView = null;
    workspaceView = null;
    mainWindow = null;
  });
}

function getPane(pane) {
  if (pane === 'chat') return chatView?.webContents ?? null;
  if (pane === 'workspace') return workspaceView?.webContents ?? null;
  return null;
}

ipcMain.handle('layout:set-split', (_event, ratio) => {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return { ok: false };
  splitRatio = Math.min(0.72, Math.max(0.28, n));
  updateViewBounds();
  scheduleRuntimeStatePersist();
  return { ok: true, splitRatio };
});

ipcMain.handle('layout:preset', (_event, preset) => {
  const presets = { balanced: 0.5, leandro: 0.65, mestre: 0.35 };
  if (!(preset in presets)) return { ok: false };
  splitRatio = presets[preset];
  updateViewBounds();
  scheduleRuntimeStatePersist();
  return { ok: true, splitRatio };
});

ipcMain.handle('browser:navigate', async (_event, pane, input) => {
  const wc = getPane(pane);
  if (!wc) return { ok: false, error: 'pane_unavailable' };
  const url = normalizeNavigation(input);
  if (!url) return { ok: false, error: 'invalid_navigation' };
  await wc.loadURL(url);
  return { ok: true, url };
});

ipcMain.handle('browser:action', (_event, pane, action) => {
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

ipcMain.handle('browser:open-external', async (_event, pane) => {
  const wc = getPane(pane);
  if (!wc) return { ok: false };
  const url = wc.getURL();
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('browser:get-states', () => ({
  chat: chatView ? safeState('chat', chatView.webContents) : viewState.chat,
  workspace: workspaceView ? safeState('workspace', workspaceView.webContents) : viewState.workspace,
  splitRatio,
}));

ipcMain.handle('workspace:capture', async () => {
  const wc = workspaceView?.webContents;
  if (!wc) return { ok: false, error: 'workspace_unavailable' };
  const dir = path.join(app.getPath('pictures'), 'MCF-Cockpit-Captures');
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `workspace-${Date.now()}.png`);
  const image = await wc.capturePage();
  writeFileSync(output, image.toPNG());
  emitBridgeEvent({ level: 'ok', message: `Captura salva: ${output}` });
  return { ok: true, path: output };
});

ipcMain.handle('bridge:toggle', async () => {
  const state = await bridge?.toggle() ?? { enabled: false, host: '127.0.0.1', port: null, token: null };
  persistBridgeState(state);
  return state;
});
ipcMain.handle('bridge:get-state', () => bridge?.getState() ?? { enabled: false, host: '127.0.0.1', port: null, token: null });
ipcMain.handle('bridge:copy-token', () => {
  const state = bridge?.getState();
  if (!state?.enabled || !state.token) return { ok: false };
  clipboard.writeText(state.token);
  return { ok: true };
});

app.whenReady().then(() => {
  app.setAccessibilitySupportEnabled(true);
  restoredRuntimeState = loadRuntimeState();
  const savedSplit = Number(restoredRuntimeState?.splitRatio);
  if (Number.isFinite(savedSplit)) splitRatio = Math.min(0.72, Math.max(0.28, savedSplit));
  createWindow();
});

app.on('activate', () => {
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
