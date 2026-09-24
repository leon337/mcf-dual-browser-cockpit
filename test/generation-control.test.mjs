import test from 'node:test';
import assert from 'node:assert/strict';
import { isGenerationStopControl, isTargetGenerationActive } from '../src/main/generation-control.mjs';

test('generation stop control evaluates every available signal', () => {
  assert.equal(isGenerationStopControl({
    ariaLabel: 'Parar de responder',
    testId: 'stop-button',
  }), true);

  assert.equal(isGenerationStopControl({
    ariaLabel: 'Some unrelated accessible label',
    testId: 'stop-button',
  }), true);

  assert.equal(isGenerationStopControl({
    ariaLabel: 'Stop generating',
  }), true);

  assert.equal(isGenerationStopControl({
    ariaLabel: 'Iniciar Voz',
    testId: '',
    text: '',
  }), false);
});


test('later user turn makes a previous assistant turn independently terminal', () => {
  assert.equal(isTargetGenerationActive({
    stopControlPresent: true,
    laterUserMessageObserved: false,
  }), true);

  assert.equal(isTargetGenerationActive({
    stopControlPresent: true,
    laterUserMessageObserved: true,
  }), false);

  assert.equal(isTargetGenerationActive({
    stopControlPresent: false,
    laterUserMessageObserved: false,
  }), false);
});
