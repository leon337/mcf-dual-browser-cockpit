import test from 'node:test';
import assert from 'node:assert/strict';
import { isGenerationStopControl } from '../src/main/generation-control.mjs';

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
