export function isChatSnapshotIdle(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.stop) return false;
  return !String(snapshot.composerText || '').trim();
}
