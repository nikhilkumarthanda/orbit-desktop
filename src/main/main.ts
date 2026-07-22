import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from "electron";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import updater from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore } from "./audit.js";
import { policies, policy } from "./policy.js";
import { cleanupPlan, gitContexts, recentWork, systemSnapshot } from "./tools.js";
import { answerWithOllama, ollamaStatus, OLLAMA_MODEL, planWithOllama } from "./ollama.js";
import type { CommandPlan, ConversationTurn, GitHubWorkflowStatus, LiveBrief, ResearchAnswer, ResearchSource } from "../shared/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let audit: AuditStore;
let mainWindow: BrowserWindow | null = null;
let speechProcess: ChildProcessWithoutNullStreams | null = null;
const { autoUpdater } = updater;
const conversation: ConversationTurn[] = [];
let lastFailureDetail = "";
let selectedVoice: string | null = null;
let activeBrowserSite: { name: string; hostname: string } | null = null;
let locationRequest: { resolve: (value: { latitude: number; longitude: number }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

function orbitVoice() {
  if (selectedVoice) return selectedVoice;
  const voices = spawnSync("/usr/bin/say", ["-v", "?"], { encoding: "utf8" }).stdout || "";
  selectedVoice = ["Ava", "Samantha", "Daniel"].find(name => new RegExp(`^${name}\\s`, "m").test(voices)) || "Daniel";
  return selectedVoice;
}

function naturalSpeech(text: string) {
  return text
    .replace(/https?:\/\/\S+/gi, "the link")
    .replace(/[{}\[\]<>_*`|]/g, " ")
    .replace(/\b(?:Error|Exception):?\s*/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([.!?])\s*/g, "$1 ")
    .trim();
}

async function installedApplications() {
  if (process.platform !== "darwin") return ["Google Chrome", "Visual Studio Code"];
  const roots = ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")];
  const names = new Set<string>(["Finder", "Terminal", "Safari"]);
  for (const root of roots) {
    try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && entry.name.endsWith(".app")) names.add(entry.name.slice(0, -4)); } catch {}
  }
  return [...names].sort().slice(0, 160);
}

function speak(text: string, protectListener = true) {
  if (process.platform !== "darwin") return;
  const raw = naturalSpeech(String(text).slice(0, 470));
  if (!raw) return;
  const spoken = /\bboss\b/i.test(raw) ? raw : `Boss, ${raw}`;
  if (protectListener && speechProcess?.stdin.writable) speechProcess.stdin.write("pause\n");
  const child = spawn("/usr/bin/say", ["-v", orbitVoice(), "-r", "158", spoken], { stdio: "ignore" });
  if (protectListener) child.once("exit", () => setTimeout(() => {
    if (speechProcess?.stdin.writable) speechProcess.stdin.write("followup\n");
  }, 450));
}

function sendVoice(type: string, payload: Record<string, unknown> = {}) {
  mainWindow?.webContents.send("orbit:voice:event", { type, ...payload });
}

function showListening() {
  mainWindow?.show(); mainWindow?.focus();
  sendVoice("wake");
  speak("Yes, boss?", false);
}

function stopSpeech() {
  if (speechProcess) { speechProcess.kill(); speechProcess = null; }
  sendVoice("stopped", { message: "Microphone off" });
}

function armVoice() {
  if (!speechProcess) startSpeech();
  if (speechProcess) speechProcess.stdin.write("arm\n");
  else { showListening(); sendVoice("unavailable", { message: "Native speech helper is not available" }); }
}

function startSpeech() {
  if (process.platform !== "darwin" || speechProcess) return;
  const bundled = path.join(process.resourcesPath, "sidecar", "orbit-speech");
  const development = path.join(app.getAppPath(), "release-sidecar", "orbit-speech");
  const binary = existsSync(bundled) ? bundled : development;
  if (!existsSync(binary)) { sendVoice("unavailable", { message: "Native speech helper is not included in this development build" }); return; }
  speechProcess = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  speechProcess.stdout.on("data", chunk => {
    buffered += String(chunk);
    const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "location" && locationRequest) {
          clearTimeout(locationRequest.timer);
          locationRequest.resolve({ latitude: Number(event.latitude), longitude: Number(event.longitude) });
          locationRequest = null;
          continue;
        }
        if (event.type === "locationError" && locationRequest) {
          clearTimeout(locationRequest.timer);
          locationRequest.reject(new Error(String(event.message || "Location is unavailable")));
          locationRequest = null;
          continue;
        }
        sendVoice(event.type, event);
        if (event.type === "wake") showListening();
        if (event.type === "command" && event.text) mainWindow?.webContents.send("orbit:voice:command", String(event.text));
      } catch { sendVoice("error", { message: "Speech helper returned invalid data" }); }
    }
  });
  speechProcess.stderr.on("data", chunk => sendVoice("error", { message: String(chunk).trim() }));
  speechProcess.on("close", () => { speechProcess = null; sendVoice("stopped"); });
}

function retrieve(request: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const script = path.join(app.getAppPath(), "sidecar", "retrieval.py");
    const bundled = path.join(process.resourcesPath, "sidecar", process.platform === "win32" ? "orbit-retrieval.exe" : "orbit-retrieval");
    const child = existsSync(bundled) ? spawn(bundled, [], { stdio: ["pipe", "pipe", "pipe"] }) : spawn("python3", [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(stderr || `Retrieval process exited with ${code}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid retrieval response")); } }
    });
    child.stdin.end(JSON.stringify({ ...request, db_path: path.join(app.getPath("userData"), "knowledge.db") }));
  });
}

function planLocal(value: string): CommandPlan {
  const command = value.trim().toLowerCase().replace(/\b(?:git|get)\s+hub\b/g, "github").replace(/\bgethub\b/g, "github");
  if (/\b(brief|explain|tell me more|what happened)\b/.test(command) && lastFailureDetail) return { intent: "answer", confidence: 1, explanation: "Previous error briefing", reply: `Boss, the previous operation failed because ${lastFailureDetail}. I can retry when you're ready.`, query: value, source: "local" };
  if (/^(hi|hello|hey|good (morning|afternoon|evening))( orbit)?[!.?]*$/.test(command)) return { intent: "answer", confidence: 1, explanation: "Local greeting matched", reply: "Yes, boss? At your service.", query: value, source: "local" };
  if (/\b(how are you|how is it going|you good)\b/.test(command)) return { intent: "answer", confidence: 1, explanation: "Local conversation matched", reply: "Running smoothly, boss. What can I do for you?", query: value, source: "local" };
  if (/\b(notifications?|notification center|alerts?)\b/.test(command)) return { intent: "notifications", confidence: 1, explanation: "Mac notification request matched", reply: "I can’t read Notification Center yet, boss. I won’t substitute news headlines for your notifications.", query: value, source: "local" };
  if (/^(?:what(?:'s| is| are)?|any|give me|tell me)(?: the)? (?:new )?updates?[?.!]*$/.test(command)) return { intent: "clarify", confidence: 1, explanation: "Update topic is ambiguous", reply: "Which updates do you mean, boss—your notifications, news, weather, cricket, GitHub, or something else?", query: value, source: "local" };
  if (/\b(weather|temperature|forecast)\b/.test(command)) return { intent: "weather", confidence: 1, explanation: "Live weather request matched", query: value, source: "local" };
  if (/\b(cricket|ipl|test match)\b.*\b(score|scores|result|match|update|live)\b|\b(score|scores)\b.*\b(cricket|ipl)\b/.test(command)) return { intent: "cricket", confidence: 1, explanation: "Live cricket request matched", query: value, source: "local" };
  if (/\b(news|headlines|top stories|world update)\b/.test(command)) return { intent: "news", confidence: 1, explanation: "Live news request matched", query: value, source: "local" };
  if (/\bgithub\b/.test(command) && /\b(workflow|actions?|deploy|build|status|complete|check|see)\b/.test(command)) return { intent: "github", confidence: .99, explanation: "GitHub workflow request matched", repository: "nikhilkumarthanda/orbit-desktop", query: value, source: "local" };
  if (/\b(open|visit|go to|navigate|search|look up|youtube|tesla|github|website|web site|\.com)\b/.test(command)) {
    const sameTab = /\b(?:same|current|this|active)\s+(?:youtube\s+)?tab\b/.test(command);
    const search = command.match(/(?:search|look up)(?:\s+(?:google|youtube))?\s+(?:for\s+)?(.+)/)?.[1]?.trim();
    const url = search && /\byoutube\b/.test(command) ? `https://www.youtube.com/results?search_query=${encodeURIComponent(search)}`
      : search && /\bgoogle\b/.test(command) ? `https://www.google.com/search?q=${encodeURIComponent(search)}`
      : /\byoutube\b/.test(command) ? "https://www.youtube.com"
      : /\btesla\b/.test(command) ? "https://www.tesla.com"
      : /\bgithub\b/.test(command) ? "https://github.com"
      : command.match(/\b([a-z0-9-]+\.(?:com|org|net|io|ai|dev))\b/) ? `https://${command.match(/\b([a-z0-9-]+\.(?:com|org|net|io|ai|dev))\b/)?.[1]}` : "";
    return { intent: "browser", confidence: .96, explanation: "Browser navigation request matched", url, query: url ? "" : (search || value), sameTab, source: "local" };
  }
  if (/\b(who|what|when|where|why|how|which|compare|explain|recommend|tell me about|is|are|can|could|should|will)\b/.test(command) || command.endsWith("?")) return { intent: "research", confidence: .9, explanation: "Knowledge question matched", query: value, source: "local" };
  const rules: [CommandPlan["intent"], RegExp, string][] = [
    ["launch", /\b(open|launch|start)\b.*\b(chrome|safari|finder|terminal|code|visual studio code)\b/, "Allowlisted application launch matched"],
    ["system", /\b(cpu|memory|ram|slow|battery|process|system|storage)\b/, "System diagnostics keywords matched"],
    ["git", /\b(git|repo|repository|branch|commit|code)\b/, "Developer context keywords matched"],
    ["cleanup", /\b(clean|cleanup|delete|large|space|downloads)\b/, "Storage cleanup keywords matched"],
    ["audit", /\b(audit|history|actions|privacy|permission)\b/, "Audit keywords matched"],
    ["recent", /\b(recent|resume|working|yesterday|last file)\b/, "Recent-work keywords matched"],
    ["knowledge", /\b(find|search|document|notes?|mention|knowledge|where)\b/, "Knowledge retrieval keywords matched"],
  ];
  const match = rules.find(([, pattern]) => pattern.test(command));
  if (match?.[0] === "launch") {
    const application = command.includes("chrome") ? "Google Chrome" : command.includes("safari") ? "Safari" : command.includes("finder") ? "Finder" : command.includes("terminal") ? "Terminal" : "Visual Studio Code";
    return { intent: "launch", confidence: .96, explanation: match[2], query: value, application, source: "local" as const };
  }
  return match ? { intent: match[0], confidence: .88, explanation: match[2], query: value, source: "local" as const } : { intent: "unknown", confidence: .2, explanation: "No safe workflow matched", query: value, source: "local" as const };
}

async function planCommand(value: string) {
  const local = planLocal(value);
  if (["answer", "clarify", "notifications", "research", "browser", "github", "weather", "news", "cricket"].includes(local.intent)) return local;
  const status = await ollamaStatus();
  if (!status.available) return local;
  try {
    const applications = await installedApplications();
    const plan = await planWithOllama({ command: value, history: conversation, installedApplications: applications });
    if (plan.intent === "launch" && (!plan.application || !applications.includes(plan.application))) return { intent: "clarify" as const, confidence: 1, explanation: "Application is not installed", reply: `I couldn't find ${plan.application || "that application"} on this Mac.`, query: value, source: "ollama" as const, model: OLLAMA_MODEL };
    conversation.push({ role: "user", content: value }, { role: "assistant", content: plan.reply || plan.explanation });
    if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
    return plan;
  } catch (error) {
    if (local.intent !== "unknown") return { ...local, reply: "Local AI is unavailable, so I'm handling that command with Orbit's offline planner." };
    const detail = error instanceof Error ? error.message : "an unknown local inference error occurred";
    lastFailureDetail = detail.includes("structured") ? "Ollama returned a response Orbit could not safely interpret" : detail.includes("timeout") ? "the local model took too long to respond" : "the local Ollama model could not complete the request";
    return { intent: "clarify", confidence: 1, explanation: "Local model unavailable", reply: "Boss, there’s an error with Ollama. Would you like me to brief you?", query: value, source: "local" };
  }
}

async function githubWorkflow(repository = "nikhilkumarthanda/orbit-desktop"): Promise<GitHubWorkflowStatus> {
  const safe = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : "nikhilkumarthanda/orbit-desktop";
  const url = `https://github.com/${safe}/actions`;
  const response = await fetch(`https://api.github.com/repos/${safe}/actions/runs?per_page=1`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Orbit-Desktop" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GitHub returned status ${response.status}`);
  const data = await response.json() as { workflow_runs?: Array<{ name?: string; status?: string; conclusion?: string }> };
  const run = data.workflow_runs?.[0];
  const state = !run ? "unknown" : run.status !== "completed" ? "pending" : run.conclusion === "success" ? "success" : "failure";
  const summary = state === "success" ? `Boss, the latest ${run?.name || "workflow"} completed successfully.` : state === "pending" ? `Boss, the latest ${run?.name || "workflow"} is still running.` : state === "failure" ? `Boss, the latest ${run?.name || "workflow"} failed. Would you like a brief?` : "Boss, I couldn't find a recent workflow run.";
  openChromeTab(url);
  activeBrowserSite = { name: "GitHub", hostname: "github.com" };
  return { repository: safe, state, workflow: run?.name, url, summary };
}

function openChromeTab(url: string) {
  const script = `on run argv
set targetUrl to item 1 of argv
tell application "Google Chrome"
activate
if (count of windows) is 0 then make new window
tell front window to make new tab with properties {URL:targetUrl}
set active tab index of front window to count of tabs of front window
end tell
end run`;
  const child = spawn("/usr/bin/osascript", ["-e", script, url], { detached: true, stdio: "ignore" });
  child.once("error", () => { const fallback = spawn("/usr/bin/open", ["-a", "Google Chrome", url], { detached: true, stdio: "ignore" }); fallback.unref(); });
  child.unref();
}

function navigateActiveChromeTab(url: string) {
  const script = `on run argv
set targetUrl to item 1 of argv
tell application "Google Chrome"
activate
if (count of windows) is 0 then make new window
set URL of active tab of front window to targetUrl
end tell
end run`;
  const child = spawn("/usr/bin/osascript", ["-e", script, url], { detached: true, stdio: "ignore" });
  child.once("error", () => openChromeTab(url));
  child.unref();
}

function searchActiveChromePage(terms: string): Promise<boolean> {
  const query = JSON.stringify(terms);
  const javascript = `(()=>{const q=${query};const selectors=['input[type="search"]','input[role="searchbox"]','form[role="search"] input','input[name="q"]','input[name="query"]','input[name="search"]','input[placeholder*="search" i]'];const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled};const el=selectors.flatMap(s=>Array.from(document.querySelectorAll(s))).find(visible);if(!el)return 'NO_SEARCH';el.focus();const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter?setter.call(el,q):el.value=q;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));const form=el.closest('form');if(form){form.requestSubmit?form.requestSubmit():form.submit()}else{el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}))}return 'SEARCHED'})()`;
  const script = `on run argv
tell application "Google Chrome"
activate
if (count of windows) is 0 then return "NO_WINDOW"
return execute active tab of front window javascript (item 1 of argv)
end tell
end run`;
  return new Promise(resolve => {
    const child = spawn("/usr/bin/osascript", ["-e", script, javascript], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.once("close", code => resolve(code === 0 && output.trim() === "SEARCHED"));
    child.once("error", () => resolve(false));
  });
}

async function browserNavigate(request: { url?: string; query?: string; site?: string; sameTab?: boolean }) {
  let target = String(request.url || "").trim();
  let usedPageSearch = false;
  let usedSiteFallback = false;
  if (!target) {
    const terms = String(request.query || request.site || "").trim().slice(0, 300);
    if (!terms) throw new Error("Orbit needs a website or search phrase");
    const context = activeBrowserSite;
    if (context?.hostname.includes("youtube.com")) target = `https://www.youtube.com/results?search_query=${encodeURIComponent(terms)}`;
    else if (context?.hostname === "github.com") target = `https://github.com/search?q=${encodeURIComponent(terms)}`;
    else if (context?.hostname.includes("amazon.")) target = `https://${context.hostname}/s?k=${encodeURIComponent(terms)}&i=aps&ref=nb_sb_noss`;
    else if (context?.hostname.includes("reddit.com")) target = `https://www.reddit.com/search/?q=${encodeURIComponent(terms)}`;
    else if (context?.hostname.includes("linkedin.com")) target = `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(terms)}`;
    else if (context && !context.hostname.includes("google.")) {
      usedPageSearch = await searchActiveChromePage(terms);
      if (usedPageSearch) return { opened: true, url: "", site: context.name, summary: `Searching ${context.name} for ${terms}, boss.` };
      usedSiteFallback = true;
      target = `https://www.google.com/search?q=${encodeURIComponent(`site:${context.hostname} ${terms}`)}`;
    }
    else target = `https://www.google.com/search?q=${encodeURIComponent(terms)}`;
  }
  let parsed: URL;
  try { parsed = new URL(target); } catch { throw new Error("Orbit could not validate that web address"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Orbit only opens HTTP or HTTPS websites");
  if (parsed.hostname.includes("amazon.") && parsed.pathname === "/s" && parsed.searchParams.get("k")) {
    parsed.searchParams.set("i", "aps");
    parsed.searchParams.set("ref", "nb_sb_noss");
  }
  if (request.sameTab) navigateActiveChromeTab(parsed.toString());
  else openChromeTab(parsed.toString());
  const destination = parsed.hostname.replace(/^www\./, "");
  const names: Record<string, string> = { "youtube.com": "YouTube", "github.com": "GitHub", "google.com": "Google", "tesla.com": "Tesla", "reddit.com": "Reddit", "linkedin.com": "LinkedIn" };
  const matched = Object.entries(names).find(([domain]) => destination === domain || destination.endsWith(`.${domain}`));
  activeBrowserSite = { name: matched?.[1] || destination, hostname: parsed.hostname };
  const searched = Boolean(request.query && !request.url);
  const summary = usedSiteFallback && activeBrowserSite ? `I couldn't control that site's search box, boss, so I searched its pages through Google.` : searched ? `Searching ${activeBrowserSite.name} for ${String(request.query).slice(0, 80)}, boss.` : request.sameTab ? `Opening ${activeBrowserSite.name} in the current Chrome tab, boss.` : `Opening ${activeBrowserSite.name} in a new Chrome tab, boss.`;
  return { opened: true, url: parsed.toString(), site: activeBrowserSite.name, summary };
}

async function launchApplication(application: string) {
  const allowed = new Set(await installedApplications());
  if (!allowed.has(application)) throw new Error("Orbit could not find that application on this Mac");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : application === "Google Chrome" ? "google-chrome" : application.toLowerCase();
  const args = process.platform === "darwin" ? ["-a", application] : process.platform === "win32" ? ["/c", "start", "", application] : [];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { launched: true, application };
}

function currentLocation(): Promise<{ latitude: number; longitude: number }> {
  if (process.platform !== "darwin") return Promise.reject(new Error("Local weather location is currently available on macOS only"));
  if (!speechProcess) startSpeech();
  if (!speechProcess?.stdin.writable) return Promise.reject(new Error("Orbit's location helper is unavailable"));
  if (locationRequest) return Promise.reject(new Error("A location request is already in progress"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { locationRequest = null; reject(new Error("Location permission timed out. Check macOS Location Services for Orbit.")); }, 15_000);
    locationRequest = { resolve, reject, timer };
    speechProcess!.stdin.write("location\n");
  });
}

const weatherDescriptions: Record<number, string> = {
  0: "clear skies", 1: "mainly clear skies", 2: "partly cloudy skies", 3: "overcast skies", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow",
  73: "snow", 75: "heavy snow", 80: "light rain showers", 81: "rain showers", 82: "heavy rain showers", 95: "thunderstorms",
};

async function liveWeather(): Promise<LiveBrief> {
  const { latitude, longitude } = await currentLocation();
  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m", temperature_unit: "fahrenheit", wind_speed_unit: "mph", timezone: "auto" }).toString();
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("The weather service is temporarily unavailable");
  const data = await response.json() as { current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number; time?: string } };
  const current = data.current;
  if (current?.temperature_2m == null) throw new Error("The weather service returned incomplete conditions");
  const condition = weatherDescriptions[current.weather_code ?? -1] || "current conditions";
  const summary = `Boss, it is ${Math.round(current.temperature_2m)} degrees with ${condition}. It feels like ${Math.round(current.apparent_temperature ?? current.temperature_2m)} degrees, with winds around ${Math.round(current.wind_speed_10m ?? 0)} miles per hour.`;
  return { summary, source: "Open-Meteo", updatedAt: current.time || new Date().toISOString() };
}

function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").trim();
}

async function rssTitles(url: string, limit: number) {
  const response = await fetch(url, { headers: { "User-Agent": "Orbit-Desktop/0.7" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`The live source returned status ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item[\s\S]*?<title>([\s\S]*?)<\/title>/gi)].map(match => decodeXml(match[1])).filter(Boolean).slice(0, limit);
}

async function liveNews(): Promise<LiveBrief> {
  const titles = await rssTitles("https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", 3);
  if (!titles.length) throw new Error("No current headlines were available");
  const clean = titles.map(title => title.replace(/\s+-\s+[^-]+$/, ""));
  return { summary: `Boss, today's top headlines are: ${clean.map((title, index) => `${index + 1}, ${title}`).join(". ")}.`, source: "Google News RSS", updatedAt: new Date().toISOString() };
}

async function liveCricket(): Promise<LiveBrief> {
  const titles = await rssTitles("https://news.google.com/rss/search?q=live%20cricket%20score&hl=en-US&gl=US&ceid=US:en", 3);
  if (!titles.length) throw new Error("I couldn't verify a current cricket score right now");
  const update = titles.find(title => /\b(?:\d+\/\d+|won by|live score|runs?|wickets?)\b/i.test(title)) || titles[0];
  return { summary: `Boss, the latest cricket update I can verify is: ${update.replace(/\s+-\s+[^-]+$/, "")}.`, source: "Google News RSS", updatedAt: new Date().toISOString() };
}

function decodeHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

async function searchPublicWeb(query: string): Promise<ResearchSource[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, { headers: { "User-Agent": "Mozilla/5.0 Orbit-Desktop/0.8" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Web search is temporarily unavailable");
  const html = await response.text();
  const blocks = [...html.matchAll(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi)];
  const sources: ResearchSource[] = [];
  for (const match of blocks) {
    let url = decodeHtml(match[1]);
    try {
      const parsed = new URL(url, "https://duckduckgo.com");
      url = parsed.searchParams.get("uddg") || parsed.toString();
      const safe = new URL(url);
      if (!/^https?:$/.test(safe.protocol)) continue;
    } catch { continue; }
    const source = { title: decodeHtml(match[2]), url, excerpt: decodeHtml(match[3] || match[4] || "") };
    if (source.title && source.excerpt && !sources.some(item => item.url === source.url)) sources.push(source);
    if (sources.length === 5) break;
  }
  if (!sources.length) throw new Error("I couldn't retrieve reliable web results for that question");
  return sources;
}

async function research(query: string): Promise<ResearchAnswer> {
  const clean = query.trim().slice(0, 500);
  if (!clean) throw new Error("Orbit needs a question to research");
  const sources = await searchPublicWeb(clean);
  let answer: string;
  const status = await ollamaStatus();
  if (status.available) answer = await answerWithOllama({ query: clean, sources, history: conversation });
  else answer = `Here are the most relevant current results: ${sources.slice(0, 3).map((source, index) => `[${index + 1}] ${source.title}. ${source.excerpt}`).join(" ")}`;
  const spokenAnswer = answer.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").slice(0, 470).trim();
  conversation.push({ role: "user", content: clean }, { role: "assistant", content: answer });
  if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
  return { answer, spokenAnswer, sources, updatedAt: new Date().toISOString() };
}

async function traced<T>(tool: string, action: () => Promise<T>) {
  const rule = policy(tool);
  await audit.record(tool, rule.risk, "started", rule.description);
  try {
    const result = await action();
    await audit.record(tool, rule.risk, "completed", rule.description);
    return result;
  } catch (error) {
    await audit.record(tool, rule.risk, "failed", error instanceof Error ? error.message : "Unknown failure");
    throw error;
  }
}

function registerIPC() {
  ipcMain.handle("orbit:policies", () => policies);
  ipcMain.handle("orbit:system", () => traced("system.snapshot", systemSnapshot));
  ipcMain.handle("orbit:recent", () => traced("work.recent", recentWork));
  ipcMain.handle("orbit:git", () => traced("git.context", gitContexts));
  ipcMain.handle("orbit:cleanup", () => traced("cleanup.plan", cleanupPlan));
  ipcMain.handle("orbit:audit", () => audit.list());
  ipcMain.handle("orbit:knowledge:index", () => traced("knowledge.index", async () => {
    const chosen = await dialog.showOpenDialog({ title: "Choose a folder Orbit may index", properties: ["openDirectory"] });
    if (chosen.canceled || !chosen.filePaths[0]) return { indexed: 0, skipped: 0, cancelled: true };
    return retrieve({ operation: "index", roots: [chosen.filePaths[0]] });
  }));
  ipcMain.handle("orbit:knowledge:search", (_event, query: string) => traced("knowledge.search", () => retrieve({ operation: "search", query: String(query).slice(0, 300), limit: 8 })));
  ipcMain.handle("orbit:command:plan", (_event, command: string) => traced("command.plan", () => planCommand(String(command).slice(0, 1000))));
  ipcMain.handle("orbit:ai:status", () => ollamaStatus());
  ipcMain.handle("orbit:path:open", (_event, target: string) => traced("files.open", async () => {
    const resolved = String(target).slice(0, 4096);
    if (!path.isAbsolute(resolved)) throw new Error("Orbit only opens absolute cited paths");
    return (await shell.openPath(resolved)) === "";
  }));
  ipcMain.handle("orbit:app:launch", (_event, application: string) => traced("app.launch", () => launchApplication(String(application))));
  ipcMain.handle("orbit:github:workflow", (_event, repository?: string) => traced("github.workflow", () => githubWorkflow(repository)));
  ipcMain.handle("orbit:browser:navigate", (_event, request: { url?: string; query?: string; site?: string; sameTab?: boolean }) => traced("browser.navigate", () => browserNavigate(request || {})));
  ipcMain.handle("orbit:live:weather", () => traced("live.weather", liveWeather));
  ipcMain.handle("orbit:live:news", () => traced("live.news", liveNews));
  ipcMain.handle("orbit:live:cricket", () => traced("live.cricket", liveCricket));
  ipcMain.handle("orbit:web:research", (_event, query: string) => traced("web.research", () => research(String(query))));
  ipcMain.handle("orbit:voice:speak", (_event, text: string) => { speak(text); return true; });
  ipcMain.handle("orbit:voice:start", () => { startSpeech(); return { started: Boolean(speechProcess) }; });
  ipcMain.handle("orbit:voice:stop", () => { stopSpeech(); return { stopped: true }; });
  ipcMain.handle("orbit:voice:arm", () => { armVoice(); return { armed: Boolean(speechProcess) }; });
  ipcMain.handle("orbit:trash", async (_event, paths: string[]) => traced("files.trash", async () => {
    const approval = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", "Move to Trash"], defaultId: 0, cancelId: 0, title: "Approve reversible cleanup", message: `Move ${Math.min(paths.length, 50)} selected file(s) to Trash?`, detail: "Orbit never permanently deletes these files. They remain recoverable from operating-system Trash." });
    if (approval.response !== 1) return { moved: [], failed: [] };
    const moved: string[] = [], failed: string[] = [];
    for (const item of [...new Set(paths)].slice(0, 50)) {
      try { await shell.trashItem(item); moved.push(item); } catch { failed.push(item); }
    }
    return { moved, failed };
  }));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1240, height: 820, minWidth: 920, minHeight: 640, titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0c10",
    webPreferences: { preload: path.join(app.getAppPath(), "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) void window.loadURL(dev); else void window.loadFile(path.join(here, "../../dist-renderer/index.html"));
  mainWindow = window;
  window.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  audit = new AuditStore(path.join(app.getPath("userData"), "orbit-audit.jsonl"));
  registerIPC(); createWindow();
  globalShortcut.register("CommandOrControl+Shift+Space", armVoice);
  startSpeech();
  if (app.isPackaged) setTimeout(() => void autoUpdater.checkForUpdatesAndNotify(), 8_000);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); speechProcess?.kill(); });
