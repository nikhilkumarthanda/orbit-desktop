import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface OrbitMemory {
  id: string;
  content: string;
  createdAt: string;
}

function memoryPath() {
  return path.join(app.getPath("userData"), "memories.enc");
}

async function load(): Promise<OrbitMemory[]> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return [];
    const encrypted = Buffer.from(await readFile(memoryPath(), "utf8"), "base64");
    const value = JSON.parse(safeStorage.decryptString(encrypted));
    return Array.isArray(value) ? value.filter(item => item?.id && item?.content) : [];
  } catch {
    return [];
  }
}

async function save(memories: OrbitMemory[]) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable");
  const encrypted = safeStorage.encryptString(JSON.stringify(memories));
  await writeFile(memoryPath(), encrypted.toString("base64"), { encoding: "utf8", mode: 0o600 });
}

export async function remember(content: string) {
  const clean = content.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!clean) throw new Error("There is nothing to remember");
  const memories = await load();
  const existing = memories.find(item => item.content.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const memory = { id: crypto.randomUUID(), content: clean, createdAt: new Date().toISOString() };
  memories.push(memory);
  await save(memories.slice(-200));
  return memory;
}

export async function recall(query = "") {
  const memories = await load();
  const words = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (!words.length) return memories.slice(-8).reverse();
  return memories
    .map(item => ({ item, score: words.filter(word => item.content.toLowerCase().includes(word)).length }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt))
    .slice(0, 8)
    .map(result => result.item);
}

export async function forget(ids: string[]) {
  const selected = new Set(ids);
  const memories = await load();
  const kept = memories.filter(item => !selected.has(item.id));
  await save(kept);
  return memories.length - kept.length;
}
