import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") process.exit(0);

const root = process.cwd();
const sourceFiles = [
  path.join(root, "native/macos/OrbitSpeech.swift"),
  path.join(root, "native/macos/OrbitGesture.swift"),
  path.join(root, "scripts/build-macos-native.sh"),
];
const outputFiles = [
  path.join(root, "release-sidecar/orbit-speech"),
  path.join(root, "release-sidecar/orbit-gesture"),
];
const stampFile = path.join(root, "release-sidecar/.orbit-native-source.sha256");

const hash = createHash("sha256");
for (const file of sourceFiles) hash.update(readFileSync(file));
const expected = hash.digest("hex");
const current = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : "";
const outputsReady = outputFiles.every(existsSync);

if (outputsReady && current === expected) {
  console.log("[orbit-native] macOS speech helper is current");
  process.exit(0);
}

console.log("[orbit-native] rebuilding macOS speech/gesture helpers for this source revision");
const result = spawnSync("/bin/zsh", [path.join(root, "scripts/build-macos-native.sh")], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.warn("[orbit-native] native helper rebuild failed; continuing dev startup with the existing helper if present");
  process.exit(0);
}

mkdirSync(path.dirname(stampFile), { recursive: true });
writeFileSync(stampFile, `${expected}\n`, "utf8");
console.log("[orbit-native] native speech helper rebuilt successfully");