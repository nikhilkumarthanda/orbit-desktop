import { contextBridge, ipcRenderer } from "electron";
import type { OrbitAPI } from "../shared/contracts.js";

const api: OrbitAPI = {
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
  openPath: path => ipcRenderer.invoke("orbit:path:open", path),
  launchApplication: application => ipcRenderer.invoke("orbit:app:launch", application),
  githubWorkflow: repository => ipcRenderer.invoke("orbit:github:workflow", repository),
  browserNavigate: request => ipcRenderer.invoke("orbit:browser:navigate", request),
  liveWeather: () => ipcRenderer.invoke("orbit:live:weather"),
  liveNews: () => ipcRenderer.invoke("orbit:live:news"),
  liveCricket: () => ipcRenderer.invoke("orbit:live:cricket"),
  startVoice: () => ipcRenderer.invoke("orbit:voice:start"),
  stopVoice: () => ipcRenderer.invoke("orbit:voice:stop"),
  armVoice: () => ipcRenderer.invoke("orbit:voice:arm"),
  speak: text => ipcRenderer.invoke("orbit:voice:speak", text),
  onVoiceEvent: callback => { const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload); ipcRenderer.on("orbit:voice:event", listener); return () => ipcRenderer.removeListener("orbit:voice:event", listener); },
  onVoiceCommand: callback => { const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command); ipcRenderer.on("orbit:voice:command", listener); return () => ipcRenderer.removeListener("orbit:voice:command", listener); },
  aiStatus: () => ipcRenderer.invoke("orbit:ai:status"),
};
contextBridge.exposeInMainWorld("orbit", api);
