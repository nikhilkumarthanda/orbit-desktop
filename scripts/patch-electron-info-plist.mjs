#!/usr/bin/env node
// Dev-mode Electron.app ships with a generic Info.plist that lacks the
// speech/location usage-description keys electron-builder injects into the
// packaged app via `build.mac.extendInfo`. Because orbit-speech is a bare
// (non-bundled) binary, macOS attributes its TCC checks to whichever app
// spawned it — in `npm run dev` that's this vendored Electron.app. Without
// these keys, requesting Speech/Location access aborts the helper with
// SIGABRT (TCC __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__) before it can even
// start. Patching node_modules here keeps dev parity with the packaged app;
// it's idempotent and safe to re-run after every `electron` install/update.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

if (process.platform !== "darwin") process.exit(0);

const plist = path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "Info.plist");
if (!existsSync(plist)) process.exit(0);

const usageDescriptions = {
  NSMicrophoneUsageDescription: "Orbit listens for the Hey Orbit wake phrase and voice commands while voice mode is enabled.",
  NSSpeechRecognitionUsageDescription: "Orbit transcribes approved voice commands into local desktop actions.",
  NSLocationWhenInUseUsageDescription: "Orbit uses your approximate location only when you ask for local weather. Coordinates are not stored.",
};

function currentValue(key) {
  try { return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim(); }
  catch { return null; }
}

for (const [key, value] of Object.entries(usageDescriptions)) {
  const existing = currentValue(key);
  if (existing === value) continue;
  const verb = existing === null ? "Add" : "Set";
  const type = verb === "Add" ? " string" : "";
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `${verb} :${key}${type} ${value}`, plist]);
  console.log(`[patch-electron-info-plist] ${verb === "Add" ? "added" : "updated"} ${key}`);
}
