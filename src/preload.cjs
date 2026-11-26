// The only bridge between the page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

async function call(name, ...args) {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r || !r.ok) throw new Error(r?.error || 'Something went wrong');
  return r.data;
}

contextBridge.exposeInMainWorld('premium', {
  call,
  on(channel, fn) {
    const allowed = ['window:fullscreen', 'window:maximized'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform
});
