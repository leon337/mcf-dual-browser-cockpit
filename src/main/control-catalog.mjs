// Auditable, read-only capability map. No generic IPC dispatch or bearer token exposure.
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../capabilities/control-catalog.v1.json', import.meta.url), 'utf8'));
export const CONTROL_CATALOG_SCHEMA = 'mcf-dual-browser-control-catalog/v1';
const clone = data => JSON.parse(JSON.stringify(data));

export function buildControlCatalog({bridgeState={},paneStates=[]}={}) {
  const catalog=clone(manifest);
  const bridge = {
    enabled: Boolean(bridgeState?.enabled),
    paused: Boolean(bridgeState?.paused),
    busy: Boolean(bridgeState?.busy),
    queueDepth: Number(bridgeState?.queueDepth) || 0,
    host: '127.0.0.1',
    port: Number.isInteger(bridgeState?.port) ? bridgeState.port : null,
  };
  catalog.runtime={bridge,panes: Array.isArray(paneStates)
    ? paneStates.map(p=>({pane:p?.pane || null,available:Boolean(p?.available),loading:Boolean(p?.loading)})) : []};
  catalog.counts={uiControls:catalog.uiControls.length,ipcChannels:catalog.ipcChannels.length,bridgeRoutes:catalog.bridgeRoutes.length};
  catalog.authorization={
    controlCatalogIsReadOnly:true,
    localBridgeAuthRequired:true,
    dangerousActionsNotImplicitlyAuthorized:true,
    identityQualifiedByDiscovery:false,
  };
  return catalog;
}
