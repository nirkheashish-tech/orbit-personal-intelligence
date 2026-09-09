const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  getData: () => ipcRenderer.invoke('data:get'),
  saveData: data => ipcRenderer.invoke('data:save', data),
  getKeyStatus: provider => ipcRenderer.invoke('key:getStatus', provider),
  setApiKey: key => ipcRenderer.invoke('key:set', {provider:'openai', key}),
  setKey: args => ipcRenderer.invoke('key:set', args),
  getProvider: () => ipcRenderer.invoke('provider:get'),
  setProvider: cfg => ipcRenderer.invoke('provider:set', cfg),
  testProvider: cfg => ipcRenderer.invoke('provider:test', cfg),
  runAI: args => ipcRenderer.invoke('ai:run', args),
  openUrl: url => ipcRenderer.invoke('open:url', url)
});
