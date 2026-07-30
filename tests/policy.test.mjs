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
  assert.match(planner, /keep_alive: "30s"/);
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

test("Amazon commands remove navigation filler and preserve spoken price limits", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"));
  assert.match(source, /function spokenAmazonPrice/);
  assert.match(source, /two\|three\|four/);
  assert.match(source, /\(\?:can\|could\|would\)\\s\+you/);
  assert.match(source, /maxPrice: price\.value/);
});

test("wake phrase uses a dedicated recognizer before fresh command capture", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8"));
  assert.match(source, /commands = \["Hey Orbit".*"Orbit".*"Stop", "Skip"/);
  assert.match(source, /startWakeListening/);
  assert.match(source, /activateCommandCapture/);
  assert.match(source, /requiresOnDeviceRecognition = false/);
  assert.match(source, /followupMode \? 30 : 25/);
});

test("microphone can be released and Orbit uses the boss voice persona", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const planner = await fs.readFile(new URL("../src/main/ollama.ts", import.meta.url), "utf8");
  assert.match(main, /orbit:voice:stop/);
  assert.match(main, /speechProcess\.kill\(\)/);
  assert.match(main, /\["Ava", "Samantha", "Jamie", "Daniel"\]/);
  assert.match(main, /naturalSpeech/);
  assert.match(renderer, /Mic on/);
  assert.match(planner, /Address the user as Boss/);
});

test("Orbit Space keeps voice controls in sidebar flow", async () => {
  const fs = await import("node:fs/promises");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const wake = await fs.readFile(new URL("../src/renderer/wake.css", import.meta.url), "utf8");
  const deck = await fs.readFile(new URL("../src/renderer/command-deck.css", import.meta.url), "utf8");
  assert.match(renderer, /<nav>.*<VoiceConsole\/>/s);
  assert.match(renderer, /className="orbit-space-page"/);
  assert.doesNotMatch(renderer, /className="orbit-trail/);
  assert.match(deck, /core-orb/);
  assert.doesNotMatch(wake, /\.voice-console\{position:fixed/);
  assert.match(deck, /deck-spin/);
});

test("browser follow-ups use active site context with safe URL adapters", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"));
  assert.match(source, /activeBrowserSite/);
  assert.match(source, /youtube\.com\/results\?search_query=/);
  assert.match(source, /github\.com\/search\?q=/);
  assert.match(source, /i=aps&ref=nb_sb_noss/);
  assert.match(source, /parsed\.searchParams\.set\("i", "aps"\)/);
  assert.match(source, /site:\$\{context\.hostname\}/);
  assert.match(source, /searchActiveChromePage/);
  assert.match(source, /navigateActiveChromeTab/);
  assert.match(source, /sameTab/);
  assert.match(source, /input\[type=/);
  assert.match(source, /parsed\.protocol !== "https:"/);
  assert.match(source, /\["answer", "clarify", "notifications", "memory", "battery", "screen", "screenshot", "research", "browser", "github", "folder", "email_draft", "weather", "news", "cricket", "soccer", "finance", "daily_brief", "youtube_play", "amazon_search", "page_describe", "page_summarize", "page_find"\]\.includes\(local\.intent\)/);
});

test("browser actions, explicit GitHub routing, weather fallback, and preferred names are reliable", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const weatherService = await fs.readFile(new URL("../src/main/live-info/weather-service.ts", import.meta.url), "utf8");
  assert.match(main, /browserAction: "play_first"/);
  assert.match(main, /browserAction: "scroll_down"/);
  assert.match(main, /youtube\.com\/watch\?v=/);
  assert.match(main, /Explicit GitHub workflow request matched/);
  assert.doesNotMatch(renderer, /plan\.intent==="launch"&&plan\.application==="Google Chrome"&&githubRequest/);
  assert.match(weatherService, /ipapi\.co\/json/);
  assert.match(weatherService, /geocoding-api\.open-meteo\.com/);
  assert.match(main, /Preferred name saved locally/);
  assert.match(main, /profile\.json/);
});

test("Mac context routes before web research and Gemini keys stay in Keychain", async () => {
  const read = path => import("node:fs/promises").then(fs => fs.readFile(new URL(`../${path}`, import.meta.url), "utf8"));
  const [main, gemini, contracts, preload, renderer, policy] = await Promise.all([
    read("src/main/main.ts"), read("src/main/gemini.ts"), read("src/shared/contracts.ts"),
    read("preload.cjs"), read("src/renderer/src.tsx"), read("src/main/policy.ts"),
  ]);
  assert.match(main, /intent: "battery"/);
  assert.match(main, /intent: "screen"/);
  assert.ok(main.indexOf('intent: "battery"') < main.indexOf('intent: "research"'));
  assert.match(main, /pmset/);
  assert.match(main, /desktopCapturer\.getSources/);
  assert.match(main, /needsLiveWeb/);
  assert.match(gemini, /find-generic-password/);
  assert.match(gemini, /add-generic-password/);
  assert.match(gemini, /x-goog-api-key/);
  assert.doesNotMatch(gemini, /\^AIza/);
  assert.match(gemini, /monthlyBudgetUsd/);
  assert.match(gemini, /gemini-usage\.json/);
  assert.doesNotMatch(gemini, /GEMINI_MODEL = "gemini-2\.5-flash"/);
  assert.match(gemini, /gemini-3\.6-flash/);
  assert.match(gemini, /gemini-flash-latest/);
  assert.match(gemini, /modelUnavailable/);
  assert.match(gemini, /models\?pageSize=1/);
  assert.match(main, /geminiStatus\(\)\.available/);
  assert.doesNotMatch(gemini, /const\s+\w*KEY\s*=\s*["']AIza/);
  assert.match(contracts, /configureGemini/);
  assert.match(preload, /orbit:gemini:configure/);
  assert.match(preload, /orbit:gemini:budget/);
  assert.match(renderer, /type="password"/);
  assert.match(renderer, /Set hard limit/);
  assert.match(policy, /screen\.describe/);
});

test("voice commands tolerate natural pauses before submitting", async () => {
  const speech = await import("node:fs/promises").then(fs => fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8"));
  assert.match(speech, /followupMode \? 30 : 25/);
  assert.match(speech, /followup \? 0\.12 : 0\.65/);
  assert.match(speech, /Apple's recognizer can mark a fragment final/);
  assert.match(speech, /unfinishedClause/);
  assert.match(speech, /settlingDelay = 4\.8/);
  assert.match(speech, /settlingDelay = final \? 2\.4 : 2\.8/);
  assert.match(speech, /immediateControl/);
});

test("explicit Outlook drafts override stale browser and GitHub context", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const contracts = await fs.readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(main, /Explicit Outlook draft overrides stale browser context/);
  assert.ok(main.indexOf("Explicit Outlook draft overrides stale browser context") < main.indexOf("Browser navigation request matched"));
  assert.match(main, /It has not been sent/);
  assert.match(main, /never send it without your approval/);
  assert.match(contracts, /"email_draft"/);
  assert.match(preload, /orbit:email:draft/);
});

test("conversation history is local, bounded, restorable, and user-clearable", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(main, /conversation-history\.json/);
  assert.match(main, /conversationEntries\.slice\(-200\)/);
  assert.match(main, /mode: 0o600/);
  assert.match(main, /loadConversation\(\)/);
  assert.match(preload, /orbit:conversation:list/);
  assert.match(preload, /orbit:conversation:clear/);
  assert.match(renderer, /Clear Orbit conversation history from this Mac/);
});

test("Orbit Play is local, permission-visible, allowlisted, and has an emergency stop", async () => {
  const fs = await import("node:fs/promises");
  const [main, renderer, playStyles, contracts, preload, pkg, native, gestureMachine, escapeState] = await Promise.all([
    fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/renderer/orbit-play.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/renderer/orbit-play.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../native/macos/OrbitGesture.swift", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/renderer/orbit-universe/gestures/gestureStateMachine.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/renderer/orbit-universe/escape/escapeState.ts", import.meta.url), "utf8"),
  ]);
  assert.match(renderer, /getUserMedia/);
  assert.match(renderer, /CAMERA ACTIVE/);
  assert.match(renderer, /Frames are never recorded or uploaded|frames never leave this Mac/i);
  assert.match(renderer, /handsNow\.current\.length===2&&handsNow\.current\.every\(hand=>hand\.gesture==="Fist"\)/);
  assert.match(renderer, /Date\.now\(\)-fistSince\.current>2000/);
  assert.match(renderer, /event\.key==="Escape"/);
  assert.match(renderer, /maxNumHands:2/);
  assert.match(gestureMachine, /point = \{ x: this\.pointXFilter\.filter\(landmarks\[8\]\.x/);
  assert.doesNotMatch(gestureMachine, /1\s*-\s*landmarks\[8\]/);
  assert.match(playStyles, /\.orbit-play video\{display:none!important/);
  assert.match(renderer, /Math\.atan2/);
  assert.match(renderer, /const clap=/);
  assert.match(renderer, /SUPERNOVA/);
  assert.match(renderer, /type PlayScene = "energy"\|"system"\|"orbit"/);
  assert.match(renderer, /GRAVITY GARDEN/);
  assert.match(renderer, /STAR FORGE/);
  assert.match(renderer, /COMET RUN/);
  assert.match(renderer, /ORBIT ESCAPE/);
  assert.match(escapeState, /orbit-escape-best/);
  assert.match(renderer, /PHASE DASH/);
  assert.match(renderer, /A \/ D OR HAND TO STEER/);
  assert.match(renderer, /PINCH TO ADVANCE/);
  assert.match(renderer, /Play Orbit Escape/);
  assert.doesNotMatch(renderer, /className="play-vignette"/);
  assert.doesNotMatch(renderer, /className="play-grain"/);
  assert.doesNotMatch(playStyles, /\.play-vignette|\.play-grain/);
  assert.doesNotMatch(playStyles, /\.orbit-play\.is-active:hover header p/);
  assert.match(main, /new Set\(\["move", "down", "up", "scroll", "media-toggle", "stop"\]\)/);
  assert.doesNotMatch(native, /keyDown|keyboardSetUnicodeString|deleteFile|sendEmail/);
  assert.match(contracts, /OrbitPlayGesture/);
  assert.match(preload, /orbit:play:stop/);
  assert.match(pkg, /NSCameraUsageDescription/);
});

test("phase two interruptions, stale-response cancellation, folders, and Orbit Space are wired", async () => {
  const fs = await import("node:fs/promises");
  const speech = await fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  assert.match(speech, /Speech interruption recognized/);
  assert.match(main, /let spokenReply/);
  assert.match(main, /orbit:speech:stop/);
  assert.match(main, /Local folder request matched before browser routing/);
  assert.match(renderer, /runRef/);
  assert.match(renderer, /stopSpeaking/);
  assert.match(renderer, /Orbit Space/);
});

test("screenshot requests use a typed native capture tool instead of general AI", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  const policy = await fs.readFile(new URL("../src/main/policy.ts", import.meta.url), "utf8");
  assert.match(main, /Native screenshot request matched/);
  assert.match(main, /intent: "screenshot"/);
  assert.match(main, /Orbit Screenshot/);
  assert.match(main, /orbit:screen:capture/);
  assert.match(renderer, /plan\.intent==="screenshot"/);
  assert.match(preload, /takeScreenshot/);
  assert.match(policy, /screen\.capture/);
});

test("reliability follow-ups preserve Finder context and recover from stalled actions", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const speech = await fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8");
  assert.match(main, /Active Finder folder action matched/);
  assert.match(main, /activeFolderPath/);
  assert.match(main, /lead\|leet/);
  assert.match(main, /setTimeout\(\(\) => \{ child\.kill\(\); resolve\(false\); \}, 4_000\)/);
  assert.match(renderer, /That action took too long and was cancelled/);
  assert.match(renderer, /setNotice\(""\);setSources\(\[\]\);setCommand\(""\)/);
  assert.match(speech, /followup \? 0\.12 : 0\.65/);
});

test("Orbit Space is the startup home and diagnostics are a separate view", async () => {
  const renderer = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8"));
  assert.match(renderer, /useState<View>\("space"\)/);
  assert.match(renderer, /\["space","Orbit Space"\]/);
  assert.match(renderer, /\["diagnostics","Diagnostics"\]/);
  assert.match(renderer, /<OrbitSpace data=/);
  assert.match(renderer, /view==="diagnostics"&&<Diagnostics/);
  assert.doesNotMatch(renderer, /createPortal/);
  assert.doesNotMatch(renderer, /view==="system"&&<System/);
});

test("phase two live answers stay relevant and speech is less repetitive", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const newsService = await fs.readFile(new URL("../src/main/live-info/news-service.ts", import.meta.url), "utf8");
  assert.match(newsService, /function newsTopic/);
  assert.match(newsService, /news\.google\.com\/rss\/search\?q=/);
  assert.match(renderer, /liveInfo\(\{query:plan\.query\|\|input/);
  assert.match(main, /who won\|winner\|champion\|world cup\|fifa/);
  assert.match(main, /speak\(nextWakeAcknowledgement\(\), false\)/);
  assert.doesNotMatch(main, /const spoken = named\.toLowerCase\(\)\.includes/);
  assert.match(main, /"-r", "172"/);
});

test("phase seven uses stable turn completion and a varied composed persona", async () => {
  const fs = await import("node:fs/promises");
  const speech = await fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const gemini = await fs.readFile(new URL("../src/main/gemini.ts", import.meta.url), "utf8");
  const ollama = await fs.readFile(new URL("../src/main/ollama.ts", import.meta.url), "utf8");
  assert.match(speech, /turn-end-candidate/);
  assert.match(speech, /current == self\.generation/);
  assert.match(main, /Yes, \$\{address\(\)\}\?/);
  assert.match(main, /I'm listening, \$\{address\(\)\}\./);
  assert.match(main, /Go ahead, \$\{address\(\)\}\./);
  assert.match(gemini, /calm precision of a modern cinematic assistant/);
  assert.match(ollama, /not mechanically in every sentence/);
});

test("phase three clarifies ambiguous FIFA requests and ranks at most two relevant recent stories", async () => {
  const main = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"));
  const gemini = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/gemini.ts", import.meta.url), "utf8"));
  const news = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/live-info/news-service.ts", import.meta.url), "utf8"));
  const engine = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/live-info/engine.ts", import.meta.url), "utf8"));
  assert.match(main, /FIFA competition is ambiguous/);
  assert.match(main, /men's World Cup, Women's World Cup, Club World Cup/);
  assert.match(news, /relevance \* 100 - Math\.min\(ageHours, 168\)/);
  assert.match(news, /topicWords\.every/);
  assert.match(news, /\.slice\(0, 2\)/);
  assert.match(engine, /one or two relevant, recent headlines/);
  assert.doesNotMatch(main, /Local conversation matched/);
  assert.match(gemini, /Handle casual conversation and long dictated requests conversationally/);
  assert.match(gemini, /Lead with a short answer suitable for speech/);
});

test("packaged preload exposes every renderer command API", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../preload.cjs", import.meta.url), "utf8"));
  for (const channel of [
    "orbit:live:info",
    "orbit:browser:youtube",
    "orbit:browser:amazon",
    "orbit:browser:describe",
    "orbit:browser:summarize",
    "orbit:browser:find",
    "orbit:screen:capture",
  ]) assert.match(source, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /orbit:live:(?:weather|news|cricket)/);
});

test("questions use cited research while notifications never route to news", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  assert.match(main, /intent: "notifications"/);
  assert.match(main, /I won’t substitute news headlines/);
  assert.match(main, /Which updates do you mean, boss/);
  assert.match(main, /\["answer", "clarify", "notifications"/);
  assert.match(main, /html\.duckduckgo\.com\/html/);
  assert.match(main, /answerWithOllama/);
  assert.match(renderer, /research-sources/);
});

test("research responses suppress model reasoning and expose only the final answer", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/ollama.ts", import.meta.url), "utf8"));
  assert.match(source, /finalAnswerOnly/);
  assert.match(source, /<think>/);
  assert.match(source, /Local synthesis returned no final answer/);
});

test("Crimson Reactor is selectable and persists across restarts", async () => {
  const fs = await import("node:fs/promises");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const theme = await fs.readFile(new URL("../src/renderer/adaptive-reactor.css", import.meta.url), "utf8");
  assert.match(renderer, /localStorage\.setItem\("orbit-theme"/);
  assert.match(renderer, /Crimson Reactor/);
  assert.match(theme, /data-orbit-theme="crimson"/);
});

test("all six reference designs are selectable full visual presets", async () => {
  const fs = await import("node:fs/promises");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const theme = await fs.readFile(new URL("../src/renderer/adaptive-reactor.css", import.meta.url), "utf8");
  for (const name of ["Cosmic Violet", "Cyber Cyan", "Obsidian Gold", "Aurora Glass", "Crimson Reactor", "Liquid Monochrome"]) {
    assert.match(renderer, new RegExp(name));
  }
  for (const id of ["violet", "cyan", "gold", "aurora", "crimson", "monochrome"]) {
    assert.match(theme, new RegExp(`data-orbit-theme="${id}"`));
  }
});

test("every reactor theme includes color-aligned orbital loops", async () => {
  const fs = await import("node:fs/promises");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/renderer/adaptive-reactor.css", import.meta.url), "utf8");
  assert.match(renderer, /className="reactor-orbits"/);
  assert.match(styles, /rgba\(var\(--reactor-rgb\),\.7\)/);
  assert.match(styles, /themed-orbit-spin/);
});

test("live briefings use transient macOS location and public read-only sources", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const speech = await fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8");
  const pkg = await fs.readFile(new URL("../package.json", import.meta.url), "utf8");
  const weatherService = await fs.readFile(new URL("../src/main/live-info/weather-service.ts", import.meta.url), "utf8");
  const newsService = await fs.readFile(new URL("../src/main/live-info/news-service.ts", import.meta.url), "utf8");
  assert.match(speech, /CLLocationManagerDelegate/);
  assert.match(speech, /authorizationStatus == \.authorizedAlways/);
  assert.doesNotMatch(speech, /authorizedWhenInUse/);
  assert.match(speech, /requestWhenInUseAuthorization/);
  assert.match(weatherService, /api\.open-meteo\.com/);
  assert.match(newsService, /news\.google\.com\/rss/);
  assert.match(main, /Orbit's location helper/);
  assert.match(pkg, /NSLocationWhenInUseUsageDescription/);
});

test("Adaptive Reactor maps voice and action states to violet gold and crimson", async () => {
  const fs = await import("node:fs/promises");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  const theme = await fs.readFile(new URL("../src/renderer/adaptive-reactor.css", import.meta.url), "utf8");
  assert.match(renderer, /setStage\("listening"\)/);
  assert.match(renderer, /setStage\("executing"\)/);
  assert.match(theme, /data-orbit-state="thinking"/);
  assert.match(theme, /data-orbit-state="executing"/);
  assert.match(theme, /--reactor:#e7b85c/);
  assert.match(theme, /--reactor:#ff4055/);
});

test("all Mac diagnostics route locally before general research", async () => {
  const main = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"));
  assert.ok(main.indexOf('explanation: "Native system request matched"') < main.indexOf('explanation: "Knowledge question matched"'));
});

test("Ollama releases model memory shortly after fallback use", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/main/ollama.ts", import.meta.url), "utf8"));
  assert.equal((source.match(/keep_alive: "30s"/g) || []).length, 2);
  assert.equal(source.includes('keep_alive: "10m"'), false);
});

test("Phase 4 YouTube selection routes before generic search and stays in the active tab", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../src/renderer/src.tsx", import.meta.url), "utf8");
  assert.ok(main.indexOf("Active YouTube ordinal selection matched before search") < main.indexOf("Browser navigation request matched"));
  assert.match(main, /browserAction: "select_result"/);
  assert.match(main, /browserAction: "selection_next"/);
  assert.match(main, /browserAction: "selection_previous"/);
  assert.match(main, /browserAction: "selection_open"/);
  assert.match(main, /data-orbit-selected/);
  assert.match(main, /const keepActiveTab = Boolean\(request\.sameTab \|\| \(!request\.url && activeBrowserSite\)\)/);
  assert.match(renderer, /resultIndex:plan\.resultIndex/);
});

test("Phase 5 wake listener refreshes and supports natural wake variants", async () => {
  const speech = await import("node:fs/promises").then(fs => fs.readFile(new URL("../native/macos/OrbitSpeech.swift", import.meta.url), "utf8"));
  assert.match(speech, /"Hey, Orbit", "Hi Orbit", "Okay Orbit", "OK Orbit"/);
  assert.match(speech, /wakeRearmCount >= 12/);
  assert.match(speech, /wake-listener-refreshed/);
});

test("Phase 5 memory is explicit, encrypted, bounded, and confirmation-gated for deletion", async () => {
  const fs = await import("node:fs/promises");
  const memory = await fs.readFile(new URL("../src/main/memory.ts", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  assert.match(memory, /safeStorage\.encryptString/);
  assert.match(memory, /safeStorage\.decryptString/);
  assert.match(memory, /mode: 0o600/);
  assert.match(memory, /memories\.slice\(-200\)/);
  assert.match(main, /rememberRequest/);
  assert.match(main, /what do you remember/);
  assert.match(main, /confirm forget/);
  assert.match(main, /pendingMemoryDeletion/);
});

test("Phase 6 validates complete artifacts and gates public releases on Apple signing", async () => {
  const fs = await import("node:fs/promises");
  const workflow = await fs.readFile(new URL("../.github/workflows/release-mac.yml", import.meta.url), "utf8");
  const verifier = await fs.readFile(new URL("../scripts/verify-mac-artifact.mjs", import.meta.url), "utf8");
  assert.match(workflow, /HAS_APPLE_SIGNING/);
  assert.match(workflow, /config\.mac\.notarize=true/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/'\).*HAS_APPLE_SIGNING/);
  assert.match(verifier, /sidecar\/orbit-speech/);
  assert.match(verifier, /sidecar\/orbit-retrieval/);
  assert.match(verifier, /NSMicrophoneUsageDescription/);
  assert.match(verifier, /codesign/);
  assert.match(verifier, /spctl/);
  assert.match(
    verifier,
    /if \(!unsigned\) \{\s*execFileSync\("codesign"[\s\S]*execFileSync\("spctl"/,
  );
});
