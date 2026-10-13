import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8');

test('settings page exposes a dedicated live automation control', () => {
  assert.match(html, /<h3>Controle da automação<\/h3>/);
  assert.match(html, /id="settingsAutomationState"/);
  assert.match(html, /id="settingsAutomationNote"/);
  assert.match(html, /id="settingsAutomationToggle"/);
});

test('automation settings display paused, busy, disabled and ready states', () => {
  assert.match(renderer, /BRIDGE DESLIGADA/);
  assert.match(renderer, /AUTOMAÇÃO PAUSADA/);
  assert.match(renderer, /AÇÃO EM CURSO/);
  assert.match(renderer, /AUTOMAÇÃO LIBERADA/);
});

test('settings automation toggle uses the trusted pause IPC and refreshes observed state', () => {
  assert.match(renderer, /settingsAutomationToggle'[\s\S]*?api\.bridge\.pause\(\)/);
  assert.match(renderer, /await refreshBridge\(\)/);
  assert.match(renderer, /async function fillSettingsForm\(\) \{\s*await refreshBridge\(\)/);
  assert.match(renderer, /await refreshControlSnapshot\(\)/);
});
