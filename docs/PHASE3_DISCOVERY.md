# Orbit — Phase 3 Discovery

Status: research document only. No application code was changed to produce this file.

Scope: a full read-through of the repository as of commit `4d12d3a` ("Make Orbit Space the primary home"), covering architecture, request lifecycle, memory/retrieval state, the tool registry, desktop integrations, and a candidate Phase 3 plan.

## 0. Codebase size, for calibration

Orbit is small and dense, not a large service. Total hand-written source is ~1,490 lines:

| File | Lines | Role |
|---|---:|---|
| `src/main/main.ts` | 651 | Electron main process — IPC, voice orchestration, all "live" integrations |
| `native/macos/OrbitSpeech.swift` | 228 | Native two-stage speech recognizer helper |
| `src/renderer/src.tsx` | 86 | Entire React UI (single file) |
| `src/main/tools.ts` | 95 | Read-only local system/file tools |
| `src/main/gemini.ts` | 103 | Optional cloud Gemini integration |
| `src/main/ollama.ts` | 79 | Local LLM planner/answerer (Ollama) |
| `src/shared/contracts.ts` | 73 | Single source of truth for all IPC types |
| `sidecar/retrieval.py` | 70 | SQLite FTS5 local search engine |
| `src/preload/preload.ts` | 38 | Typed preload (see §9, likely dead code) |
| `src/main/policy.ts` | 31 | Tool registry / risk policy |
| `src/main/audit.ts` | 20 | Append-only JSONL audit log |

Everything else is CSS (`src/renderer/*.css`, several hundred lines total, one file per feature area) and config (Vite, tsconfig ×2, electron-builder in `package.json`, GitHub Actions).

Git history shows two prior phases: **Phase 1** ("Complete Orbit phase one") replaced a cloud AI planner with local Ollama; **Phase 2** ("Improve Phase 2 voice control and Orbit Space") reworked the native voice pipeline into a two-stage wake/dictation design and made "Orbit Space" the landing view. This document is discovery for whatever Phase 3 becomes.

---

## 1. High-level architecture

```text
┌─────────────────────────────┐        NDJSON over stdio        ┌──────────────────────────────┐
│  native/macos/OrbitSpeech   │◄────────────────────────────────┤   Electron main process       │
│  (compiled Swift binary,    │  arm / pause / resume / followup │   src/main/main.ts            │
│  spawned as a subprocess)   │──────────────────────────────────►  (spawn, parse events, route)  │
└─────────────────────────────┘        {type, text, ...}        └───────────────┬────────────────┘
                                                                                 │
                     ┌───────────────────────────────────────────────────────────┤ ipcMain.handle(...)
                     │                                                            │
      ┌──────────────▼──────────────┐   JSON over stdin/stdout    ┌───────────────▼───────────────┐
      │  sidecar/retrieval.py       │◄────────────────────────────┤  contextBridge preload.cjs     │
      │  (spawned per request, or   │  {operation, roots|query}   │  window.orbit.* (allowlisted)  │
      │  bundled PyInstaller binary)│                              └───────────────┬───────────────┘
      └──────────────────────────────┘                                            │ nodeIntegration:false
                                                                                    │ contextIsolation:true
                                                                     ┌──────────────▼───────────────┐
  Outbound HTTP (fetch, no SDKs):                                   │  React renderer (src.tsx)     │
   • http://127.0.0.1:11434   Ollama (local LLM)                    │  sandboxed, single view-router │
   • generativelanguage.googleapis.com  Gemini (optional, opt-in)   └────────────────────────────────┘
   • api.open-meteo.com / geocoding-api.open-meteo.com  weather
   • news.google.com/rss  news + cricket headlines
   • html.duckduckgo.com/html  web research
   • api.github.com  Actions/workflow status
   • /usr/bin/say, /usr/bin/osascript, /usr/bin/pmset, /usr/bin/security  macOS system binaries
```

**Electron main process** (`src/main/main.ts`) is the hub. It owns: window creation, all `ipcMain.handle` registrations, the voice subprocess lifecycle, text-to-speech (shelling out to `/usr/bin/say`), browser automation (AppleScript via `osascript`), every "live" data integration (weather/news/cricket/GitHub/web research), battery/location/screen-capture access, and the command planner (`planCommand`, a deterministic regex cascade with an Ollama structured-output fallback).

**Renderer** (`src/renderer/src.tsx`) is a single-file React app with no router library — a `View` union type (`space|diagnostics|recent|knowledge|git|cleanup|audit|settings`) drives `useState`-based view switching. It never touches Node, fs, or child_process; it only calls the `window.orbit` API injected by the preload script. It owns UI state (busy/error/notice/theme) and voice-console visuals, and it renders 7 themed "reactor" presets purely via CSS + a `data-orbit-theme` attribute.

**Python sidecar** (`sidecar/retrieval.py`) is a dependency-free, single-file SQLite FTS5 engine. It has no daemon/server mode — main.ts spawns it fresh per index/search call (either `python3 sidecar/retrieval.py` in dev, or a PyInstaller-frozen `orbit-retrieval` binary in packaged release builds), pipes a JSON request over stdin, and reads a JSON response from stdout.

**Native macOS module** (`native/macos/OrbitSpeech.swift`) is a standalone Swift command-line program (compiled via `scripts/build-macos-native.sh` → `xcrun swiftc`), not an Electron native addon. It runs as a long-lived subprocess, communicating over stdin (single-word commands: `arm`, `pause`, `resume`, `followup`, `location`) and stdout (newline-delimited JSON events). It also owns CoreLocation access for weather.

**Voice pipeline**: two-stage, matching the Phase 2 commit. `NSSpeechRecognizer` (constrained, on-device, low-power) listens continuously for a fixed command set (`"Hey Orbit"`, `"Orbit"`, `"Stop"`, `"Skip"`, `"That's enough"`, `"That is enough"`). On wake, it stops and hands off to `SFSpeechRecognizer` (dictation-grade, may use network recognition) for one command capture window (~25–30s, with filler-word-aware settling delays), then returns to wake listening. `speak()` in main.ts pauses wake listening while Orbit is talking and supports barge-in interruption.

**AI integrations**: two independent, swappable backends behind small type-safe wrappers:
- `src/main/ollama.ts` — local-only, no API key, talks to `http://127.0.0.1:11434`. Used for structured intent planning (JSON-schema-constrained `format` field) and as a research-answer synthesizer.
- `src/main/gemini.ts` — optional, user-opt-in cloud multimodal model, API key stored in macOS Keychain (never in files), with a local monthly-spend estimate/budget cap enforced client-side and model-name fallback list for handling model deprecation.

Gemini, when configured, is preferred for research answers and is the only backend used for screen-understanding (`describeScreen`). Ollama is the fallback for both planning and research when Gemini is unset or over budget. If neither is available, the deterministic `planLocal()` regex planner still handles a wide set of intents with zero AI dependency.

**Tool execution pipeline**: every privileged capability is registered as a named policy entry (`src/main/policy.ts`) with a `risk` tier (`read|reversible|sensitive|external|destructive`) and an `approvalRequired` flag. `ipcMain.handle` callbacks wrap their action in `traced(toolName, action)` (main.ts), which looks up the policy, appends a `started` audit record, runs the action, then appends `completed` or `failed`. There is no generic "tool executor" abstraction beyond this — each IPC handler directly calls its implementation function; `traced()` is the only shared plumbing.

---

## 2. Folder-by-folder explanation

```
src/main/         Electron main-process source (TypeScript, compiled by tsc → dist-electron/main)
  main.ts           IPC registration, voice/speech orchestration, browser automation, live data
                     integrations (weather/news/cricket/GitHub/research/screen/battery), command
                     planner (planLocal + planCommand), profile persistence, window/app lifecycle.
  tools.ts          Pure, read-only local system tools: systemSnapshot, recentWork, gitContexts,
                     cleanupPlan. No IPC registration here — main.ts imports and wires these.
  ollama.ts         Local LLM client: ollamaStatus, planWithOllama (structured JSON planning),
                     answerWithOllama (research synthesis), finalAnswerOnly (<think> stripping,
                     shared with gemini.ts).
  gemini.ts         Optional cloud client: Keychain key storage/retrieval, key verification,
                     usage/budget tracking (gemini-usage.json), answerWithGemini (text + optional
                     inline image for screen understanding), model-fallback handling.
  policy.ts         The tool registry: `policies` array + `policy(name)` lookup + `riskRank`.
  audit.ts          AuditStore — append-only JSONL log at <userData>/orbit-audit.jsonl, list()
                     returns the most recent 100 events, newest first.

src/preload/       Typed preload source (TypeScript). Compiles to dist-electron/preload/preload.js,
                     which main.ts does NOT load at runtime — see §9, technical debt #1.

src/renderer/      The entire React UI.
  src.tsx            Single-file app: view router, command bar, voice console, all view components
                     (OrbitSpace, Diagnostics, Recent, Knowledge, Repos, Cleanup, Audit, Settings).
  *.css              One stylesheet per feature/era: style, wake, product, voice, ai, command-deck,
                     adaptive-reactor, orbit-space — all imported unconditionally in src.tsx.
  assets/themes/     Six .webp background/theme images (violet, cyan, gold, aurora, crimson, mono).
  index.html         Vite entry HTML.
  env.d.ts           Vite client type declarations.

src/shared/        contracts.ts — every IPC payload/response type, the Intent union, and the
                     OrbitAPI interface implemented by preload and consumed by both main and
                     renderer. This is the de facto IPC schema; there is no runtime validation
                     layer (no zod/io-ts) — types are compile-time only.

preload.cjs         The ACTUAL preload script loaded by BrowserWindow at runtime (CommonJS, at
                     repo root so it ships unbundled). Hand-maintained duplicate of the logic in
                     src/preload/preload.ts. See §9.

native/macos/
  OrbitSpeech.swift    The two-stage speech recognizer helper (see §1).
  OrbitSpeech.entitlements  Hardened-runtime entitlements: audio-input, speech-recognition.

scripts/
  build-macos-native.sh  Compiles OrbitSpeech.swift → release-sidecar/orbit-speech via swiftc -O.

sidecar/
  retrieval.py         SQLite FTS5 index/search engine (see §1, §6).
  test_retrieval.py    Python unittest coverage for retrieval.py.
  orbit-retrieval.spec PyInstaller spec used by the release workflow to freeze retrieval.py.

release-sidecar/     Build output only (.gitkeep tracked; binaries produced by CI/local builds,
                     bundled into the packaged app via electron-builder's extraResources).

tests/
  policy.test.mjs      Node's built-in test runner. Every test here asserts against raw *source
                     text* (regex/string matches over file contents), not runtime behavior — see
                     §9, technical debt #8, for the implication.

.github/workflows/
  quality.yml           On push/PR to main: npm ci && npm run check (tsc ×2, tests, vite build).
  release-mac.yml       On tag/dispatch: builds the Swift helper, freezes the Python sidecar with
                     PyInstaller, runs electron-builder for a signed-or-unsigned dmg/zip, and
                     publishes to GitHub Releases.

dist-electron/, dist-renderer/, node_modules/, release-sidecar/*.bin  Build artifacts, not source.
```

---

## 3. Current request lifecycle

**Entry points** (three, all converge on the same planner):
1. Typed text in the command bar → Enter key → `executeText(command)`.
2. Voice final transcript → `onVoiceCommand` IPC event → `executeText(text)` (auto-fires).
3. Voice partial transcript → `onVoiceEvent("partial")` → only updates the command-bar text live, does not execute.

**Step-by-step** (renderer `executeText`, `src/renderer/src.tsx:42`):

1. Renderer calls `window.orbit.stopSpeaking()` (barge-in: cancel any in-progress TTS) and enters `guard()`, which sets UI stage to `"thinking"` and catches/report errors uniformly (including a spoken error message).
2. `window.orbit.planCommand(input)` → IPC `orbit:command:plan` → main process `planCommand(value)`:
   a. Checks a "call me X" name-change regex first (persisted to `profile.json`, short-circuits everything else).
   b. Calls `planLocal(value)` — a large ordered cascade of regexes (`src/main/main.ts:178-227`) that directly resolves many intents without any AI: greetings/small talk, "brief me on the last failure", notifications (explicitly refused — never substituted with news), battery, screen, ambiguous "updates" (asks for clarification), weather, cricket, news, explicit GitHub Actions requests, folder-open shortcuts, active-page browser actions (play-first-video, scroll), generic system/CPU/memory keywords, generic browser navigation/search (with site-specific URL builders for YouTube/Google/Tesla/GitHub), a final "does this look like a question" catch-all → `research`, then a lower-confidence keyword table (launch/system/git/cleanup/audit/recent/knowledge) as a last resort before `unknown`.
   c. If `planLocal` resolved one of a fixed "final" intent set (`answer|clarify|notifications|battery|screen|research|browser|github|folder|weather|news|cricket`), that plan is returned immediately — Ollama is never consulted for these.
   d. Otherwise, checks `ollamaStatus()`. If Ollama isn't running/installed, returns the local (possibly `unknown`) plan as-is.
   e. If Ollama is available, calls `planWithOllama` with the last 10 conversation turns and the live installed-app list, using a JSON-schema-constrained `format` so the model can only emit one of a fixed intent enum plus bounded-length string fields. Validates `launch` intents against the actual installed-app set (rejects/clarifies otherwise). Appends the turn to the in-memory `conversation` array (capped at 20 entries).
   f. On any Ollama failure: if the local planner already found something better than `unknown`, falls back to it with an "AI unavailable" caveat reply; otherwise returns a `clarify` intent with a friendly spoken error and stashes a technical `lastFailureDetail` string for the next "brief me" request.
3. Renderer inspects `plan.intent` and dispatches to the matching `window.orbit.*` call: `research`, `batteryStatus`, `describeScreen`, `githubWorkflow`, `browserNavigate`, `openFolder`, `liveWeather`/`liveNews`/`liveCricket`, `launchApplication`, `searchKnowledge`, or (default) `load(intent as View)` to just switch views (system/recent/git/cleanup/audit).
4. Each of those IPC handlers on the main side is wrapped in `traced(toolName, action)` (§1) — audit-logs start/complete/fail, looks up risk via `policy()`.
5. Result flows back to the renderer: `notice` state is set for on-screen display (with citation links for research), and `window.orbit.speak(text)` triggers TTS (`/usr/bin/say`, voice auto-selected from Ava/Samantha/Daniel, rate 172, sanitized via `naturalSpeech()` to strip markdown/URLs/error prefixes, personalized to the user's preferred name via `personalize()`).
6. A monotonically increasing `runRef` counter lets a newer command (or explicit "Stop") invalidate an in-flight older one — stale responses are silently dropped (`if (run !== runRef.current) return`).

**Destructive path (cleanup/trash) is the one exception with an extra gate**: renderer requires an explicit file selection + a native `confirm()` dialog before calling `window.orbit.trash(paths)`; the main process then shows its own OS-native `dialog.showMessageBox` approval (independent of the renderer, so a compromised renderer can't silently bypass it) before calling `shell.trashItem` (recoverable, never a hard delete), capped at 50 paths per call.

---

## 4. Existing conversation/context handling

- A single **in-process, in-memory array** `conversation: ConversationTurn[]` in `main.ts` (module-level `let`, not per-window/session-keyed). Capped at 20 entries (10 user/assistant pairs) via `splice`.
- Populated by two call sites: `planCommand` (after a successful Ollama plan) and `research` (after every research answer). Screen-understanding (`describeScreen`) also pushes to it but does not read it as intent-planning context.
- Passed as message history to `planWithOllama` (last 10 turns), `answerWithOllama` (last 6), and `answerWithGemini` (last 8) — each call site slices independently, no shared windowing policy.
- **Not persisted** — lost on app restart or process crash. There is no session/thread identity; it's a single global conversation for the whole app lifetime.
- No summarization/compaction strategy beyond hard truncation (oldest entries silently dropped once the cap is hit).
- The only durable "who is this user" state is `preferredName`, loaded/saved via `profile.json` in `app.getPath("userData")` (see §5). It is not modeled as part of `conversation` — it's applied at output time via string substitution (`personalize()`), not injected into any prompt.

---

## 5. Existing memory implementation

There is no general-purpose memory system. What exists:

| What | Where | Persisted? | Scope |
|---|---|---|---|
| Preferred name of the user ("Boss" by default, or a name set via "call me X") | `profile.json` in Electron `userData` | Yes, disk | Global, single value |
| Gemini usage/budget (requests, tokens, estimated cost, monthly cap) | `gemini-usage.json` in `userData` | Yes, disk | Global, resets monthly by `month` key |
| Gemini API key | macOS Keychain (`security` CLI, service `com.orbit.desktop.gemini`) | Yes, OS keychain | Global |
| UI theme selection | `localStorage` in the renderer | Yes, browser storage | Renderer-only, cosmetic |
| Conversation turns | in-memory array (§4) | No | Process lifetime only |
| `activeBrowserSite` (last-navigated site, for follow-up scroll/search/play-first) | in-memory `let` in main.ts | No | Process lifetime only |
| `lastFailureDetail` (for "brief me on that error") | in-memory `let` in main.ts | No | Overwritten on each new failure |

There is no concept of long-term facts about the user, past tasks, or cross-session recall beyond the name. Phase 3 planning should treat "memory" as a green field, not an extension of something partial.

---

## 6. Existing retrieval/RAG implementation

`sidecar/retrieval.py` + the `orbit:knowledge:index` / `orbit:knowledge:search` IPC handlers (main.ts `retrieve()`) constitute the whole system:

- **Storage**: a single SQLite database at `<userData>/knowledge.db`, one FTS5 virtual table `documents(path UNINDEXED, title, body, modified_at UNINDEXED)`.
- **Indexing** (`index_roots`): triggered by the renderer's "Choose folder" button, which opens a native single-directory picker (`dialog.showOpenDialog`, `openDirectory` only — one folder per index operation). **Every index call first runs `DELETE FROM documents`** — indexing a new folder wipes any previously indexed folder's content. There is no incremental/additive multi-folder index and no way to indexed two folders concurrently, despite the README describing "approved folders" (plural).
- Walks the tree (`os.walk`), skips dotfiles and `node_modules|dist|build|venv`, only indexes files matching a fixed extension allowlist (`.md .txt .py .ts .tsx .js .jsx .json .csv`) under 1.5MB, caps total indexed files at 2,000. Each file becomes exactly **one row** — no chunking, so a large matched file is one FTS document (snippet extraction still works via FTS5 `snippet()`, but relevance/granularity degrades for long files).
- **Search**: tokenizes the query into alphanumeric tokens (max 12), builds an `OR` FTS5 MATCH query, ranks by `bm25()` with column weights (title 2.0, body 1.0), then re-scores client-side as `0.9 * relevance + 0.1 * recency` (recency decays linearly to 0 over 180 days). Returns up to `limit` (renderer requests 8) hits with a highlighted snippet.
- **No embeddings, no vector index, no reranking model** — purely lexical BM25 full-text search. The README's own "Next milestones" list already names "hybrid semantic embeddings and reranking on top of the implemented SQLite FTS5 baseline" as unbuilt future work — this document confirms that gap still exists as of this commit.
- **Process model**: stateless subprocess per call (dev: `python3 sidecar/retrieval.py`; packaged: bundled PyInstaller binary `orbit-retrieval`/`orbit-retrieval.exe`), request/response via JSON over stdin/stdout, `db_path` injected by the main process on every call. No persistent connection, no caching, no background reindex/watch.
- Retrieval results are surfaced two ways: (a) directly in the "Local knowledge" view (`Knowledge` component, manual search box), and (b) via the `knowledge` planner intent, which routes a natural-language "find/search/document/notes" utterance into the same `searchKnowledge` call and switches the view automatically.
- Results are **not** fed back into Ollama/Gemini as retrieval-augmented context for `research()` — `research()` only uses live web search (DuckDuckGo HTML scrape), never the local index. So despite both existing, there is currently no actual RAG (retrieval feeding a generation step) — local search and AI-answered research are two separate, non-composed features.

---

## 7. Existing tool registry or equivalent

`src/main/policy.ts` is the registry: a flat array of 19 `ToolPolicy` records (`name`, `risk`, `approvalRequired`, `description`), covering every privileged main-process capability — from `system.snapshot` (risk `read`) through `knowledge.index`/`files.trash` (risk `sensitive`/`destructive`, `approvalRequired: true`).

Mechanics:
- `policy(name)` throws if a name isn't registered — this is the only enforcement; nothing stops an `ipcMain.handle` from being added without a matching policy entry (it would only fail at call time, inside `traced()`, not at startup).
- `traced(tool, action)` (main.ts) is the sole consumer: look up policy → audit "started" → run → audit "completed"/"failed". It does **not** itself enforce `approvalRequired` — that's handled ad hoc per-tool (e.g. `files.trash`'s handler calls `dialog.showMessageBox` itself; `knowledge.index`'s handler calls `dialog.showOpenDialog` itself). The registry is descriptive/auditable, not a gate that blocks execution.
- `riskRank` (a `Record<Risk, number>`) is exported but **not referenced anywhere else in the codebase** — dead code, presumably intended for future sorting/filtering of audit entries or a risk-based UI.
- The full policy list is exposed to the renderer via `orbit:policies` (`ipcMain.handle("orbit:policies", () => policies)`), but **the renderer never calls `window.orbit.policies()`** — there's no settings/about screen listing what Orbit can do. This is a built, working, but entirely unused capability.
- Not every renderer-visible IPC handler in `main.ts` is wrapped in `traced`/backed by a policy entry — e.g. `orbit:voice:speak`, `orbit:voice:start/stop`, `orbit:speech:stop`, `orbit:voice:arm`, `orbit:ai:status`, `orbit:gemini:status` bypass the registry entirely (reasonable for control-plane/status calls, but worth being explicit about: the registry covers "tools" in the sense of user-facing actions with side effects, not every IPC surface).

There is no dynamic tool-calling loop (no LLM "function calling" against this registry) — Ollama's structured-output plan selects one `intent` from a fixed enum, and the renderer's `if/else` chain in `executeText` is what actually maps intents to IPC calls. The policy registry and the intent-to-handler mapping are two separate, manually-kept-parallel lists (policy names like `"web.research"` vs. intent names like `"research"` — related but not the same identifier space).

---

## 8. Browser, Finder, Weather, Music, and other desktop integrations

| Integration | Mechanism | Notes |
|---|---|---|
| **Browser** | AppleScript (`osascript`) targeting **Google Chrome only** | `openChromeTab` (new tab), `navigateActiveChromeTab` (same tab), `searchActiveChromePage` (injects JS to find and submit a visible search input on the active page — generic site search fallback), scroll up/down (JS `scrollBy`, with a System Events key-code fallback if Accessibility isn't granted), "play first YouTube result" (scrapes YouTube's search HTML for a `videoId` via regex, then navigates). Site-aware follow-ups use an in-memory `activeBrowserSite` (name/hostname/last query) to build contextual URLs for YouTube/GitHub/Amazon/Reddit/LinkedIn search, or fall back to a `site:` Google search. No Safari/Firefox/Edge support. |
| **Finder** | `shell.openPath` | Two entry points: `openPath` (opens any absolute path — used for citing recent-work files and knowledge-search hit files) and `openFolder` (only a fixed allowlist: Documents/Downloads/Desktop/Projects/Developer, resolved under `os.homedir()` — arbitrary folder names are rejected). |
| **Weather** | Open-Meteo (forecast) + Open-Meteo geocoding, location via native CoreLocation (through the Swift helper's `location` stdin command) or IP-geolocation fallback (`ipapi.co`) | No API key required (Open-Meteo is free/keyless). Location is transient — coordinates aren't stored (matches the `NSLocationWhenInUseUsageDescription` copy in `package.json`). |
| **News** | Google News RSS (regex-based `<item><title>` extraction, no XML parser dependency) | Supports a general "top headlines" feed and a topic-specific search feed. |
| **Cricket** | Same Google News RSS mechanism, filtered by a score/result-pattern regex | Not a dedicated sports API — just a news-headline heuristic. |
| **GitHub** | Public GitHub REST API (`api.github.com/repos/.../actions/runs`), unauthenticated | Defaults to `nikhilkumarthanda/orbit-desktop` if no repo specified/matched by the `^owner/repo$` safety regex. Also opens the Actions page in Chrome as a side effect. |
| **App launching** | `installedApplications()` scans `/Applications`, `/System/Applications`, `~/Applications` for `*.app` bundles (plus a hardcoded `Finder/Terminal/Safari`), capped at 160 names, sorted | `launchApplication` only accepts names present in that live-scanned set (defense against the LLM inventing an app name); actually launches via `open -a <name>` on macOS. |
| **Battery** | `/usr/bin/pmset -g batt`, regex-parsed | macOS-only; throws on other platforms. |
| **Screen understanding** | `desktopCapturer.getSources` (Electron) → PNG thumbnail → base64 → Gemini vision (`answerWithGemini` with `imageBase64`) | Requires a configured Gemini key; there is no local/offline screen-understanding path. |
| **Music** | **None found.** | No Spotify/Apple Music/`osascript "tell application \"Music\""` code exists anywhere in `src/`, `native/`, or `sidecar/`. If Phase 3 wants music control, it is a net-new integration, not an extension of anything present. |
| **Local file system tools** (recent work, git repos, cleanup) | Direct Node `fs`/`child_process` (`src/main/tools.ts`) | Read-only except `cleanup` → `trash`, which is the one path with double approval (§3). |
| **Web research** | DuckDuckGo HTML endpoint (`html.duckduckgo.com/html`), scraped via regex (no official API/key) | Triggered only when the query looks time-sensitive (`needsLiveWeb` keyword regex: today/now/latest/news/price/score/weather/election/version/202[5-9]/etc.); otherwise the LLM answers from its own knowledge with no web grounding. |

---

## 9. Areas that should remain untouched because they are stable

These are small, deliberately hardened, and/or have explicit regression-test coverage — changing them casually risks reopening solved problems (several commit messages are literally "Fix X" for issues in these exact areas):

1. **Electron security boundary** (`createWindow` webPreferences in `main.ts`, `preload.cjs`): `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and a hand-frozen (`Object.freeze`) allowlisted `window.orbit` API. `tests/policy.test.mjs` explicitly asserts the renderer has no shell bridge (`doesNotMatch(preload, /child_process|exec\(|spawn\(/)`). Any Phase 3 work should add new capabilities through this same preload/IPC pattern, never by relaxing these flags.
2. **The trash double-approval flow** (renderer `confirm()` + main-process `dialog.showMessageBox`, `src/main/main.ts:618-626`) — this is the only destructive action in the app and is test-covered (`"main process owns destructive approval"`, `"renderer confirms before trashing"`). Keep both gates independent; don't let a future "smart" cleanup feature skip the native dialog.
3. **Gemini key handling** (`src/main/gemini.ts`) — Keychain-only storage, never written to disk/env/logs, verified against Google before saving, monthly budget hard-cap. Test-covered (`doesNotMatch(gemini, /\^AIza/)`, Keychain command assertions). Treat as a template for any future credential, not something to touch.
4. **The native voice timing model** (`native/macos/OrbitSpeech.swift`) — the wake/dictation handoff delays (`followup ? 0.18 : 0.55`), the capture timeout (`followupMode ? 30 : 25`), and the filler-word settling delay (`endsInFiller ? 5.0 : (final ? 3.0 : 3.8)`) are empirically tuned and individually pinned by tests (`"voice commands tolerate natural pauses..."`, `"wake phrase uses a dedicated recognizer..."`). These numbers look arbitrary out of context but encode real debugging history — don't "clean them up" without re-verifying against a real Mac mic.
5. **`shared/contracts.ts`** as the single IPC schema source — both `main.ts`'s handlers and `preload.cjs`'s bridge and `src.tsx`'s calls must stay structurally aligned with it. It's small enough to review by eye, but it's the highest-leverage file in the repo; a change here ripples through at minimum 4 files.
6. **`policy.ts` / `audit.ts`** — minimal, already does its one job (append-only audit trail, risk labeling), and is the trust anchor the README's "Auditability" principle rests on.
7. **The ordering-sensitive rules in `planLocal()`** — several tests assert relative ordering of regex branches (e.g. `"all Mac diagnostics route locally before general research"` checks `system` appears before `knowledge` in source; battery/screen are asserted before `research`). If Phase 3 restructures the planner, these invariants need to be preserved or the tests deliberately updated with the same intent.

---

## 10. Technical debt / architectural issues to address before Phase 3

Ordered roughly by how much they'd block new work rather than by severity:

1. **Duplicate, drift-prone preload implementations.** `src/preload/preload.ts` is compiled by `tsc -p tsconfig.electron.json` into `dist-electron/preload/preload.js`, but `main.ts` loads `preload.cjs` from the repo root instead (`path.join(app.getAppPath(), "preload.cjs")`). The TypeScript preload appears to be dead output — nothing loads it — while the actual runtime bridge (`preload.cjs`) is a hand-maintained CommonJS duplicate that must be manually kept in sync with `OrbitAPI` in `contracts.ts`. Any new IPC method must currently be added in up to 4 places (`contracts.ts`, `main.ts` handler, `preload.cjs`, and `src/preload/preload.ts` if it's meant to matter) with no compiler check tying `preload.cjs` to the `OrbitAPI` interface. **Recommendation**: either delete `src/preload/preload.ts` and formalize `preload.cjs` as the source of truth (documented as intentional, given sandboxed CJS preload constraints), or make the build actually produce and load the compiled TS preload and delete the hand-written duplicate.

2. **`main.ts` is a 651-line God file.** It mixes: IPC registration, voice-subprocess lifecycle, TTS, AppleScript browser automation, weather/news/cricket/GitHub HTTP clients, web-research scraping + answer orchestration, screen capture, battery, location bridging, profile persistence, and the entire command planner. There is no per-integration module boundary the way `tools.ts`/`ollama.ts`/`gemini.ts` already demonstrate is possible. Before adding more integrations (e.g. Music, Calendar per the README's own roadmap), extracting weather/news/browser/github into sibling modules (mirroring `tools.ts`) would keep this file from growing unbounded.

3. **`planLocal()` is an ordering-sensitive regex cascade with no per-rule isolation.** ~25 branches in one function, tested only by asserting relative string position of literal explanation strings in the source file (not by actually invoking the function with sample inputs and checking the returned intent). Adding a new local intent means finding the right insertion point among existing regexes to avoid a false match upstream — this is exactly the kind of thing that produces subtle regressions ("weather" swallowing "weather in my code" style edge cases, etc.). Consider an ordered-rule-list data structure with actual unit tests that call `planLocal()` directly, rather than only source-text assertions.

4. **Test suite validates source text, not behavior.** All of `tests/policy.test.mjs` (240+ lines) works by reading `.ts`/`.swift`/`.tsx` files as strings and regex-matching against them — there is no test that actually imports and calls `planLocal`, `planWithOllama`, `browserNavigate`, etc., and asserts on real return values, nor any Electron-level integration/E2E test. This gives a false sense of coverage: a refactor that preserves all the matched substrings but changes behavior would pass every test. Given Phase 3 will likely touch the planner and/or add new tools, introducing real unit tests (calling exported functions with mocked `fetch`/`spawn`) for `planLocal`, `ollama.ts`, and `gemini.ts` would materially derisk the work — `ollama.ts` and `gemini.ts` already take an optional `fetcher` param that's clearly designed for this but currently unused by any test.

5. **No conversation/session persistence, no memory system beyond one name field** (§4, §5). Any Phase 3 feature involving "remember X for later," multi-session context, or task continuity needs this built from scratch — there's no partial implementation to extend, and no obvious extension point (the `conversation` array is a bare in-memory `let`, not behind an interface).

6. **Retrieval is single-folder, full-reindex-on-index, unchunked, lexical-only** (§6), and is not actually wired into `research()` as retrieval-augmented generation despite both features existing side by side. If Phase 3 wants real RAG (local docs informing AI answers) or multi-folder knowledge, this needs real design work, not incremental tweaks — the current `DELETE FROM documents` on every index call in particular will surprise anyone building on top of it.

7. **High fan-out per new intent/tool.** Adding one new capability today touches: `contracts.ts` (Intent union + any new payload types), `policy.ts` (registry entry), `main.ts` (planner branch + IPC handler + `traced` wrapping), `preload.cjs` (bridge method), `ollama.ts` PLAN_SCHEMA enum (if it should be AI-selectable), and `src.tsx` (dispatch branch in `executeText`, plus a view/UI if it renders something). Seven touchpoints for one capability is a lot of manual synchronization with no compiler/lint enforcement connecting them (e.g. nothing fails the build if an `Intent` enum value has no `planLocal` branch, no ollama schema entry, and no renderer dispatch — it would just silently fall through to `unknown` or a generic view-switch). A declarative tool-definition pattern (one object per tool that generates the policy entry, schema fragment, and dispatch registration) would reduce this significantly and is probably worth doing before adding several Phase 3 tools.

8. **Unused/dead surface area**: `orbit:policies` IPC handler is registered but never called by the renderer; `riskRank` export in `policy.ts` is never imported anywhere; `requiresConfirmation` is defined in `CommandPlan` and required in the Ollama JSON schema but never read by any consumer (renderer ignores it, main.ts ignores it). These suggest either an abandoned UI plan (a "what can Orbit do" / permissions screen) or an abandoned per-plan confirmation flow. Worth a decision — either wire them up (a policy/permissions view seems like natural Phase 3 material given "Auditability"/"Least privilege" are stated product principles) or remove them to reduce surface area.

9. **Browser automation is Chrome-only and fragile by nature.** AppleScript + regex-scraped YouTube HTML + injected page-search JS are all liable to break silently on Chrome/YouTube UI changes, and there's no automated way to detect that breakage (no integration test opens a real browser). If Phase 3 expands browser capabilities, consider at least a manual smoke-test checklist, since this can't be meaningfully unit-tested.

10. **No runtime schema validation on IPC boundaries.** `contracts.ts` types are compile-time only; handlers do minimal manual coercion (`String(x).slice(...)`) rather than a shared validator. This is a low but real risk given the renderer is sandboxed specifically because it's treated as semi-trusted — a malformed/oversized payload from a compromised renderer would rely on each handler's ad hoc guards rather than one shared boundary check.

---

## 11. Proposed Phase 3 plan — small, sequenced milestones

Ordered so each milestone is independently shippable, low-risk to the stable areas in §9, and unblocks the next one. None of this has been implemented — it's a proposal to discuss.

**M1 — Close the preload duplication (tech debt #1).** Decide and document which preload file is canonical; delete the other; add a `check`-time guard (even a simple diff-based test) so they can never silently diverge again. Pure cleanup, no user-visible change, de-risks every later milestone that touches the IPC surface.

**M2 — Add real unit tests for the planner and AI clients (tech debt #3, #4).** Using the existing `fetcher`/mock-friendly seams in `ollama.ts`/`gemini.ts`, add direct-call tests for `planLocal` (a table of input → expected intent) and mocked-fetch tests for `planWithOllama`/`answerWithGemini`/`answerWithOllama` error paths. This is the safety net every subsequent milestone benefits from, and it's independent of any product change.

**M3 — Extract `main.ts` integrations into sibling modules (tech debt #2).** Mechanical refactor: move weather/news/cricket into `src/main/live.ts`, GitHub into `src/main/github.ts`, browser automation into `src/main/browser.ts`, following the existing `tools.ts` pattern exactly. No behavior change; makes `main.ts` reviewable again and gives new integrations (M6+) an obvious home.

**M4 — Wire up or remove the dead policy/confirmation surface (tech debt #8).** Either (a) build a minimal "What can Orbit do" settings panel backed by the already-working `orbit:policies` call, and start honoring `requiresConfirmation` in the renderer for AI-suggested plans, or (b) remove both if they're not wanted. Small, and it turns two things this document flagged as ambiguous into a clear decision either way.

**M5 — Design (not yet build) a declarative tool-definition format (tech debt #7).** A short design doc/spike: one object per tool that derives the policy entry, the Ollama schema fragment, and the IPC registration, so a new tool is defined once instead of edited in 7 places. This directly de-risks every new integration in M6+ and should land before, not after, adding several new tools.

**M6 — Conversation persistence (§4, §5 gap).** Smallest viable memory step: persist the existing `conversation` array to disk (e.g. alongside `profile.json`) so context survives app restarts, with the same 20-entry cap. No new "memory" concept yet — just making the existing one durable. Natural precursor to any real memory/personalization feature.

**M7 — RAG: connect local knowledge search into `research()` (§6 gap).** When a research query isn't clearly a live-web question, also query the local FTS5 index and fold any high-scoring hits into the evidence passed to `answerWithGemini`/`answerWithOllama`, with citations rendered the same way live-web sources already are. This is the first milestone that turns the two existing-but-disconnected retrieval features into actual RAG, and it's scoped to not touch indexing.

**M8 — Multi-folder, additive indexing (§6 gap).** Remove the `DELETE FROM documents` full-wipe-on-index behavior; key rows by root so re-indexing one folder doesn't destroy another's index; let "Choose folder" be additive with a way to list/remove indexed roots. This is a real (if modest) schema/behavior change to `retrieval.py`, best done after M7 proves the retrieval path is worth investing in further.

**M9 — Evaluate the first new desktop integration (Music, per the discovery gap in §8, or Calendar per the README roadmap) using the M5 tool-definition pattern.** Pick one, build it end-to-end (AppleScript or a documented API, policy entry, planner rule, audit coverage, UI surface) as the first real test of the M5 pattern with a genuinely new capability rather than a refactor of an existing one.

Milestones M1–M5 are pure infrastructure/de-risking and could be done in any order or combined; M6 onward are the first user-visible Phase 3 features and are ordered by dependency (persistence before richer memory; RAG-wiring before schema changes to the index; tooling pattern before the first new integration that would otherwise add an 8th manual touchpoint).
