// Tater Talk - bridge between the window and the main program

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tater', {
  connect: (platform, name, opts) => ipcRenderer.invoke('platform-connect', platform, name, opts),
  twitchLogin: (clientId) => ipcRenderer.invoke('twitch-login', clientId),
  disconnect: (platform) => ipcRenderer.invoke('platform-disconnect', platform),
  pickSound: () => ipcRenderer.invoke('pick-sound'),
  importSoundFolder: () => ipcRenderer.invoke('import-sound-folder'),
  fishSearch: (options) => ipcRenderer.invoke('fish-search', options),
  fishSpeak: (options) => ipcRenderer.invoke('fish-tts', options),
  widgetInfo: () => ipcRenderer.invoke('widget-info'),
  widgetPush: (data) => ipcRenderer.send('widget-push', data),
  widgetSettings: (s) => ipcRenderer.send('widget-settings', s),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  onEvent: (callback) => ipcRenderer.on('stream-event', (e, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('stream-status', (e, data) => callback(data)),
  onTwitchFollows: (callback) => ipcRenderer.on('twitch-follows', (e, data) => callback(data))
});
