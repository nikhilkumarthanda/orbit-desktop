export type Risk = "read" | "reversible" | "sensitive" | "external" | "destructive";

export interface ToolPolicy {
  name: string;
  risk: Risk;
  approvalRequired: boolean;
  description: string;
}

export interface SystemSnapshot {
  platform: string;
  hostname: string;
  uptimeHours: number;
  cpuModel: string;
  cpuUsagePct: number;
  memory: { totalGb: number; usedGb: number; usedPct: number };
  storage: { mount: string; totalGb: number; usedGb: number; usedPct: number }[];
  processes: { pid: number; name: string; cpuPct: number; memoryPct: number }[];
  capturedAt: string;
}

export interface RecentItem { path: string; name: string; modifiedAt: string; sizeBytes: number; kind: string }
export interface GitContext { path: string; branch: string; status: string[]; lastCommit: string; lastCommitAt: string }
export interface CleanupCandidate extends RecentItem { reason: string; recoverable: true }
export interface AuditEvent { id: string; at: string; tool: string; risk: Risk; status: string; summary: string }
export interface SearchHit { path: string; title: string; excerpt: string; score: number; modified_at: number }
export type Intent = "battery" | "screen" | "system" | "recent" | "knowledge" | "git" | "github" | "browser" | "cleanup" | "audit" | "launch" | "folder" | "weather" | "news" | "cricket" | "soccer" | "finance" | "daily_brief" | "youtube_play" | "amazon_search" | "page_describe" | "page_summarize" | "page_find" | "notifications" | "research" | "answer" | "clarify" | "unknown";
export interface ConversationTurn { role: "user" | "assistant"; content: string }
export interface CommandPlan { intent: Intent; confidence: number; explanation: string; query?: string; application?: string; folder?: string; repository?: string; url?: string; reply?: string; sameTab?: boolean; browserAction?: "play_first"|"scroll_down"|"scroll_up"; maxPrice?: number; minPrice?: number; liveServices?: string[]; requiresConfirmation?: boolean; source?: "local"|"ollama"; model?: string }
export interface GitHubWorkflowStatus { repository: string; state: "success"|"failure"|"pending"|"unknown"; workflow?: string; url: string; summary: string }
export interface LiveBrief { summary: string; source: string; updatedAt: string }
export interface ResearchSource { title: string; url: string; excerpt: string }
export interface ResearchAnswer { answer: string; spokenAnswer: string; sources: ResearchSource[]; updatedAt: string }
export interface AIStatus { provider: "ollama"; configured: boolean; available: boolean; running: boolean; model: string; cost: "$0"; installCommand: string }
export interface GeminiUsageStatus { month: string; requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; monthlyBudgetUsd: number; remainingUsd: number; blocked: boolean }
export interface GeminiStatus { provider: "gemini"; configured: boolean; available: boolean; model: string; cost: "$0 on Google free tier"; usage: GeminiUsageStatus }
export interface BatteryStatus { percentage: number; charging: boolean; timeRemaining?: string; summary: string }
export interface VoiceEvent { type: "ready"|"wake"|"listening"|"partial"|"command"|"speaking"|"interrupted"|"error"|"unavailable"|"stopped"; text?: string; message?: string; onDevice?: boolean; mode?: "wake-word"|"command" }

export interface OrbitAPI {
  policies(): Promise<ToolPolicy[]>;
  systemSnapshot(): Promise<SystemSnapshot>;
  recentWork(): Promise<RecentItem[]>;
  gitContext(): Promise<GitContext[]>;
  cleanupPlan(): Promise<CleanupCandidate[]>;
  trash(paths: string[]): Promise<{ moved: string[]; failed: string[] }>;
  audit(): Promise<AuditEvent[]>;
  indexKnowledge(): Promise<{ indexed: number; skipped: number; cancelled?: boolean }>;
  searchKnowledge(query: string): Promise<{ hits: SearchHit[] }>;
  planCommand(command: string): Promise<CommandPlan>;
  openPath(path: string): Promise<boolean>;
  openFolder(folder: string): Promise<{ opened: boolean; folder: string }>;
  launchApplication(application: string): Promise<{ launched: boolean; application: string }>;
  githubWorkflow(repository?: string): Promise<GitHubWorkflowStatus>;
  browserNavigate(request: { url?: string; query?: string; site?: string; sameTab?: boolean; browserAction?: "play_first"|"scroll_down"|"scroll_up" }): Promise<{ opened: boolean; url: string; site: string; summary: string }>;
  liveInfo(request: { query: string; services?: string[] }): Promise<LiveBrief>;
  youtubePlay(query: string): Promise<{ summary: string }>;
  amazonSearch(request: { query: string; maxPrice?: number; minPrice?: number }): Promise<{ summary: string }>;
  describePage(): Promise<{ summary: string }>;
  summarizePage(): Promise<{ summary: string }>;
  findOnPage(query: string): Promise<{ summary: string }>;
  research(query: string): Promise<ResearchAnswer>;
  batteryStatus(): Promise<BatteryStatus>;
  describeScreen(query: string): Promise<ResearchAnswer>;
  startVoice(): Promise<{ started: boolean }>;
  stopVoice(): Promise<{ stopped: boolean }>;
  stopSpeaking(): Promise<{ stopped: boolean }>;
  armVoice(): Promise<{ armed: boolean }>;
  speak(text: string): Promise<boolean>;
  onVoiceEvent(callback: (event: VoiceEvent) => void): () => void;
  onVoiceCommand(callback: (command: string) => void): () => void;
  aiStatus(): Promise<AIStatus>;
  geminiStatus(): Promise<GeminiStatus>;
  configureGemini(apiKey: string): Promise<GeminiStatus>;
  setGeminiBudget(monthlyBudgetUsd: number): Promise<GeminiStatus>;
}
