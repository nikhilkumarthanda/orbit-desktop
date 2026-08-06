import { access, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { shell, systemPreferences } from "electron";
import type { MacControlRequest, MacControlResult, MacPermissionStatus, MacWindow } from "../shared/contracts.js";

function run(executable: string, args: string[], timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("The macOS action timed out")); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `macOS returned exit code ${code}`));
    });
  });
}

async function appleScript(source: string, args: string[] = []) {
  if (process.platform !== "darwin") throw new Error("Native application control is available on macOS only");
  return run("/usr/bin/osascript", ["-e", source, ...args]);
}

function safeApplication(value?: string) {
  const application = String(value || "").trim();
  if (!application || application.length > 120 || /[\r\n]/.test(application)) throw new Error("Orbit needs a valid application name");
  return application;
}

function absoluteTarget(value?: string) {
  const target = path.resolve(String(value || ""));
  if (!value || !path.isAbsolute(String(value))) throw new Error("Orbit only changes absolute paths you selected");
  return target;
}

async function verifyRunning(application: string, expected: boolean) {
  let running = false;
  try { await run("/usr/bin/pgrep", ["-x", application], 2_000); running = true; } catch {}
  return running === expected;
}

export async function macPermissionStatus(): Promise<MacPermissionStatus> {
  if (process.platform !== "darwin") return { platform: "unsupported", accessibility: "unavailable", automation: "unavailable", guidance: "Orbit native control requires macOS." };
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
  return {
    platform: "macOS",
    accessibility,
    automation: "unknown",
    guidance: accessibility === "granted" ? "Accessibility is ready. macOS may separately ask for Automation access per application." : "Enable Orbit in System Settings → Privacy & Security → Accessibility.",
  };
}

export async function listMacWindows(): Promise<MacWindow[]> {
  const output = await appleScript(`set AppleScript's text item delimiters to linefeed
tell application "System Events"
set rows to {}
repeat with p in (application processes whose background only is false)
  set appName to name of p
  repeat with w in windows of p
    try
      set end of rows to appName & tab & name of w
    end try
  end repeat
end repeat
return rows as text
end tell`);
  return output.split("\n").map(row => {
    const [application, ...title] = row.split("\t");
    return { application, title: title.join("\t") };
  }).filter(item => item.application && item.title).slice(0, 100);
}

export async function executeMacControl(request: MacControlRequest): Promise<MacControlResult> {
  const action = request?.action;
  if (action === "list_windows") {
    const windows = await listMacWindows();
    return { action, completed: true, verified: true, summary: windows.length ? `Found ${windows.length} open windows.` : "No standard application windows are open.", windows };
  }

  if (["open_app", "focus_app", "hide_app", "quit_app", "focus_window"].includes(action)) {
    const application = safeApplication(request.application);
    if (action === "open_app" || action === "focus_app") {
      await run("/usr/bin/open", ["-a", application]);
      const verified = await verifyRunning(application, true);
      return { action, completed: verified, verified, summary: verified ? `${application} is open and active.` : `macOS did not verify that ${application} opened.` };
    }
    if (action === "hide_app") {
      await appleScript('on run argv\ntell application "System Events" to set visible of process (item 1 of argv) to false\nend run', [application]);
      return { action, completed: true, verified: true, summary: `${application} is hidden.` };
    }
    if (action === "quit_app") {
      await appleScript('on run argv\ntell application (item 1 of argv) to quit\nend run', [application]);
      await new Promise(resolve => setTimeout(resolve, 350));
      const verified = await verifyRunning(application, false);
      return { action, completed: verified, verified, summary: verified ? `${application} closed.` : `${application} is still running, possibly because it has unsaved work.` };
    }
    const title = String(request.windowTitle || "").trim();
    if (!title) throw new Error("Orbit needs part of the window title");
    const output = await appleScript(`on run argv
set appName to item 1 of argv
set titlePart to item 2 of argv
tell application "System Events"
  tell process appName
    set frontmost to true
    repeat with w in windows
      if name of w contains titlePart then
        perform action "AXRaise" of w
        return name of w
      end if
    end repeat
  end tell
end tell
return ""
end run`, [application, title]);
    const verified = Boolean(output);
    return { action, completed: verified, verified, summary: verified ? `Brought “${output}” forward in ${application}.` : `I couldn't find a ${application} window containing “${title}”.` };
  }

  if (action === "open_file_with") {
    const target = absoluteTarget(request.sourcePath);
    const application = safeApplication(request.application);
    await access(target);
    await run("/usr/bin/open", ["-a", application, target]);
    const verified = await verifyRunning(application, true);
    return { action, completed: verified, verified, summary: verified ? `Opened ${path.basename(target)} in ${application}.` : `macOS did not verify ${application}.` };
  }
  if (action === "reveal_file") {
    const target = absoluteTarget(request.sourcePath);
    await access(target);
    shell.showItemInFolder(target);
    return { action, completed: true, verified: true, summary: `Revealed ${path.basename(target)} in Finder.` };
  }
  if (action === "create_folder") {
    const target = absoluteTarget(request.destinationPath);
    await mkdir(target);
    const verified = (await stat(target)).isDirectory();
    return { action, completed: verified, verified, summary: verified ? `Created folder ${path.basename(target)}.` : "macOS did not verify the new folder." };
  }
  if (action === "move_path" || action === "rename_path") {
    const source = absoluteTarget(request.sourcePath);
    const destination = absoluteTarget(request.destinationPath);
    if (source === destination) throw new Error("The source and destination are the same");
    await rename(source, destination);
    let verified = false;
    try { await access(destination); verified = true; } catch {}
    return { action, completed: verified, verified, summary: verified ? `${action === "move_path" ? "Moved" : "Renamed"} ${path.basename(source)} to ${path.basename(destination)}.` : "macOS did not verify the file change." };
  }
  throw new Error("Unsupported macOS action");
}
