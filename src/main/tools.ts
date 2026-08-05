import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import type { CleanupCandidate, FileMatch, GitContext, RecentItem, SystemSnapshot } from "../shared/contracts.js";

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

async function fileItems(paths: string[]): Promise<RecentItem[]> {
  const unique = [...new Set(paths.map(value => value.trim()).filter(Boolean))];
  const items = await Promise.all(unique.slice(0, 250).map(async full => {
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
      const name = path.basename(full);
      return { path: full, name, modifiedAt: info.mtime.toISOString(), sizeBytes: info.size, kind: path.extname(name).slice(1) || "file" };
    } catch { return null; }
  }));
  return items.filter((item): item is RecentItem => item !== null);
}

export async function recentWork() {
  const home = os.homedir();
  const roots = ["Documents", "Desktop", "Downloads", "Projects", "Developer"].map(folder => path.join(home, folder));
  const items = (await Promise.all(roots.map(root => walk(root)))).flat();
  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 40);
}

const fileAliases: Record<string, string[]> = {
  excel: ["xlsx", "xls", "csv"], spreadsheet: ["xlsx", "xls", "csv", "numbers"],
  word: ["docx", "doc", "rtf"], document: ["docx", "doc", "pdf", "rtf", "txt"],
  presentation: ["pptx", "ppt", "key"], powerpoint: ["pptx", "ppt"], pdf: ["pdf"],
};

function fileQuery(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const ignored = new Set(["a", "an", "the", "my", "please", "file", "document", "open", "find", "show", "get", "locate", "we", "were", "working", "worked", "on", "from", "in", "that", "this", "me"]);
  return normalized.split(/\s+/).filter(token => token.length > 1 && !ignored.has(token));
}

function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function requestedFilename(value: string) {
  const quoted = value.match(/["'“”]([^"'“”]+)["'“”]/)?.[1];
  const withoutCommand = value.replace(/^\s*(?:please\s+)?(?:open|find|show|get|locate)\s+/i, "").trim();
  const candidate = (quoted || withoutCommand).replace(/\s+(?:from|in)\s+.+$/i, "").trim();
  return /\.[a-z0-9]{1,8}$/i.test(candidate) ? candidate : "";
}

async function spotlightFiles(query: string, tokens: string[]) {
  if (process.platform !== "darwin") return [];
  const exact = requestedFilename(query);
  const meaningful = tokens.filter(token => !fileAliases[token] && !new Set(["today", "yesterday", "recent", "latest", "last"]).has(token));
  const exactTerms = exact ? [...normalizedName(path.parse(exact).name).split(/\s+/), path.extname(exact).slice(1)] : [];
  const clauses = (exactTerms.length ? exactTerms : meaningful)
    .map(token => token.replace(/[\\'"*?]/g, " ").trim()).filter(Boolean).slice(0, 5)
    .map(token => `kMDItemFSName == '*${token}*'cd`);
  if (!clauses.length) return [];
  const output = await command("/usr/bin/mdfind", ["-onlyin", os.homedir(), clauses.join(" && ")]);
  return fileItems(output.split("\n"));
}

export async function findFiles(query: string): Promise<{ matches: FileMatch[] }> {
  const tokens = fileQuery(query);
  if (!tokens.length) return { matches: [] };
  const home = os.homedir();
  const roots = ["Documents", "Desktop", "Downloads", "Projects", "Developer", "Library/Mobile Documents/com~apple~CloudDocs"]
    .map(folder => path.join(home, folder));
  const approvedItems = (await Promise.all(roots.map(root => walk(root, 0, { value: 3000 })))).flat();
  const spotlightItems = await spotlightFiles(query, tokens);
  const items = [...new Map([...approvedItems, ...spotlightItems].map(item => [item.path, item])).values()];
  const now = Date.now();
  const requestedExtensions = new Set(tokens.flatMap(token => fileAliases[token] || []));
  const nameTokens = tokens.filter(token => !fileAliases[token]);
  const relativeWords = new Set(["today", "yesterday", "recent", "latest", "last"]);
  const exactRequest = requestedFilename(query);
  const exactNormalized = normalizedName(exactRequest);
  const exactStem = normalizedName(path.parse(exactRequest).name);
  const exactStemTokens = exactStem.split(/\s+/).filter(Boolean);
  const scored = items.map(item => {
    const name = normalizedName(item.name);
    const stem = normalizedName(path.parse(item.name).name);
    const extension = item.kind.toLowerCase();
    const ageDays = Math.max(0, (now - new Date(item.modifiedAt).getTime()) / 86_400_000);
    let score = 0;
    const reasons: string[] = [];
    if (exactNormalized && name === exactNormalized) { score += 160; reasons.push("exact filename match"); }
    else if (exactStem && stem === exactStem) { score += 130; reasons.push("exact name match"); }
    else if (exactStem && (stem.includes(exactStem) || exactStem.includes(stem))) { score += 55; reasons.push("close filename match"); }
    else if (exactStemTokens.length && exactStemTokens.every(token => stem.split(/\s+/).includes(token))) { score += 70; reasons.push("all requested name words match"); }
    for (const token of nameTokens) {
      if (relativeWords.has(token)) continue;
      if (name.includes(token)) { score += name.split(/\s+/).includes(token) ? 30 : 18; reasons.push(`name matches “${token}”`); }
    }
    if (requestedExtensions.has(extension)) { score += 28; reasons.push(`${extension.toUpperCase()} file`); }
    if (tokens.some(token => relativeWords.has(token))) {
      const recency = ageDays < 2 ? 24 : ageDays < 7 ? 12 : ageDays < 30 ? 4 : 0;
      score += recency;
      if (recency) reasons.push(ageDays < 2 ? "modified recently" : "recently modified");
    } else score += Math.max(0, 8 - Math.min(8, ageDays / 14));
    return { ...item, score: Math.round(score * 10) / 10, reason: reasons.slice(0, 3).join(" · ") || "recent local file" };
  }).filter(item => item.score > 10).sort((a, b) => b.score - a.score || b.modifiedAt.localeCompare(a.modifiedAt));
  return { matches: scored.slice(0, 8) };
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
