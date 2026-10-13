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
const controlCenter = document.getElementById('controlCenter');
const controlCenterButton = document.getElementById('controlCenterButton');

let ratio = 0.5;
let dragging = false;
let toastTimer = null;
let refreshTimer = null;
let refreshQueued = false;
let refreshing = false;
let controlOpen = false;
let currentControlPage = 'overview';
let controlMetadata = { settings: null, instanceId: null, agentProfile: null, version: '0.7.0' };
let latestSnapshot = null;
const states = { chat: null, workspace: null };
const PAGE_COPY = {
  overview: ['Visão geral', 'Estado operacional do cockpit, bridge e runtime local.'],
  observability: ['Observabilidade', 'Eventos locais, estados das missões, identidades e evidências resumidas.'],
  settings: ['Configurações', 'Preferências persistidas para inicialização e monitoramento.'],
};

function setToast(message, type = '') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3300);
}

function element(tag, className = '', text = '') {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
}

function clearAndAppend(parent, children) {
  parent.replaceChildren(...children);
}

function displayTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function displayDateTime(value) {
  if (!value) return 'sem registro';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'sem registro';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stateTone(value) {
  const state = String(value || '').toUpperCase();
  if (['READY', 'COMPLETED', 'RESULT_CAPTURED', 'ACTIVE', 'ONLINE', 'CONNECTED', 'DELIVERED', 'ACCEPTED'].includes(state)) return 'good';
  if (['FAILED', 'UNVERIFIED', 'REJECTED', 'INTERRUPTED', 'ERROR', 'OFFLINE', 'CANCELLED_BY_AUTHORITY'].includes(state)) return 'bad';
  if (['RECOVERING', 'QUEUED', 'WORKING', 'INITIALIZING', 'PAUSED', 'CANCEL_REQUESTED'].includes(state)) return 'warn';
  return '';
}

function statePill(value) {
  const name = String(value || 'UNKNOWN').replaceAll('_', ' ');
  return element('span', `state-pill ${stateTone(value)}`, name);
}

function renderStatusRows(targetId, rows) {
  const target = document.getElementById(targetId);
  clearAndAppend(target, rows.map(([label, value, tone]) => {
    const row = element('div', 'status-row');
    row.append(element('span', 'status-label', label));
    const valueNode = element('span', 'status-value');
    if (tone) valueNode.append(statePill(value));
    else valueNode.textContent = String(value ?? '—');
    row.append(valueNode);
    return row;
  }));
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

function selectPresetForRatio(value) {
  const preset = Math.abs(value - 0.65) < 0.025 ? 'leandro'
    : Math.abs(value - 0.35) < 0.025 ? 'mestre' : Math.abs(value - 0.5) < 0.025 ? 'balanced' : '';
  selectPreset(preset);
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
  if (controlOpen) scheduleSnapshotRefresh();
}

async function navigateWorkspace() {
  const value = workspaceAddress.value.trim();
  if (!value) return;
  const result = await api.browser.navigate('workspace', value);
  if (!result?.ok) setToast('Endereço ou pesquisa inválidos.', 'error');
}

async function refreshBridge() {
  const state = await api.bridge.getState();
  document.getElementById('instanceLabel').textContent = `INSTÂNCIA: ${state.instanceId} · LEANDRO + MESTRE`;
  const pauseButton = document.getElementById('pauseBridgeButton');
  pauseButton.textContent = state.paused ? 'RETOMAR' : 'PAUSAR';
  pauseButton.setAttribute('aria-pressed', String(state.paused));
  pauseButton.disabled = !state.enabled;
  bridgeButton.classList.toggle('on', state.enabled);
  bridgeButton.querySelector('span:last-child').textContent = state.enabled ? `AGENT BRIDGE · ${state.port}` : 'AGENT BRIDGE OFF';
  copyTokenButton.classList.toggle('hidden', !state.enabled);
  if (state.enabled) activity.textContent = `Bridge local: 127.0.0.1:${state.port} · token efêmero`;
  else activity.textContent = 'Cockpit local · Bridge desligada';
}

function renderEventRows(target, events, compact = false) {
  if (!events?.length) {
    target.replaceChildren(element('div', 'empty-state', 'Nenhum evento no buffer local.'));
    return;
  }
  const rows = events.map(event => {
    const row = element('div', 'event-row');
    row.append(element('span', 'event-time', displayTime(event.timestamp)));
    const details = element('div');
    details.append(element('div', 'event-name', event.type || 'EVENT'));
    const metaParts = [event.source, event.pane, event.agentId, event.state || event.status].filter(Boolean);
    details.append(element('span', 'event-meta', metaParts.join(' · ') || event.eventId || 'Evento local'));
    row.append(details);
    const tag = element('span', 'event-tag', event.authority || 'local');
    row.append(tag);
    return row;
  });
  if (compact) target.classList.add('compact-list');
  else target.classList.remove('compact-list');
  clearAndAppend(target, rows);
}

function renderOverview(snapshot) {
  const bridge = snapshot.bridge || {};
  const agents = snapshot.agents || [];
  const missions = snapshot.missions || [];
  const readyAgents = agents.filter(agent => agent.handshakeVerified && agent.state === 'READY').length;
  const activeStates = new Set(['QUEUED', 'DELIVERED', 'ACCEPTED', 'WORKING', 'RESULT_CAPTURED', 'RECOVERING']);
  const activeMissions = missions.filter(mission => activeStates.has(String(mission.state).toUpperCase())).length;
  const failedMissions = missions.filter(mission => ['FAILED', 'UNVERIFIED', 'REJECTED', 'INTERRUPTED'].includes(String(mission.state).toUpperCase())).length;

  const bridgeMetric = document.getElementById('bridgeMetric');
  bridgeMetric.textContent = bridge.enabled ? 'ONLINE' : 'OFF';
  bridgeMetric.className = `metric-value ${bridge.enabled ? 'good' : 'warn'}`;
  document.getElementById('bridgeMetricNote').textContent = bridge.enabled ? `127.0.0.1:${bridge.port}` : 'API HTTP não está escutando';
  const runtimeMetric = document.getElementById('runtimeMetric');
  runtimeMetric.textContent = agents.length && readyAgents === agents.length ? 'READY' : agents.length ? 'PARCIAL' : 'INICIALIZANDO';
  runtimeMetric.className = `metric-value ${agents.length && readyAgents === agents.length ? 'good' : 'warn'}`;
  document.getElementById('runtimeMetricNote').textContent = agents.length ? `${readyAgents}/${agents.length} handshakes verificados` : 'Nenhuma identidade retornada';
  document.getElementById('agentsMetric').textContent = String(agents.length);
  document.getElementById('agentsMetricNote').textContent = `${readyAgents} prontos · ${agents.length - readyAgents} pendentes`;
  const missionsMetric = document.getElementById('missionsMetric');
  missionsMetric.textContent = String(missions.length);
  missionsMetric.className = `metric-value ${failedMissions ? 'warn' : ''}`;
  document.getElementById('missionsMetricNote').textContent = `${activeMissions} em andamento · ${failedMissions} com falha/interrupção`;

  const paneReady = (snapshot.panes || []).filter(pane => pane.available).length;
  renderStatusRows('overviewStatusList', [
    ['Agent Bridge', bridge.enabled ? 'ONLINE' : 'OFF', bridge.enabled ? 'good' : 'warn'],
    ['Estado da automação', bridge.paused ? 'PAUSED' : bridge.busy ? 'WORKING' : 'IDLE', bridge.paused ? 'warn' : bridge.busy ? 'warn' : 'good'],
    ['Fila de ações', String(bridge.queueDepth ?? 0), ''],
    ['Painéis disponíveis', `${paneReady}/2`, paneReady === 2 ? 'good' : 'warn'],
    ['Perfil de agentes', bridge.agentProfile || controlMetadata.agentProfile || '—', ''],
    ['Última leitura', displayDateTime(snapshot.capturedAt), ''],
  ]);
  renderEventRows(document.getElementById('overviewEvents'), (snapshot.events || []).slice(0, 6), true);
}

function renderBridgeDetails(snapshot) {
  const bridge = snapshot.bridge || {};
  renderStatusRows('bridgeDetailList', [
    ['Estado HTTP', bridge.enabled ? 'ONLINE' : 'OFFLINE', bridge.enabled ? 'good' : 'warn'],
    ['Endereço', bridge.host || '127.0.0.1', ''],
    ['Porta ativa', bridge.port ?? 'nenhuma', ''],
    ['Instance ID', bridge.instanceId || '—', ''],
    ['Perfil', bridge.agentProfile || '—', ''],
    ['Automação', bridge.paused ? 'PAUSED' : bridge.busy ? 'BUSY' : 'IDLE', bridge.paused || bridge.busy ? 'warn' : 'good'],
    ['Profundidade da fila', bridge.queueDepth ?? 0, ''],
    ['Capturado em', displayDateTime(snapshot.capturedAt), ''],
  ]);

  const paneTarget = document.getElementById('paneList');
  clearAndAppend(paneTarget, (snapshot.panes || []).map(pane => {
    const wrapper = element('div', 'pane-item');
    const head = element('div', 'pane-item-head');
    head.append(element('span', 'pane-item-name', pane.pane === 'chat' ? 'ChatGPT · painel humano' : 'Workspace · painel operacional'));
    head.append(statePill(pane.available ? pane.loading ? 'LOADING' : 'AVAILABLE' : 'OFFLINE'));
    wrapper.append(head);
    wrapper.append(element('span', 'pane-item-url', pane.url || 'URL não disponível'));
    if (pane.title) wrapper.append(element('span', 'event-meta', pane.title));
    return wrapper;
  }));
}

function renderAgents(agents) {
  const target = document.getElementById('agentList');
  document.getElementById('agentCountLabel').textContent = String(agents.length);
  if (!agents.length) {
    target.replaceChildren(element('div', 'empty-state', 'O runtime não retornou identidades. Verifique o estado de inicialização.'));
    return;
  }
  clearAndAppend(target, agents.map(agent => {
    const row = element('div', 'record-row');
    const head = element('div', 'record-row-head');
    const left = element('div');
    left.append(element('div', 'record-title', agent.agentId || 'Agente sem nome'));
    left.append(element('div', 'record-subtitle', [agent.role, agent.pane, agent.sessionId ? `sessão ${agent.sessionId}…` : 'sem sessão'].filter(Boolean).join(' · ')));
    head.append(left);
    head.append(statePill(agent.state));
    row.append(head);
    row.append(element('div', 'record-subtitle', `Handshake: ${agent.handshakeVerified ? 'verificado' : 'pendente'} · Atualizado: ${displayDateTime(agent.updatedAt)}`));
    if (agent.reconciliationRequired) row.append(element('div', 'record-warning', `Reconciliação exigida: ${agent.reconciliationRequired}`));
    if (agent.lastError) row.append(element('div', 'record-warning', agent.lastError));
    return row;
  }));
}

function renderMissions(missions) {
  const target = document.getElementById('missionList');
  document.getElementById('missionCountLabel').textContent = String(missions.length);
  if (!missions.length) {
    target.replaceChildren(element('div', 'empty-state', 'Nenhuma missão local registrada nesta instância.'));
    return;
  }
  clearAndAppend(target, [...missions].slice().reverse().slice(0, 100).map(mission => {
    const row = element('div', 'record-row');
    const head = element('div', 'record-row-head');
    const left = element('div');
    left.append(element('div', 'record-title', mission.missionId || 'Missão sem ID'));
    left.append(element('div', 'record-subtitle', [mission.agentId, mission.pane, `tentativa ${mission.attemptNumber || 1}`].filter(Boolean).join(' · ')));
    head.append(left);
    head.append(statePill(mission.state));
    row.append(head);
    row.append(element('div', 'record-subtitle', `Atualizada: ${displayDateTime(mission.updatedAt || mission.createdAt)} · envelope ${(mission.envelopeId || '').slice(0, 12)}`));
    if (mission.reconciliationRequired) row.append(element('div', 'record-warning', 'Execução exige reconciliação antes de nova tentativa.'));
    if (mission.lastError) row.append(element('div', 'record-warning', mission.lastError));
    return row;
  }));
}

function renderReceipts(receipts) {
  const target = document.getElementById('receiptList');
  document.getElementById('receiptCountLabel').textContent = String(receipts.length);
  if (!receipts.length) {
    target.replaceChildren(element('div', 'empty-state', 'Ainda não existem receipts no runtime.'));
    return;
  }
  clearAndAppend(target, receipts.map(receipt => {
    const row = element('div', 'record-row');
    const head = element('div', 'record-row-head');
    const left = element('div');
    left.append(element('div', 'record-title', receipt.kind || 'RECEIPT'));
    left.append(element('div', 'record-subtitle', [receipt.agentId, receipt.envelopeId ? `envelope ${receipt.envelopeId.slice(0, 12)}` : ''].filter(Boolean).join(' · ')));
    head.append(left);
    head.append(statePill(receipt.status));
    row.append(head);
    row.append(element('div', 'record-subtitle', displayDateTime(receipt.createdAt)));
    return row;
  }));
}

async function refreshControlSnapshot() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const snapshot = await api.bridge.getObservability();
    if (!snapshot || snapshot.ok === false) {
      document.getElementById('lastRefresh').textContent = 'Leitura indisponível';
      return;
    }
    latestSnapshot = snapshot;
    renderOverview(snapshot);
    renderBridgeDetails(snapshot);
    renderAgents(snapshot.agents || []);
    renderMissions(snapshot.missions || []);
    renderEventRows(document.getElementById('eventFeed'), snapshot.events || []);
    renderReceipts(snapshot.receipts || []);
    document.getElementById('eventCountLabel').textContent = String((snapshot.events || []).length);
    document.getElementById('lastRefresh').textContent = `Atualizado às ${displayTime(snapshot.capturedAt)}`;
    await refreshBridge();
  } catch (error) {
    document.getElementById('lastRefresh').textContent = 'Falha na leitura local';
    if (controlOpen) setToast(`Observabilidade indisponível: ${error.message}`, 'error');
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      if (controlOpen) scheduleSnapshotRefresh();
    }
  }
}

function scheduleSnapshotRefresh() {
  if (!controlOpen) return;
  clearTimeout(window.__mcfRefreshDebounce);
  window.__mcfRefreshDebounce = setTimeout(() => { refreshControlSnapshot(); }, 180);
}

function configureAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const interval = Number(controlMetadata.settings?.refreshIntervalMs) || 3000;
  refreshTimer = setInterval(() => {
    if (controlOpen) refreshControlSnapshot();
  }, interval);
}

function switchControlPage(name) {
  if (!PAGE_COPY[name]) return;
  currentControlPage = name;
  document.querySelectorAll('[data-control-tab]').forEach(button => {
    const active = button.dataset.controlTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-control-page]').forEach(page => {
    page.classList.toggle('hidden', page.dataset.controlPage !== name);
  });
  document.getElementById('controlTitle').textContent = PAGE_COPY[name][0];
  document.getElementById('controlDescription').textContent = PAGE_COPY[name][1];
  if (name === 'settings') fillSettingsForm();
  else refreshControlSnapshot();
}

async function openControlCenter(page = 'overview') {
  controlOpen = true;
  controlCenter.classList.remove('hidden');
  paneGrid.classList.add('hidden');
  stageDivider.classList.add('hidden');
  document.body.classList.add('control-mode');
  controlCenterButton.setAttribute('aria-expanded', 'true');
  controlCenterButton.classList.add('selected');
  controlCenterButton.querySelector('span:last-child').textContent = 'FECHAR';
  await api.layout.setMode('control-center');
  switchControlPage(page);
  await refreshControlSnapshot();
}

async function closeControlCenter() {
  controlOpen = false;
  controlCenter.classList.add('hidden');
  paneGrid.classList.remove('hidden');
  stageDivider.classList.remove('hidden');
  document.body.classList.remove('control-mode');
  controlCenterButton.setAttribute('aria-expanded', 'false');
  controlCenterButton.classList.remove('selected');
  controlCenterButton.querySelector('span:last-child').textContent = 'CONTROLE';
  await api.layout.setMode('cockpit');
}

async function fillSettingsForm() {
  const metadata = await api.settings.get();
  if (!metadata?.ok) return;
  controlMetadata = { ...controlMetadata, ...metadata };
  const settings = metadata.settings;
  document.getElementById('settingsStartBridge').checked = settings.startBridgeOnLaunch;
  document.getElementById('settingsPort').value = String(settings.preferredBridgePort);
  document.getElementById('settingsLayout').value = settings.defaultLayout;
  document.getElementById('settingsRefresh').value = String(settings.refreshIntervalMs);
  document.getElementById('settingsEventLimit').value = String(settings.eventLimit);
  document.getElementById('settingsInstance').textContent = metadata.instanceId || '—';
  document.getElementById('settingsProfile').textContent = metadata.agentProfile || '—';
  document.getElementById('settingsVersion').textContent = metadata.version || '—';
  document.getElementById('appVersion').textContent = `v${metadata.version || '0.7.0'}`;
  document.getElementById('settingsStatus').textContent = 'Preferências carregadas do perfil local.';
  configureAutoRefresh();
}

function readSettingsForm() {
  return {
    startBridgeOnLaunch: document.getElementById('settingsStartBridge').checked,
    preferredBridgePort: Number(document.getElementById('settingsPort').value),
    defaultLayout: document.getElementById('settingsLayout').value,
    refreshIntervalMs: Number(document.getElementById('settingsRefresh').value),
    eventLimit: Number(document.getElementById('settingsEventLimit').value),
  };
}

async function saveSettingsForm(event) {
  event.preventDefault();
  const status = document.getElementById('settingsStatus');
  status.className = '';
  status.textContent = 'Salvando preferências…';
  const result = await api.settings.save(readSettingsForm());
  if (!result?.ok) {
    status.className = 'error';
    status.textContent = `Configuração inválida: ${result?.error || 'erro ao salvar'}`;
    return;
  }
  controlMetadata.settings = result.settings;
  configureAutoRefresh();
  const layoutRatio = { balanced: 0.5, leandro: 0.65, mestre: 0.35 }[result.settings.defaultLayout] ?? 0.5;
  setRatio(layoutRatio, false);
  selectPresetForRatio(layoutRatio);
  status.className = 'ok';
  status.textContent = 'Configurações salvas. Layout aplicado agora; inicialização e porta preferencial serão usadas na próxima abertura/ativação.';
  setToast('Configurações do cockpit salvas.', 'ok');
  await refreshControlSnapshot();
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
    scheduleSnapshotRefresh();
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
    if (typeof payload.splitRatio === 'number') {
      setRatio(payload.splitRatio, false);
      selectPresetForRatio(payload.splitRatio);
    }
    return;
  }
  if (payload.pane === 'chat' || payload.pane === 'workspace') renderState(payload.pane, payload);
});

api.bridge.onEvent(event => {
  if (event.message) activity.textContent = event.message;
  if (event.level === 'error') setToast(event.message, 'error');
  scheduleSnapshotRefresh();
});

controlCenterButton.addEventListener('click', () => {
  if (controlOpen) closeControlCenter();
  else openControlCenter('overview');
});
document.getElementById('closeControlCenter').addEventListener('click', closeControlCenter);
document.getElementById('refreshControlButton').addEventListener('click', refreshControlSnapshot);
document.querySelectorAll('[data-control-tab]').forEach(button => {
  button.addEventListener('click', () => switchControlPage(button.dataset.controlTab));
});
document.querySelectorAll('[data-open-tab]').forEach(button => {
  button.addEventListener('click', () => switchControlPage(button.dataset.openTab));
});
document.getElementById('settingsForm').addEventListener('submit', saveSettingsForm);
document.getElementById('pauseBridgeButton').addEventListener('click', async () => {
  try {
    const state = await api.bridge.pause();
    await refreshBridge();
    setToast(state.paused ? 'Novas ações pausadas. A ação em curso pode terminar.' : 'Automação retomada.');
    scheduleSnapshotRefresh();
  } catch { setToast('Não foi possível pausar a automação.', 'error'); }
});

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && controlOpen) closeControlCenter();
});

(async () => {
  const initial = await api.browser.getStates();
  setRatio(initial.splitRatio ?? 0.5, false);
  selectPresetForRatio(initial.splitRatio ?? 0.5);
  renderState('chat', initial.chat);
  renderState('workspace', initial.workspace);
  const metadata = await api.settings.get();
  if (metadata?.ok) {
    controlMetadata = { ...controlMetadata, ...metadata };
    document.getElementById('appVersion').textContent = `v${metadata.version || '0.7.0'}`;
  }
  configureAutoRefresh();
  await refreshBridge();
})();
