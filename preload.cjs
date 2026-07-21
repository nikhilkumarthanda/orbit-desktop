const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orbit", Object.freeze({
  policies: () => ipcRenderer.invoke("orbit:policies"),
  systemSnapshot: () => ipcRenderer.invoke("orbit:system"),
  recentWork: () => ipcRenderer.invoke("orbit:recent"),
  gitContext: () => ipcRenderer.invoke("orbit:git"),
  cleanupPlan: () => ipcRenderer.invoke("orbit:cleanup"),
  trash: paths => ipcRenderer.invoke("orbit:trash", paths),
  audit: () => ipcRenderer.invoke("orbit:audit"),
  indexKnowledge: () => ipcRenderer.invoke("orbit:knowledge:index"),
  searchKnowledge: query => ipcRenderer.invoke("orbit:knowledge:search", query),
  planCommand: command => ipcRenderer.invoke("orbit:command:plan", command),
  openPath: target => ipcRenderer.invoke("orbit:path:open", target),
  launchApplication: application => ipcRenderer.invoke("orbit:app:launch", application),
  startVoice: () => ipcRenderer.invoke("orbit:voice:start"),
  armVoice: () => ipcRenderer.invoke("orbit:voice:arm"),
  speak: text => ipcRenderer.invoke("orbit:voice:speak", text),
  onVoiceEvent: callback => { const listener = (_event, payload) => callback(payload); ipcRenderer.on("orbit:voice:event", listener); return () => ipcRenderer.removeListener("orbit:voice:event", listener); },
  onVoiceCommand: callback => { const listener = (_event, command) => callback(command); ipcRenderer.on("orbit:voice:command", listener); return () => ipcRenderer.removeListener("orbit:voice:command", listener); },
}));
