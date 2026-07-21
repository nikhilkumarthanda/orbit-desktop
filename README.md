# Orbit

Orbit is a local-first desktop operating layer that helps users understand and safely act on their computer context. The first working release inspects system resources, recovers recent work, summarizes local Git context, prepares reversible cleanup plans, searches user-approved documents, and records every tool invocation in an audit log.

## Product principles

- Local by default: no cloud model is required for system tools.
- Typed tools: renderer code cannot access Node or the filesystem directly.
- Least privilege: Electron uses context isolation, a sandboxed renderer, and an allowlisted preload API.
- Controlled agency: destructive operations require explicit selection and approval.
- Recoverability: cleanup moves files to operating-system Trash rather than permanently deleting them.
- Auditability: every privileged tool invocation records its risk, state, and summary.

## Current workflows

1. Diagnose CPU, memory, storage, and resource-heavy processes.
2. Recover recently modified work across common user folders.
3. Discover local Git repositories, branches, changes, and last commits.
4. Identify large or stale Downloads without modifying anything.
5. Move explicitly selected files to Trash after approval.
6. Review a local action history.
7. Index approved folders into SQLite FTS5 and retrieve cited passages without uploading files.
8. Route natural-language commands through a deterministic, typed intent planner that refuses unclear requests.

## Signature wake experience

Orbit 0.2 adds a native macOS speech helper. While Orbit is running, say **Hey Orbit** followed by a command, or press **⌘ Shift Space** globally. Orbit displays partial transcription, routes the final command through its typed safety planner, speaks its response with the macOS voice, and executes only registered tools. On-device recognition is preferred when the Mac supports it.

Orbit cannot listen while the computer is physically asleep. It resumes listening when the app and Mac are awake. macOS will request Microphone and Speech Recognition permission on first use.

## Architecture

```text
React renderer → allowlisted IPC bridge → Electron main process → typed local tools
                                               ↓
                                         JSONL audit log
                                               ↓
                                   Python + SQLite FTS5 retrieval
```

The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. It has no arbitrary shell bridge. Each tool is registered with a risk policy.

Destructive cleanup is approved twice: selection in the renderer and a native main-process confirmation. A compromised renderer therefore cannot silently bypass the visible operating-system approval dialog.

## Use the app

1. Open Orbit and select **Wake Orbit** for the cinematic spoken introduction.
   You can also say `Hey Orbit, open Google Chrome` or press `⌘ Shift Space`.
2. Use **System**, **Recent work**, or **Repositories** for read-only local context.
3. Open **Local knowledge**, select **Choose folder**, and approve one folder to index.
4. Search normally or type commands such as `find my launch notes` in the global command bar.
5. Open **Safe cleanup** to preview candidates. Files only move after selection and native confirmation, and remain recoverable from Trash.
6. Review **Action history** to inspect privileged tool activity.

## Development

```bash
npm install
npm run dev
```

Validate the project:

```bash
npm run check
```

Create a platform package:

```bash
npm run dist
```

The macOS release workflow bundles both the Python retrieval engine and native Swift speech helper, so end users do not install Node, npm, Python, or development packages. Packaged builds check GitHub Releases for updates. Tagged builds remain unsigned until Apple Developer signing and notarization credentials are configured.

## Next milestones

- Hybrid semantic embeddings and reranking on top of the implemented SQLite FTS5 baseline
- Encrypted SQLite activity graph and retention controls
- Fine-grained persisted folder grants and revocation UI
- Streaming microphone input; native text-to-speech is already implemented
- GitHub and calendar connectors
- Agent evaluation suite and prompt-injection tests
- Apple Developer signing and notarization (packaging workflow is implemented)

Orbit is an AI-assisted personal project. It is not represented as an operating-system vendor integration or an autonomous unrestricted agent.
