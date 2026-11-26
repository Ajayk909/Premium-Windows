// Premium for Windows — main process.
// Owns the window, the YouTube data layer, the stream proxy and everything saved to disk.
import { app, BrowserWindow, ipcMain, protocol, net, shell, session, nativeTheme, dialog, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as yt from './innertube.js';
import * as streams from './streams.js';
import * as roku from './roku.js';
import * as google from './google.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// One copy of the app at a time; a second launch just focuses the first window.
if (!app.requestSingleInstanceLock()) app.quit();

// ytv:// is our stream proxy. Video segments go through the main process so we can send
// the headers YouTube's servers expect and so the page never runs into CORS.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ytv', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }
]);

let win;
const store = new Store(app.getPath('userData'));

const TITLEBAR_HEIGHT = 56;

function createWindow() {
  const bounds = store.get('window') || { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#ECEDF3',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#1C1D24', height: TITLEBAR_HEIGHT },
    icon: path.join(here, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  if (store.get('maximized')) win.maximize();
  Menu.setApplicationMenu(null);

  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    store.set('maximized', win.isMaximized());
    if (!win.isMaximized() && !win.isFullScreen()) store.set('window', win.getBounds());
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('close', saveBounds);
  win.on('enter-full-screen', () => send('window:fullscreen', true));
  win.on('leave-full-screen', () => send('window:fullscreen', false));
  win.on('maximize', () => send('window:maximized', true));
  win.on('unmaximize', () => send('window:maximized', false));

  // Links that leave the app open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (isDev) win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- Stream proxy ----------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': '*'
};

function registerProxy() {
  protocol.handle('ytv', async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const u = new URL(request.url);
    const target = 'https://' + u.host + u.pathname + u.search;
    const headers = {
      'User-Agent': streams.userAgentFor(u.searchParams.get('c')),
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
      'Accept': '*/*'
    };
    const range = request.headers.get('range');
    if (range) headers['Range'] = range;
    let body;
    if (request.method === 'POST') body = Buffer.from(await request.arrayBuffer());
    try {
      const res = await net.fetch(target, { method: request.method, headers, body, redirect: 'follow', bypassCustomProtocolHandlers: true });
      const out = new Headers();
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        const v = res.headers.get(k);
        if (v) out.set(k, v);
      }
      for (const [k, v] of Object.entries(CORS)) out.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch (err) {
      return new Response(String(err?.message || err), { status: 502, headers: CORS });
    }
  });
}

// ---------- IPC ----------

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${name}]`, err);
      return { ok: false, error: String(err?.message || err) };
    }
  });
}

const MOCK = process.env.PREMIUM_MOCK === '1';

function registerIpc() {
  if (MOCK) return registerMockIpc();
  registerSharedIpc();
  // YouTube data
  handle('yt:search', (q, filter, cont) => yt.search(q, filter, cont));
  handle('yt:suggest', (q) => yt.suggestions(q));
  handle('yt:details', (id) => yt.details(id));
  handle('yt:comments', (token) => yt.comments(token));
  handle('yt:channel', (id, tab, cont) => yt.channel(id, tab, cont));
  handle('yt:latest', (channel) => yt.latest(channel));
  handle('yt:latestMany', (channels, perChannel) => yt.latestMany(channels, perChannel));
  handle('yt:cues', (url) => yt.cues(url));
  handle('yt:sponsor', (id, cats) => yt.sponsorSegments(id, cats));
  handle('yt:dislikes', (id) => yt.dislikes(id));
  handle('yt:resolve', (url) => yt.resolve(url));
  handle('yt:playlist', (id, cont) => yt.playlist(id, cont));

  // Streams
  handle('streams:get', (id, from) => streams.get(id, from));

}

async function registerMockIpc() {
  const { mock } = await import('./mock.js');
  handle('yt:search', (q, f) => mock.search(q, f));
  handle('yt:suggest', (q) => mock.suggestions(q));
  handle('yt:details', (id) => mock.details(id));
  handle('yt:comments', () => mock.comments());
  handle('yt:channel', (id) => mock.channel(id));
  handle('yt:latest', () => mock.latestMany([]));
  handle('yt:latestMany', (s) => mock.latestMany(s));
  handle('yt:cues', () => []);
  handle('yt:sponsor', () => [{ start: 30, end: 60, category: 'sponsor' }, { start: 400, end: 420, category: 'selfpromo' }]);
  handle('yt:dislikes', () => ({ likes: 48000, dislikes: 312 }));
  handle('yt:resolve', (u) => yt.resolve(u));
  handle('yt:playlist', () => ({ title: 'Mock playlist', items: mock.search('x').items, continuation: null }));
  handle('streams:get', () => mock.streams());
  registerSharedIpc();
}

function registerSharedIpc() {
  // Google account (same sign-in as the iPhone app)
  handle('google:status', () => google.status());
  handle('google:signIn', () => google.signIn());
  handle('google:cancel', () => google.cancel());
  handle('google:signOut', () => google.signOut());
  handle('google:import', () => google.importAll());
  handle('google:profile', () => google.refreshProfile());

  // Storage
  handle('store:load', () => ({ library: store.get('library'), settings: store.get('settings') }));
  handle('store:save', (key, value) => { if (key === 'library' || key === 'settings') store.set(key, value); });
  handle('store:export', async (data) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Back up your Premium library',
      defaultPath: path.join(app.getPath('documents'), `premium-backup-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'Premium backup', extensions: ['json'] }]
    });
    if (canceled || !filePath) return false;
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return true;
  });
  handle('store:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Restore a Premium backup', properties: ['openFile'],
      filters: [{ name: 'Premium backup', extensions: ['json'] }]
    });
    if (canceled || !filePaths?.[0]) return null;
    return JSON.parse(await fs.readFile(filePaths[0], 'utf8'));
  });

  // Roku
  handle('roku:scan', () => roku.scan());
  handle('roku:probe', (ip) => roku.probe(ip));
  handle('roku:key', (ip, key) => roku.key(ip, key));
  handle('roku:cast', (ip, id, t) => roku.cast(ip, id, t));

  // Window
  handle('win:titlebar', (color, symbol) => {
    if (win && process.platform === 'win32') win.setTitleBarOverlay({ color, symbolColor: symbol, height: TITLEBAR_HEIGHT });
    nativeTheme.themeSource = symbol.toLowerCase() === '#ffffff' ? 'dark' : 'light';
  });
  handle('win:fullscreen', (on) => win?.setFullScreen(!!on));
  handle('win:isFullscreen', () => !!win?.isFullScreen());
  handle('win:pin', (on) => win?.setAlwaysOnTop(!!on, 'floating'));
  handle('app:open', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  handle('app:version', () => app.getVersion());
  handle('app:copy', (text) => import('electron').then(({ clipboard }) => clipboard.writeText(String(text))));
}

app.on('second-instance', (_e, argv) => {
  // Google's sign-in redirect arrives here as a premium link on the command line.
  const url = google.findUrl(argv);
  if (url) google.handleUrl(url);
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

app.whenReady().then(async () => {
  // Thumbnails and avatars: ask for the right referrer so i.ytimg / yt3 never refuse.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.ytimg.com/*', 'https://*.ggpht.com/*', 'https://*.googleusercontent.com/*'] },
    (details, cb) => {
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      cb({ requestHeaders: details.requestHeaders });
    }
  );
  google.init(app.getPath('userData'), (text) => send('google:progress', text));
  registerProxy();
  await registerIpc();
  streams.init(app.getPath('userData')).catch((e) => console.error('[streams:init]', e));
  createWindow();
  if (process.env.PREMIUM_SHOT) import('./devshots.js').then((m) => m.run(win, process.env.PREMIUM_SHOT)).catch((e) => console.error(e));
});

app.on('window-all-closed', () => { store.flush(); app.quit(); });
app.on('before-quit', () => store.flush());
