// Hidden PO-token window: lets the page fetch Google's BotGuard endpoints through the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('potBridge', {
  fetch: (url, init) => ipcRenderer.invoke('pot:fetch', url, init)
});
