export const CONTROL_SETTINGS_SCHEMA = 'mcf-cockpit-control-settings/v1';

export const DEFAULT_CONTROL_SETTINGS = Object.freeze({
  startBridgeOnLaunch: true,
  preferredBridgePort: 47831,
  defaultLayout: 'balanced',
  refreshIntervalMs: 3000,
  eventLimit: 50,
});

const LAYOUTS = new Set(['balanced', 'leandro', 'mestre']);
const REFRESH_INTERVALS = new Set([2000, 3000, 5000, 10000]);
const EVENT_LIMITS = new Set([25, 50, 100]);

export function normalizeControlSettings(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    startBridgeOnLaunch: typeof value.startBridgeOnLaunch === 'boolean'
      ? value.startBridgeOnLaunch
      : DEFAULT_CONTROL_SETTINGS.startBridgeOnLaunch,
    preferredBridgePort: Number.isInteger(value.preferredBridgePort)
        && value.preferredBridgePort >= 1024
        && value.preferredBridgePort <= 65535
      ? value.preferredBridgePort
      : DEFAULT_CONTROL_SETTINGS.preferredBridgePort,
    defaultLayout: LAYOUTS.has(value.defaultLayout)
      ? value.defaultLayout
      : DEFAULT_CONTROL_SETTINGS.defaultLayout,
    refreshIntervalMs: REFRESH_INTERVALS.has(value.refreshIntervalMs)
      ? value.refreshIntervalMs
      : DEFAULT_CONTROL_SETTINGS.refreshIntervalMs,
    eventLimit: EVENT_LIMITS.has(value.eventLimit)
      ? value.eventLimit
      : DEFAULT_CONTROL_SETTINGS.eventLimit,
  };
}

export function validateControlSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'settings_object_required' };
  }
  if (typeof input.startBridgeOnLaunch !== 'boolean') {
    return { ok: false, error: 'startBridgeOnLaunch_must_be_boolean' };
  }
  if (!Number.isInteger(input.preferredBridgePort)
      || input.preferredBridgePort < 1024
      || input.preferredBridgePort > 65535) {
    return { ok: false, error: 'preferredBridgePort_out_of_range' };
  }
  if (!LAYOUTS.has(input.defaultLayout)) {
    return { ok: false, error: 'defaultLayout_invalid' };
  }
  if (!REFRESH_INTERVALS.has(input.refreshIntervalMs)) {
    return { ok: false, error: 'refreshIntervalMs_invalid' };
  }
  if (!EVENT_LIMITS.has(input.eventLimit)) {
    return { ok: false, error: 'eventLimit_invalid' };
  }
  return { ok: true, settings: normalizeControlSettings(input) };
}
