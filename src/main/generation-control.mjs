export function isGenerationStopControl({
  ariaLabel = '',
  testId = '',
  title = '',
  text = '',
} = {}) {
  const labels = [ariaLabel, testId, title, text]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  return labels.some(label =>
    label === 'stop-button'
    || label.includes('stop generating')
    || label.includes('stop responding')
    || label.includes('parar de gerar')
    || label.includes('parar de responder')
    || label.includes('interromper resposta')
  );
}

export function isTargetGenerationActive({
  stopControlPresent = false,
  laterUserMessageObserved = false,
} = {}) {
  return Boolean(stopControlPresent) && !Boolean(laterUserMessageObserved);
}
