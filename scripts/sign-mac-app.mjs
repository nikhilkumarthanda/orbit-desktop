#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const codesign = (target, entitlements, deep = false) => {
  const args = ["--force", "--sign", "-", "--timestamp=none"];
  if (deep) {
    args.push("--deep");
  }
  if (entitlements) {
    args.push("--options", "runtime", "--entitlements", entitlements);
  }
  args.push(target);
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
};

const findNestedCode = (appPath) => {
  const frameworks = path.join(appPath, "Contents", "Frameworks");
  if (!fs.existsSync(frameworks)) return [];

  const result = execFileSync("/usr/bin/find", [
    frameworks,
    "-depth",
    "(",
    "-type", "d", "(",
    "-name", "*.framework", "-o",
    "-name", "*.app", "-o",
    "-name", "*.xpc",
    ")",
    "-o",
    "-type", "f", "(",
    "-name", "*.dylib", "-o",
    "-perm", "-111",
    ")",
    ")",
    "-print",
  ], { encoding: "utf8" });

  return [...new Set(result.split("\n").filter(Boolean))];
};

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const entitlements = path.join(context.packager.projectDir, "native/macos/OrbitSpeech.entitlements");

  // Electron's vendored frameworks arrive signed by Electron's Developer ID.
  // Signing only the outer Orbit.app leaves mixed Team IDs and macOS terminates
  // the process at launch. Re-sign every nested code object deepest-first with
  // the same ad-hoc identity, then seal the outer app last.
  for (const target of findNestedCode(appPath)) {
    codesign(target);
  }
  // Seal the complete app once more after every nested object has been
  // re-signed. `--deep` is safe here because the explicit inside-out pass has
  // already removed Electron\'s vendor identity from nested code.
  codesign(appPath, entitlements, true);

  execFileSync("/usr/bin/codesign", [
    "--verify", "--deep", "--strict", "--verbose=4", appPath,
  ], { stdio: "inherit" });
}
