import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import updater from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore } from "./audit.js";
import { policies, policy } from "./policy.js";
import { cleanupPlan, gitContexts, recentWork, systemSnapshot } from "./tools.js";
import { ollamaStatus, OLLAMA_MODEL, planWithOllama } from "./ollama.js";
import type { CommandPlan, ConversationTurn } from "../shared/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let audit: AuditStore;
let mainWindow: BrowserWindow | null = null;
let speechProcess: ChildProcessWithoutNullStreams | null = null;
const { autoUpdater } = updater;
const conversation: ConversationTurn[] = [];

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
  const raw = String(text).slice(0, 470).trim();
  if (!raw) return;
  const spoken = /\bboss\b/i.test(raw) ? raw : `Boss, ${raw}`;
  if (protectListener && speechProcess?.stdin.writable) speechProcess.stdin.write("pause\n");
  const child = spawn("/usr/bin/say", ["-v", "Daniel", "-r", "168", spoken], { detached: true, stdio: "ignore" });
  if (protectListener) child.once("close", () => setTimeout(() => {
    if (speechProcess?.stdin.writable) speechProcess.stdin.write("resume\n");
  }, 450));
  child.unref();
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
  const command = value.trim().toLowerCase();
  if (/^(hi|hello|hey|good (morning|afternoon|evening))( orbit)?[!.?]*$/.test(command)) return { intent: "answer", confidence: 1, explanation: "Local greeting matched", reply: "Yes, boss? At your service.", query: value, source: "local" };
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
  if (local.intent === "answer") return local;
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
    const detail = error instanceof Error ? error.message : "Unknown local inference error";
    return { intent: "clarify", confidence: 1, explanation: "Local model unavailable", reply: `Boss, Ollama is installed but inference failed. ${detail}`, query: value, source: "local" };
  }
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
