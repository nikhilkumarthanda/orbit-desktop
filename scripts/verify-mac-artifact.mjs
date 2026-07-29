#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  console.error("verify:mac must run on macOS");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const unsigned = process.argv.includes("--unsigned");
const explicit = process.argv.slice(2).find(value => value !== "--unsigned");
const dmg = explicit
  ? path.resolve(explicit)
  : readdirSync(dist).filter(name => name.endsWith(".dmg")).map(name => path.join(dist, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

if (!dmg || !existsSync(dmg)) throw new Error("No Orbit DMG was found");

const mount = mkdtempSync(path.join(tmpdir(), "orbit-verify-"));
let mounted = false;
try {
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg], { stdio: "inherit" });
  mounted = true;
  const app = path.join(mount, "Orbit.app");
  const required = [
    "Contents/MacOS/Orbit",
    "Contents/Info.plist",
    "Contents/Resources/app.asar",
    "Contents/Resources/sidecar/orbit-speech",
    "Contents/Resources/sidecar/orbit-gesture",
    "Contents/Resources/sidecar/orbit-retrieval",
  ];
  for (const relative of required) {
    if (!existsSync(path.join(app, relative))) throw new Error(`Packaged Orbit is missing ${relative}`);
  }
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription", "NSLocationWhenInUseUsageDescription"]) {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents/Info.plist")], { stdio: "ignore" });
  }
  if (!unsigned) {
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
    execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=2", app], { stdio: "inherit" });
  }
  console.log(
    `Verified ${path.basename(dmg)}: helpers and privacy metadata${unsigned ? "" : ", signature, and Gatekeeper assessment"} passed.`,
  );
} finally {
  if (mounted) execFileSync("hdiutil", ["detach", mount], { stdio: "ignore" });
  rmSync(mount, { recursive: true, force: true });
}
