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

test("OpenAI planning is structured and credentials remain main-process only", async () => {
  const fs = await import("node:fs/promises");
  const planner = await fs.readFile(new URL("../src/main/openai.ts", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(planner, /type: "json_schema"/);
  assert.match(planner, /additionalProperties: false/);
  assert.match(planner, /gpt-5\.6-terra/);
  assert.match(main, /safeStorage\.encryptString/);
  assert.doesNotMatch(preload, /readApiKey|decryptString|openai-key\.bin/);
  assert.match(main, /Cloud planner unavailable/);
});

test("voice commands cross only registered IPC and typed planner boundaries", async () => {
  const fs = await import("node:fs/promises");
  const speech = await fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(speech, /wakePhrases\.first/);
  assert.match(main, /CommandOrControl\+Shift\+Space/);
  assert.match(preload, /orbit:voice:command/);
  assert.doesNotMatch(preload, /child_process|exec\(|spawn\(/);
});

test("wake phrase recognition tolerates punctuation and common transcription variants", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8"));
  assert.match(source, /CharacterSet\.alphanumerics\.inverted/);
  assert.match(source, /"hey orbit", "hay orbit", "hey orbid", "hey or bit"/);
});
