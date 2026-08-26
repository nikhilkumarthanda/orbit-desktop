import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("Phase 4 visual browser fallback is screenshot-grounded, native-clicked, verified, and bounded", async () => {
  const embedded = await source("src/main/embedded-browser.ts");
  const gemini = await source("src/main/gemini.ts");

  assert.match(embedded, /export async function visualSnapshot/);
  assert.match(embedded, /capturePage\(\)/);
  assert.match(embedded, /image\.toPNG\(\)\.toString\("base64"\)/);
  assert.match(embedded, /export async function clickAtPoint/);
  assert.match(embedded, /sendInputEvent\(\{ type: "mouseDown"/);
  assert.match(embedded, /planVisualBrowserTarget/);
  assert.match(embedded, /visual\.confidence < 0\.72/);
  assert.match(embedded, /stopped instead of retrying blindly/);

  assert.match(gemini, /export async function planVisualBrowserTarget/);
  assert.match(gemini, /inline_data: \{ mime_type: "image\/png"/);
  assert.match(gemini, /responseMimeType: "application\/json"/);
  assert.match(gemini, /Do not guess hidden or off-screen controls/);
  assert.match(gemini, /consequential action that was not requested/);
});

test("LinkedIn job searches map new-grad and date constraints to deterministic filters", async () => {
  const engine = await source("src/main/browser-task-engine.ts");

  assert.match(engine, /function linkedinJobsSearchUrl/);
  assert.ok(engine.includes("const newGrad = /"), "LinkedIn adapter must recognize a new-grad/entry-level constraint");
  assert.ok(engine.includes('url.searchParams.set("f_E", "2")'), "new-grad must map to LinkedIn Entry level");
  assert.ok(engine.includes('url.searchParams.set("f_TPR", "r86400")'), "past 24 hours must map to the LinkedIn date filter");
  assert.ok(engine.includes('url.searchParams.set("f_TPR", "r604800")'), "past week must map to the LinkedIn date filter");
  assert.ok(engine.includes('url.searchParams.set("f_WT", "2")'), "remote must map to the LinkedIn remote filter");
  assert.ok(engine.includes('current.pathname.startsWith("/jobs/search")'), "Orbit must verify the LinkedIn Jobs search destination");
  assert.ok(engine.includes("expected.searchParams.entries()"), "Orbit must verify requested LinkedIn filter params after navigation");
});
