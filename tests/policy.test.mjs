import test from "node:test";
import assert from "node:assert/strict";

test("destructive tools require approval in source policy", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/policy.ts", import.meta.url), "utf8"));
  assert.match(source, /name: "files\.trash", risk: "destructive", approvalRequired: true/);
});

test("renderer confirms before trashing", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8"));
  assert.match(source, /confirm\(`Move/);
});

test("main process owns destructive approval", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"));
  assert.match(source, /showMessageBox/);
  assert.match(source, /approval\.response !== 1/);
});

test("knowledge access is folder-scoped and cited", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  assert.match(main, /showOpenDialog/);
  assert.match(renderer, /Open cited file/);
});

test("sandbox preload uses a CommonJS context bridge", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(main, /preload\.cjs/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("orbit"/);
});

test("application launching is constrained to discovered installed apps and storage is rendered", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  assert.match(main, /const allowed = new Set\(await installedApplications\(\)\)/);
  assert.match(main, /entry\.name\.endsWith\("\.app"\)/);
  assert.match(renderer, /Storage volumes/);
});

test("Ollama planning is local, structured, and requires no cloud credential", async () => {
  const fs = await import("node:fs/promises");
  const planner = await fs.readFile(new URL("../src/main/ollama.ts", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(planner, /127\.0\.0\.1:11434/);
  assert.match(planner, /additionalProperties: false/);
  assert.match(planner, /qwen3:4b/);
  assert.match(planner, /think: false/);
  assert.match(planner, /keep_alive: "10m"/);
  assert.match(planner, /num_predict: 1000/);
  assert.match(main, /Local greeting matched/);
  assert.doesNotMatch(planner, /api\.openai\.com|Authorization|Bearer/);
  assert.doesNotMatch(main + preload, /saveApiKey|readApiKey|decryptString/);
  assert.match(main, /Local model unavailable/);
});

test("voice commands cross only registered IPC and typed planner boundaries", async () => {
  const fs = await import("node:fs/promises");
  const speech = await fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(speech, /NSSpeechRecognizerDelegate/);
  assert.match(main, /CommandOrControl\+Shift\+Space/);
  assert.match(preload, /orbit:voice:command/);
  assert.doesNotMatch(preload, /child_process|exec\(|spawn\(/);
});

test("wake phrase uses a dedicated recognizer before fresh command capture", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8"));
  assert.match(source, /commands = \["Hey Orbit", "Orbit"\]/);
  assert.match(source, /startWakeListening/);
  assert.match(source, /activateCommandCapture/);
  assert.match(source, /requiresOnDeviceRecognition = false/);
  assert.match(source, /followupMode \? 20 : 12/);
});

test("microphone can be released and Orbit uses the boss voice persona", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const planner = await fs.readFile(new URL("../src/main/ollama.ts", import.meta.url), "utf8");
  assert.match(main, /orbit:voice:stop/);
  assert.match(main, /speechProcess\.kill\(\)/);
  assert.match(main, /\["Ava", "Samantha", "Daniel"\]/);
  assert.match(main, /naturalSpeech/);
  assert.match(renderer, /Mic on/);
  assert.match(planner, /Address the user as Boss/);
});

test("A+C command deck keeps voice controls in sidebar flow", async () => {
  const fs = await import("node:fs/promises");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const wake = await fs.readFile(new URL("../src/renderer/wake.css", import.meta.url), "utf8");
  const deck = await fs.readFile(new URL("../src/renderer/command-deck.css", import.meta.url), "utf8");
  assert.match(renderer, /<nav>.*<VoiceConsole\/>/s);
  assert.match(renderer, /className="command-core"/);
  assert.doesNotMatch(wake, /\.voice-console\{position:fixed/);
  assert.match(deck, /deck-spin/);
  assert.match(deck, /core-orb/);
});
