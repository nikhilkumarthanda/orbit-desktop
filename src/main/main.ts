import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import updater from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore } from "./audit.js";
import { policies, policy } from "./policy.js";
import { cleanupPlan, findFiles, gitContexts, recentWork, systemSnapshot } from "./tools.js";
import { answerWithOllama, ollamaStatus, OLLAMA_MODEL, planWithOllama } from "./ollama.js";
import { answerWithGemini, geminiKey, geminiStatus, saveGeminiKey, setGeminiBudget } from "./gemini.js";
import { amazonSearchWithPriceFilter, youtubePlayFirst } from "./browser-workflows.js";
import { describeCurrentPage, findOnPage, summarizeCurrentPage } from "./browser-intelligence.js";
import { createLiveInformationEngine } from "./live-info/engine.js";
import { createWeatherService } from "./live-info/weather-service.js";
import { createNewsService } from "./live-info/news-service.js";
import { createSportsService } from "./live-info/sports-service.js";
import { createFinanceService } from "./live-info/finance-service.js";
import { createCalendarService } from "./live-info/calendar-service.js";
import { createEmailService } from "./live-info/email-service.js";
import { forget, recall, remember } from "./memory.js";
import { executeMacControl, macPermissionStatus } from "./macos-control.js";
import { researchPublicWeb, shouldReadTheWeb } from "./web-research.js";
import { contactsForName } from "./recipients.js";
import { destinationAdapter, destinationsFor } from "./destination-adapters.js";
import { fallbackEmailBody, inferEmailSubject } from "./email-drafting.js";
import type { CommandPlan, ConversationEntry, ConversationTurn, GitHubWorkflowStatus, OrbitPlayGesture, OrbitPlayMode, ResearchAnswer, ResearchSource } from "../shared/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let audit: AuditStore;
let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let speechProcess: ChildProcessWithoutNullStreams | null = null;
let gestureProcess: ChildProcessWithoutNullStreams | null = null;
let orbitPlayMode: OrbitPlayMode = "playground";
let orbitPlayActive = false;
let lastGestureAt = 0;
let spokenReply: ReturnType<typeof spawn> | null = null;
const { autoUpdater } = updater;
const conversation: ConversationTurn[] = [];
let conversationEntries: ConversationEntry[] = [];
function conversationPath() { return path.join(app.getPath("userData"), "conversation-history.json"); }
function saveConversation() {
  const file = conversationPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(conversationEntries.slice(-200), null, 2), { mode: 0o600 });
}
function loadConversation() {
  try {
    const parsed = JSON.parse(readFileSync(conversationPath(), "utf8")) as ConversationEntry[];
    conversationEntries = Array.isArray(parsed) ? parsed.filter(item => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string").slice(-200) : [];
  } catch { conversationEntries = []; }
  conversation.splice(0, conversation.length, ...conversationEntries.slice(-20).map(({ role, content }) => ({ role, content })));
}
function appendConversation(turn: ConversationTurn) {
  const entry: ConversationEntry = { role: turn.role, content: String(turn.content).slice(0, 10_000), id: crypto.randomUUID(), at: new Date().toISOString() };
  conversationEntries.push(entry);
  conversation.push({ role: entry.role, content: entry.content });
  if (conversationEntries.length > 200) conversationEntries.splice(0, conversationEntries.length - 200);
  if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
  saveConversation();
  return conversationEntries;
}
let lastFailureDetail = "";
let selectedVoice: string | null = null;
let wakeAcknowledgementIndex = 0;
let activeBrowserSite: { name: string; hostname: string; query?: string } | null = null;
let activeSocialDraft: { provider: "linkedin"|"facebook"; content: string } | null = null;
let activeEmailDraft: { recipient: string; displayName: string; subject: string; body: string } | null = null;
let selectedYouTubeResult: number | null = null;
let quitting = false;
let pendingMemoryDeletion: string[] = [];
let activeFolderPath: string | null = null;
let preferredName = "Boss";
let profilePath = "";
const defaultWritingPreferences = { tone: "professional", length: "concise", greeting: "Hi", signature: "Nikhil", natural: true } as const;
let writingPreferences: { tone: "professional"|"friendly"|"casual"|"formal"; length: "concise"|"balanced"|"detailed"; greeting: string; signature: string; natural: boolean } = { ...defaultWritingPreferences };
let locationRequest: { resolve: (value: { latitude: number; longitude: number }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

function orbitVoice() {
  if (selectedVoice) return selectedVoice;
  const voices = spawnSync("/usr/bin/say", ["-v", "?"], { encoding: "utf8" }).stdout || "";
  selectedVoice = ["Ava", "Samantha", "Jamie", "Daniel"].find(name => new RegExp(`^${name}\\s`, "m").test(voices)) || "Daniel";
  return selectedVoice;
}

function nextWakeAcknowledgement() {
  const options = [`Yes, ${address()}?`, `I'm listening, ${address()}.`, `Go ahead, ${address()}.`];
  const reply = options[wakeAcknowledgementIndex % options.length];
  wakeAcknowledgementIndex += 1;
  return reply;
}

function naturalSpeech(text: string) {
  return text
    .replace(/https?:\/\/\S+/gi, "the link")
    .replace(/[{}\[\]<>_*`|]/g, " ")
    .replace(/\b(?:Error|Exception):?\s*/gi, "")
    .replace(/\s*[·•]\s*/g, ". ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .replace(/\s*([.!?])\s*/g, "$1 ")
    .trim();
}

function address() { return preferredName || "Boss"; }
function personalize(text: string) { return text.replace(/\bboss\b/gi, address()); }

async function savePreferredName(name: string) {
  preferredName = name;
  if (profilePath) await writeFile(profilePath, JSON.stringify({ preferredName, writingPreferences }, null, 2), "utf8");
}

async function loadProfile() {
  profilePath = path.join(app.getPath("userData"), "profile.json");
  try {
    const stored = JSON.parse(await readFile(profilePath, "utf8")) as { preferredName?: string; writingPreferences?: typeof writingPreferences };
    if (/^[\p{L}][\p{L} .'-]{0,39}$/u.test(stored.preferredName || "")) preferredName = stored.preferredName!.trim();
    if (stored.writingPreferences) writingPreferences = { ...defaultWritingPreferences, ...stored.writingPreferences };
  } catch {}
}

async function saveEmailPreferences(value: typeof writingPreferences) {
  writingPreferences = {
    tone: ["professional","friendly","casual","formal"].includes(value.tone) ? value.tone : "professional",
    length: ["concise","balanced","detailed"].includes(value.length) ? value.length : "concise",
    greeting: String(value.greeting || "Hi").trim().slice(0, 30),
    signature: String(value.signature || "Nikhil").trim().slice(0, 80),
    natural: value.natural !== false,
  };
  if (profilePath) await writeFile(profilePath, JSON.stringify({ preferredName, writingPreferences }, null, 2), "utf8");
  return writingPreferences;
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
  const named = personalize(raw);
  // Replies already include the preferred name when it sounds natural. Avoid
  // prefixing every sentence, which makes a conversation feel synthetic.
  const spoken = named;
  stopSpeaking(false);
  if (protectListener && speechProcess?.stdin.writable) speechProcess.stdin.write("pause\n");
  const child = spawn("/usr/bin/say", ["-v", orbitVoice(), "-r", "172", spoken], { stdio: "ignore" });
  spokenReply = child;
  sendVoice("speaking", { message: "Orbit is speaking" });
  if (protectListener) child.once("exit", () => setTimeout(() => {
    if (spokenReply !== child) return;
    spokenReply = null;
    if (speechProcess?.stdin.writable) speechProcess.stdin.write("followup\n");
  }, 450));
}

function stopSpeaking(resumeListener = true) {
  const wasSpeaking = Boolean(spokenReply);
  if (spokenReply) { spokenReply.kill(); spokenReply = null; }
  if (wasSpeaking) sendVoice("interrupted", { message: "Response stopped" });
  if (resumeListener && speechProcess?.stdin.writable) speechProcess.stdin.write("followup\n");
  return wasSpeaking;
}

function sendVoice(type: string, payload: Record<string, unknown> = {}) {
  mainWindow?.webContents.send("orbit:voice:event", { type, ...payload });
  overlayWindow?.webContents.send("orbit:voice:event", { type, ...payload });
}

function showListening() {
  sendVoice("wake");
  speak(nextWakeAcknowledgement(), false);
}

function stopSpeech() {
  if (speechProcess) { speechProcess.kill(); speechProcess = null; }
  sendVoice("stopped", { message: "Microphone off" });
}

function armVoice() {
  if (!speechProcess) startSpeech();
  if (speechProcess?.stdin.writable) {
    console.log(`[speech] writing "arm" to helper pid=${speechProcess.pid}`);
    speechProcess.stdin.write("arm\n");
  } else {
    console.warn(`[speech] cannot arm: speechProcess=${speechProcess ? `pid ${speechProcess.pid}` : "null"}, stdin.writable=${Boolean(speechProcess?.stdin.writable)}`);
    showListening();
    sendVoice("unavailable", { message: "Native speech helper is not available" });
  }
}

function startSpeech() {
  if (process.platform !== "darwin") { console.log("[speech] startSpeech skipped: not darwin"); return; }
  if (speechProcess) { console.log(`[speech] startSpeech skipped: already running, pid=${speechProcess.pid}`); return; }
  const bundled = path.join(process.resourcesPath, "sidecar", "orbit-speech");
  const development = path.join(app.getAppPath(), "release-sidecar", "orbit-speech");
  const bundledExists = existsSync(bundled);
  const binary = bundledExists ? bundled : development;
  console.log(`[speech] resolved binary path: ${binary} (bundled=${bundledExists} at ${bundled}, development exists=${existsSync(development)} at ${development})`);
  if (!existsSync(binary)) {
    console.error(`[speech] binary not found at resolved path: ${binary}`);
    sendVoice("unavailable", { message: "Native speech helper is not included in this development build" });
    return;
  }
  console.log(`[speech] spawning binary: ${binary}`);
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  speechProcess = child;
  console.log(`[speech] spawn() returned, pid=${child.pid ?? "unknown"}`);
  child.on("spawn", () => console.log(`[speech] spawn confirmed, pid=${child.pid}`));
  let buffered = "";
  child.stdout.on("data", chunk => {
    console.log(`[speech] stdout: ${String(chunk).trim()}`);
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
        if (event.type === "interrupt") { stopSpeaking(); continue; }
        sendVoice(event.type, event);
        if (event.type === "wake") { console.log(`[speech] wake event received from helper (mode=${event.mode ?? "unknown"}); transitioning to full recognition`); showListening(); }
        if (event.type === "command" && event.text) mainWindow?.webContents.send("orbit:voice:command", String(event.text));
      } catch { sendVoice("error", { message: "Speech helper returned invalid data" }); }
    }
  });
  child.stderr.on("data", chunk => {
    console.error(`[speech] stderr: ${String(chunk).trim()}`);
    sendVoice("error", { message: String(chunk).trim() });
  });
  child.stdin.on("error", err => console.error(`[speech] stdin write error: ${err instanceof Error ? err.message : String(err)}`));
  child.on("error", err => {
    console.error(`[speech] spawn/runtime error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    if (speechProcess === child) speechProcess = null;
    sendVoice("unavailable", { message: `Speech helper failed to start: ${err instanceof Error ? err.message : String(err)}` });
  });
  child.on("exit", (code, signal) => console.log(`[speech] exit event: code=${code} signal=${signal}`));
  child.on("close", (code, signal) => {
    console.log(`[speech] close event: code=${code} signal=${signal}, pid was ${child.pid}`);
    if (speechProcess === child) speechProcess = null;
    sendVoice("stopped");
    if (!quitting) setTimeout(startSpeech, 1_000);
  });
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

function spokenAmazonPrice(command: string): { value?: number; phrase?: string } {
  const numeric = command.match(/\b(?:under|below|less than)\s*\$?\s*(\d+(?:\.\d+)?)/);
  if (numeric) return { value: Number(numeric[1]), phrase: numeric[0] };

  // Speech recognition commonly transcribes "$250" as "two fifty" or
  // "two hundred fifty". Support the useful shopping range without asking a
  // language model to guess a price.
  const compact = command.match(/\b(?:under|below|less than)\s+(one|two|three|four|five|six|seven|eight|nine)\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/);
  if (compact) {
    const hundreds: Record<string, number> = { one: 100, two: 200, three: 300, four: 400, five: 500, six: 600, seven: 700, eight: 800, nine: 900 };
    const remainder: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
    return { value: hundreds[compact[1]] + remainder[compact[2]], phrase: compact[0] };
  }

  const explicit = command.match(/\b(?:under|below|less than)\s+(one|two|three|four|five|six|seven|eight|nine)\s+hundred(?:\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))?\b/);
  if (explicit) {
    const hundreds: Record<string, number> = { one: 100, two: 200, three: 300, four: 400, five: 500, six: 600, seven: 700, eight: 800, nine: 900 };
    const remainder: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
    return { value: hundreds[explicit[1]] + (explicit[2] ? remainder[explicit[2]] : 0), phrase: explicit[0] };
  }

  return {};
}

function planLocal(value: string): CommandPlan {
  const command = value.trim().toLowerCase()
    .replace(/\b(?:git|get)\s+hub\b/g, "github")
    .replace(/\bgethub\b/g, "github")
    .replace(/\b(?:lead|leet)\s+code\b/g, "leetcode");
  const cleanRecipientName = (name?: string) => name?.replace(/\s+\b(?:right\s+now|now|please|for\s+me)\b\s*$/i, "").trim();
  if (/\b(brief|explain|tell me more|what happened)\b/.test(command) && lastFailureDetail) return { intent: "answer", confidence: 1, explanation: "Previous error briefing", reply: `Boss, the previous operation failed because ${lastFailureDetail}. I can retry when you're ready.`, query: value, source: "local" };
  if (/^(hi|hello|hey|good (morning|afternoon|evening))( orbit)?[!.?]*$/.test(command)) return { intent: "answer", confidence: 1, explanation: "Local greeting matched", reply: "Yes, boss? At your service.", query: value, source: "local" };
  if (/\b(notifications?|notification center|alerts?)\b/.test(command)) return { intent: "notifications", confidence: 1, explanation: "Mac notification request matched", reply: "I can’t read Notification Center yet, boss. I won’t substitute news headlines for your notifications.", query: value, source: "local" };
  if (/\b(?:what(?:'s| is)?|check|tell me|show me)?\s*(?:my|the)?\s*battery(?:\s+(?:level|percentage|status))?\b/.test(command)) return { intent: "battery", confidence: 1, explanation: "Native battery request matched", query: value, source: "local" };
  const appNames: Array<[RegExp, string]> = [[/\b(?:chrome|google chrome)\b/, "Google Chrome"], [/\bsafari\b/, "Safari"], [/\b(?:vs code|visual studio code|code)\b/, "Visual Studio Code"], [/\bfinder\b/, "Finder"], [/\bterminal\b/, "Terminal"], [/\bpreview\b/, "Preview"], [/\b(?:outlook|microsoft outlook)\b/, "Microsoft Outlook"]];
  const namedApplication = appNames.find(([pattern]) => pattern.test(command))?.[1];
  if (/\b(?:list|show|what|which)\b.*\b(?:open )?windows\b/.test(command)) return { intent: "mac_control", confidence: 1, explanation: "Native window inventory matched", macAction: { action: "list_windows" }, query: value, source: "local" };
  const windowRequest = command.match(/\b(?:bring|focus|show|switch to)\b(?:\s+my|\s+the)?\s+(.+?)\s+window(?:\s+forward)?\b/);
  if (windowRequest && namedApplication) return { intent: "mac_control", confidence: 1, explanation: "Native window focus matched", macAction: { action: "focus_window", application: namedApplication, windowTitle: windowRequest[1].replace(/\b(?:chrome|google chrome|safari|finder|terminal|vs code|visual studio code)\b/g, "").trim() || windowRequest[1] }, query: value, source: "local" };
  if (namedApplication && /\b(?:switch(?:\s+back)? to|focus|bring forward)\b/.test(command)) return { intent: "mac_control", confidence: 1, explanation: "Native application focus matched", macAction: { action: "focus_app", application: namedApplication }, query: value, source: "local" };
  if (namedApplication && /\bhide\b/.test(command)) return { intent: "mac_control", confidence: 1, explanation: "Native application hide matched", macAction: { action: "hide_app", application: namedApplication }, query: value, source: "local" };
  if (namedApplication && /\b(?:close|quit)\b/.test(command)) return { intent: "mac_control", confidence: 1, explanation: "Native application quit matched", macAction: { action: "quit_app", application: namedApplication }, requiresConfirmation: true, query: value, source: "local" };
  const quotedPaths = [...value.matchAll(/["“]([^"”]+)["”]/g)].map(match => match[1]);
  if (/\b(?:move)\b/i.test(value) && quotedPaths.length >= 2) return { intent: "mac_control", confidence: 1, explanation: "Confirmed Finder move workflow matched", macAction: { action: "move_path", sourcePath: quotedPaths[0], destinationPath: quotedPaths[1] }, requiresConfirmation: true, query: value, source: "local" };
  if (/\brename\b/i.test(value) && quotedPaths.length >= 2) return { intent: "mac_control", confidence: 1, explanation: "Confirmed Finder rename workflow matched", macAction: { action: "rename_path", sourcePath: quotedPaths[0], destinationPath: quotedPaths[1] }, requiresConfirmation: true, query: value, source: "local" };
  if (/\b(?:create|make)\b.*\bfolder\b/i.test(value) && quotedPaths[0]) return { intent: "mac_control", confidence: 1, explanation: "Confirmed Finder folder creation matched", macAction: { action: "create_folder", destinationPath: quotedPaths[0] }, requiresConfirmation: true, query: value, source: "local" };
  if (/\breveal\b/i.test(value) && quotedPaths[0]) return { intent: "mac_control", confidence: 1, explanation: "Finder reveal matched", macAction: { action: "reveal_file", sourcePath: quotedPaths[0] }, query: value, source: "local" };
  const openWith = value.match(/\bopen\s+(.+?)\s+in\s+(preview|visual studio code|vs code|chrome|safari|outlook)\b/i);
  if (openWith) return { intent: "mac_control", confidence: 1, explanation: "Open file in requested application matched", macAction: { action: "open_file_with", application: appNames.find(([pattern]) => pattern.test(openWith[2].toLowerCase()))?.[1] || openWith[2] }, query: openWith[1].trim(), source: "local" };
  if (/\b(?:take|capture|save|make|grab)\b(?:\s+(?:a|the|my|this|current|full))?\s*(?:screen\s*shot|screenshot)\b|\b(?:screen\s*shot|screenshot)\s+(?:this|that|now|please)\b/.test(command)) return { intent: "screenshot", confidence: 1, explanation: "Native screenshot request matched", query: value, source: "local" };
  if (/\b(?:what(?:'s| is) on|describe|read|analy[sz]e|look at|see)\s+(?:my|the|this|current)?\s*screen\b|\bscreen\s*(?:right now|now)\b/.test(command)) return { intent: "screen", confidence: 1, explanation: "Native screen request matched", query: value, source: "local" };
  if (/^(?:what(?:'s| is| are)?|any|give me|tell me)(?: the)? (?:new )?updates?[?.!]*$/.test(command)) return { intent: "clarify", confidence: 1, explanation: "Update topic is ambiguous", reply: "Which updates do you mean, boss—your notifications, news, weather, cricket, GitHub, or something else?", query: value, source: "local" };
  if (/^(?:who\s+won|who(?:'s| is)\s+the\s+(?:winner|champion)\s+of)\s+(?:the\s+)?fifa[?.!]*$/.test(command)) return { intent: "clarify", confidence: 1, explanation: "FIFA competition is ambiguous", reply: "Which FIFA competition do you mean, boss—the men's World Cup, Women's World Cup, Club World Cup, or another tournament?", query: value, source: "local" };
  if (/\b(?:what'?s|what is)\s+happening\s+today\b|\bcatch me up\b|\b(?:morning|daily) briefing\b/.test(command)) return { intent: "daily_brief", confidence: 1, explanation: "Composite daily briefing request matched", query: value, liveServices: ["weather", "news", "calendar", "email"], source: "local" };
  if (/\b(weather|temperature|forecast|rain|raining|umbrella|snow|humid)\b/.test(command)) return { intent: "weather", confidence: 1, explanation: "Live weather request matched", query: value, liveServices: ["weather"], source: "local" };
  if (/\b(cricket|ipl|test match)\b.*\b(score|scores|result|match|update|live)\b|\b(score|scores)\b.*\b(cricket|ipl)\b/.test(command)) return { intent: "cricket", confidence: 1, explanation: "Live cricket request matched", query: value, liveServices: ["sports"], source: "local" };
  if (/\b(fifa|world cup|premier league|champions league|soccer)\b.*\b(score|scores|result|match|final|winner|won|update|live)\b|\b(score|scores|result|winner)\b.*\b(fifa|world cup|soccer)\b/.test(command)) return { intent: "soccer", confidence: 1, explanation: "Live soccer/FIFA request matched", query: value, liveServices: ["sports"], source: "local" };
  if (/\b(news|headlines|top stories|world update)\b/.test(command)) return { intent: "news", confidence: 1, explanation: "Live news request matched", query: value, liveServices: ["news"], source: "local" };
  if (/\b(stock|shares?|ticker|market cap|share price|trading at)\b/.test(command)) return { intent: "finance", confidence: 1, explanation: "Live finance request matched", query: value, liveServices: ["finance"], source: "local" };
  if (/\bgithub\b/.test(command) && /\b(workflow|actions?|deployment|ci|build (?:status|run)|check (?:the )?(?:workflow|actions?|deployment|ci|build))\b/.test(command)) return { intent: "github", confidence: .99, explanation: "Explicit GitHub workflow request matched", repository: "nikhilkumarthanda/orbit-desktop", query: value, source: "local" };
  if (/\b(?:outlook|gmail|apple mail|mail|email|e-mail)\b/.test(command) && /\b(?:draft|write|compose)\b/.test(command)) {
    const provider = /\bgmail\b/.test(command) ? "gmail" : /\boutlook\b/.test(command) ? "outlook" : /\b(?:apple mail|mail app)\b/.test(command) ? "mail" : undefined;
    const recipient = cleanRecipientName(command.match(/\b(?:to|for)\s+(.+?)(?=\s+(?:regarding|about|saying|telling|with subject)\b|[,.;]|$)/)?.[1]?.trim());
    const leaveTomorrow = /\bleave\b/.test(command) && /\b(?:tomorrow|tomo)\b/.test(command);
    const sender = command.match(/,\s*([a-z][a-z .'-]+)[.!]*$/i)?.[1]?.trim() || "Nikhil";
    const displayName = recipient?.replace(/\b\w/g, letter => letter.toUpperCase()) || "";
    const subject = leaveTomorrow ? "Leave Request" : inferEmailSubject(value);
    const body = leaveTomorrow
      ? `Hi ${displayName || "there"},\n\nI would like to request leave for tomorrow.\n\nThank you,\n${sender}`
      : "";
    return { intent: "email_draft", confidence: 1, explanation: "Email draft action, destination, and recipient parsed independently", recipient, subject, body, provider, query: value, requiresConfirmation: true, source: "local" };
  }
  if (activeEmailDraft && /^(?:please\s+)?(?:make|rewrite|change|update|add|remove|shorten|expand)\b|^(?:more|less)\s+(?:formal|professional|friendly|casual|detailed)/.test(command)) return { intent: "email_rewrite", confidence: 1, explanation: "Active email revision matched", query: value, source: "local" };
  const callMatch = command.match(/\b(?:call|facetime)\s+(.+?)(?:\s+(?:on|using)\s+(?:facetime|phone))?[.!?]*$/);
  if (callMatch) return { intent: "contact_call", confidence: 1, explanation: "Contact call request matched", recipient: cleanRecipientName(callMatch[1]) || callMatch[1].trim(), requiresConfirmation: true, query: value, source: "local" };
  if (/\b(?:post|draft|write|create)\b.*\b(?:linkedin|facebook)\b|\b(?:linkedin|facebook)\b.*\b(?:post|update)\b/.test(command)) return { intent: "social_draft", confidence: 1, explanation: "Social post drafting request matched", query: value, source: "local" };
  if (/^(?:publish|post|share)(?: it| this| the draft)?[.!?]*$/.test(command) && activeSocialDraft) return { intent: "social_publish", confidence: 1, explanation: "Explicit active social draft publication matched", requiresConfirmation: true, source: "local" };
  const ordinal = command.match(/^(?:please )?(?:open|play|select|highlight|click)\s+(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+(?:visible\s+)?(?:video|result)[.!]*$/);
  if (ordinal) {
    const names: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
    const resultIndex = names[ordinal[1]] || Number.parseInt(ordinal[1], 10);
    return { intent: "browser", confidence: 1, explanation: "Active YouTube ordinal selection matched before search", browserAction: "select_result", resultIndex, sameTab: true, source: "local" };
  }
  if (/^(?:no[, ]*)?(?:the\s+)?next\s+one[.!]*$/.test(command)) return { intent: "browser", confidence: 1, explanation: "Move active browser selection forward", browserAction: "selection_next", sameTab: true, source: "local" };
  if (/^(?:no[, ]*)?(?:the\s+)?previous\s+one[.!]*$/.test(command)) return { intent: "browser", confidence: 1, explanation: "Move active browser selection backward", browserAction: "selection_previous", sameTab: true, source: "local" };
  if (/^(?:yes|yeah|yep|open it|play it|that one|this one)[.!]*$/.test(command)) return { intent: "browser", confidence: 1, explanation: "Confirm active browser selection", browserAction: "selection_open", sameTab: true, source: "local" };
  const folderMatch = command.match(/\b(?:open|show|go to)\s+(?:my\s+|the\s+)?(documents?|downloads?|desktop|projects?|developer)(?:\s+folder)?\b/);
  if (folderMatch) {
    const folder = ({ document: "Documents", documents: "Documents", download: "Downloads", downloads: "Downloads", desktop: "Desktop", project: "Projects", projects: "Projects", developer: "Developer" } as Record<string, string>)[folderMatch[1]];
    return { intent: "folder", confidence: 1, explanation: "Local folder request matched before browser routing", folder, reply: `Opening ${folder}.`, query: value, source: "local" };
  }
  const fileMatch = command.match(/\b(?:open|find|locate|show|get)\s+(?:me\s+)?(.+?)(?:\s+file)?[.!?]*$/);
  if (fileMatch && /\b(file|document|pdf|excel|spreadsheet|word|powerpoint|presentation|resume|tracker|sheet|report|download|yesterday|recent|latest)\b/.test(command)) {
    return { intent: "file", confidence: .96, explanation: "Natural-language local file request matched", query: fileMatch[1].trim(), source: "local" };
  }
  if (/^(?:please )?(?:open|launch|select)\s+(?:the\s+)?(?:first|1st)\s+file[.!]*$/.test(command)) {
    return { intent: "folder", confidence: 1, explanation: "Active Finder folder action matched", folder: "__first__", reply: "Opening the first file.", query: value, source: "local" };
  }
  if (/\byoutube\b/.test(command) && /\bplay\b/.test(command) && !/\b(?:first|1st)\b.*\b(?:video|result)\b/.test(command)) {
    const query = command.replace(/\bopen\s+youtube\b/g, "").replace(/\byoutube\b/g, "").replace(/\bplay\b/g, "").replace(/\band\b/g, "").replace(/\bon\b/g, "").replace(/\s+/g, " ").trim();
    return { intent: "youtube_play", confidence: 1, explanation: "Single-shot YouTube play request matched", query: query || value, source: "local" };
  }
  if (/\bamazon\b/.test(command) && /\b(search|find|look for|buy|shop for)\b/.test(command)) {
    const price = spokenAmazonPrice(command);
    const query = command
      .replace(/\b(search|find|look for|buy|shop for)\b/g, "")
      .replace(/\bamazon\b/g, "")
      .replace(/\bfor\b/g, "")
      .replace(price.phrase || /\b(?:under|below|less than)\s*\$?\s*\d+(?:\.\d+)?\b/g, "")
      .replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:open|go to|visit)\b/, "")
      .replace(/^(?:please\s+)?(?:can|could|would)\s+you\b/, "")
      .replace(/^\s*(?:and|then)\b/, "")
      .replace(/\s+/g, " ")
      .trim();
    return { intent: "amazon_search", confidence: 1, explanation: "Amazon search with optional price filter matched", query: query || value, maxPrice: price.value, source: "local" };
  }
  if (/\b(?:what'?s|what is)\s+on\s+this\s+page\b|\bdescribe\s+(?:this|the)\s+page\b|\bwhat\s+(?:page|site)\s+is\s+this\b/.test(command)) return { intent: "page_describe", confidence: 1, explanation: "Page description request matched", query: value, source: "local" };
  if (/\bsummarize\s+(?:this|the)\s+(?:article|page|story)\b/.test(command)) return { intent: "page_summarize", confidence: 1, explanation: "Page summarization request matched", query: value, source: "local" };
  {
    const findMatch = command.match(/\bwhich\s+button\s+(.+)|\bwhere\s+is\s+the\s+(.+?)\s+button\b|\bfind\s+the\s+(.+?)\s+(?:button|link)\b/);
    if (findMatch) {
      const target = (findMatch[1] || findMatch[2] || findMatch[3] || "").trim();
      return { intent: "page_find", confidence: 1, explanation: "Page element lookup request matched", query: target || value, source: "local" };
    }
  }
  if (/\b(?:play|open|select|click)\b.*\b(?:first|1st)\b.*\b(?:video|result)\b/.test(command)) return { intent: "browser", confidence: 1, explanation: "Active YouTube result action matched", browserAction: "play_first", sameTab: true, source: "local" };
  if (/^(?:please )?(?:scroll|page)\s+(?:down|lower)(?:\s+(?:a little|more))?[.!]*$/.test(command)) return { intent: "browser", confidence: 1, explanation: "Active page scroll matched", browserAction: "scroll_down", sameTab: true, source: "local" };
  if (/^(?:please )?(?:scroll|page)\s+(?:up|higher)(?:\s+(?:a little|more))?[.!]*$/.test(command)) return { intent: "browser", confidence: 1, explanation: "Active page scroll matched", browserAction: "scroll_up", sameTab: true, source: "local" };
  if (/\b(?:my|this|the)?\s*(cpu|memory|ram|storage|disk|system|process(?:es)?|computer|mac)\b/.test(command)) return { intent: "system", confidence: .98, explanation: "Native system request matched", query: value, source: "local" };
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
  if (/^(?:orbit[, ]+)?(?:yes[, ]+)?confirm forget[.!]?$/iu.test(value.trim())) {
    if (!pendingMemoryDeletion.length) return { intent: "memory" as const, confidence: 1, explanation: "No pending memory deletion", reply: "There is no pending memory deletion.", query: value, source: "local" as const };
    const removed = await forget(pendingMemoryDeletion);
    pendingMemoryDeletion = [];
    return { intent: "memory" as const, confidence: 1, explanation: "Confirmed encrypted memory deletion", reply: `Deleted ${removed} saved ${removed === 1 ? "memory" : "memories"}.`, query: value, source: "local" as const };
  }
  if (/^(?:orbit[, ]+)?cancel forget[.!]?$/iu.test(value.trim())) {
    pendingMemoryDeletion = [];
    return { intent: "memory" as const, confidence: 1, explanation: "Memory deletion cancelled", reply: "Memory deletion cancelled.", query: value, source: "local" as const };
  }
  const forgetRequest = value.trim().match(/^(?:orbit[, ]+)?forget(?: everything| what (?:i|I) told you)?(?: about\s+(.+?))?[.!]?$/iu);
  if (forgetRequest) {
    const matches = await recall(forgetRequest[1] || "");
    if (!matches.length) return { intent: "memory" as const, confidence: 1, explanation: "No matching memories", reply: "I couldn’t find a matching saved memory.", query: value, source: "local" as const };
    pendingMemoryDeletion = matches.map(item => item.id);
    return { intent: "memory" as const, confidence: 1, explanation: "Memory deletion requires confirmation", reply: `I found ${matches.length} matching ${matches.length === 1 ? "memory" : "memories"}. Say “confirm forget” to delete ${matches.length === 1 ? "it" : "them"}, or “cancel forget.”`, query: value, source: "local" as const };
  }
  const rememberRequest = value.trim().match(/^(?:orbit[, ]+)?remember(?: that)?\s+(.+?)[.!]?$/iu);
  if (rememberRequest) {
    const memory = await remember(rememberRequest[1].trim());
    return { intent: "memory" as const, confidence: 1, explanation: "Explicit encrypted memory saved", reply: `I’ll remember that: ${memory.content}`, query: value, source: "local" as const };
  }
  const recallRequest = value.trim().match(/^(?:orbit[, ]+)?what do you remember(?: about\s+(.+?))?[?.!]?$/iu);
  if (recallRequest) {
    const memories = await recall(recallRequest[1] || "");
    const reply = memories.length ? `I remember: ${memories.map(item => item.content).join("; ")}` : "I don’t have a matching saved memory yet.";
    return { intent: "memory" as const, confidence: 1, explanation: "Encrypted local memory recalled", reply, query: value, source: "local" as const };
  }
  const nameRequest = value.trim().match(/^(?:orbit[, ]+)?(?:please )?(?:call|address) me (?:as )?([\p{L}][\p{L} .'-]{0,39})[.!]?$/iu);
  if (nameRequest) {
    const name = nameRequest[1].replace(/[.!]+$/, "").trim();
    await savePreferredName(name);
    return { intent: "answer" as const, confidence: 1, explanation: "Preferred name saved locally", reply: `Of course, ${name}. I'll call you ${name} from now on.`, query: value, source: "local" as const };
  }
  const local = planLocal(value);
  if (local.reply) local.reply = personalize(local.reply);
  if (["answer", "clarify", "notifications", "memory", "battery", "screen", "screenshot", "research", "browser", "github", "folder", "file", "mac_control", "email_draft", "email_rewrite", "contact_call", "social_draft", "social_publish", "weather", "news", "cricket", "soccer", "finance", "daily_brief", "youtube_play", "amazon_search", "page_describe", "page_summarize", "page_find"].includes(local.intent)) return local;
  const status = await ollamaStatus();
  if (!status.available) return local;
  try {
    const applications = await installedApplications();
    const plan = await planWithOllama({ command: value, history: conversation, installedApplications: applications });
    if (plan.intent === "launch" && (!plan.application || !applications.includes(plan.application))) return { intent: "clarify" as const, confidence: 1, explanation: "Application is not installed", reply: `I couldn't find ${plan.application || "that application"} on this Mac.`, query: value, source: "ollama" as const, model: OLLAMA_MODEL };
    if (plan.reply) plan.reply = personalize(plan.reply);
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
  const summary = state === "success" ? `${address()}, the latest ${run?.name || "workflow"} completed successfully.` : state === "pending" ? `${address()}, the latest ${run?.name || "workflow"} is still running.` : state === "failure" ? `${address()}, the latest ${run?.name || "workflow"} failed. Would you like a brief?` : `${address()}, I couldn't find a recent workflow run.`;
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

function executeActiveChromeJavaScript(javascript: string): Promise<string> {
  const script = `on run argv
tell application "Google Chrome"
activate
if (count of windows) is 0 then return "NO_WINDOW"
return execute active tab of front window javascript (item 1 of argv)
end tell
end run`;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script, javascript], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Chrome selection timed out")); }, 4_000);
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { error += String(chunk); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(error.trim() || "Orbit could not control the active Chrome tab"));
    });
    child.once("error", reason => { clearTimeout(timer); reject(reason); });
  });
}

async function updateYouTubeSelection(action: "select_result"|"selection_next"|"selection_previous"|"selection_open", requestedIndex?: number) {
  if (!activeBrowserSite?.hostname.includes("youtube.com")) throw new Error("Open YouTube search results first");
  if (action === "selection_open" && selectedYouTubeResult === null) throw new Error("Choose a video first, then say open it");
  const delta = action === "selection_next" ? 1 : action === "selection_previous" ? -1 : 0;
  const requested = Math.max(1, Math.min(10, Number(requestedIndex || 1)));
  const javascript = `(()=>{const action=${JSON.stringify(action)},requested=${requested},delta=${delta};
const all=[...document.querySelectorAll('ytd-video-renderer,ytd-rich-item-renderer')].filter(el=>el.querySelector('a#thumbnail[href*="/watch"]'));
if(!all.length)return JSON.stringify({error:'NO_RESULTS'});
const visible=all.filter(el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.width>0&&r.height>0});
let absolute=Number(window.__orbitSelectedVideoIndex);
if(action==='select_result'){const target=visible[requested-1];if(!target)return JSON.stringify({error:'NOT_ENOUGH',count:visible.length});absolute=all.indexOf(target)}
else absolute=Math.max(0,Math.min(all.length-1,(Number.isFinite(absolute)?absolute:0)+delta));
const target=all[absolute],link=target.querySelector('a#thumbnail[href*="/watch"]'),title=(target.querySelector('#video-title')?.textContent||'selected video').trim();
if(action==='selection_open'){link.click();delete window.__orbitSelectedVideoIndex;return JSON.stringify({opened:true,title})}
window.__orbitSelectedVideoIndex=absolute;
document.querySelectorAll('[data-orbit-selected]').forEach(el=>{el.style.outline='';el.style.boxShadow='';el.removeAttribute('data-orbit-selected')});
target.dataset.orbitSelected='true';target.style.outline='4px solid #9b7cff';target.style.boxShadow='0 0 0 8px rgba(155,124,255,.3)';target.scrollIntoView({behavior:'smooth',block:'center'});
return JSON.stringify({opened:false,title,absolute:absolute+1})})()`;
  let result: { error?: string; count?: number; opened?: boolean; title?: string; absolute?: number };
  try { result = JSON.parse(await executeActiveChromeJavaScript(javascript)); }
  catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Chrome selection failed"}. In Chrome, enable View → Developer → Allow JavaScript from Apple Events.`);
  }
  if (result.error === "NO_RESULTS") throw new Error("Orbit could not find YouTube video results in the active tab");
  if (result.error === "NOT_ENOUGH") throw new Error(`Only ${result.count || 0} video results are visible. Scroll a little and try again.`);
  if (result.opened) {
    selectedYouTubeResult = null;
    return { opened: true, url: "", site: "YouTube", summary: `Opening ${result.title || "the selected video"}, ${address()}.` };
  }
  selectedYouTubeResult = result.absolute || requested;
  return { opened: true, url: "", site: "YouTube", summary: `I highlighted ${result.title || "that video"}. Is this the one, ${address()}?` };
}

async function browserNavigate(request: { url?: string; query?: string; site?: string; sameTab?: boolean; browserAction?: "play_first"|"scroll_down"|"scroll_up"|"select_result"|"selection_next"|"selection_previous"|"selection_open"; resultIndex?: number }) {
  if (request.browserAction && ["select_result", "selection_next", "selection_previous", "selection_open"].includes(request.browserAction)) {
    return updateYouTubeSelection(request.browserAction as "select_result"|"selection_next"|"selection_previous"|"selection_open", request.resultIndex);
  }
  if (request.browserAction === "scroll_down" || request.browserAction === "scroll_up") {
    if (!activeBrowserSite) throw new Error("Open a website first, then ask Orbit to scroll it");
    const direction = request.browserAction === "scroll_down" ? 1 : -1;
    const javascript = `window.scrollBy({top:${direction}*Math.max(500,window.innerHeight*.78),behavior:'smooth'});'SCROLLED'`;
    const script = `on run argv
tell application "Google Chrome"
activate
if (count of windows) is 0 then return "NO_WINDOW"
return execute active tab of front window javascript (item 1 of argv)
end tell
end run`;
    const scrolled = await new Promise<boolean>(resolve => {
      const child = spawn("/usr/bin/osascript", ["-e", script, javascript], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 4_000);
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.once("close", code => { clearTimeout(timer); resolve(code === 0 && output.trim() === "SCROLLED"); });
      child.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (!scrolled) {
      const keyCode = request.browserAction === "scroll_down" ? "121" : "116";
      const fallback = `tell application "Google Chrome" to activate\ndelay 0.1\ntell application "System Events" to key code ${keyCode}`;
      const fallbackWorked = spawnSync("/usr/bin/osascript", ["-e", fallback], { encoding: "utf8" }).status === 0;
      if (!fallbackWorked) throw new Error("Allow Orbit to control Chrome in System Settings → Privacy & Security → Accessibility, then try scrolling again");
    }
    return { opened: true, url: "", site: activeBrowserSite.name, summary: `Scrolled ${request.browserAction === "scroll_down" ? "down" : "up"} on ${activeBrowserSite.name}, ${address()}.` };
  }
  if (request.browserAction === "play_first") {
    if (!activeBrowserSite?.hostname.includes("youtube.com") || !activeBrowserSite.query) throw new Error("Search YouTube first, then ask Orbit to play the first video");
    const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(activeBrowserSite.query)}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8_000) });
    const videoId = (await response.text()).match(/"videoId":"([A-Za-z0-9_-]{11})"/)?.[1];
    if (!videoId) throw new Error("Orbit couldn't identify the first YouTube result");
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    navigateActiveChromeTab(url);
    return { opened: true, url, site: "YouTube", summary: `Playing the first YouTube result, ${address()}.` };
  }
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
      if (usedPageSearch) return { opened: true, url: "", site: context.name, summary: `Searching ${context.name} for ${terms}, ${address()}.` };
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
  const keepActiveTab = Boolean(request.sameTab || (!request.url && activeBrowserSite));
  if (keepActiveTab) navigateActiveChromeTab(parsed.toString());
  else openChromeTab(parsed.toString());
  selectedYouTubeResult = null;
  const destination = parsed.hostname.replace(/^www\./, "");
  const names: Record<string, string> = { "youtube.com": "YouTube", "github.com": "GitHub", "google.com": "Google", "tesla.com": "Tesla", "reddit.com": "Reddit", "linkedin.com": "LinkedIn" };
  const matched = Object.entries(names).find(([domain]) => destination === domain || destination.endsWith(`.${domain}`));
  activeBrowserSite = { name: matched?.[1] || destination, hostname: parsed.hostname, query: parsed.hostname.includes("youtube.com") ? (parsed.searchParams.get("search_query") || undefined) : undefined };
  const searched = Boolean(request.query && !request.url);
  const summary = usedSiteFallback && activeBrowserSite ? `I couldn't control that site's search box, ${address()}, so I searched its pages through Google.` : searched ? `Searching ${activeBrowserSite.name} for ${String(request.query).slice(0, 80)}, ${address()}.` : keepActiveTab ? `Opening ${activeBrowserSite.name} in the current Chrome tab, ${address()}.` : `Opening ${activeBrowserSite.name} in a new Chrome tab, ${address()}.`;
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

async function draftEmail(request: { recipient?: string; subject: string; body: string; instruction?: string; provider?: "gmail"|"outlook"|"mail" }) {
  const requested = String(request.recipient || "").trim();
  if (!requested) return { drafted: false, summary: "Who would you like to email? Say a name or email address; the destination you choose can resolve it using its own suggestions." };
  let recipient = requested;
  let displayName = requested;
  const providers = destinationsFor("email").map(adapter => adapter.id) as ("gmail"|"outlook"|"mail")[];
  if (!request.provider) {
    const contacts = !requested.includes("@") ? contactsForName(requested).filter(match => match.emails.length) : [];
    if (contacts.length > 1 && contacts[0].score - contacts[1].score < 12) return { drafted: false, summary: `I found more than one ${requested}. Choose the correct recipient before I open the draft.`, recipient: requested, recipients: contacts };
    const contact = contacts[0];
    if (contact) { recipient = contact.emails[0]; displayName = contact.name; }
    let subject = String(request.subject && request.subject !== "Draft Email" ? request.subject : inferEmailSubject(request.instruction || "")).slice(0, 200);
    let body = String(request.body || "").slice(0, 5_000);
    if (!body && request.instruction) body = await generateEmailBody(displayName, request.instruction);
    activeEmailDraft = { recipient, displayName, subject, body };
    return { drafted: false, summary: `Review the draft for ${displayName}, then choose where to open it.`, recipient, displayName, subject, body, providers };
  }
  const adapter = destinationAdapter(request.provider);
  if (!requested.includes("@") && adapter.resolution === "system-contacts") {
    const matches = contactsForName(requested);
    const usable = matches.filter(match => match.emails.length);
    if (!usable.length) return { drafted: false, summary: `${adapter.label} could not resolve ${requested} through macOS Contacts. Choose Gmail or Outlook to use that service's own recipient suggestions, or provide an address.`, recipient: requested, providers, recipients: matches };
    if (usable.length > 1 && usable[0].score - usable[1].score < 12) return { drafted: false, summary: `I found more than one ${requested}. Choose the correct contact.`, recipients: usable };
    if (usable.length) { recipient = usable[0].emails[0]; displayName = usable[0].name; }
  }
  let subject = String(request.subject && request.subject !== "Draft Email" ? request.subject : inferEmailSubject(request.instruction || "")).slice(0, 200);
  let body = String(request.body || "").slice(0, 5_000);
  if (!body && request.instruction) body = await generateEmailBody(displayName, request.instruction);
  const mailto = new URL(`mailto:${recipient}`); mailto.searchParams.set("subject", subject); mailto.searchParams.set("body", body);
  if (request.provider === "gmail" || request.provider === "outlook") {
    const resolved = await openWebEmailDraft(request.provider, recipient, subject, body);
    return { drafted: true, summary: resolved ? `I opened the complete editable ${adapter.label} draft for ${displayName}. Recipient, subject, and body were inserted; it has not been sent.` : `I opened ${adapter.label} with the subject and body. Verify ${displayName} in the To suggestions before sending.`, recipient, displayName, subject, body, verifiedFields: resolved ? ["recipient","subject","body"] : ["subject","body"] };
  }
  else await shell.openExternal(mailto.toString());
  return { drafted: true, summary: `I opened the complete editable ${adapter.label} draft for ${displayName}. It has not been sent.`, recipient, displayName, subject, body, verifiedFields: ["recipient","subject","body"] };
}

async function generateEmailBody(displayName: string, instruction: string) {
  const saved = (await recall("")).map(item => item.content).filter(value => /\b(?:writing|email|message|tone|style|signature|professional|formal|casual|concise|direct)\b/i.test(value));
  const configured = `${writingPreferences.length}, ${writingPreferences.tone}, ${writingPreferences.natural ? "natural and not robotic" : "neutral"}; greeting ${writingPreferences.greeting}; sign as ${writingPreferences.signature}`;
  const preferences = [configured, ...saved];
  const prompt = `Write a complete polished email to ${displayName} from Nikhil. Preserve every material fact and requested outcome from the user's instruction, but rewrite it naturally rather than copying it verbatim. Follow these writing preferences: ${preferences.join("; ")}. User instruction: ${instruction}. Return only the email body with greeting, message, and sign-off. Do not add invented dates, reasons, promises, or details.`;
  try { return geminiStatus().available ? await answerWithGemini({ query: prompt, sources: [], history: conversation }) : (await ollamaStatus()).available ? await answerWithOllama({ query: prompt, sources: [], history: conversation }) : fallbackEmailBody(displayName, instruction, writingPreferences); }
  catch { return fallbackEmailBody(displayName, instruction, writingPreferences); }
}

async function rewriteEmail(request: { recipient?: string; subject?: string; body?: string; instruction: string }) {
  const current = request.body ? { recipient: request.recipient || "", displayName: request.recipient || "the recipient", subject: request.subject || "Email Draft", body: request.body } : activeEmailDraft;
  if (!current) return { drafted: false, summary: "There is no active email draft to revise. Ask me to draft one first." };
  const prompt = `Rewrite this email according to the instruction while preserving all facts. Instruction: ${request.instruction}. Current email:\n${current.body}`;
  const body = await generateEmailBody(current.displayName, prompt);
  activeEmailDraft = { ...current, body };
  return { drafted: false, summary: "I updated the active draft. Review it before opening an email app.", recipient: current.recipient, displayName: current.displayName, subject: current.subject, body, providers: destinationsFor("email").map(adapter => adapter.id) as ("gmail"|"outlook"|"mail")[] };
}

async function openWebEmailDraft(provider: "gmail"|"outlook", recipient: string, subject: string, body: string) {
  const adapter = destinationAdapter(provider);
  const emailAddress = recipient.includes("@");
  const url = new URL(adapter.composeUrl);
  url.searchParams.set(provider === "gmail" ? "su" : "subject", subject);
  url.searchParams.set("body", body);
  // Preserve the requested identity in the compose URL even when it is a
  // contact name. Gmail and Outlook can then expose their native suggestions,
  // and the To field is never silently left blank if Apple Events is blocked.
  url.searchParams.set("to", recipient);
  openChromeTab(url.toString());
  await new Promise(resolve => setTimeout(resolve, 2_800));
  if (emailAddress) {
    const expectedSubject = JSON.stringify(subject);
    const expectedBody = JSON.stringify(body.slice(0, 80));
    const verification = `(()=>{const subject=${expectedSubject},body=${expectedBody};const values=[...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(e=>String(e.value||e.innerText||e.textContent||''));const page=document.body.innerText||'';return values.some(v=>v.includes(subject))&&(values.some(v=>v.includes(body))||page.includes(body))?'VERIFIED':'UNVERIFIED'})()`;
    try { return (await executeActiveChromeJavaScript(verification)).includes("VERIFIED"); } catch { return false; }
  }
  const value = JSON.stringify(recipient);
  const typeScript = `(()=>{const value=${value};const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled};const selectors=${JSON.stringify(provider === "gmail" ? ["input[peoplekit-id]","input[aria-label*='To' i]","textarea[name='to']"] : ["input[aria-label*='To' i]","input[placeholder*='To' i]","input[role='combobox']"])};const input=selectors.flatMap(s=>[...document.querySelectorAll(s)]).find(visible);if(!input)return 'NO_TO';input.focus();const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set||Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;setter?setter.call(input,value):input.value=value;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));input.dispatchEvent(new Event('change',{bubbles:true}));return 'TYPED'})()`;
  let typed = "";
  try { typed = await executeActiveChromeJavaScript(typeScript); }
  catch {
    // Chrome disables JavaScript from Apple Events by default. The compose page
    // focuses To when no recipient is supplied, so use normal accessibility
    // keystrokes and let the destination show its own autocomplete results.
    const script = `on run argv
tell application "Google Chrome" to activate
delay 0.2
tell application "System Events"
keystroke (item 1 of argv)
delay 0.9
end tell
end run`;
    const fallback = spawnSync("/usr/bin/osascript", ["-e", script, recipient], { encoding: "utf8", timeout: 5_000 });
    if (fallback.status === 0) return false;
    // Last-resort deep link keeps the draft usable and avoids exposing a raw
    // AppleScript error. Gmail/Outlook can validate the value in their own UI.
    url.searchParams.set("to", recipient);
    navigateActiveChromeTab(url.toString());
    return false;
  }
  if (!typed.includes("TYPED")) throw new Error(`${adapter.label} opened, but Orbit could not find its recipient field. Confirm you are signed in and try again.`);
  await new Promise(resolve => setTimeout(resolve, 900));
  const chooseScript = `(()=>{const wanted=${value}.toLowerCase().replace(/\\s+/g,' ').trim();const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};const candidates=[...document.querySelectorAll('[role="option"],[role="listbox"] [role="button"],li[role="presentation"]')].filter(visible);const exact=candidates.find(e=>(e.innerText||e.textContent||'').toLowerCase().replace(/\\s+/g,' ').trim().startsWith(wanted));if(!exact)return 'SUGGESTIONS_OPEN';exact.click();return 'RESOLVED'})()`;
  return (await executeActiveChromeJavaScript(chooseScript)).includes("RESOLVED");
}

async function callContact(request: { recipient: string; value?: string }) {
  const matches = contactsForName(String(request.recipient || ""));
  const callable = matches.filter(match => match.phones.length || match.emails.length);
  if (!callable.length) return { drafted: false, summary: `I couldn't find a callable contact named ${request.recipient}.`, recipients: matches };
  if (!request.value) return { drafted: false, summary: `Choose how to call ${callable[0].name}. Orbit will ask once more before starting the call.`, recipients: callable };
  const target = request.value.trim();
  await shell.openExternal(target.includes("@") ? `facetime://${encodeURIComponent(target)}` : `tel://${encodeURIComponent(target)}`);
  return { drafted: true, summary: `Opening the call for ${callable[0].name}.` };
}

async function socialDraft(request: { instruction?: string; content?: string; provider?: "linkedin"|"facebook" }) {
  let content = String(request.content || "").trim();
  const instruction = String(request.instruction || "").trim();
  if (!content) {
    const platform = request.provider ? ` for ${request.provider}` : "";
    const prompt = `Write a polished, natural social media post${platform}. User request: ${instruction}. Return only the post text. Do not invent achievements or facts. Avoid excessive emojis and hashtags.`;
    try { content = geminiStatus().available ? await answerWithGemini({ query: prompt, sources: [], history: conversation }) : (await ollamaStatus()).available ? await answerWithOllama({ query: prompt, sources: [], history: conversation }) : instruction; } catch { content = instruction; }
  }
  content = content.replace(/^```\w*\s*|\s*```$/g, "").trim().slice(0, 3_000);
  if (!request.provider) return { drafted: false, summary: "Your post is ready. Where should I open the editable draft?", content, providers: ["linkedin", "facebook"] as const };
  const provider = request.provider;
  openChromeTab(destinationAdapter(provider).composeUrl);
  await new Promise(resolve => setTimeout(resolve, 2_800));
  const encoded = JSON.stringify(content);
  const openComposer = provider === "linkedin" ? `(()=>{const start=[...document.querySelectorAll('button')].find(b=>/start a post/i.test(b.innerText||b.getAttribute('aria-label')||''));if(!start)return 'NO_COMPOSER';start.click();return 'OPENED'})()` : `(()=>{const start=[...document.querySelectorAll('[role="button"]')].find(b=>/what.*mind|create post/i.test((b.innerText||b.getAttribute('aria-label')||'').toLowerCase()));if(!start)return 'NO_COMPOSER';start.click();return 'OPENED'})()`;
  let result = ""; try { result = await executeActiveChromeJavaScript(openComposer); } catch { throw new Error("Orbit opened the site but Chrome blocked composer control. Enable View → Developer → Allow JavaScript from Apple Events, then try again."); }
  if (!result.includes("OPENED")) throw new Error(`Orbit opened ${provider}, but could not find the post composer. Confirm you are signed in, then try again.`);
  await new Promise(resolve => setTimeout(resolve, 900));
  const insert = `(()=>{const boxes=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],.ql-editor[contenteditable="true"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});const box=boxes.at(-1);if(!box)return 'NO_EDITOR';box.focus();document.execCommand('selectAll',false);document.execCommand('insertText',false,${encoded});box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${encoded}}));const actual=(box.innerText||box.textContent||'').replace(/\\s+/g,' ').trim();const wanted=${encoded}.replace(/\\s+/g,' ').trim();return actual.includes(wanted.slice(0,Math.min(80,wanted.length)))?'VERIFIED':'UNVERIFIED'})()`;
  try { result = await executeActiveChromeJavaScript(insert); } catch { result = "UNVERIFIED"; }
  if (!result.includes("VERIFIED")) throw new Error(`Orbit opened ${provider}, but could not verify that the post text was inserted. Your draft remains available in Orbit.`);
  activeSocialDraft = { provider, content };
  return { drafted: true, summary: `I inserted an editable ${provider === "linkedin" ? "LinkedIn" : "Facebook"} draft. Review it or ask me to revise it. It has not been published.`, content, provider };
}

async function socialPublish(provider: "linkedin"|"facebook") {
  if (!activeSocialDraft || activeSocialDraft.provider !== provider) return { published: false, summary: "There is no active draft for that destination." };
  const approval = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", "Publish"], defaultId: 0, cancelId: 0, title: `Publish to ${provider === "linkedin" ? "LinkedIn" : "Facebook"}?`, message: "Publish the currently visible post?", detail: activeSocialDraft.content.slice(0, 500) });
  if (approval.response !== 1) return { published: false, summary: "Publication cancelled. Your draft remains open." };
  const javascript = `(()=>{const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(b=>/^(post|publish|share)$/i.test((b.innerText||b.getAttribute('aria-label')||'').trim())&&!b.disabled);const button=buttons.at(-1);if(!button)return 'NO_BUTTON';button.click();return 'CLICKED'})()`;
  const result = await executeActiveChromeJavaScript(javascript);
  if (!result.includes("CLICKED")) return { published: false, summary: "I could not verify a publish button, so nothing was posted." };
  activeSocialDraft = null;
  return { published: true, summary: `The ${provider === "linkedin" ? "LinkedIn" : "Facebook"} publish action was confirmed and submitted.` };
}

function currentLocation(): Promise<{ latitude: number; longitude: number }> {
  if (process.platform !== "darwin") return Promise.reject(new Error("Local weather location is currently available on macOS only"));
  if (locationRequest) return Promise.reject(new Error("A location request is already in progress"));
  const wasRunning = Boolean(speechProcess);
  if (!speechProcess) startSpeech();
  return new Promise((resolve, reject) => {
    const send = () => {
      if (!speechProcess?.stdin.writable) { reject(new Error("Orbit's location helper is unavailable")); return; }
      const timer = setTimeout(() => { locationRequest = null; reject(new Error("Location permission timed out. Check macOS Location Services for Orbit.")); }, 15_000);
      locationRequest = { resolve, reject, timer };
      speechProcess!.stdin.write("location\n");
    };
    // A freshly spawned helper's stdin pipe can take a tick to become writable;
    // give it a short grace period instead of failing on the very first request.
    if (wasRunning || speechProcess?.stdin.writable) send();
    else setTimeout(send, 400);
  });
}

const liveInfo = createLiveInformationEngine([
  createWeatherService(currentLocation),
  createNewsService(),
  createSportsService(),
  createFinanceService(),
  createCalendarService(),
  createEmailService(),
]);

async function research(query: string, progress?: (event: import("../shared/contracts.js").ResearchProgress) => void): Promise<ResearchAnswer> {
  const clean = query.trim().slice(0, 500);
  if (!clean) throw new Error("Orbit needs a question to research");
  progress?.({ stage: "thinking", message: "Understanding your question and planning the research" });
  const sources = shouldReadTheWeb(clean) ? await researchPublicWeb(clean, fetch, progress) : [];
  progress?.({ stage: "writing", message: sources.length ? "Preparing a cited answer" : "Preparing the answer" });
  let answer: string;
  if (geminiStatus().available) answer = await answerWithGemini({ query: clean, sources, history: conversation });
  else {
    const status = await ollamaStatus();
    if (status.available) answer = await answerWithOllama({ query: clean, sources, history: conversation });
    else if (sources.length) answer = `Here are the most relevant current results: ${sources.slice(0, 3).map((source, index) => `[${index + 1}] ${source.title}. ${source.excerpt}`).join(" ")}`;
    else throw new Error("Start Ollama or add a free Gemini API key in Settings to answer general questions");
  }
  answer = personalize(answer);
  const spokenAnswer = answer.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").slice(0, 470).trim();
  return { answer, spokenAnswer, sources, updatedAt: new Date().toISOString() };
}

function batteryStatus() {
  if (process.platform !== "darwin") throw new Error("Battery status is currently available on macOS only");
  const output = spawnSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8" }).stdout;
  const match = output.match(/(\d+)%.*?;\s*(charging|charged|discharging|finishing charge)/i);
  if (!match) throw new Error("This Mac did not report a battery level");
  const percentage = Number(match[1]);
  const charging = /charging|charged/i.test(match[2]);
  const timeRemaining = output.match(/(\d+:\d+) remaining/i)?.[1];
  const summary = `${address()}, your battery is at ${percentage}% and it is ${charging ? "charging" : "not charging"}${timeRemaining ? `, with about ${timeRemaining} remaining` : ""}.`;
  return { percentage, charging, timeRemaining, summary };
}

async function capturePrimaryScreen() {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: display.size, fetchWindowIcons: false });
  const capture = sources.find(source => source.display_id === String(display.id)) || sources[0];
  if (!capture || capture.thumbnail.isEmpty()) throw new Error("Orbit could not capture the screen. Allow Screen Recording in System Settings → Privacy & Security.");
  return capture.thumbnail.toPNG();
}

async function takeScreenshot() {
  const png = await capturePrimaryScreen();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(app.getPath("desktop"), `Orbit Screenshot ${stamp}.png`);
  await writeFile(target, png);
  shell.showItemInFolder(target);
  return { saved: true, path: target, summary: `Screenshot saved to Desktop as ${path.basename(target)}.` };
}

async function describeScreen(query: string): Promise<ResearchAnswer> {
  if (!geminiKey()) throw new Error("Add your free Gemini API key in Settings before using screen understanding");
  const png = await capturePrimaryScreen();
  const answer = personalize(await answerWithGemini({ query: query || "Describe what is visible on my screen", history: conversation, imageBase64: png.toString("base64") }));
  const spokenAnswer = answer.replace(/\s+/g, " ").slice(0, 470).trim();
  conversation.push({ role: "user", content: query }, { role: "assistant", content: answer });
  return { answer, spokenAnswer, sources: [], updatedAt: new Date().toISOString() };
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
  ipcMain.handle("orbit:files:find", (_event, query: string) => traced("files.find", () => findFiles(String(query).slice(0, 300))));
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
  ipcMain.handle("orbit:folder:open", (_event, requested: string) => traced("files.open", async () => {
    const folders: Record<string, string> = { documents: "Documents", downloads: "Downloads", desktop: "Desktop", projects: "Projects", developer: "Developer" };
    if (requested === "__first__") {
      if (!activeFolderPath) throw new Error("Open a Finder folder first, then ask Orbit to open its first file");
      const entries = (await readdir(activeFolderPath, { withFileTypes: true }))
        .filter(entry => !entry.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const first = entries.find(entry => entry.isFile()) || entries[0];
      if (!first) throw new Error("That Finder folder is empty");
      const opened = (await shell.openPath(path.join(activeFolderPath, first.name))) === "";
      return { opened, folder: first.name };
    }
    const folder = folders[String(requested).toLowerCase()];
    if (!folder) throw new Error("Orbit only opens approved home folders");
    activeFolderPath = path.join(os.homedir(), folder);
    const opened = (await shell.openPath(activeFolderPath)) === "";
    return { opened, folder };
  }));
  ipcMain.handle("orbit:app:launch", (_event, application: string) => traced("app.launch", () => launchApplication(String(application))));
  ipcMain.handle("orbit:mac:permissions", () => traced("mac.permissions", macPermissionStatus));
  ipcMain.handle("orbit:mac:control", (_event, request) => {
    const mutation = ["create_folder", "move_path", "rename_path"].includes(String(request?.action));
    return traced(mutation ? "mac.files.change" : "mac.control", () => executeMacControl(request));
  });
  ipcMain.handle("orbit:email:draft", (_event, request) => traced("email.draft", () => draftEmail(request || { subject: "", body: "" })));
  ipcMain.handle("orbit:email:rewrite", (_event, request) => traced("email.draft", () => rewriteEmail(request)));
  ipcMain.handle("orbit:writing-preferences:get", () => writingPreferences);
  ipcMain.handle("orbit:writing-preferences:save", (_event, preferences) => saveEmailPreferences(preferences));
  ipcMain.handle("orbit:contact:call", (_event, request) => traced("contact.call", () => callContact(request || { recipient: "" })));
  ipcMain.handle("orbit:window:show-main", () => { if (!mainWindow) createWindow(); mainWindow?.show(); mainWindow?.focus(); return { shown: Boolean(mainWindow) }; });
  ipcMain.handle("orbit:overlay:state", (_event, state) => { overlayWindow?.webContents.send("orbit:overlay:state", state); return { updated: Boolean(overlayWindow) }; });
  ipcMain.handle("orbit:social:draft", (_event, request) => traced("social.draft", () => socialDraft(request || {})));
  ipcMain.handle("orbit:social:publish", (_event, provider) => traced("social.publish", () => socialPublish(provider)));
  ipcMain.handle("orbit:conversation:list", () => conversationEntries);
  ipcMain.handle("orbit:conversation:append", (_event, turn: ConversationTurn) => appendConversation({ role: turn?.role === "assistant" ? "assistant" : "user", content: String(turn?.content || "") }));
  ipcMain.handle("orbit:conversation:clear", () => {
    conversationEntries = [];
    conversation.splice(0);
    saveConversation();
    return { cleared: true };
  });
  ipcMain.handle("orbit:github:workflow", (_event, repository?: string) => traced("github.workflow", () => githubWorkflow(repository)));
  ipcMain.handle("orbit:browser:navigate", (_event, request: { url?: string; query?: string; site?: string; sameTab?: boolean; browserAction?: "play_first"|"scroll_down"|"scroll_up"|"select_result"|"selection_next"|"selection_previous"|"selection_open"; resultIndex?: number }) => traced("browser.navigate", () => browserNavigate(request || {})));
  ipcMain.handle("orbit:live:info", (_event, request: { query: string; services?: string[] }) => traced("live.info", () => liveInfo.handle(String(request?.query || ""), request?.services)));
  ipcMain.handle("orbit:browser:youtube", (_event, query: string) => traced("browser.agent.youtube", () => youtubePlayFirst(String(query || ""))));
  ipcMain.handle("orbit:browser:amazon", (_event, request: { query: string; maxPrice?: number; minPrice?: number }) => traced("browser.agent.amazon", () => amazonSearchWithPriceFilter(String(request?.query || ""), request?.maxPrice, request?.minPrice)));
  ipcMain.handle("orbit:browser:describe", () => traced("browser.agent.describe", async () => ({ summary: await describeCurrentPage() })));
  ipcMain.handle("orbit:browser:summarize", () => traced("browser.agent.summarize", async () => ({ summary: await summarizeCurrentPage() })));
  ipcMain.handle("orbit:browser:find", (_event, query: string) => traced("browser.agent.find", async () => ({ summary: await findOnPage(String(query || "")) })));
  ipcMain.handle("orbit:web:research", (event, query: string) => traced("web.research", () => research(String(query), progress => event.sender.send("orbit:web:progress", progress))));
  ipcMain.handle("orbit:system:battery", () => traced("system.battery", async () => batteryStatus()));
  ipcMain.handle("orbit:screen:describe", (_event, query: string) => traced("screen.describe", () => describeScreen(String(query).slice(0, 500))));
  ipcMain.handle("orbit:screen:capture", () => traced("screen.capture", takeScreenshot));
  ipcMain.handle("orbit:gemini:status", () => geminiStatus());
  ipcMain.handle("orbit:gemini:configure", (_event, key: string) => traced("gemini.configure", async () => { await saveGeminiKey(String(key)); return geminiStatus(); }));
  ipcMain.handle("orbit:gemini:budget", (_event, value: number) => traced("gemini.budget", async () => { setGeminiBudget(Number(value)); return geminiStatus(); }));
  ipcMain.handle("orbit:play:start", (_event, requested: OrbitPlayMode) => {
    orbitPlayMode = requested === "desktop" ? "desktop" : "playground";
    orbitPlayActive = true;
    if (orbitPlayMode === "desktop" && process.platform === "darwin" && !gestureProcess) {
      const binary = app.isPackaged
        ? path.join(process.resourcesPath, "sidecar", "orbit-gesture")
        : path.join(app.getAppPath(), "release-sidecar", "orbit-gesture");
      if (existsSync(binary)) {
        gestureProcess = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
        gestureProcess.once("close", () => { gestureProcess = null; orbitPlayActive = false; });
      }
    }
    const supported = orbitPlayMode === "playground" || Boolean(gestureProcess);
    if (!supported) orbitPlayActive = false;
    return { active: orbitPlayActive, mode: orbitPlayMode, supported, permission: "unknown", message: supported ? "Orbit Play is active. Camera processing stays on this Mac." : "Build the macOS gesture helper before using desktop control." };
  });
  ipcMain.handle("orbit:play:stop", () => {
    orbitPlayActive = false;
    if (gestureProcess) { gestureProcess.stdin.write('{"action":"up","x":0.5,"y":0.5}\n'); gestureProcess.kill(); gestureProcess = null; }
    return { active: false, mode: orbitPlayMode, supported: true, permission: "unknown", message: "Orbit Play stopped." };
  });
  ipcMain.handle("orbit:play:action", (_event, gesture: OrbitPlayGesture) => {
    if (!orbitPlayActive) return { accepted: false };
    const allowed = new Set(["move", "down", "up", "scroll", "media-toggle", "stop"]);
    if (!gesture || !allowed.has(gesture.action)) return { accepted: false };
    if (gesture.action === "stop") {
      orbitPlayActive = false;
      gestureProcess?.stdin.write('{"action":"up","x":0.5,"y":0.5}\n');
      return { accepted: true };
    }
    if (orbitPlayMode !== "desktop" || !gestureProcess) return { accepted: false };
    const now = Date.now();
    if (gesture.action === "move" && now - lastGestureAt < 24) return { accepted: false };
    lastGestureAt = now;
    const safe: OrbitPlayGesture = { action: gesture.action };
    if (gesture.x !== undefined) safe.x = Math.max(0, Math.min(1, Number(gesture.x)));
    if (gesture.y !== undefined) safe.y = Math.max(0, Math.min(1, Number(gesture.y)));
    if (gesture.deltaY !== undefined) safe.deltaY = Math.max(-80, Math.min(80, Number(gesture.deltaY)));
    gestureProcess.stdin.write(`${JSON.stringify(safe)}\n`);
    return { accepted: true };
  });
  ipcMain.handle("orbit:voice:speak", (_event, text: string) => { speak(text); return true; });
  ipcMain.handle("orbit:voice:start", () => { startSpeech(); return { started: Boolean(speechProcess) }; });
  ipcMain.handle("orbit:voice:stop", () => { stopSpeech(); return { stopped: true }; });
  ipcMain.handle("orbit:speech:stop", () => ({ stopped: stopSpeaking() }));
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

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const display = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: 104, height: 104, x: display.x + display.width - 128, y: display.y + Math.round(display.height * .44),
    frame: false, transparent: true, backgroundColor: "#00000000", resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: true,
    webPreferences: { preload: path.join(app.getAppPath(), "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) { const url = new URL(dev); url.searchParams.set("overlay", "1"); void window.loadURL(url.toString()); }
  else void window.loadFile(path.join(here, "../../dist-renderer/index.html"), { query: { overlay: "1" } });
  overlayWindow = window;
  window.on("closed", () => { overlayWindow = null; });
  return window;
}

app.whenReady().then(async () => {
  audit = new AuditStore(path.join(app.getPath("userData"), "orbit-audit.jsonl"));
  loadConversation();
  await loadProfile();
  registerIPC(); createWindow(); createOverlayWindow();
  globalShortcut.register("CommandOrControl+Shift+Space", () => { createOverlayWindow(); armVoice(); });
  startSpeech();
  if (app.isPackaged) setTimeout(() => void autoUpdater.checkForUpdatesAndNotify(), 8_000);
  app.on("activate", () => { if (!mainWindow) createWindow(); createOverlayWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { quitting = true; globalShortcut.unregisterAll(); overlayWindow?.destroy(); spokenReply?.kill(); speechProcess?.kill(); gestureProcess?.kill(); });
