import type { Risk, ToolPolicy } from "../shared/contracts.js";

export const policies: ToolPolicy[] = [
  { name: "system.snapshot", risk: "read", approvalRequired: false, description: "Inspect CPU, memory, storage and processes" },
  { name: "work.recent", risk: "sensitive", approvalRequired: false, description: "Read metadata from recent local files" },
  { name: "files.find", risk: "sensitive", approvalRequired: false, description: "Rank file metadata in approved Mac folders against a natural-language request" },
  { name: "git.context", risk: "read", approvalRequired: false, description: "Inspect local Git repository metadata" },
  { name: "cleanup.plan", risk: "read", approvalRequired: false, description: "Identify cleanup candidates without modifying them" },
  { name: "knowledge.index", risk: "sensitive", approvalRequired: true, description: "Index text from a user-selected folder into the local database" },
  { name: "knowledge.search", risk: "sensitive", approvalRequired: false, description: "Search the local document index" },
  { name: "command.plan", risk: "read", approvalRequired: false, description: "Classify a command locally into a typed Orbit workflow" },
  { name: "files.open", risk: "reversible", approvalRequired: false, description: "Open a cited local path with its default application" },
  { name: "app.launch", risk: "external", approvalRequired: false, description: "Launch an installed application selected by Orbit's typed planner" },
  { name: "mac.permissions", risk: "read", approvalRequired: false, description: "Check whether macOS Accessibility control is available" },
  { name: "mac.control", risk: "reversible", approvalRequired: false, description: "Control an application, window, or Finder through a typed native action" },
  { name: "mac.files.change", risk: "sensitive", approvalRequired: true, description: "Create, move, or rename an explicitly selected local path after confirmation" },
  { name: "github.workflow", risk: "external", approvalRequired: false, description: "Read public GitHub Actions status and open it in Chrome" },
  { name: "browser.navigate", risk: "external", approvalRequired: false, description: "Open a validated public web destination in a new Chrome tab" },
  { name: "live.info", risk: "external", approvalRequired: false, description: "Retrieve live weather, news, sports, or finance information (transient Mac location used only for weather) and summarize it naturally" },
  { name: "web.research", risk: "external", approvalRequired: false, description: "Search public web sources and synthesize a cited answer" },
  { name: "contacts.resolve", risk: "sensitive", approvalRequired: false, description: "Resolve a spoken name against macOS Contacts without exposing the address book to the renderer" },
  { name: "email.draft", risk: "external", approvalRequired: false, description: "Generate and open an editable email draft; sending remains a separate confirmed action" },
  { name: "contact.call", risk: "external", approvalRequired: true, description: "Open a confirmed FaceTime or telephone call for a resolved contact" },
  { name: "social.draft", risk: "external", approvalRequired: false, description: "Generate and insert an editable social post into a supported signed-in web composer" },
  { name: "social.publish", risk: "external", approvalRequired: true, description: "Publish the active social draft only after explicit confirmation" },
  { name: "system.battery", risk: "read", approvalRequired: false, description: "Read the Mac battery level and charging state" },
  { name: "screen.describe", risk: "sensitive", approvalRequired: false, description: "Capture the current screen and send it to the configured vision model" },
  { name: "screen.capture", risk: "sensitive", approvalRequired: false, description: "Capture the primary display and save it locally to Desktop" },
  { name: "gemini.configure", risk: "sensitive", approvalRequired: false, description: "Store a Gemini API key in macOS Keychain" },
  { name: "files.trash", risk: "destructive", approvalRequired: true, description: "Move explicitly selected files to operating-system Trash" },
  { name: "browser.agent.youtube", risk: "external", approvalRequired: false, description: "Search YouTube and play the first result in a dedicated automation browser" },
  { name: "browser.agent.amazon", risk: "external", approvalRequired: false, description: "Search Amazon and apply a price filter in a dedicated automation browser" },
  { name: "browser.agent.describe", risk: "read", approvalRequired: false, description: "Read-only inspection of the current automation browser page" },
  { name: "browser.agent.summarize", risk: "external", approvalRequired: false, description: "Summarize the current automation browser page's article text using the configured AI model" },
  { name: "browser.agent.find", risk: "read", approvalRequired: false, description: "Locate a button or link on the current automation browser page matching a description" },
];

export function policy(name: string): ToolPolicy {
  const match = policies.find(item => item.name === name);
  if (!match) throw new Error(`Unregistered tool: ${name}`);
  return match;
}

export const riskRank: Record<Risk, number> = { read: 0, reversible: 1, sensitive: 2, external: 3, destructive: 4 };
