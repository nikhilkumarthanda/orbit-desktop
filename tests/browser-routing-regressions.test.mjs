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
  assert.match(engine, /function youtubeSearchMatches/);
  assert.match(engine, /Correcting YouTube to the search results/);
  assert.match(engine, /YouTube search results are still rendering/);
  assert.match(engine, /if \(play\) return youtubeWatchUrl\(pageUrl\)/);
  assert.match(engine, /targetUrl\.search/);
  assert.match(engine, /best matching YouTube result/i);
});

test("dedicated YouTube playback stays embedded and respects visible result order", async () => {
  const workflow = await source("src/main/browser-workflows.ts");
  assert.match(workflow, /import \* as embedded from "\.\/embedded-browser\.js"/);
  assert.match(workflow, /let lastYouTubeSearch = ""/);
  assert.match(workflow, /function ordinalFromQuery/);
  assert.match(workflow, /function youtubeResultControls/);
  assert.match(workflow, /const chosen = results\[0\]/);
  assert.match(workflow, /return openCurrentYouTubeResult\(ordinal\)/);
  assert.match(workflow, /await embedded\.goBack\(\)/);
  assert.match(workflow, /const chosen = results\[index\]/);
  assert.match(workflow, /await embedded\.clickByLabel\(chosen\.label\)/);
  assert.match(workflow, /youtube\.com\\\/watch/);
  assert.doesNotMatch(workflow, /function bestYouTubeResult|strongEarly/);
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

test("Stack Overflow and MDN searches route directly to deterministic Orbit Browser tasks", async () => {
  const preload = await source("preload.cjs");
  assert.match(preload, /function technicalSiteBrowserGoal/);
  assert.match(preload, /stack\\s\*over\\s\*flow/);
  assert.match(preload, /https:\/\/stackoverflow\.com\/search\?q=/);
  assert.match(preload, /https:\/\/developer\.mozilla\.org\/en-US\/search\?q=/);
  assert.match(preload, /const technicalSite = !external \? technicalSiteBrowserGoal\(value\) : ""/);
  assert.match(preload, /intent: "browser_task"/);
  assert.match(preload, /Direct embedded technical-site routing matched before legacy browser planning/);
  assert.match(preload, /stack\\s\*over\\s\*flow\|stackoverflow\|mdn\|mozilla\\s\+developer/);
});

test("external browsers require an explicit browser request", async () => {
  const preload = await source("preload.cjs");
  assert.match(preload, /function enforceOrbitBrowserDefault/);
  assert.match(preload, /plan\.intent === "browser" \|\| externalLaunch/);
  assert.match(preload, /Orbit Browser is the default web surface unless an external browser is explicitly requested/);
  assert.match(preload, /const planned = await ipcRenderer\.invoke\("orbit:command:plan"/);
  assert.match(preload, /return enforceOrbitBrowserDefault\(value, planned\)/);
  assert.match(preload, /(?:open\|launch\|start).*chrome.*safari.*firefox.*edge.*brave/s);
});

test("embedded browser layout prioritizes the web viewport and compacts Orbit home", async () => {
  const embedded = await source("src/main/embedded-browser.ts");
  assert.match(embedded, /preferredBrowserWidth = width >= 1450 \? 820/);
  assert.match(embedded, /available \* 0\.34/);
  assert.match(embedded, /html\.orbit-browser-open \.assistant-heading,/);
  assert.match(embedded, /html\.orbit-browser-open \.assistant-core,/);
  assert.match(embedded, /display: none !important/);
  assert.match(embedded, /overflow: hidden !important/);
});

test("active YouTube context keeps playback and ordinal follow-ups inside Orbit Browser", async () => {
  const preload = await source("preload.cjs");
  assert.match(preload, /function activeOrbitBrowserHost/);
  assert.match(preload, /function contextualOrbitBrowserFollowUp/);
  assert.match(preload, /function contextualizeOrbitBrowserCommand/);
  assert.match(preload, /function youtubeOrdinalPlaybackCommand/);
  assert.match(preload, /go\\s\+back/);
  assert.match(preload, /first\|second\|third\|fourth\|fifth/);
  assert.match(preload, /play \$\{match\[1\]\.toLowerCase\(\)\} one on YouTube/);
  assert.match(preload, /function youtubePlaybackCommand/);
  assert.match(preload, /const ordinal = youtubeOrdinalPlaybackCommand\(text\)/);
  assert.match(preload, /const explicitPlayback = text\.match/);
  assert.match(preload, /\(\?:open\|play\|watch\)/);
  assert.match(preload, /explicitPlayback\?\.\[1\]/);
  assert.match(preload, /play \$\{explicitPlayback\[1\]\.trim\(\)\} on YouTube/);
  assert.match(preload, /function youtubePlaybackQuery/);
  assert.match(preload, /\(\?:open\|play\|watch\).*\\s\+/);
  assert.match(preload, /play \$\{match\[1\]\.trim\(\)\} on YouTube/);
  assert.match(preload, /const playback = !external \? youtubePlaybackCommand\(value\) : ""/);
  assert.match(preload, /intent: "youtube_play"/);
  assert.match(preload, /Direct embedded YouTube playback shortcut matched before browser-agent routing/);
  assert.doesNotMatch(preload, /return ipcRenderer\.invoke\("orbit:command:plan", playback\)/);
  assert.match(preload, /const contextual = !external && contextualOrbitBrowserFollowUp\(value\)/);
  assert.match(preload, /looksLikeCareerBrowserRequest\(value\).*\|\| contextual/s);
  assert.ok(preload.indexOf("if (explicitlyRequestsExternalBrowser(value)) return value") < preload.indexOf("const playback = youtubePlaybackCommand(value)"), "explicit Chrome/Safari requests must override embedded YouTube playback");
});

test("compound YouTube back-and-search keeps the search clause", async () => {
  const preload = await source("preload.cjs");
  assert.match(preload, /function youtubeCompoundBackSearch/);
  assert.match(preload, /(?:go\\s\+back\|back).*search/);
  assert.match(preload, /const compoundYoutubeSearch = !external \? youtubeCompoundBackSearch\(value\) : ""/);
  assert.match(preload, /orbit:embedded-browser:back/);
  assert.match(preload, /search YouTube for \$\{compoundYoutubeSearch\}/);
  assert.match(preload, /Compound YouTube back-and-search shortcut preserved both requested actions/);
});

test("local development refreshes the native speech helper", async () => {
  const [pkg, helper] = await Promise.all([source("package.json"), source("scripts/ensure-macos-native.mjs")]);
  assert.match(pkg, /node scripts\/ensure-macos-native\.mjs/);
  assert.match(helper, /OrbitSpeech\.swift/);
  assert.match(helper, /release-sidecar\/orbit-speech/);
  assert.match(helper, /build-macos-native\.sh/);
});

test("career/browser consequential actions remain approval gated", async () => {
  const [engine, preload] = await Promise.all([source("src/main/browser-task-engine.ts"), source("preload.cjs")]);
  const risky = engine.match(/const riskyLabels = .*;/)?.[0] || "";
  for (const action of ["send", "submit", "publish", "post", "connect"]) assert.match(risky, new RegExp(action));
  assert.match(preload, /APPROVE NEXT/);
  assert.match(preload, /orbit:browser:task:resume/);
});