const { contextBridge, ipcRenderer } = require("electron");

let embeddedBrowserVisible = false;
let browserTaskRunning = false;
ipcRenderer.on("orbit:embedded-browser:state", (_event, payload) => {
  embeddedBrowserVisible = Boolean(payload?.visible);
});
ipcRenderer.on("orbit:browser:task:event", (_event, payload) => {
  browserTaskRunning = payload?.task?.status === "running";
});

function looksLikeBrowserFollowUp(value) {
  return /^(?:now\s+)?(?:search(?:\s+for)?\b|look\s+for\b|find\s+(?:on\s+)?(?:this|the)\s+page\b|open\s+(?:the\s+)?(?:(?:first|second|third|fourth|fifth|next|previous|last|\d+(?:st|nd|rd|th))\s+)?(?:result|link|article|repository|repo|release|issue|page)\b|click\b|select\b|choose\b|scroll\b|go\s+(?:back|forward)\b|back\b|forward\b|reload\b|refresh\b|summarize\s+(?:this|the)\s+page\b|read\s+(?:this|the)\s+page\b|what\b.*\bpage\b|tell\s+me\s+(?:what|when|where|which|who|how)\b|compare\b)/i.test(value.trim());
}

function normalizeOrbitCommand(command) {
  const value = String(command || "").trim();
  const browserAgent = value.match(/^(?:hey\s+)?orbit\s*[,;:\-]?\s*(?:please\s+)?(?:use\s+)?(?:your\s+|orbit(?:'s)?\s+)?(?:autonomous\s+|cloud\s+)?browser(?:\s+agent)?\s*[,;:\-]?\s*(?:to\s+)?(.+)$/i)
    || value.match(/^(?:please\s+)?(?:use\s+)?(?:your\s+|orbit(?:'s)?\s+)?(?:autonomous\s+|cloud\s+)?browser(?:\s+agent)?\s*[,;:\-]?\s*(?:to\s+)?(.+)$/i);
  if (browserAgent) return `browser agent to ${browserAgent[1].trim()}`;
  if (embeddedBrowserVisible && !browserTaskRunning && looksLikeBrowserFollowUp(value)) return `browser agent to ${value}`;
  return value;
}

function installLongCommandPreview() {
  const syncInput = input => {
    if (!(input instanceof HTMLInputElement)) return;
    const command = input.closest(".command:not(.knowledge-search)");
    if (!command) return;

    let preview = command.querySelector(":scope > .orbit-command-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "orbit-command-preview";
      preview.setAttribute("aria-live", "polite");
      preview.innerHTML = "<small>CURRENT REQUEST</small><p></p>";
      command.prepend(preview);
    }

    const value = String(input.value || "").trim();
    const show = value.length > 58;
    preview.hidden = !show;
    command.classList.toggle("has-prompt-preview", show);
    const text = preview.querySelector("p");
    if (text && text.textContent !== value) text.textContent = value;
  };

  const syncAll = () => {
    document.querySelectorAll(".command:not(.knowledge-search) input").forEach(syncInput);
  };

  const start = () => {
    syncAll();
    document.addEventListener("input", event => {
      if (event.target instanceof HTMLInputElement) syncInput(event.target);
    }, true);
    // React can update the controlled command value from voice events without a
    // native input event, so keep the preview synchronized with those updates too.
    window.setInterval(syncAll, 180);
  };

  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

installLongCommandPreview();

contextBridge.exposeInMainWorld("orbit", Object.freeze({
  policies: () => ipcRenderer.invoke("orbit:policies"),
  systemSnapshot: () => ipcRenderer.invoke("orbit:system"),
  recentWork: () => ipcRenderer.invoke("orbit:recent"),
  findFiles: query => ipcRenderer.invoke("orbit:files:find", query),
  gitContext: () => ipcRenderer.invoke("orbit:git"),
  cleanupPlan: () => ipcRenderer.invoke("orbit:cleanup"),
  trash: paths => ipcRenderer.invoke("orbit:trash", paths),
  audit: () => ipcRenderer.invoke("orbit:audit"),
  indexKnowledge: () => ipcRenderer.invoke("orbit:knowledge:index"),
  searchKnowledge: query => ipcRenderer.invoke("orbit:knowledge:search", query),
  planCommand: command => ipcRenderer.invoke("orbit:command:plan", normalizeOrbitCommand(command)),
  openPath: target => ipcRenderer.invoke("orbit:path:open", target),
  openFolder: folder => ipcRenderer.invoke("orbit:folder:open", folder),
  launchApplication: application => ipcRenderer.invoke("orbit:app:launch", application),
  macPermissions: () => ipcRenderer.invoke("orbit:mac:permissions"),
  macControl: request => ipcRenderer.invoke("orbit:mac:control", request),
  draftEmail: request => ipcRenderer.invoke("orbit:email:draft", request),
  rewriteEmail: request => ipcRenderer.invoke("orbit:email:rewrite", request),
  writingPreferences: () => ipcRenderer.invoke("orbit:writing-preferences:get"),
  saveWritingPreferences: preferences => ipcRenderer.invoke("orbit:writing-preferences:save", preferences),
  callContact: request => ipcRenderer.invoke("orbit:contact:call", request),
  showMainWindow: () => ipcRenderer.invoke("orbit:window:show-main"),
  setAssistantState: state => ipcRenderer.invoke("orbit:overlay:state", state),
  onAssistantState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on("orbit:overlay:state", listener); return () => ipcRenderer.removeListener("orbit:overlay:state", listener); },
  socialDraft: request => ipcRenderer.invoke("orbit:social:draft", request),
  socialPublish: provider => ipcRenderer.invoke("orbit:social:publish", provider),
  conversationHistory: () => ipcRenderer.invoke("orbit:conversation:list"),
  appendConversation: turn => ipcRenderer.invoke("orbit:conversation:append", turn),
  clearConversation: () => ipcRenderer.invoke("orbit:conversation:clear"),
  githubWorkflow: repository => ipcRenderer.invoke("orbit:github:workflow", repository),
  browserNavigate: request => ipcRenderer.invoke("orbit:browser:navigate", request),
  liveInfo: request => ipcRenderer.invoke("orbit:live:info", request),
  youtubePlay: query => ipcRenderer.invoke("orbit:browser:youtube", query),
  amazonSearch: request => ipcRenderer.invoke("orbit:browser:amazon", request),
  describePage: () => ipcRenderer.invoke("orbit:browser:describe"),
  summarizePage: () => ipcRenderer.invoke("orbit:browser:summarize"),
  findOnPage: query => ipcRenderer.invoke("orbit:browser:find", query),
  startBrowserTask: goal => ipcRenderer.invoke("orbit:browser:task:start", goal),
  resumeBrowserTask: confirmed => ipcRenderer.invoke("orbit:browser:task:resume", confirmed),
  cancelBrowserTask: () => ipcRenderer.invoke("orbit:browser:task:cancel"),
  browserTaskStatus: () => ipcRenderer.invoke("orbit:browser:task:status"),
  onBrowserTask: callback => { const listener = (_event, payload) => callback(payload); ipcRenderer.on("orbit:browser:task:event", listener); return () => ipcRenderer.removeListener("orbit:browser:task:event", listener); },
  onEmbeddedBrowserState: callback => { const listener = (_event, payload) => callback(payload); ipcRenderer.on("orbit:embedded-browser:state", listener); return () => ipcRenderer.removeListener("orbit:embedded-browser:state", listener); },
  research: query => ipcRenderer.invoke("orbit:web:research", query),
  onResearchProgress: callback => { const listener = (_event, progress) => callback(progress); ipcRenderer.on("orbit:web:progress", listener); return () => ipcRenderer.removeListener("orbit:web:progress", listener); },
  batteryStatus: () => ipcRenderer.invoke("orbit:system:battery"),
  describeScreen: query => ipcRenderer.invoke("orbit:screen:describe", query),
  takeScreenshot: () => ipcRenderer.invoke("orbit:screen:capture"),
  startVoice: () => ipcRenderer.invoke("orbit:voice:start"),
  stopVoice: () => ipcRenderer.invoke("orbit:voice:stop"),
  stopSpeaking: () => ipcRenderer.invoke("orbit:speech:stop"),
  armVoice: () => ipcRenderer.invoke("orbit:voice:arm"),
  speak: text => ipcRenderer.invoke("orbit:voice:speak", text),
  onVoiceEvent: callback => { const listener = (_event, payload) => callback(payload); ipcRenderer.on("orbit:voice:event", listener); return () => ipcRenderer.removeListener("orbit:voice:event", listener); },
  onVoiceCommand: callback => { const listener = (_event, command) => callback(command); ipcRenderer.on("orbit:voice:command", listener); return () => ipcRenderer.removeListener("orbit:voice:command", listener); },
  aiStatus: () => ipcRenderer.invoke("orbit:ai:status"),
  geminiStatus: () => ipcRenderer.invoke("orbit:gemini:status"),
  configureGemini: apiKey => ipcRenderer.invoke("orbit:gemini:configure", apiKey),
  setGeminiBudget: monthlyBudgetUsd => ipcRenderer.invoke("orbit:gemini:budget", monthlyBudgetUsd),
  orbitPlayStart: mode => ipcRenderer.invoke("orbit:play:start", mode),
  orbitPlayStop: () => ipcRenderer.invoke("orbit:play:stop"),
  orbitPlayAction: gesture => ipcRenderer.invoke("orbit:play:action", gesture),
}));