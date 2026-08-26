import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("Phase 4.2 visually fills and selects with local verified bounded actions", async () => {
  const embedded = await source("src/main/embedded-browser.ts");
  const gemini = await source("src/main/gemini.ts");
  const preload = await source("preload.cjs");

  assert.match(gemini, /VisualBrowserTargetKind = "click" \| "field" \| "option"/);
  assert.match(gemini, /targetKind\?: VisualBrowserTargetKind/);
  assert.match(gemini, /targetKind === "field"/);
  assert.match(gemini, /targetKind === "option"/);

  assert.match(embedded, /export type BrowserAgentActivity/);
  for (const state of ["reading_dom", "visual_inspection", "target_found", "acting", "verifying"]) assert.ok(embedded.includes(state));
  assert.match(embedded, /async function nativeReplaceFocusedText/);
  assert.match(embedded, /insertText\(value\)/);
  assert.match(embedded, /async function visualFill/);
  assert.match(embedded, /async function visualSelect/);
  assert.match(embedded, /BLOCKED_SECRET_INPUT/);
  assert.match(embedded, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
  assert.match(embedded, /const allowRetry = !CONSEQUENTIAL_LABEL\.test\(label\)/);
  assert.match(embedded, /field did not retain the requested value after one corrected retry/);
  assert.match(embedded, /could not verify that the selection stuck after one corrected retry/);

  for (const label of ["READING DOM", "VISUAL INSPECTION", "TARGET FOUND", "ACTING", "VERIFYING"]) assert.ok(preload.includes(label));
});

test("Career site adapter recognizes ATS forms and custom comboboxes without auto-submit", async () => {
  const career = await source("src/main/career-agent.ts");

  assert.match(career, /export type CareerSiteAdapter/);
  assert.match(career, /export function careerSiteAdapter/);
  assert.ok(career.includes("greenhouse.io"));
  assert.ok(career.includes("lever.co"));
  assert.ok(career.includes("myworkdayjobs.com"));
  assert.ok(career.includes('"combobox"'));
  assert.ok(career.includes('["select", "combobox"]'));
  assert.match(career, /multiStep/);
  assert.match(career, /sensitiveField\.test\(control\.label\)/);
  assert.match(career, /Orbit did not submit anything/);
});
