import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("YouTube play requests use deterministic Orbit Browser recovery", async () => {
  const engine = await source("src/main/browser-task-engine.ts");
  assert.match(engine, /function youtubePlayTerms/);
  assert.match(engine, /youtube\.com\/results\?search_query=/);
  assert.match(engine, /function dynamicPageSnapshot/);
  assert.match(engine, /Waiting for YouTube to finish rendering/);
  assert.match(engine, /youtubeResultControl/);
  assert.match(engine, /youtubeWatchUrl/);
  assert.match(engine, /if \(play\) return youtubeWatchUrl\(pageUrl\)/);
  assert.match(engine, /best matching YouTube result/i);
});

test("open calculator bypasses browser context and launches native Calculator", async () => {
  const preload = await source("preload.cjs");
  assert.match(preload, /function nativeApplicationRequest/);
  assert.match(preload, /return "Calculator"/);
  assert.match(preload, /orbit:app:launch/);
  assert.match(preload, /Native application shortcut matched before browser routing/);
  const nativeIndex = preload.indexOf("const nativeApplication = nativeApplicationRequest(value)");
  const browserIndex = preload.indexOf("const browserFollowUp =");
  assert.ok(nativeIndex >= 0 && browserIndex >= 0 && nativeIndex < browserIndex, "native app routing must run before browser follow-up routing");
});

test("career/browser consequential actions remain approval gated", async () => {
  const [engine, preload] = await Promise.all([source("src/main/browser-task-engine.ts"), source("preload.cjs")]);
  const risky = engine.match(/const riskyLabels = .*;/)?.[0] || "";
  for (const action of ["send", "submit", "publish", "post", "connect"]) assert.match(risky, new RegExp(action));
  assert.match(preload, /APPROVE NEXT/);
  assert.match(preload, /orbit:browser:task:resume/);
});
