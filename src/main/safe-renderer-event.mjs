/**
 * Electron may dispose a WebFrameMain between isDestroyed() and send().
 * The UI notification is best-effort; the MCF ledger/bridge owns durable state.
 * Only expected disposal races are suppressed. Other errors still surface.
 */
export function safeRendererEventSend(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed?.() === true) return false;
  try {
    webContents.send(channel, payload);
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    const disposed = webContents.isDestroyed?.() === true
      || /render frame was disposed/i.test(message)
      || /webcontents has been destroyed/i.test(message)
      || /object has been destroyed/i.test(message);
    if (disposed) return false;
    throw error;
  }
}
