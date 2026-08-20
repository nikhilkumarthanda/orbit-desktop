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
export interface FileMatch extends RecentItem { score: number; reason: string }
export interface GitContext { path: string; branch: string; status: string[]; lastCommit: string; lastCommitAt: string }
export interface CleanupCandidate extends RecentItem { reason: string; recoverable: true }
export interface AuditEvent { id: string; at: string; tool: string; risk: Risk; status: string; summary: string }
export interface SearchHit { path: string; title: string; excerpt: string; score: number; modified_at: number }
export type Intent = "browser_task" | "battery" | "screen" | "screenshot" | "system" | "recent" | "knowledge" | "git" | "github" | "browser" | "cleanup" | "audit" | "launch" | "mac_control" | "folder" | "file" | "email_draft" | "email_rewrite" | "contact_call" | "social_draft" | "social_publish" | "weather" | "news" | "cricket" | "soccer" | "finance" | "daily_brief" | "youtube_play" | "amazon_search" | "page_describe" | "page_summarize" | "page_find" | "notifications" | "memory" | "research" | "answer" | "clarify" | "unknown";
export interface ConversationTurn { role: "user" | "assistant"; content: string }
export interface ConversationEntry extends ConversationTurn { id: string; at: string }
export type MacControlAction = "open_app" | "focus_app" | "hide_app" | "quit_app" | "list_windows" | "focus_window" | "open_file_with" | "reveal_file" | "create_folder" | "move_path" | "rename_path";
export interface MacControlRequest { action: MacControlAction; application?: string; windowTitle?: string; sourcePath?: string; destinationPath?: string }
export interface MacWindow { application: string; title: string }
export interface MacControlResult { action: MacControlAction; completed: boolean; verified: boolean; summary: string; windows?: MacWindow[] }
export interface MacPermissionStatus { platform: "macOS" | "unsupported"; accessibility: "granted" | "denied" | "unavailable"; automation: "unknown" | "unavailable"; guidance: string }
export type DraftProvider = "gmail" | "outlook" | "mail";
export interface WritingPreferences { tone: "professional"|"friendly"|"casual"|"formal"; length: "concise"|"balanced"|"detailed"; greeting: string; signature: string; natural: boolean }
export interface RecipientChoice { id: string; name: string; emails: string[]; phones: string[]; score: number }
export interface DraftResult { drafted: boolean; summary: string; subject?: string; body?: string; recipient?: string; displayName?: string; providers?: DraftProvider[]; recipients?: RecipientChoice[]; verifiedFields?: Array<"recipient"|"subject"|"body"> }
export type SocialProvider = "linkedin" | "facebook";
export interface SocialDraftResult { drafted: boolean; summary: string; content: string; provider?: SocialProvider; providers?: SocialProvider[] }
export interface CommandPlan { intent: Intent; confidence: number; explanation: string; query?: string; application?: string; macAction?: MacControlRequest; folder?: string; repository?: string; url?: string; reply?: string; recipient?: string; subject?: string; body?: string; provider?: DraftProvider; sameTab?: boolean; browserAction?: "play_first"|"scroll_down"|"scroll_up"|"select_result"|"selection_next"|"selection_previous"|"selection_open"; resultIndex?: number; maxPrice?: number; minPrice?: number; liveServices?: string[]; requiresConfirmation?: boolean; source?: "local"|"ollama"; model?: string }
export interface GitHubWorkflowStatus { repository: string; state: "success"|"failure"|"pending"|"unknown"; workflow?: string; url: string; summary: string }
export interface LiveBrief { summary: string; source: string; updatedAt: string }
export interface ResearchSource { title: string; url: string; excerpt: string }
export type ResearchStage = "thinking" | "searching" | "reading" | "comparing" | "writing";
export interface ResearchProgress { stage: ResearchStage; message: string; current?: number; total?: number; source?: string }
export interface ResearchAnswer { answer: string; spokenAnswer: string; sources: ResearchSource[]; updatedAt: string }
export type BrowserTaskStatus = "running"|"waiting_for_confirmation"|"paused"|"completed"|"cancelled"|"failed";
export type BrowserPlanner = "gemini"|"ollama";
export type BrowserTaskActionType = "navigate"|"new_tab"|"switch_tab"|"close_tab"|"back"|"forward"|"reload"|"click"|"fill"|"select"|"scroll"|"wait"|"complete"|"ask_user";
export interface BrowserTaskAction { type: BrowserTaskActionType; url?: string; label?: string; value?: string; direction?: "up"|"down"; tabId?: string; tabIndex?: number; reason?: string }
export interface BrowserTaskStep { at: string; action: BrowserTaskAction; outcome: string }
export interface BrowserTask { id: string; goal: string; status: BrowserTaskStatus; steps: BrowserTaskStep[]; summary: string; url: string; title: string; planner?: BrowserPlanner; pendingAction?: BrowserTaskAction }
export interface BrowserTaskEvent { type: "status"|"step"; task: BrowserTask; message?: string }
export interface EmbeddedBrowserTab { id: string; url: string; title: string; loading: boolean }
export interface EmbeddedBrowserState { visible: boolean; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; activeTabId: string; tabs: EmbeddedBrowserTab[] }
export interface AIStatus { provider: "ollama"; configured: boolean; available: boolean; running: boolean; model: string; cost: "$0"; installCommand: string }
export interface GeminiUsageStatus { month: string; requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; monthlyBudgetUsd: number; remainingUsd: number; blocked: boolean }
export interface GeminiStatus { provider: "gemini"; configured: boolean; available: boolean; model: string; cost: "$0 on Google free tier"; usage: GeminiUsageStatus }
export interface BatteryStatus { percentage: number; charging: boolean; timeRemaining?: string; summary: string }
export interface VoiceEvent { type: "ready"|"wake"|"listening"|"partial"|"command"|"speaking"|"interrupted"|"error"|"unavailable"|"stopped"; text?: string; message?: string; onDevice?: boolean; mode?: "wake-word"|"command" }
export type OrbitPlayMode = "playground" | "desktop";
export type OrbitPlayAction = "move" | "down" | "up" | "scroll" | "media-toggle" | "stop";
export interface OrbitPlayStatus { active: boolean; mode: OrbitPlayMode; supported: boolean; permission: "unknown"|"granted"|"denied"; message: string }
export interface OrbitPlayGesture { action: OrbitPlayAction; x?: number; y?: number; deltaY?: number }

export interface OrbitAPI {
  policies(): Promise<ToolPolicy[]>;
  systemSnapshot(): Promise<SystemSnapshot>;
  recentWork(): Promise<RecentItem[]>;
  findFiles(query: string): Promise<{ matches: FileMatch[] }>;
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
  macPermissions(): Promise<MacPermissionStatus>;
  macControl(request: MacControlRequest): Promise<MacControlResult>;
  draftEmail(request: { recipient?: string; subject: string; body: string; instruction?: string; provider?: DraftProvider }): Promise<DraftResult>;
  rewriteEmail(request: { recipient?: string; subject?: string; body?: string; instruction: string }): Promise<DraftResult>;
  writingPreferences(): Promise<WritingPreferences>;
  saveWritingPreferences(preferences: WritingPreferences): Promise<WritingPreferences>;
  callContact(request: { recipient: string; value?: string }): Promise<DraftResult>;
  showMainWindow(): Promise<{ shown: boolean }>;
  setAssistantState(state: "ready"|"listening"|"working"|"attention"|"muted"): Promise<{ updated: boolean }>;
  onAssistantState(callback: (state: "ready"|"listening"|"working"|"attention"|"muted") => void): () => void;
  socialDraft(request: { instruction?: string; content?: string; provider?: SocialProvider }): Promise<SocialDraftResult>;
  socialPublish(provider: SocialProvider): Promise<{ published: boolean; summary: string }>;
  conversationHistory(): Promise<ConversationEntry[]>;
  appendConversation(turn: ConversationTurn): Promise<ConversationEntry[]>;
  clearConversation(): Promise<{ cleared: boolean }>;
  githubWorkflow(repository?: string): Promise<GitHubWorkflowStatus>;
  browserNavigate(request: { url?: string; query?: string; site?: string; sameTab?: boolean; browserAction?: "play_first"|"scroll_down"|"scroll_up"|"select_result"|"selection_next"|"selection_previous"|"selection_open"; resultIndex?: number }): Promise<{ opened: boolean; url: string; site: string; summary: string }>;
  liveInfo(request: { query: string; services?: string[] }): Promise<LiveBrief>;
  youtubePlay(query: string): Promise<{ summary: string }>;
  amazonSearch(request: { query: string; maxPrice?: number; minPrice?: number }): Promise<{ summary: string }>;
  describePage(): Promise<{ summary: string }>;
  summarizePage(): Promise<{ summary: string }>;
  findOnPage(query: string): Promise<{ summary: string }>;
  startBrowserTask(goal: string): Promise<BrowserTask>;
  resumeBrowserTask(confirmed: boolean): Promise<BrowserTask>;
  cancelBrowserTask(): Promise<BrowserTask|null>;
  browserTaskStatus(): Promise<BrowserTask|null>;
  onBrowserTask(callback: (event: BrowserTaskEvent) => void): () => void;
  onEmbeddedBrowserState(callback: (state: EmbeddedBrowserState) => void): () => void;
  research(query: string): Promise<ResearchAnswer>;
  onResearchProgress(callback: (progress: ResearchProgress) => void): () => void;
  batteryStatus(): Promise<BatteryStatus>;
  describeScreen(query: string): Promise<ResearchAnswer>;
  takeScreenshot(): Promise<{ saved: boolean; path: string; summary: string }>;
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
  orbitPlayStart(mode: OrbitPlayMode): Promise<OrbitPlayStatus>;
  orbitPlayStop(): Promise<OrbitPlayStatus>;
  orbitPlayAction(gesture: OrbitPlayGesture): Promise<{ accepted: boolean }>;
}
