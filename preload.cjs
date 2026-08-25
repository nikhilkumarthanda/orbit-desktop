const { contextBridge, ipcRenderer } = require("electron");

const BROWSER_PANE_STORAGE_KEY = "orbit-browser-agent-pane-width";
let embeddedBrowserVisible = false;
let embeddedBrowserState = null;
let browserTaskRunning = false;
let browserTaskState = null;
let panePreferenceApplied = false;

ipcRenderer.on("orbit:embedded-browser:state", (_event, payload) => {
  embeddedBrowserVisible = Boolean(payload?.visible);
  embeddedBrowserState = payload || null;
  renderOrbitBrowserChrome();
  syncBrowserRuntimePlanner();
});
ipcRenderer.on("orbit:browser:task:event", (_event, payload) => {
  browserTaskState = payload?.task || null;
  browserTaskRunning = ["running", "waiting_for_confirmation", "paused"].includes(browserTaskState?.status);
  renderOrbitBrowserChrome();
  syncBrowserRuntimePlanner();
});

function explicitlyRequestsExternalBrowser(value) {
  const text = String(value || "").trim();
  return /^(?:hey\s+orbit[,;:\s-]*)?(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:google\s+)?(?:chrome|safari|firefox|edge|brave)(?:\s+browser)?[.!?]*$/i.test(text)
    || /\b(?:use|using|with|through|in|via|open(?:\s+it|\s+this|\s+that)?\s+in)\s+(?:google\s+)?chrome\b|\b(?:use|using|with|through|in|via|open(?:\s+it|\s+this|\s+that)?\s+in)\s+safari\b|\b(?:use|using|with|through|in|via)\s+(?:firefox|edge|brave)\b/i.test(text);
}

function nativeApplicationRequest(value) {
  const text = String(value || "").trim();
  if (/^(?:hey\s+orbit[,;:\s-]*)?(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?calculator(?:\s+app)?[.!?]*$/i.test(text)) return "Calculator";
  return "";
}

function isBrowserContinueRequest(value) {
  return /^(?:hey\s+orbit[,;:\s-]*)?(?:please\s+)?(?:continue|resume|carry\s+on|keep\s+going|i(?:'m| am)\s+done|done|finished|completed|try\s+again)(?:\s+(?:the\s+)?(?:browser|task|workflow))?[.!?]*$/i.test(String(value || "").trim());
}

function isBrowserStopRequest(value) {
  return /^(?:hey\s+orbit[,;:\s-]*)?(?:please\s+)?(?:stop|cancel|end)(?:\s+(?:the\s+)?(?:browser|browser\s+task|task|workflow))[.!?]*$/i.test(String(value || "").trim());
}

function activeOrbitBrowserHost() {
  try { return new URL(String(embeddedBrowserState?.url || "")).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function youtubeCompoundBackSearch(value) {
  const text = String(value || "").trim();
  if (!text || explicitlyRequestsExternalBrowser(text)) return "";
  if (!/(?:^|\.)youtube\.com$/i.test(activeOrbitBrowserHost())) return "";
  const match = text.match(/^(?:now\s+)?(?:go\s+back|back)\s*(?:,?\s*(?:and|then)\s+)\s*(?:search(?:\s+for)?|find|look\s+up)\s+(.+?)\s*[.!?]*$/i);
  return match?.[1]?.trim() || "";
}

function contextualOrbitBrowserFollowUp(value) {
  const text = String(value || "").trim();
  if (!embeddedBrowserVisible || !text) return false;
  if (nativeApplicationRequest(text) || explicitlyRequestsExternalBrowser(text)) return false;
  const host = activeOrbitBrowserHost();
  if (!host) return false;
  if (/(?:^|\.)youtube\.com$/i.test(host)) {
    return /^(?:now\s+)?(?:open|play|search(?:\s+for)?|find|look\s+up)\b.+/i.test(text)
      || /^(?:now\s+)?(?:open|play)\s+(?:another|next)\b/i.test(text);
  }
  return /^(?:now\s+)?(?:open|search(?:\s+for)?|find|look\s+up|click|select|choose|scroll|go\s+(?:back|forward)|back|forward|reload|refresh|summarize|read|tell\s+me|what|which|who|when|where|how|compare)\b/i.test(text);
}

function contextualizeOrbitBrowserCommand(value) {
  const text = String(value || "").trim();
  const host = activeOrbitBrowserHost();
  if (/(?:^|\.)youtube\.com$/i.test(host)) {
    let match = text.match(/^(?:now\s+)?(?:open|play)\s+(.+?)\s*[.!?]*$/i);
    if (match && !/\byoutube\b/i.test(match[1])) return `play ${match[1].trim()} on YouTube`;
    match = text.match(/^(?:now\s+)?(?:search(?:\s+for)?|find|look\s+up)\s+(.+?)\s*[.!?]*$/i);
    if (match && !/\byoutube\b/i.test(match[1])) return `search YouTube for ${match[1].trim()}`;
  }
  return text;
}

function technicalSiteBrowserGoal(value) {
  const text = String(value || "").trim();
  if (!text || explicitlyRequestsExternalBrowser(text)) return "";
  const stack = /\bstack\s*over\s*flow\b/i.test(text);
  const mdn = /\b(?:mdn|mozilla\s+developer\s+network)\b/i.test(text);
  if (!stack && !mdn) return "";

  const search = text.match(/\b(?:search(?:\s+for)?|find|look\s+up)\s+(.+?)\s*[.!?]*$/i);
  if (stack) {
    if (search?.[1]) return `open https://stackoverflow.com/search?q=${encodeURIComponent(search[1].trim())}`;
    return "open https://stackoverflow.com";
  }
  if (search?.[1]) return `open https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(search[1].trim())}`;
  return "open https://developer.mozilla.org";
}

function youtubeOrdinalPlaybackCommand(value) {
  const text = String(value || "").trim();
  if (!text || explicitlyRequestsExternalBrowser(text)) return "";
  if (!/(?:^|\.)youtube\.com$/i.test(activeOrbitBrowserHost())) return "";
  const match = text.match(/^(?:go\s+back(?:\s*,?\s*(?:and\s+)?)?)?(?:open|play)\s+(?:the\s+)?(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s*(?:one|video|result)?[.!?]*$/i);
  if (!match) return "";
  return `play ${match[1].toLowerCase()} one on YouTube`;
}

function youtubePlaybackCommand(value) {
  const text = String(value || "").trim();
  if (!text || explicitlyRequestsExternalBrowser(text)) return "";
  const ordinal = youtubeOrdinalPlaybackCommand(text);
  if (ordinal) return ordinal;

  const explicitPlayback = text.match(/^(?:hey\s+orbit[,;:\s-]*)?(?:please\s+)?(?:open|play|watch)\s+(.+?)\s+(?:on\s+)?youtube\s*[.!?]*$/i);
  if (explicitPlayback?.[1]) return `play ${explicitPlayback[1].trim()} on YouTube`;

  if (/\byoutube\b/i.test(text) && /\bplay\b/i.test(text)) return text;
  if (/(?:^|\.)youtube\.com$/i.test(activeOrbitBrowserHost()) && contextualOrbitBrowserFollowUp(text)) {
    const contextual = contextualizeOrbitBrowserCommand(text);
    if (/\byoutube\b/i.test(contextual) && /\bplay\b/i.test(contextual)) return contextual;
  }
  return "";
}

function youtubePlaybackQuery(value) {
  return String(value || "")
    .trim()
    .replace(/^(?:hey\s+orbit[,;:\s-]*)?/i, "")
    .replace(/^(?:please\s+)?/i, "")
    .replace(/^(?:open|play|watch)\s+/i, "")
    .replace(/\s+(?:on\s+)?youtube\s*[.!?]*$/i, "")
    .trim();
}

function looksLikeCareerBrowserRequest(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const careerTarget = /\b(?:linkedin|jobright|greenhouse|lever|workday|career\s+site|job\s+site|jobs?|job\s+posting|role|application|recruiter|hiring\s+manager|outreach|connection\s+note|career\s+profile|application\s+profile)\b/i.test(text);
  const careerAction = /\b(?:open|visit|search|find|apply|inspect|review|analy[sz]e|autofill|fill|track|mark|save|draft|write|create|post|publish|message|connect|enhance|improve|update|switch|continue|submit)\b/i.test(text);
  return careerTarget && careerAction;
}

function looksLikeWebRequest(value) {
  const text = value.trim();
  if (!text) return false;
  return /\b(?:open|visit|browse|go\s+to|navigate\s+to|search|look\s+up|find\s+online|check\s+online|google)\b/i.test(text)
    && /\b(?:github|youtube|amazon|wikipedia|reddit|linkedin|jobright|greenhouse|lever|workday|stack\s*over\s*flow|stackoverflow|mdn|mozilla\s+developer\s+network|google|website|site|web|page|repository|repo|release|issue|article|result|link|job|application)\b|\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|app|co|edu)\b/i.test(text)
    || /\b(?:github|youtube|amazon|wikipedia|reddit|linkedin|jobright|greenhouse|lever|workday|stack\s*over\s*flow|stackoverflow|mdn|mozilla\s+developer\s+network)\b/i.test(text)
    || /\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|app|co|edu)\b/i.test(text);
}

function looksLikeBrowserFollowUp(value) {
  const text = value.trim();
  return /^(?:now\s+)?(?:search(?:\s+for)?\b|look\s+for\b|find\s+(?:on\s+)?(?:this|the)\s+page\b|open\s+(?:the\s+)?(?:(?:first|second|third|fourth|fifth|next|previous|last|\d+(?:st|nd|rd|th))\s+)?(?:result|link|article|repository|repo|release|releases|issue|issues|page|job|application)\b|apply\b|autofill\b|fill\s+(?:this|the)\s+(?:application|form)\b|inspect\s+(?:this|the)\s+(?:job|application|form)\b|click\b|select\b|choose\b|scroll\b|go\s+(?:back|forward)\b|back\b|forward\b|reload\b|refresh\b|summarize\s+(?:this|the)\s+page\b|read\s+(?:this|the)\s+page\b|what\b.*\bpage\b|tell\s+me\s+(?:what|when|where|which|who|how)\b|compare\b|switch\s+(?:back\s+)?to\b|close\s+(?:this|current|active|the)?\s*(?:orbit\s+browser\s+)?tab\b)/i.test(text)
    || /^(?:now\s+)?(?:tell\s+me|what(?:'s|\s+is|\s+are)?|which|who|when|where|how)\b.*\b(?:shown|visible|here|page|site|result|release|releases|issue|issues|repository|repo|article|link|job|application)\b/i.test(text);
}

function wantsNewOrbitTab(value) {
  const text = String(value || "").trim();
  return /\b(?:open|create|start|add|use)\b[^.?!]{0,50}\bnew\s+(?:orbit\s+browser\s+)?tab\b/i.test(text)
    || /\b(?:in|into)\s+(?:a\s+)?new\s+(?:orbit\s+browser\s+)?tab\b/i.test(text);
}

function enforceOrbitBrowserDefault(value, plan) {
  if (!plan || explicitlyRequestsExternalBrowser(value) || nativeApplicationRequest(value)) return plan;
  const application = String(plan.application || "").toLowerCase();
  const externalLaunch = plan.intent === "launch" && /(?:chrome|safari|firefox|edge|brave)/i.test(application);
  if (plan.intent === "browser" || externalLaunch) {
    const goal = plan.url ? `open ${plan.url}` : String(plan.query || value || "").trim();
    return {
      intent: "browser_task",
      confidence: Math.max(.99, Number(plan.confidence) || 0),
      explanation: "Orbit Browser is the default web surface unless an external browser is explicitly requested",
      query: goal || String(value || "").trim(),
      source: "local",
    };
  }
  return plan;
}

function normalizeOrbitCommand(command) {
  const value = String(command || "").trim();
  const browserAgent = value.match(/^(?:hey\s+)?orbit\s*[,;:\-]?\s*(?:please\s+)?(?:use\s+)?(?:your\s+|orbit(?:'s)?\s+)?(?:autonomous\s+|cloud\s+)?browser(?:\s+agent)?\s*[,;:\-]?\s*(?:to\s+)?(.+)$/i)
    || value.match(/^(?:please\s+)?(?:use\s+)?(?:your\s+|orbit(?:'s)?\s+)?(?:autonomous\s+|cloud\s+)?browser(?:\s+agent)?\s*[,;:\-]?\s*(?:to\s+)?(.+)$/i);
  if (browserAgent) return `browser agent to ${browserAgent[1].trim()}`;

  if (nativeApplicationRequest(value)) return value;
  if (explicitlyRequestsExternalBrowser(value)) return value;
  const technicalSite = technicalSiteBrowserGoal(value);
  if (technicalSite) return `browser agent to ${technicalSite}`;
  const playback = youtubePlaybackCommand(value);
  if (playback) return playback;
  const contextual = contextualOrbitBrowserFollowUp(value);
  if (looksLikeCareerBrowserRequest(value) || wantsNewOrbitTab(value) || looksLikeWebRequest(value) || contextual) return `browser agent to ${contextual ? contextualizeOrbitBrowserCommand(value) : value}`;
  if (embeddedBrowserVisible && looksLikeBrowserFollowUp(value)) return `browser agent to ${value}`;
  return value;
}

function waitingBrowserTaskPlan() {
  const input = browserTaskState?.pendingKind === "input";
  const paused = browserTaskState?.status === "paused";
  const detail = browserTaskState?.summary || (paused ? "Orbit has a resumable browser task paused at its last checkpoint." : input ? "Orbit needs information before it can continue." : "Orbit is waiting for approval before a consequential browser action.");
  return {
    intent: "answer",
    confidence: 1,
    explanation: "A resumable Orbit Browser task cannot be silently replaced",
    reply: paused
      ? `${detail} Say “continue” to re-inspect the current page and resume, or stop the browser task before starting another browser workflow.`
      : input
        ? `${detail} Type or say the answer in Orbit. If you completed a password, MFA, CAPTCHA, or other manual-only step directly on the site, say “continue”.`
        : `${detail} Approve that exact action or stop the browser task before starting something else.`,
    source: "local",
  };
}

function applyReturnedBrowserTask(task) {
  if (!task) return;
  browserTaskState = task;
  browserTaskRunning = ["running", "waiting_for_confirmation", "paused"].includes(task.status);
  renderOrbitBrowserChrome();
  syncBrowserRuntimePlanner();
}

async function planOrbitCommand(command) {
  const value = String(command || "").trim();

  if (browserTaskRunning && isBrowserStopRequest(value)) {
    const task = await ipcRenderer.invoke("orbit:browser:task:cancel").catch(() => null);
    applyReturnedBrowserTask(task);
    browserTaskRunning = false;
    return { intent: "answer", confidence: 1, explanation: "Explicit browser task stop matched", reply: "Stopped the current Orbit Browser task.", query: value, source: "local" };
  }

  if (browserTaskState?.status === "waiting_for_confirmation" && browserTaskState?.pendingKind === "input") {
    if (isBrowserContinueRequest(value)) {
      const task = await ipcRenderer.invoke("orbit:browser:task:continue").catch(() => null);
      applyReturnedBrowserTask(task);
      return { intent: "answer", confidence: 1, explanation: "Manual browser checkpoint resume matched", reply: task?.summary || "Re-inspecting the current page and continuing the browser task.", query: value, source: "local" };
    }
    const nativeApplication = nativeApplicationRequest(value);
    if (nativeApplication) {
      await ipcRenderer.invoke("orbit:app:launch", nativeApplication);
      return { intent: "answer", confidence: 1, explanation: "Native application opened without replacing the waiting browser checkpoint", reply: `Opened ${nativeApplication}. The Orbit Browser task is still waiting for your answer.`, query: value, source: "local" };
    }
    if (explicitlyRequestsExternalBrowser(value) || looksLikeWebRequest(value) || looksLikeBrowserFollowUp(value)) return waitingBrowserTaskPlan();
    const task = await ipcRenderer.invoke("orbit:browser:task:input", value).catch(() => null);
    applyReturnedBrowserTask(task);
    return { intent: "answer", confidence: 1, explanation: "Task-scoped browser input supplied", reply: task?.summary || "I recorded that answer for the paused browser task and re-inspected the current page.", query: value, source: "local" };
  }

  if (browserTaskState?.status === "waiting_for_confirmation") return waitingBrowserTaskPlan();

  if (browserTaskState?.status === "paused") {
    if (isBrowserContinueRequest(value)) {
      const task = await ipcRenderer.invoke("orbit:browser:task:continue").catch(() => null);
      applyReturnedBrowserTask(task);
      return { intent: "answer", confidence: 1, explanation: "Resumable browser checkpoint continued", reply: task?.summary || "Continuing from the last verified browser checkpoint.", query: value, source: "local" };
    }
    const nativeApplication = nativeApplicationRequest(value);
    if (nativeApplication) {
      await ipcRenderer.invoke("orbit:app:launch", nativeApplication);
      return { intent: "answer", confidence: 1, explanation: "Native application opened without replacing the paused browser checkpoint", reply: `Opened ${nativeApplication}. Your paused Orbit Browser checkpoint is still preserved.`, query: value, source: "local" };
    }
    return waitingBrowserTaskPlan();
  }

  const nativeApplication = nativeApplicationRequest(value);
  if (nativeApplication) {
    if (browserTaskState?.status === "running") {
      await ipcRenderer.invoke("orbit:browser:task:cancel").catch(() => null);
      browserTaskRunning = false;
      browserTaskState = null;
    }
    await ipcRenderer.invoke("orbit:app:launch", nativeApplication);
    return { intent: "answer", confidence: 1, explanation: "Native application shortcut matched before browser routing", reply: `Opened ${nativeApplication}.`, query: value, source: "local" };
  }

  const external = explicitlyRequestsExternalBrowser(value);
  const compoundYoutubeSearch = !external ? youtubeCompoundBackSearch(value) : "";
  if (compoundYoutubeSearch) {
    if (browserTaskState?.status === "running") {
      await ipcRenderer.invoke("orbit:browser:task:cancel").catch(() => null);
      browserTaskRunning = false;
      browserTaskState = null;
    }
    await ipcRenderer.invoke("orbit:embedded-browser:back").catch(() => null);
    return { intent: "browser_task", confidence: 1, explanation: "Compound YouTube back-and-search shortcut preserved both requested actions", query: `search YouTube for ${compoundYoutubeSearch}`, source: "local" };
  }
  const technicalSite = !external ? technicalSiteBrowserGoal(value) : "";
  if (technicalSite) {
    if (browserTaskState?.status === "running") {
      await ipcRenderer.invoke("orbit:browser:task:cancel").catch(() => null);
      browserTaskRunning = false;
      browserTaskState = null;
    }
    return { intent: "browser_task", confidence: 1, explanation: "Direct embedded technical-site routing matched before legacy browser planning", query: technicalSite, source: "local" };
  }
  const playback = !external ? youtubePlaybackCommand(value) : "";
  if (playback) {
    if (browserTaskState?.status === "running") {
      await ipcRenderer.invoke("orbit:browser:task:cancel").catch(() => null);
      browserTaskRunning = false;
      browserTaskState = null;
    }
    const query = youtubePlaybackQuery(playback);
    return { intent: "youtube_play", confidence: 1, explanation: "Direct embedded YouTube playback shortcut matched before browser-agent routing", query: query || playback, source: "local" };
  }
  const contextual = !external && contextualOrbitBrowserFollowUp(value);
  const browserFollowUp = !external && (looksLikeCareerBrowserRequest(value) || wantsNewOrbitTab(value) || looksLikeWebRequest(value) || contextual || (embeddedBrowserVisible && looksLikeBrowserFollowUp(value)));

  if (browserFollowUp && browserTaskState?.status === "running") {
    await ipcRenderer.invoke("orbit:browser:task:cancel").catch(() => null);
    browserTaskRunning = false;
    browserTaskState = null;
  }

  const planned = await ipcRenderer.invoke("orbit:command:plan", normalizeOrbitCommand(value));
  return enforceOrbitBrowserDefault(value, planned);
}

function browserHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, "") || "New tab"; }
  catch { return "New tab"; }
}

function clampPaneWidth(value) {
  return Math.max(300, Math.min(720, Math.round(Number(value) || 410)));
}

function storedPaneWidth() {
  try {
    const value = Number(window.localStorage.getItem(BROWSER_PANE_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clampPaneWidth(value) : null;
  } catch { return null; }
}

function applyStoredPaneWidth() {
  if (panePreferenceApplied) return;
  panePreferenceApplied = true;
  const saved = storedPaneWidth();
  if (saved) void ipcRenderer.invoke("orbit:embedded-browser:pane:set", saved).catch(() => null);
}

function syncBrowserRuntimePlanner() {
  const apply = () => {
    const node = document.querySelector(".browser-runtime-bar .browser-runtime-planner");
    if (!node || !browserTaskState?.planner) return;
    const planner = browserTaskState.planner;
    node.textContent = planner === "native" ? "NATIVE" : planner === "ollama" ? "LOCAL OLLAMA" : "GEMINI";
    node.classList.toggle("local", planner === "ollama" || planner === "native");
    node.classList.toggle("native", planner === "native");
  };
  if (document.readyState === "loading") return;
  window.requestAnimationFrame(() => { apply(); window.setTimeout(apply, 0); });
}

function installOrbitBrowserChrome() {
  if (document.getElementById("orbit-browser-chrome-style")) return;
  const style = document.createElement("style");
  style.id = "orbit-browser-chrome-style";
  style.textContent = `
#orbit-browser-chrome{position:fixed;z-index:2147482000;top:10px;left:calc(276px + var(--orbit-agent-pane-width,460px) + 12px);right:12px;height:94px;display:none;grid-template-rows:42px 42px;gap:4px;padding:5px 7px;border:1px solid rgba(155,124,255,.24);border-radius:15px;background:linear-gradient(180deg,rgba(15,17,25,.98),rgba(8,10,16,.97));box-shadow:0 16px 46px rgba(0,0,0,.48),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(20px);color:#e9ebf3;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:auto}
#orbit-browser-chrome *{box-sizing:border-box}
#orbit-browser-divider{position:fixed;z-index:2147482500;top:108px;bottom:12px;left:calc(276px + var(--orbit-agent-pane-width,460px) + 6px);width:12px;transform:translateX(-50%);display:none;cursor:col-resize;touch-action:none;user-select:none}
#orbit-browser-divider::before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;border-radius:999px;background:rgba(155,124,255,.22);box-shadow:0 0 0 1px rgba(255,255,255,.025);transition:background .16s,box-shadow .16s}
#orbit-browser-divider:hover::before,#orbit-browser-divider.dragging::before{background:#9b7cff;box-shadow:0 0 14px rgba(155,124,255,.75)}
.orbit-browser-tab-row{display:flex;align-items:center;gap:5px;min-width:0}.orbit-browser-wordmark{display:flex;align-items:center;gap:7px;flex:none;padding:0 6px 0 2px}.orbit-browser-wordmark i{width:23px;height:23px;border-radius:8px;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,#fff,#a893ff 16%,#5640d0 58%,#16102e);box-shadow:0 0 18px rgba(126,96,255,.55);font:800 10px/1 sans-serif;font-style:normal}.orbit-browser-wordmark span{display:grid;line-height:1.05}.orbit-browser-wordmark b{font-size:9px;letter-spacing:.12em}.orbit-browser-wordmark small{font-size:7px;color:#666e82;letter-spacing:.08em}
.orbit-browser-tabs{display:flex;align-items:center;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:none;flex:1}.orbit-browser-tabs::-webkit-scrollbar{display:none}.orbit-browser-tab{display:flex;align-items:center;min-width:120px;max-width:190px;height:31px;border:1px solid transparent;border-radius:9px;background:#11141d;overflow:hidden;flex:0 1 180px}.orbit-browser-tab.active{border-color:rgba(155,124,255,.42);background:linear-gradient(180deg,#201a37,#151522);box-shadow:inset 0 1px rgba(255,255,255,.05)}.orbit-browser-tab>button:first-child{min-width:0;flex:1;height:100%;border:0;background:transparent;color:#858da0;padding:0 8px;text-align:left;cursor:pointer;display:grid;align-content:center;gap:1px}.orbit-browser-tab.active>button:first-child{color:#f1efff}.orbit-browser-tab b{font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}.orbit-browser-tab small{font-size:7px;color:#60687a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.orbit-browser-tab .orbit-tab-close{width:26px;height:100%;border:0;background:transparent;color:#687084;cursor:pointer;font-size:13px}.orbit-browser-tab .orbit-tab-close:hover{color:white;background:#ffffff0a}.orbit-browser-new-tab{width:29px;height:29px;flex:none;border:1px solid #ffffff0e;border-radius:9px;background:#11141c;color:#a9b0c1;cursor:pointer;font-size:17px;line-height:1}.orbit-browser-new-tab:hover{border-color:rgba(155,124,255,.35);color:white;background:#191629}
.orbit-browser-focus{display:flex;align-items:center;gap:3px;flex:none}.orbit-browser-focus button{height:27px;border:1px solid #ffffff0e;border-radius:8px;background:#0e1118;color:#858da0;padding:0 7px;font-size:6px;font-weight:800;letter-spacing:.07em;cursor:pointer;white-space:nowrap}.orbit-browser-focus button:hover{border-color:rgba(155,124,255,.35);color:#f4f0ff;background:#171525}
.orbit-browser-nav{display:grid;grid-template-columns:auto auto auto minmax(80px,1fr) auto;gap:5px;align-items:center}.orbit-browser-nav>button{width:30px;height:30px;border:1px solid #ffffff0d;border-radius:9px;background:#0e1118;color:#7e8799;cursor:pointer;font-size:13px}.orbit-browser-nav>button:hover:not(:disabled){border-color:rgba(155,124,255,.3);color:white;background:#171525}.orbit-browser-nav>button:disabled{opacity:.3;cursor:default}.orbit-browser-address{height:30px;display:flex;align-items:center;gap:7px;min-width:0;padding:0 10px;border:1px solid #ffffff0d;border-radius:10px;background:#090c12;color:#8d95a7}.orbit-browser-address i{width:6px;height:6px;border-radius:50%;background:#59d794;box-shadow:0 0 9px #59d794;flex:none}.orbit-browser-address.loading i{background:#9b7cff;box-shadow:0 0 10px #9b7cff;animation:orbit-browser-pulse .8s infinite}.orbit-browser-address span{font-size:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.orbit-browser-agent,.orbit-browser-input-required{height:27px;display:flex;align-items:center;gap:5px;padding:0 8px;border:1px solid rgba(155,124,255,.2);border-radius:999px;background:#151221;color:#a99bf0;font-size:7px;font-weight:800;letter-spacing:.08em;white-space:nowrap}.orbit-browser-agent i{width:5px;height:5px;border-radius:50%;background:#9b7cff;box-shadow:0 0 8px #9b7cff}.orbit-browser-input-required{border-color:rgba(255,188,92,.4);background:rgba(138,85,22,.2);color:#ffd99a;cursor:pointer}.orbit-browser-input-required:hover{border-color:rgba(255,188,92,.7);background:rgba(138,85,22,.32);color:#fff0d1}.orbit-browser-nav>.orbit-browser-approve,.orbit-browser-nav>.orbit-browser-continue{width:auto;min-width:92px;height:29px;padding:0 10px;font-size:7px;font-weight:850;letter-spacing:.08em;white-space:nowrap}.orbit-browser-nav>.orbit-browser-approve{border-color:rgba(96,224,157,.42);background:rgba(36,126,81,.22);color:#9ff0c4}.orbit-browser-nav>.orbit-browser-approve:hover{border-color:rgba(96,224,157,.72);background:rgba(36,126,81,.34);color:#d9ffe9}.orbit-browser-nav>.orbit-browser-continue{border-color:rgba(155,124,255,.42);background:rgba(78,56,151,.25);color:#c8bdff}.orbit-browser-nav>.orbit-browser-continue:hover{border-color:rgba(155,124,255,.72);background:rgba(78,56,151,.4);color:#fff}@keyframes orbit-browser-pulse{50%{opacity:.35}}
@media(max-width:1100px){#orbit-browser-chrome{left:calc(276px + var(--orbit-agent-pane-width,390px) + 8px);right:8px}#orbit-browser-divider{left:calc(276px + var(--orbit-agent-pane-width,390px) + 4px)}.orbit-browser-wordmark span{display:none}.orbit-browser-tab{min-width:95px}.orbit-browser-agent{display:none}.orbit-browser-focus button{padding:0 5px;font-size:0}.orbit-browser-focus button::first-letter{font-size:7px}.orbit-browser-nav{grid-template-columns:auto auto auto minmax(70px,1fr)}}`;
  document.documentElement.appendChild(style);

  const root = document.createElement("div");
  root.id = "orbit-browser-chrome";
  root.setAttribute("aria-label", "Orbit Browser controls");

  const divider = document.createElement("div");
  divider.id = "orbit-browser-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", "Resize Orbit and Browser panes");
  divider.setAttribute("aria-orientation", "vertical");
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const cssWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--orbit-agent-pane-width"));
    const startWidth = Number.isFinite(cssWidth) ? cssWidth : storedPaneWidth() || 410;
    let pendingWidth = clampPaneWidth(startWidth);
    let frame = 0;
    const flush = () => {
      frame = 0;
      const next = clampPaneWidth(pendingWidth);
      document.documentElement.style.setProperty("--orbit-agent-pane-width", `${next}px`);
      try { window.localStorage.setItem(BROWSER_PANE_STORAGE_KEY, String(next)); } catch {}
      void ipcRenderer.invoke("orbit:embedded-browser:pane:set", next).catch(() => null);
    };
    const move = moveEvent => {
      pendingWidth = startWidth + moveEvent.clientX - startX;
      if (!frame) frame = window.requestAnimationFrame(flush);
    };
    const finish = () => {
      if (frame) { window.cancelAnimationFrame(frame); flush(); }
      divider.classList.remove("dragging");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
    };
    divider.classList.add("dragging");
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  });

  document.body.append(root, divider);
}

function button(text, title, handler, disabled = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.title = title;
  node.disabled = disabled;
  node.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    void handler();
  });
  return node;
}

function focusOrbitCommandInput() {
  const input = document.querySelector(".command:not(.knowledge-search) input");
  if (input && typeof input.focus === "function") {
    input.focus();
    return true;
  }
  void ipcRenderer.invoke("orbit:embedded-browser:focus:orbit").catch(() => null);
  return false;
}

function renderOrbitBrowserChrome() {
  const start = () => {
    installOrbitBrowserChrome();
    const root = document.getElementById("orbit-browser-chrome");
    const divider = document.getElementById("orbit-browser-divider");
    if (!root) return;
    const state = embeddedBrowserState;
    root.style.display = state?.visible ? "grid" : "none";
    if (divider) divider.style.display = state?.visible ? "block" : "none";
    if (!state?.visible) return;
    applyStoredPaneWidth();

    root.replaceChildren();
    const tabRow = document.createElement("div");
    tabRow.className = "orbit-browser-tab-row";
    const wordmark = document.createElement("div");
    wordmark.className = "orbit-browser-wordmark";
    const orb = document.createElement("i"); orb.textContent = "O";
    const words = document.createElement("span");
    const name = document.createElement("b"); name.textContent = "ORBIT BROWSER";
    const local = document.createElement("small"); local.textContent = "ISOLATED SESSION";
    words.append(name, local); wordmark.append(orb, words); tabRow.appendChild(wordmark);

    const tabs = document.createElement("div");
    tabs.className = "orbit-browser-tabs";
    for (const item of Array.isArray(state.tabs) ? state.tabs : []) {
      const shell = document.createElement("div");
      shell.className = `orbit-browser-tab${item.id === state.activeTabId ? " active" : ""}`;
      const select = document.createElement("button");
      select.type = "button";
      const title = document.createElement("b"); title.textContent = item.title || browserHost(item.url);
      const domain = document.createElement("small"); domain.textContent = browserHost(item.url);
      select.append(title, domain);
      select.addEventListener("click", () => void ipcRenderer.invoke("orbit:embedded-browser:tab:switch", item.id));
      const close = button("×", "Close tab", () => ipcRenderer.invoke("orbit:embedded-browser:tab:close", item.id));
      close.className = "orbit-tab-close";
      shell.append(select, close);
      tabs.appendChild(shell);
    }
    tabRow.appendChild(tabs);
    const add = button("+", "New Orbit Browser tab", () => ipcRenderer.invoke("orbit:embedded-browser:tab:new"));
    add.className = "orbit-browser-new-tab";
    tabRow.appendChild(add);

    const focus = document.createElement("div");
    focus.className = "orbit-browser-focus";
    focus.append(
      button("FOCUS ORBIT", "Focus Orbit assistant pane", () => ipcRenderer.invoke("orbit:embedded-browser:focus:orbit")),
      button("FOCUS BROWSER", "Focus active Orbit Browser tab", () => ipcRenderer.invoke("orbit:embedded-browser:focus:browser")),
    );
    tabRow.appendChild(focus);

    const nav = document.createElement("div");
    nav.className = "orbit-browser-nav";
    nav.append(
      button("‹", "Back", () => ipcRenderer.invoke("orbit:embedded-browser:back"), !state.canGoBack),
      button("›", "Forward", () => ipcRenderer.invoke("orbit:embedded-browser:forward"), !state.canGoForward),
      button("↻", "Reload", () => ipcRenderer.invoke("orbit:embedded-browser:reload")),
    );
    const address = document.createElement("div");
    address.className = `orbit-browser-address${state.loading ? " loading" : ""}`;
    const live = document.createElement("i");
    const url = document.createElement("span");
    url.textContent = state.url || "New Orbit tab";
    address.append(live, url);
    nav.appendChild(address);

    if (browserTaskState?.status === "waiting_for_confirmation") {
      const pending = browserTaskState.pendingAction?.label || browserTaskState.pendingAction?.reason || browserTaskState.summary || "the next browser step";
      if (browserTaskState.pendingKind === "input") {
        const input = button("INPUT REQUIRED", "Type or say your answer in Orbit. For password/MFA/CAPTCHA, complete it manually on the site and say continue.", () => {
          void ipcRenderer.invoke("orbit:embedded-browser:focus:orbit").catch(() => null);
          window.setTimeout(focusOrbitCommandInput, 40);
        });
        input.className = "orbit-browser-input-required";
        input.title = `${browserTaskState.summary || pending}\n\nType or say the answer in Orbit. For manual-only secrets/codes/CAPTCHA, complete the site yourself and say “continue”.`;
        nav.appendChild(input);
      } else {
        const approve = button("APPROVE NEXT", `Approve: ${pending}`, async () => {
          if (!window.confirm(`Approve only this next Orbit Browser action?\n\n${pending}`)) return;
          const task = await ipcRenderer.invoke("orbit:browser:task:resume", true);
          applyReturnedBrowserTask(task);
        });
        approve.className = "orbit-browser-approve";
        nav.appendChild(approve);
      }
    } else if (browserTaskState?.status === "paused") {
      const resume = button("CONTINUE", browserTaskState.summary || "Resume from the last verified browser checkpoint", async () => {
        const task = await ipcRenderer.invoke("orbit:browser:task:continue").catch(() => null);
        applyReturnedBrowserTask(task);
      });
      resume.className = "orbit-browser-continue";
      nav.appendChild(resume);
    } else {
      const agent = document.createElement("div");
      agent.className = "orbit-browser-agent";
      const agentDot = document.createElement("i");
      const agentLabel = document.createElement("span");
      agentLabel.textContent = browserTaskState?.planner === "native"
        ? "NATIVE CONTROLS ACTIVE"
        : browserTaskState?.planner === "ollama"
          ? "LOCAL OLLAMA ACTIVE"
          : browserTaskState?.planner === "gemini"
            ? "GEMINI AGENT ACTIVE"
            : "AGENT CONTROLS ACTIVE TAB";
      agent.append(agentDot, agentLabel);
      nav.appendChild(agent);
    }
    root.append(tabRow, nav);
    syncBrowserRuntimePlanner();
  };

  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

function installLongCommandPreview() {
  const isCommandInput = input => Boolean(input && input.tagName === "INPUT" && input.closest?.(".command:not(.knowledge-search)"));
  const syncInput = input => {
    if (!isCommandInput(input)) return;
    const command = input.closest(".command:not(.knowledge-search)");
    if (!command) return;

    let preview = command.querySelector(":scope > .orbit-command-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "orbit-command-preview";
      preview.setAttribute("aria-live", "polite");
      preview.innerHTML = "<small>FULL REQUEST</small><p></p>";
      preview.addEventListener("click", () => input.focus());
      command.prepend(preview);
    }

    const value = String(input.value || "").trim();
    const show = value.length > 34 || value.includes("\n");
    preview.hidden = !show;
    command.classList.toggle("has-prompt-preview", show);
    const text = preview.querySelector("p");
    if (text && text.textContent !== value) text.textContent = value;
  };

  const syncAll = () => document.querySelectorAll(".command:not(.knowledge-search) input").forEach(syncInput);
  const start = () => {
    syncAll();
    document.addEventListener("input", event => {
      const target = event.target;
      if (isCommandInput(target)) syncInput(target);
    }, true);
    window.setInterval(syncAll, 120);
  };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

installLongCommandPreview();
renderOrbitBrowserChrome();

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
  planCommand: command => planOrbitCommand(command),
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
  submitBrowserTaskInput: answer => ipcRenderer.invoke("orbit:browser:task:input", answer),
  continueBrowserTask: () => ipcRenderer.invoke("orbit:browser:task:continue"),
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