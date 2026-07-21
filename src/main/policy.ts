import type { Risk, ToolPolicy } from "../shared/contracts.js";

export const policies: ToolPolicy[] = [
  { name: "system.snapshot", risk: "read", approvalRequired: false, description: "Inspect CPU, memory, storage and processes" },
  { name: "work.recent", risk: "sensitive", approvalRequired: false, description: "Read metadata from recent local files" },
  { name: "git.context", risk: "read", approvalRequired: false, description: "Inspect local Git repository metadata" },
  { name: "cleanup.plan", risk: "read", approvalRequired: false, description: "Identify cleanup candidates without modifying them" },
  { name: "knowledge.index", risk: "sensitive", approvalRequired: true, description: "Index text from a user-selected folder into the local database" },
  { name: "knowledge.search", risk: "sensitive", approvalRequired: false, description: "Search the local document index" },
  { name: "command.plan", risk: "read", approvalRequired: false, description: "Classify a command locally into a typed Orbit workflow" },
  { name: "files.open", risk: "reversible", approvalRequired: false, description: "Open a cited local path with its default application" },
  { name: "app.launch", risk: "external", approvalRequired: false, description: "Launch an installed application selected by Orbit's typed planner" },
  { name: "ai.credentials", risk: "sensitive", approvalRequired: false, description: "Store or remove an encrypted OpenAI API key" },
  { name: "files.trash", risk: "destructive", approvalRequired: true, description: "Move explicitly selected files to operating-system Trash" },
];

export function policy(name: string): ToolPolicy {
  const match = policies.find(item => item.name === name);
  if (!match) throw new Error(`Unregistered tool: ${name}`);
  return match;
}

export const riskRank: Record<Risk, number> = { read: 0, reversible: 1, sensitive: 2, external: 3, destructive: 4 };
