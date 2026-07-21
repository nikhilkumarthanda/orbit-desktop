import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import type { CleanupCandidate, GitContext, RecentItem, SystemSnapshot } from "../shared/contracts.js";

const exec = promisify(execFile);
const GB = 1024 ** 3;

async function command(binary: string, args: string[]) {
  try { return (await exec(binary, args, { timeout: 6000, maxBuffer: 2_000_000 })).stdout.trim(); }
  catch { return ""; }
}

async function cpuUsage() {
  const before = os.cpus();
  await new Promise(resolve => setTimeout(resolve, 180));
  const after = os.cpus();
  let idle = 0, total = 0;
  after.forEach((cpu, index) => {
    const previous = before[index].times;
    const current = cpu.times;
    idle += current.idle - previous.idle;
    total += Object.keys(current).reduce((sum, key) => sum + current[key as keyof typeof current] - previous[key as keyof typeof previous], 0);
  });
  return total ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

export async function systemSnapshot(): Promise<SystemSnapshot> {
  const processText = await command("ps", ["-axo", "pid=,comm=,%cpu=,%mem=", "-r"]);
  const processes = processText.split("\n").filter(Boolean).slice(0, 10).map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)$/);
    return match ? { pid: Number(match[1]), name: path.basename(match[2]), cpuPct: Number(match[3]), memoryPct: Number(match[4]) } : null;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const df = await command("df", ["-k", "/"]);
  const row = df.split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const total = os.totalmem(), free = os.freemem();
  return {
    platform: `${os.type()} ${os.release()}`, hostname: os.hostname(), uptimeHours: Math.round(os.uptime() / 360) / 10,
    cpuModel: os.cpus()[0]?.model ?? "Unknown", cpuUsagePct: await cpuUsage(),
    memory: { totalGb: Math.round(total / GB * 10) / 10, usedGb: Math.round((total - free) / GB * 10) / 10, usedPct: Math.round((1 - free / total) * 1000) / 10 },
    storage: row.length >= 5 ? [{ mount: "/", totalGb: Math.round(Number(row[1]) / 1024 ** 2 * 10) / 10, usedGb: Math.round(Number(row[2]) / 1024 ** 2 * 10) / 10, usedPct: Number(row[4].replace("%", "")) }] : [],
    processes, capturedAt: new Date().toISOString(),
  };
}

async function walk(root: string, depth = 0, budget = { value: 1200 }): Promise<RecentItem[]> {
  if (depth > 4 || budget.value <= 0) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const output: RecentItem[] = [];
    for (const entry of entries) {
      if (--budget.value <= 0 || entry.name.startsWith(".")) break;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) output.push(...await walk(full, depth + 1, budget));
      else if (entry.isFile()) {
        const info = await stat(full);
        output.push({ path: full, name: entry.name, modifiedAt: info.mtime.toISOString(), sizeBytes: info.size, kind: path.extname(entry.name).slice(1) || "file" });
      }
    }
    return output;
  } catch { return []; }
}

export async function recentWork() {
  const home = os.homedir();
  const roots = ["Documents", "Desktop", "Downloads", "Projects", "Developer"].map(folder => path.join(home, folder));
  const items = (await Promise.all(roots.map(root => walk(root)))).flat();
  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 40);
}

export async function gitContexts(): Promise<GitContext[]> {
  const home = os.homedir();
  const found = await command("find", [home, "-maxdepth", "4", "-type", "d", "-name", ".git"]);
  const repos = found.split("\n").filter(Boolean).slice(0, 20).map(item => path.dirname(item));
  const contexts: GitContext[] = [];
  for (const repo of repos) {
    const [branch, status, log] = await Promise.all([
      command("git", ["-C", repo, "branch", "--show-current"]), command("git", ["-C", repo, "status", "--short"]),
      command("git", ["-C", repo, "log", "-1", "--format=%s%x09%cI"]),
    ]);
    const [lastCommit = "No commits", lastCommitAt = ""] = log.split("\t");
    contexts.push({ path: repo, branch: branch || "detached", status: status.split("\n").filter(Boolean), lastCommit, lastCommitAt });
  }
  return contexts.sort((a, b) => b.lastCommitAt.localeCompare(a.lastCommitAt));
}

export async function cleanupPlan(): Promise<CleanupCandidate[]> {
  const downloads = await walk(path.join(os.homedir(), "Downloads"), 0, { value: 2500 });
  const cutoff = Date.now() - 90 * 86400_000;
  return downloads.filter(item => item.sizeBytes > 25 * 1024 ** 2 || new Date(item.modifiedAt).getTime() < cutoff)
    .sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 50)
    .map(item => ({ ...item, reason: item.sizeBytes > 25 * 1024 ** 2 ? "Large download" : "Not modified in 90 days", recoverable: true }));
}
