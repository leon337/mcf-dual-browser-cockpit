const api = window.cockpit;

const paneGrid = document.getElementById('paneGrid');
const splitter = document.getElementById('toolbarSplitter');
const stageDivider = document.getElementById('stageDivider');
const workspaceAddress = document.getElementById('workspaceAddress');
const chatUrl = document.getElementById('chatUrl');
const chatLoading = document.getElementById('chatLoading');
const workspaceLoading = document.getElementById('workspaceLoading');
const chatStatus = document.getElementById('chatStatus');
const workspaceStatus = document.getElementById('workspaceStatus');
const bridgeButton = document.getElementById('bridgeButton');
const copyTokenButton = document.getElementById('copyTokenButton');
const activity = document.getElementById('activity');
const toast = document.getElementById('toast');

let ratio = 0.5;
let dragging = false;
let toastTimer = null;
const states = { chat: null, workspace: null };

function setToast(message, type = '') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3300);
}

function setRatio(next, notify = true) {
  ratio = Math.min(0.72, Math.max(0.28, Number(next) || 0.5));
  paneGrid.style.gridTemplateColumns = `${ratio}fr 8px ${1 - ratio}fr`;
  const gapLeft = Math.floor((window.innerWidth - 8) * ratio);
  stageDivider.style.left = `${gapLeft}px`;
  if (notify) api.layout.setSplit(ratio);
}

function selectPreset(name) {
  document.querySelectorAll('[data-preset]').forEach(btn => btn.classList.toggle('active', btn.dataset.preset === name));
}

function renderState(pane, state) {
  states[pane] = state;
  const isChat = pane === 'chat';
  const loadingEl = isChat ? chatLoading : workspaceLoading;
  loadingEl.textContent = state.loading ? 'carregando…' : 'pronto';
  loadingEl.classList.toggle('idle', !state.loading);

  if (isChat) {
    chatUrl.textContent = state.url || 'https://chatgpt.com/';
    chatStatus.textContent = `ChatGPT: ${state.title || 'pronto'}`;
  } else {
    if (document.activeElement !== workspaceAddress && state.url) workspaceAddress.value = state.url;
    workspaceStatus.textContent = `Workspace: ${state.title || 'pronto'}`;
  }

  document.querySelectorAll(`[data-pane="${pane}"][data-action="back"]`).forEach(btn => btn.disabled = !state.canGoBack);
  document.querySelectorAll(`[data-pane="${pane}"][data-action="forward"]`).forEach(btn => btn.disabled = !state.canGoForward);
}

async function navigateWorkspace() {
  const value = workspaceAddress.value.trim();
  if (!value) return;
  const result = await api.browser.navigate('workspace', value);
  if (!result?.ok) setToast('Endereço ou pesquisa inválidos.', 'error');
}

async function refreshBridge() {
  const state = await api.bridge.getState();
  bridgeButton.classList.toggle('on', state.enabled);
  bridgeButton.querySelector('span:last-child').textContent = state.enabled ? `AGENT BRIDGE · ${state.port}` : 'AGENT BRIDGE OFF';
  copyTokenButton.classList.toggle('hidden', !state.enabled);
  if (state.enabled) activity.textContent = `Bridge local: 127.0.0.1:${state.port} · token efêmero`;
  else activity.textContent = 'Cockpit local · Bridge desativada por padrão';
}

document.querySelectorAll('[data-pane][data-action]').forEach(button => {
  button.addEventListener('click', async () => {
    const result = await api.browser.action(button.dataset.pane, button.dataset.action);
    if (!result?.ok && result?.error) setToast(result.error, 'error');
  });
});

document.querySelectorAll('[data-external]').forEach(button => {
  button.addEventListener('click', () => api.browser.openExternal(button.dataset.external));
});

document.querySelectorAll('[data-preset]').forEach(button => {
  button.addEventListener('click', async () => {
    const preset = button.dataset.preset;
    const result = await api.layout.preset(preset);
    if (result?.ok) {
      setRatio(result.splitRatio, false);
      selectPreset(preset);
    }
  });
});

document.getElementById('goButton').addEventListener('click', navigateWorkspace);
workspaceAddress.addEventListener('keydown', event => {
  if (event.key === 'Enter') navigateWorkspace();
});

document.getElementById('captureButton').addEventListener('click', async () => {
  const result = await api.workspace.capture();
  if (result?.ok) setToast(`Captura salva em ${result.path}`, 'ok');
  else setToast('Não foi possível capturar o workspace.', 'error');
});

bridgeButton.addEventListener('click', async () => {
  try {
    const state = await api.bridge.toggle();
    await refreshBridge();
    setToast(state.enabled ? 'Agent Bridge ativada apenas em 127.0.0.1.' : 'Agent Bridge desativada.', state.enabled ? 'ok' : '');
  } catch (error) {
    setToast(`Falha ao alternar bridge: ${error.message}`, 'error');
  }
});

copyTokenButton.addEventListener('click', async () => {
  const result = await api.bridge.copyToken();
  setToast(result?.ok ? 'Token efêmero copiado.' : 'Bridge não está ativa.', result?.ok ? 'ok' : 'error');
});

splitter.addEventListener('pointerdown', event => {
  dragging = true;
  splitter.setPointerCapture(event.pointerId);
  selectPreset('');
});
splitter.addEventListener('pointermove', event => {
  if (!dragging) return;
  setRatio(event.clientX / window.innerWidth);
});
splitter.addEventListener('pointerup', event => {
  dragging = false;
  if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
});
splitter.addEventListener('dblclick', () => {
  setRatio(0.5);
  selectPreset('balanced');
});

window.addEventListener('resize', () => setRatio(ratio, false));

api.browser.onState(payload => {
  if (payload.pane === 'layout') {
    if (typeof payload.splitRatio === 'number') setRatio(payload.splitRatio, false);
    return;
  }
  if (payload.pane === 'chat' || payload.pane === 'workspace') renderState(payload.pane, payload);
});

api.bridge.onEvent(event => {
  activity.textContent = event.message;
  if (event.level === 'error') setToast(event.message, 'error');
});

(async () => {
  const initial = await api.browser.getStates();
  setRatio(initial.splitRatio ?? 0.5, false);
  renderState('chat', initial.chat);
  renderState('workspace', initial.workspace);
  await refreshBridge();
})();
