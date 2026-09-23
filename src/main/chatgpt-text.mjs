export function normalizedComparable(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeAssistantCandidate(value) {
  return normalizedComparable(value)
    .replace(/^(?:chatgpt\s+(?:said|disse)|assistant|assistente)\s*:?\s*/i, '')
    .trim();
}
