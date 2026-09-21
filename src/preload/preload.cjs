const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cockpit', {
  layout: {
    setSplit: (ratio) => ipcRenderer.invoke('layout:set-split', ratio),
    preset: (preset) => ipcRenderer.invoke('layout:preset', preset),
  },
  browser: {
    navigate: (pane, input) => ipcRenderer.invoke('browser:navigate', pane, input),
    action: (pane, action) => ipcRenderer.invoke('browser:action', pane, action),
    openExternal: (pane) => ipcRenderer.invoke('browser:open-external', pane),
    getStates: () => ipcRenderer.invoke('browser:get-states'),
    onState: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on('browser:state', wrapped);
      return () => ipcRenderer.removeListener('browser:state', wrapped);
    },
  },
  workspace: {
    capture: () => ipcRenderer.invoke('workspace:capture'),
  },
  bridge: {
    toggle: () => ipcRenderer.invoke('bridge:toggle'),
    getState: () => ipcRenderer.invoke('bridge:get-state'),
    copyToken: () => ipcRenderer.invoke('bridge:copy-token'),
    onEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on('bridge:event', wrapped);
      return () => ipcRenderer.removeListener('bridge:event', wrapped);
    },
  },
});
