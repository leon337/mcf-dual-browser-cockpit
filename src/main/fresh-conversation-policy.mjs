export function isFreshConversationSurface(currentUrl, targetUrl) {
  try {
    const current = new URL(String(currentUrl || ''));
    const target = new URL(String(targetUrl || ''));
    if (current.origin !== target.origin) return false;
    if (current.hostname !== 'chatgpt.com') return false;
    if (/\/c\/[^/]+/.test(current.pathname)) return false;

    const normalize = value => value.replace(/\/$/, '');
    const targetPath = normalize(target.pathname);
    const currentPath = normalize(current.pathname);

    if (targetPath === '') {
      return currentPath === '' || currentPath === '/';
    }

    return currentPath === targetPath
      || currentPath === targetPath + '/project';
  } catch {
    return false;
  }
}
