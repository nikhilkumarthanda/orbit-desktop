#!/usr/bin/env node
// electron-builder ships the vendored Electron binary's own ad-hoc signature
// unchanged when no CSC_LINK/identity is configured - it never reseals the
// assembled app (real Info.plist, resources, asar) under one signature. That
// leaves "Sealed Resources=none" / "Info.plist=not bound", which macOS
// Gatekeeper reports as "<app> is damaged and can't be opened" (a broken-
// signature error, not the milder "unidentified developer" warning). Re-
// signing the whole bundle ad-hoc after packaging fixes that: the app is
// still unsigned by a real Developer ID (so first launch still needs a
// right-click > Open), but it's no longer reported as damaged.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const entitlements = path.join(context.packager.projectDir, "native/macos/OrbitSpeech.entitlements");
  execFileSync("/usr/bin/codesign", [
    "--deep", "--force", "--options", "runtime",
    "--entitlements", entitlements,
    "--sign", "-", appPath,
  ], { stdio: "inherit" });
}
