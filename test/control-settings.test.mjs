import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTROL_SETTINGS,
  normalizeControlSettings,
  validateControlSettings,
} from '../src/main/control-settings.mjs';

test('control settings expose safe, deterministic defaults', () => {
  assert.deepEqual({ ...DEFAULT_CONTROL_SETTINGS }, {
    startBridgeOnLaunch: true,
    preferredBridgePort: 47831,
    defaultLayout: 'balanced',
    refreshIntervalMs: 3000,
    eventLimit: 50,
  });
});

test('control settings accept all supported preferences', () => {
  const result = validateControlSettings({
    startBridgeOnLaunch: false,
    preferredBridgePort: 41651,
    defaultLayout: 'mestre',
    refreshIntervalMs: 5000,
    eventLimit: 100,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, {
    startBridgeOnLaunch: false,
    preferredBridgePort: 41651,
    defaultLayout: 'mestre',
    refreshIntervalMs: 5000,
    eventLimit: 100,
  });
});

test('control settings reject ports outside the unprivileged supported range', () => {
  for (const preferredBridgePort of [0, 80, 1023, 65536, 47831.5, '47831']) {
    const result = validateControlSettings({
      ...DEFAULT_CONTROL_SETTINGS,
      preferredBridgePort,
    });
    assert.equal(result.ok, false, String(preferredBridgePort));
    assert.equal(result.error, 'preferredBridgePort_out_of_range');
  }
});

test('control settings reject unsupported layout, refresh and history choices', () => {
  assert.equal(validateControlSettings({ ...DEFAULT_CONTROL_SETTINGS, defaultLayout: 'random' }).error, 'defaultLayout_invalid');
  assert.equal(validateControlSettings({ ...DEFAULT_CONTROL_SETTINGS, refreshIntervalMs: 4000 }).error, 'refreshIntervalMs_invalid');
  assert.equal(validateControlSettings({ ...DEFAULT_CONTROL_SETTINGS, eventLimit: 5000 }).error, 'eventLimit_invalid');
});

test('normalizing damaged persisted settings falls back field by field', () => {
  assert.deepEqual(normalizeControlSettings({
    startBridgeOnLaunch: 'yes',
    preferredBridgePort: 70000,
    defaultLayout: 'bad-layout',
    refreshIntervalMs: 4000,
    eventLimit: 20,
  }), { ...DEFAULT_CONTROL_SETTINGS });
});
