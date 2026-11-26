// Mints YouTube proof-of-origin tokens in a hidden window (see src/potoken). Web clients need a
// "session" token bound to the visitor ID for the video links and a "content" token bound to
// the video ID for the player request. Tokens are cached; the minter refreshes itself.
import { BrowserWindow, ipcMain, net } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let ready = null;
const cache = new Map();

ipcMain.handle('pot:fetch', async (_e, url, init = {}) => {
  if (!/^https:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com|youtube\.com)\//i.test(url)) throw new Error('blocked');
  const res = await net.fetch(url, { method: init.method || 'GET', headers: init.headers || {}, body: init.body });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
});

function ensureWindow() {
  if (ready) return ready;
  ready = (async () => {
    win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        preload: path.join(here, '..', 'potoken', 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: 'potoken'
      }
    });
    win.on('closed', () => { win = null; ready = null; });
    await win.loadFile(path.join(here, '..', 'potoken', 'potoken.html'));
    for (let i = 0; i < 50; i++) {
      if (await win.webContents.executeJavaScript('window.potReady === true')) return win;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('PO token page did not start');
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

/** Returns { [binding]: token } for each binding (visitor data, video ID). */
export async function mint(bindings) {
  const fresh = (b) => cache.has(b) && Date.now() - cache.get(b).at < 6 * 3600 * 1000;
  const missing = bindings.filter((b) => !fresh(b));
  if (missing.length) {
    const w = await ensureWindow();
    const result = await Promise.race([
      w.webContents.executeJavaScript(`window.mintTokens(${JSON.stringify(missing)})`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PO token timed out')), 20000))
    ]);
    for (const [k, v] of Object.entries(result || {})) {
      cache.set(k, { token: v, at: Date.now() });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
  }
  const out = {};
  for (const b of bindings) out[b] = cache.get(b)?.token;
  return out;
}

/** Warm up in the background so the first video doesn't wait for BotGuard. */
export function warm(visitorData) {
  if (visitorData) mint([visitorData]).catch((e) => console.warn('[potoken] warm-up failed:', e.message));
}
